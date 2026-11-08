import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { initializeReviewerConfig, roleDivision } from "./reviewer-config";
import { memberPresetsFixture } from "./testing";

// The captured division must reach the real Codex thread instructions and
// survive a restart, without asserting the shipped prompt prose.
const choice = {
  backend: "codex" as const,
  model: "fixture-model",
  effort: "medium",
};
const preset = {
  worker: choice,
  researcher: choice,
  standards: choice,
  spec: choice,
  high_risk_spec: choice,
};
const captured = "DIVISION-ALPHA-CAPTURED";
const edited = "DIVISION-BETA-LATER";

test("the captured task division reaches new and resumed Codex sessions and never the legacy ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-role-division-native-"));
  const configPath = join(root, "config.toml");
  await initializeReviewerConfig(configPath);
  const file = join(root, "prompts/role-division.md");
  await writeFile(file, captured);
  const memberPresets = await memberPresetsFixture(root, preset);
  const makeRuntime = () =>
    new CodexRuntime({
      cwd: root,
      origin: () => "http://127.0.0.1:1",
      codexPath: fileURLToPath(
        new URL("../tests/fake-codex.mjs", import.meta.url),
      ),
      env: {
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        CODEX_HOME: join(root, "codex"),
        FAKE_SERVER_ROOT: root,
      },
    });
  let runtime = makeRuntime();
  const makeWorkspace = (division = true) =>
    new Workspace({
      directory: root,
      runtime,
      projects: async () => [{ alias: "alpha", name: "Alpha", path: root }],
      memberPresets,
      ...(division ? { roleDivision: () => roleDivision(configPath) } : {}),
    });
  let app = makeWorkspace();
  const requests = async () =>
    (await readFile(join(root, ".fake-app-server-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const instructions = async (
    method: "thread/start" | "thread/resume",
    threadId?: string,
  ) =>
    (await requests())
      .filter(
        (r) =>
          r.method === method &&
          !!r.params.developerInstructions &&
          (method === "thread/start"
            ? !r.params.ephemeral
            : r.params.threadId === threadId),
      )
      .map((r) => r.params.developerInstructions as string);
  try {
    const orc = await app.createOrc("alpha");
    const worker = (await app.tool(
      app.store.byId(orc.id)!.token,
      "worker_start",
      {
        project: "alpha",
        title: "Worker",
        spec: "#5554",
        message: "Work",
      },
    )) as { id: string };
    // Both new sessions carry the captured text at their real thread start.
    const starts = await instructions("thread/start");
    expect(starts).toHaveLength(2);
    for (const text of starts) expect(text).toContain(captured);
    const orcThread = app.detail(orc.id).threadId!;
    const workerThread = app.detail(worker.id).threadId!;
    expect(orcThread).not.toBe(workerThread);

    // Editing the file does not change the captured text after a restart.
    await writeFile(file, edited);
    app.dispose();
    await runtime.close();
    runtime = makeRuntime();
    app = makeWorkspace();
    await app.updateSettings(orc.id, {
      model: "fixture-model",
      effort: "medium",
    });
    await app.tool(app.store.byId(orc.id)!.token, "worker_send", {
      workerId: worker.id,
      message: "Continue",
    });
    expect(app.detail(orc.id).threadId).toBe(orcThread);
    expect(app.detail(worker.id).threadId).toBe(workerThread);
    const orcResume = (await instructions("thread/resume", orcThread)).at(-1)!;
    const workerResume = (await instructions("thread/resume", workerThread)).at(
      -1,
    )!;
    expect(orcResume).toContain(captured);
    expect(workerResume).toContain(captured);
    expect(orcResume).not.toContain(edited);
    expect(workerResume).not.toContain(edited);
    // A Worker added by the restarted Orc inherits the stored text, not the file.
    const later = (await app.tool(
      app.store.byId(orc.id)!.token,
      "worker_start",
      {
        project: "alpha",
        title: "Later",
        spec: "#5554",
        message: "Work",
      },
    )) as { id: string };
    expect(app.detail(later.id).threadId).not.toBe(workerThread);
    expect((await instructions("thread/start")).at(-1)).toContain(captured);
    expect((await instructions("thread/start")).at(-1)).not.toContain(edited);

    // Without a captured division the file is never read for instructions.
    app.dispose();
    await runtime.close();
    runtime = makeRuntime();
    app = makeWorkspace(false);
    await app.createOrc("alpha");
    const legacy = (await instructions("thread/start")).at(-1)!;
    expect(legacy).not.toContain(captured);
    expect(legacy).not.toContain(edited);
  } finally {
    app.dispose();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
