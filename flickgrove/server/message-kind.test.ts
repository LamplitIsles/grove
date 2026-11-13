import { expect, test } from "bun:test";
import type { EntryRecord, Storage } from "@earendil-works/pi-durable";
import {
  codexMessageKind,
  piAnswerKinds,
  piToolProgress,
} from "./message-kind";

const kind = async (f: ReturnType<typeof fixture>, entries = f.entries) => [
  ...(await piAnswerKinds(f.storage, entries as unknown as EntryRecord[])),
];
function fixture() {
  const input = {
    id: 1,
    conversationId: 1,
    kind: "grove.input",
    data: { operation: "op" },
  };
  const answer = {
    id: 2,
    conversationId: 1,
    kind: "pi.assistant",
    byTaskId: 3,
    model: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "answer" }],
      },
    ],
  };
  const receipt = {
    type: "input",
    status: "done",
    conversationId: 1,
    entry: 1,
    answer: 2,
  };
  const task = {
    id: 3,
    conversationId: 1,
    kind: "pi.generation",
    state: {
      status: "terminal",
      outcome: { status: "completed", result: { entryId: 2 } },
    },
  };
  const storage = {
    submissionByRequest: async () => receipt,
    task: async () => task,
  } as unknown as Pick<Storage, "submissionByRequest" | "task">;
  return { entries: [input, answer], input, answer, receipt, task, storage };
}

test("Codex only maps explicit known phases", () => {
  expect(
    ["commentary", "final_answer", "other", null, undefined].map(
      codexMessageKind,
    ),
  ).toEqual(["progress", "result", undefined, undefined, undefined]);
});

test("Pi requires a matching completed input and generation in the bounded view", async () => {
  const f = fixture();
  expect(await kind(f)).toEqual([2]);
  for (const reason of ["length", "toolUse"]) {
    f.answer.model[0].stopReason = reason;
    expect(await kind(f)).toEqual([2]);
  }
  expect(await kind(f, [f.answer])).toEqual([]); // input on a different page
  f.receipt.status = "unanswered";
  expect(await kind(f)).toEqual([]);
  f.receipt.status = "done";
  f.receipt.answer = 99;
  expect(await kind(f)).toEqual([]);
  f.receipt.answer = 2;
  f.task.state.outcome.result.entryId = 99;
  expect(await kind(f)).toEqual([]);
  f.task.state.outcome.result.entryId = 2;
  f.answer.model[0].content.push({ type: "toolCall", text: "" });
  expect(await kind(f)).toEqual([]); // a tool call is not a result, even when settled
  expect(piToolProgress(f.answer as unknown as EntryRecord)).toBe("progress");
  f.answer.model[0].content.pop();
  for (const reason of ["error", "aborted", "deferred"]) {
    f.answer.model[0].stopReason = reason;
    expect(await kind(f)).toEqual([]);
  }
});

test("Pi progress requires a tool call in the same assistant model message", () => {
  const f = fixture();
  const entry = f.answer as unknown as EntryRecord;
  expect(piToolProgress(entry)).toBeUndefined();
  f.answer.model[0].content.push({ type: "toolCall", text: "" });
  for (const reason of ["toolUse", "stop", "aborted", "error"]) {
    f.answer.model[0].stopReason = reason;
    expect(piToolProgress(entry)).toBe("progress");
  }
  const other = structuredClone(f.answer);
  other.kind = "pi.tool-result";
  expect(piToolProgress(other as unknown as EntryRecord)).toBeUndefined();
  f.answer.model.push({
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "toolCall", text: "" }],
  });
  expect(piToolProgress(entry)).toBeUndefined();
});
