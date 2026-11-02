import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPiSession } from "./pi-session";
import { PiRuntime } from "./pi";
import sharp from "sharp";
import type { RuntimeAgent, RuntimeEvent, RuntimeHandle } from "./runtime";

const until = async (check: () => boolean) => {
  for (let n = 0; n < 1000; n++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Fixture timed out");
};

test("Pi binds model metadata to queued inputs across recovery without changing history", async () => {
  if (!process.env.GROVE_CONTEXT_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-context-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, "codex"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        GROVE_CONTEXT_CHILD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code ? out + err : "" }).toEqual({
        code: 0,
        output: "",
      });
    } finally {
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "working"),
    sessionDir = join(agentDir, "grove-durable");
  await mkdir(agentDir);
  await mkdir(cwd);
  const captured: any[] = [];
  let hold = true;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      captured.push(await req.json());
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      if (hold)
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  chunk({ role: "assistant", content: "" }, null),
                ),
              );
            },
            cancel() {},
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return new Response(
        chunk({ role: "assistant", content: "done" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "fixture",
          models: [
            {
              id: "fake",
              name: "fake",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const agent: RuntimeAgent = {
    id: "fixture",
    token: "fixture",
    role: "orc",
    ownerId: "fixture",
    project: { alias: "fixture", name: "fixture", path: cwd },
    title: "Fixture",
    model: "fake",
    effort: "off",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
  };
  const options = {
    agentDir,
    sessionDir,
    selection: { provider: "fixture", model: "fake", effort: "off" },
    tool: async () => ({}),
  };
  const imagePath = join(cwd, "fixture.png");
  await writeFile(
    imagePath,
    await sharp({
      create: { width: 2, height: 2, channels: 4, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  const events: RuntimeEvent[] = [];
  let handle: RuntimeHandle | undefined;
  const alice =
      'Human message metadata (data): {"name":"Alice","submittedAt":"2026-01-01T00:00:00.000Z"}',
    bob =
      'Human message metadata (data): {"name":"Bob","submittedAt":"2026-01-01T00:01:00.000Z"}';
  try {
    handle = await openPiSession(agent, (e) => events.push(e), options);
    const threadId = handle.threadId;
    const run = await handle.send(
      "same text",
      undefined,
      [imagePath],
      "a",
      "envelope",
      false,
      alice,
    );
    await until(() => captured.length === 1);
    await handle.send("same text", run, [], "b", "envelope", false, bob);
    await handle.send("same text", run, [], "b", "envelope", false, bob);
    await handle.close();
    handle = undefined;
    hold = false;
    handle = await openPiSession(
      { ...agent, threadId },
      (e) => events.push(e),
      options,
    );
    await until(
      () =>
        captured.length >= 3 &&
        events.some(
          (e) =>
            e.type === "submission" &&
            e.operationId === "b" &&
            e.status === "done",
        ),
    );
    const last = JSON.stringify(captured.at(-1).messages);
    expect(last.split(alice.replaceAll('"', '\\"')).length - 1).toBe(1);
    expect(last.split(bob.replaceAll('"', '\\"')).length - 1).toBe(1);
    const users = captured
      .at(-1)
      .messages.filter((m: any) => m.role === "user");
    expect(JSON.stringify(users[0])).toContain("Alice");
    expect(JSON.stringify(users[0])).not.toContain("Bob");
    expect(JSON.stringify(users[0])).toContain("image_url");
    expect(JSON.stringify(users[1])).toContain("Bob");
    expect(JSON.stringify(users[1])).not.toContain("Alice");
    const history = (
      await new PiRuntime({ agentDir, tool: async () => ({}) }).historyMessages(
        threadId,
      )
    ).messages.filter((m) => m.role === "user");
    expect(history.map((m) => [m.clientId, m.text])).toEqual([
      ["a", "same text"],
      ["b", "same text"],
    ]);
    expect(history[0]?.images).toHaveLength(1);
    expect(
      await new PiRuntime({ agentDir, tool: async () => ({}) }).historyImage(
        threadId,
        history[0]!.images![0]!.id,
      ),
    ).not.toBeNull();
    expect(
      events
        .filter((e) => e.type === "item" && e.item.type === "userMessage")
        .every((e) => e.type !== "item" || e.item.text === "same text"),
    ).toBe(true);
    await handle.send("third", undefined, [], "c");
    await until(() => captured.length >= 4);
    const later = JSON.stringify(captured.at(-1).messages);
    expect(later.split(alice.replaceAll('"', '\\"')).length - 1).toBe(1);
    expect(later.split(bob.replaceAll('"', '\\"')).length - 1).toBe(1);
    await until(() =>
      events.some(
        (e) =>
          e.type === "submission" &&
          e.operationId === "c" &&
          e.status === "done",
      ),
    );
    hold = true;
    const stopping = await handle.send(
      "active",
      undefined,
      [],
      "d",
      "envelope",
      false,
      alice,
    );
    await until(() => captured.length >= 5);
    await handle.send(
      "withdrawn",
      stopping,
      [imagePath],
      "e",
      "envelope",
      false,
      bob,
    );
    await handle.interrupt(stopping);
    const stoppedHistory = (
      await new PiRuntime({ agentDir, tool: async () => ({}) }).historyMessages(
        threadId,
      )
    ).messages;
    const withdrawn = stoppedHistory.find((m) => m.clientId === "e")!;
    expect(withdrawn.text).toBe("withdrawn");
    expect(withdrawn.images).toHaveLength(1);
  } finally {
    await handle?.close();
    await provider.stop(true);
  }
}, 30000);
