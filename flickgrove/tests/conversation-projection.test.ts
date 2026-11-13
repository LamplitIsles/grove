import { expect, test } from "bun:test";
import { projectConversation } from "../src/conversation-projection";
import type { Message } from "../src/contracts";

test("a result groups progress across user inputs while hiding confirmed member reports", () => {
  const message = (id: string, fields: Partial<Message> = {}): Message => ({
    id,
    role: "assistant",
    text: id,
    at: 1,
    ...fields,
  });
  const worker = {
    id: "worker",
    source: "worker" as const,
    status: "sent" as const,
    at: 1,
    text: "report",
    questionIds: [],
  };
  const input = [
    message("progress", { kind: "progress" }),
    message("input", { role: "user" }),
    message("report", { role: "user", clientId: "worker" }),
    message("unknown"),
    message("answer", { kind: "result" }),
    message("next", { kind: "progress" }),
  ];
  const rows = projectConversation(input, [worker]);
  expect(rows.map((row) => row.id)).toEqual([
    "input",
    "unknown",
    "group:answer",
    "answer",
    "next",
  ]);
  expect(rows[2]).toMatchObject({
    type: "group",
    messages: [{ id: "progress" }],
  });
  expect(input.map((item) => item.id)).toEqual([
    "progress",
    "input",
    "report",
    "unknown",
    "answer",
    "next",
  ]);
  expect(
    projectConversation(input.slice(0, 3), [worker]).map((row) => row.id),
  ).toEqual(["progress", "input"]);
});

test("questions, failed deliveries and unknown messages remain visible", () => {
  const messages: Message[] = [
    {
      id: "question",
      role: "assistant",
      kind: "progress",
      questionItemId: "q",
      text: "question",
      at: 1,
    },
    { id: "unknown", role: "assistant", text: "unknown", at: 2 },
    {
      id: "unknown-user",
      role: "user",
      text: "Worker report: not proven",
      at: 2,
    },
    { id: "result", role: "assistant", kind: "result", text: "answer", at: 3 },
  ];
  expect(projectConversation(messages).map((row) => row.id)).toEqual([
    "question",
    "unknown",
    "unknown-user",
    "result",
  ]);
});

test("confirmed member reports are hidden while uncertain and failed reports remain visible", () => {
  const report = (source: "worker" | "reviewer" | "researcher") => ({
    id: source,
    source,
    status: "sent" as const,
    text: `${source} report`,
    questionIds: [],
    at: 1,
  });
  const worker = report("worker");
  const reviewer = report("reviewer");
  const researcher = report("researcher");
  const messages: Message[] = [
    {
      id: "worker-message",
      clientId: worker.id,
      role: "user",
      text: worker.text,
      at: 1,
    },
    {
      id: "review-message",
      role: "user",
      text: reviewer.text,
      at: 2,
      delivery: reviewer,
    },
    {
      id: "research-message",
      clientId: researcher.id,
      role: "user",
      text: researcher.text,
      at: 3,
    },
    {
      id: "uncertain",
      role: "user",
      text: "unconfirmed",
      at: 4,
      delivery: { ...reviewer, id: "uncertain", status: "uncertain" },
    },
    {
      id: "failed",
      role: "user",
      text: "failed",
      at: 5,
      delivery: {
        ...researcher,
        id: "failed",
        status: "failed",
        error: "failed",
      },
    },
    {
      id: "error-sent",
      role: "user",
      text: "reported error",
      at: 5,
      delivery: { ...worker, id: "error-sent", error: "delivery error" },
    },
    {
      id: "provisional",
      role: "user",
      text: "provisional delivery",
      at: 5,
      provisional: true,
      delivery: { ...worker, id: "provisional" },
    },
    {
      id: "ambiguous-role",
      role: "assistant",
      kind: "progress",
      text: "uncertain member provenance",
      at: 5,
      delivery: { ...worker, id: "ambiguous-role", status: "uncertain" },
    },
    {
      id: "question",
      role: "assistant",
      kind: "progress",
      questionItemId: "q",
      text: "question",
      at: 6,
    },
    { id: "result", role: "assistant", kind: "result", text: "result", at: 7 },
  ];
  const deliveries = [worker, researcher];
  expect(
    projectConversation(messages.slice(0, -1), deliveries).map((row) => row.id),
  ).toEqual([
    "uncertain",
    "failed",
    "error-sent",
    "provisional",
    "ambiguous-role",
    "question",
  ]);
  const rows = projectConversation(messages, deliveries);
  expect(rows.map((row) => row.id)).toEqual([
    "uncertain",
    "failed",
    "error-sent",
    "provisional",
    "ambiguous-role",
    "question",
    "result",
  ]);
});
