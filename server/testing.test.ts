import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixtureSync,
} from "./testing";
import { Workspace } from "./workspace";
import type { RuntimeItem } from "./runtime";

test("fake native history preserves message classification across synchronization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-fake-classification-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
  });
  try {
    const agent = await app.createOrc("alpha");
    await app.send(agent.id, "work", "operation");
    const turnId = app.detail(agent.id).turnId!;
    const items: RuntimeItem[] = [
      {
        id: "progress",
        type: "agentMessage",
        text: "progress",
        phase: "commentary",
      },
      {
        id: "result",
        type: "agentMessage",
        text: "result",
        phase: "final_answer",
      },
      {
        id: "explicit",
        type: "agentMessage",
        text: "explicit",
        kind: "result",
        phase: "commentary",
      },
      { id: "unknown", type: "agentMessage", text: "unknown", phase: "other" },
      { id: "missing", type: "agentMessage", text: "missing" },
      {
        id: "question",
        type: "agentMessage",
        text: "question",
        kind: "result",
        phase: "final_answer",
        delivery: "async",
        questions: [{ question: "Choose?" }],
      },
    ];
    for (const item of items)
      runtime.emit(agent.id, { type: "item", turnId, item });
    const expected = [
      "progress",
      "result",
      "result",
      undefined,
      undefined,
      undefined,
    ];
    const kinds = (messages: { id: string; kind?: string }[]) =>
      items.map((item) => messages.find((m) => m.id === item.id)?.kind);
    expect(kinds(app.detail(agent.id).messages)).toEqual(expected);
    expect(
      kinds((await runtime.historyMessages(agent.threadId!)).messages),
    ).toEqual(expected);
    expect(
      kinds(
        (
          await runtime.messageWindow(agent.threadId!, {
            operation: "operation",
          })
        ).messages,
      ),
    ).toEqual(expected);
    expect(kinds((await app.synchronizeDetail(agent.id)).messages)).toEqual(
      expected,
    );
    expect(
      app.detail(agent.id).messages.find((m) => m.id === "question")
        ?.questionItemId,
    ).toBe("question");
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
