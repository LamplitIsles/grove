import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { FakeRuntime } from "./testing";
import { WorkspaceStore } from "./workspace-store";

test("close an unsent session after restart and reopening detail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-empty-close-"));
  const projects = async () => [
    { alias: "owned", name: "Owned", path: directory },
  ];
  const runtime = () =>
    new CodexRuntime({
      cwd: directory,
      origin: () => "http://127.0.0.1:1",
      codexPath: fileURLToPath(
        new URL("../tests/fake-codex.mjs", import.meta.url),
      ),
      env: {
        ...Object.fromEntries(
          Object.keys(process.env).map((k) => [k, undefined]),
        ),
        PATH: process.env.PATH,
        HOME: join(directory, "home"),
        CODEX_HOME: join(directory, "codex"),
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CACHE_HOME: join(directory, "cache"),
        TMPDIR: directory,
        FAKE_SERVER_ROOT: directory,
        FAKE_SERVER_PROCESS_LOG: join(directory, "pids"),
      },
    });
  const firstRuntime = runtime();
  let disconnected = false;
  const open = firstRuntime.open.bind(firstRuntime);
  firstRuntime.open = (agent, notify) =>
    open(agent, (event) => {
      if (event.type === "disconnected") disconnected = true;
      notify(event);
    });
  const first = new Workspace({
    directory: join(directory, "workspace"),
    runtime: firstRuntime,
    projects,
  });
  let second: Workspace | undefined;
  let secondRuntime: CodexRuntime | undefined;
  try {
    const owner = await first.createOrc("owned");
    const pid = Number(
      (await readFile(join(directory, "pids"), "utf8"))
        .trim()
        .split("\n")
        .at(-1),
    );
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 200 && !disconnected; i++) await Bun.sleep(10);
    expect(disconnected).toBe(true);
    await firstRuntime.close();
    first.dispose();
    secondRuntime = runtime();
    second = new Workspace({
      directory: join(directory, "workspace"),
      runtime: secondRuntime,
      projects,
    });
    await second
      .synchronizeDetail(owner.id)
      .catch(() => second!.detail(owner.id));
    await second.reconcileSettings(owner.id).catch(() => {});
    expect(await second.closeTree(owner.id)).toEqual({
      closed: true,
      id: owner.id,
    });
    expect(second.snapshot().agents).toHaveLength(0);
    const calls = (
      await readFile(join(directory, ".fake-app-server-requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(calls.filter((r) => r.method === "turn/start")).toHaveLength(0);
    expect(calls.filter((r) => r.method === "thread/unsubscribe")).toHaveLength(
      1,
    );
  } finally {
    first.dispose();
    second?.dispose();
    await firstRuntime.close();
    await secondRuntime?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

for (const mode of ["working", "unknown"] as const) {
  test(`disconnect and restart retain ${mode} submitted work`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "grove-close-guard-"));
    const projects = async () => [
      { alias: "owned", name: "Owned", path: directory },
    ];
    const runtime = new FakeRuntime();
    const app = new Workspace({ directory, runtime, projects });
    let restored: Workspace | undefined;
    try {
      const owner = await app.createOrc("owned");
      if (mode === "unknown")
        runtime.sendOverride = async () => {
          throw new Error("fixture admission unknown");
        };
      await app.send(owner.id, "real work", "original-operation");
      expect(runtime.inputs).toHaveLength(1);
      runtime.emit(owner.id, {
        type: "disconnected",
        error: "fixture disconnect",
      });
      expect(app.detail(owner.id).workUnconfirmed).toBe(true);
      app.dispose();
      const next = new FakeRuntime();
      restored = new Workspace({ directory, runtime: next, projects });
      await expect(restored.closeTree(owner.id)).rejects.toThrow(
        "New session is still working or has an unconfirmed delivery",
      );
      expect(restored.detail(owner.id).workUnconfirmed).toBe(true);
      expect(next.inputs).toHaveLength(0);
      expect(restored.snapshot().agents).toHaveLength(1);
    } finally {
      app.dispose();
      restored?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("legacy unknown outcome cannot be cleared by empty history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-close-legacy-"));
  const projects = async () => [
    { alias: "owned", name: "Owned", path: directory },
  ];
  const app = new Workspace({
    directory,
    runtime: new FakeRuntime(),
    projects,
  });
  let restored: Workspace | undefined;
  try {
    const owner = await app.createOrc("owned");
    app.dispose();
    const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
    const legacy = store.track(store.byId(owner.id)!);
    legacy.state = "error";
    legacy.turnEnded = false;
    store.flush();
    store.close();
    const runtime = new FakeRuntime();
    restored = new Workspace({ directory, runtime, projects });
    await expect(restored.closeTree(owner.id)).rejects.toThrow(
      "New session is still working or has an unconfirmed delivery",
    );
    expect(restored.detail(owner.id).workUnconfirmed).toBe(true);
    await expect(restored.abandonCloseCandidate(owner.id)).rejects.toThrow(
      "No unconfirmed user submissions to abandon",
    );
    expect(runtime.inputs).toHaveLength(0);
    await restored.reconcileSettings(owner.id);
    await expect(
      restored.closeTree(owner.id, undefined, true),
    ).resolves.toEqual({
      closed: true,
      id: owner.id,
    });
    expect(restored.store.byId(owner.id)).toMatchObject({
      closed: true,
      state: "error",
      turnEnded: false,
      deliveries: [],
    });
    expect(runtime.inputs).toHaveLength(0);
  } finally {
    app.dispose();
    restored?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restoring a confirmed closed legacy unknown does not invent a terminal turn", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "grove-close-legacy-undefined-"),
  );
  const projects = async () => [
    { alias: "owned", name: "Owned", path: directory },
  ];
  const runtime = new FakeRuntime();
  const app = new Workspace({ directory, runtime, projects });
  try {
    const owner = await app.createOrc("owned");
    const agent = (
      app as unknown as {
        state: { agents: import("./runtime").RuntimeAgent[] };
      }
    ).state.agents.find((a) => a.id === owner.id)!;
    agent.state = "error";
    agent.turnEnded = undefined;
    await app.closeTree(owner.id, undefined, true);
    await app.resumeHistory("owned", owner.threadId!, false);
    expect(app.store.byId(owner.id)).toMatchObject({
      closed: false,
      state: "error",
    });
    expect(app.store.byId(owner.id)?.turnEnded).toBeUndefined();
    expect(app.detail(owner.id).workUnconfirmed).toBe(true);
    expect(runtime.inputs).toHaveLength(0);
  } finally {
    app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
