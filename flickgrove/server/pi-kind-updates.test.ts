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

test("late Pi classification updates an existing entry and survives a stale in-flight read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-pi-kind-"));
  const runtime = new FakeRuntime();
  runtime.models = async () => [
    {
      backend: "pi",
      provider: "fixture",
      id: "fake",
      name: "Fake",
      efforts: ["off"],
      defaultEffort: "off",
      isDefault: true,
      fastTier: null,
    },
  ];
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
  });
  try {
    const agent = await app.createOrc("alpha", {
      orc: { backend: "pi", provider: "fixture", model: "fake", effort: "off" },
      fast: false,
    });
    await app.send(agent.id, "start", "operation");
    const turnId = app.detail(agent.id).turnId!;
    const emit = (id: string, kind?: "progress") =>
      runtime.emit(agent.id, {
        type: "item",
        turnId,
        item: { id, type: "agentMessage", text: id, kind },
      });
    emit("early");
    const before = app.detail(agent.id).messages.find((m) => m.id === "early")!;
    expect(before.kind).toBeUndefined();
    emit("early", "progress");
    expect(app.detail(agent.id).messages.find((m) => m.id === "early")).toEqual(
      { ...before, kind: "progress" },
    );
    emit("during");
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const read = runtime.historyMessages.bind(runtime);
    runtime.historyMessages = async (thread, cursor) => {
      const page = structuredClone(await read(thread, cursor));
      started.resolve();
      await gate.promise;
      return page;
    };
    const sync = app.synchronizeDetail(agent.id);
    await started.promise;
    emit("during", "progress");
    gate.resolve();
    expect((await sync).messages.find((m) => m.id === "during")?.kind).toBe(
      "progress",
    );
    expect(
      app.detail(agent.id).messages.filter((m) => m.id === "during"),
    ).toHaveLength(1);
    const longText = "x".repeat(300_000);
    runtime.emit(agent.id, {
      type: "item",
      turnId,
      item: { id: "large", type: "agentMessage", text: longText },
    });
    await app.synchronizeDetail(agent.id);
    expect(
      app.detail(agent.id).messages.find((m) => m.id === "large")?.bodyRef,
    ).toBe("large");
    runtime.emit(agent.id, {
      type: "item",
      turnId,
      item: {
        id: "large",
        type: "agentMessage",
        text: longText,
        kind: "progress",
      },
    });
    expect(
      app.detail(agent.id).messages.find((m) => m.id === "large")?.kind,
    ).toBe("progress");
    emit("terminal");
    runtime.emit(agent.id, { type: "completed", turnId, status: "completed" });
    emit("terminal", "progress");
    expect(
      app.detail(agent.id).messages.find((m) => m.id === "terminal")?.kind,
    ).toBe("progress");
    runtime.emit(agent.id, {
      type: "item",
      turnId: "new-question-turn",
      item: {
        id: "question",
        type: "agentMessage",
        text: "question",
        delivery: "async",
        questions: [{ question: "Choose?" }],
      },
    });
    runtime.emit(agent.id, {
      type: "item",
      turnId: "new-question-turn",
      item: {
        id: "question",
        type: "agentMessage",
        text: "question",
        kind: "progress",
      },
    });
    expect(
      app.detail(agent.id).messages.find((m) => m.id === "question")?.kind,
    ).toBeUndefined();
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
