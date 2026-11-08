import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPiSession } from "./pi-session";
import type { RuntimeAgent } from "./runtime";

// A fake local provider shows what Pi actually sends to the model, using the
// repository's existing test-owned harness pattern. Only fixture markers are
// asserted, never the shipped prompt prose.
const orcDivision = "PI-DIVISION-ORC-CAPTURED";
const workerDivision = "PI-DIVISION-WORKER-CAPTURED";

test("Pi delivers each session's captured task division on creation and resume", async () => {
  if (!process.env.GROVE_ROLE_DIVISION_PI_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-role-division-pi-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, "codex"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        GROVE_ROLE_DIVISION_PI_CHILD: "1",
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
      const evidence = out
        .split("\n")
        .find((line) => line.startsWith("pi division requests"));
      if (evidence) console.log(evidence);
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
  const agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(process.env.HOME!, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  const messages: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: unknown };
      messages.push(JSON.stringify(body.messages));
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(
        chunk({ role: "assistant", content: "Fixture answer" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  // Test-owned provider credentials only: a local endpoint and a fixture key.
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "owned-fixture-only",
          models: [
            {
              id: "fake",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const member = (
    id: string,
    role: "orc" | "worker",
    roleDivisionSnapshot?: string,
  ): RuntimeAgent => ({
    id,
    token: `token-${id}`,
    role,
    ownerId: role === "worker" ? "orc" : undefined,
    project: { alias: "fixture", name: "fixture", path: cwd },
    title: id,
    model: "fake",
    effort: "off",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
    ...(roleDivisionSnapshot === undefined ? {} : { roleDivisionSnapshot }),
  });
  const turn = async (agent: RuntimeAgent, text: string, id: string) => {
    let complete!: () => void;
    const completed = new Promise<void>((resolve, reject) => {
      complete = resolve;
      setTimeout(() => reject(new Error("fixture turn timed out")), 20000);
    });
    const handle = await openPiSession(
      agent,
      (event) => {
        if (event.type === "completed") complete();
      },
      {
        agentDir,
        sessionDir: join(agentDir, "grove-durable"),
        selection: { provider: "fixture", model: "fake", effort: "off" },
        tool: async () => ({}),
      },
    );
    await handle.send(text, undefined, [], id);
    await completed;
    return handle;
  };
  try {
    const orc = member("orc", "orc", orcDivision);
    const first = await turn(orc, "Start", "first");
    const threadId = first.threadId;
    await first.close();
    // The host passes the same captured text again for this session.
    orc.threadId = threadId;
    const resumed = await turn(orc, "Continue", "second");
    expect(resumed.threadId).toBe(threadId);
    await resumed.close();
    const worker = await turn(
      member("worker", "worker", workerDivision),
      "Work",
      "third",
    );
    await worker.close();
    await turn(member("legacy", "worker"), "Legacy", "fourth");

    expect(messages).toHaveLength(4);
    // Creation and resume both carry the Orc's captured text.
    expect(messages[0]).toContain(orcDivision);
    expect(messages[1]).toContain(orcDivision);
    // The Worker carries only its own captured text.
    expect(messages[2]).toContain(workerDivision);
    expect(messages[2]).not.toContain(orcDivision);
    // A session without captured text picks up neither another member's text nor a file.
    expect(messages[3]).not.toContain(orcDivision);
    expect(messages[3]).not.toContain(workerDivision);
    console.log(
      `pi division requests ${JSON.stringify({ requests: messages.length, threadId })}
`,
    );
  } finally {
    upstream.stop(true);
  }
});
