import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchingVersion } from "./instance-version";
import { instanceManager, ManagerNotStarted } from "./instance-manager";
import { InstanceControls } from "./instance-controls";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { HostService } from "./hosts";
import { createHandler } from "./http";

test("version requires a clean matching build and startup identity", () => {
  const commit = "a".repeat(40),
    clean = { commit, dirty: false };
  expect(matchingVersion(clean, clean)).toBe("aaaaaaa");
  expect(matchingVersion({ ...clean, dirty: true }, clean)).toBeNull();
  expect(matchingVersion(clean, { ...clean, dirty: true })).toBeNull();
  expect(
    matchingVersion(clean, { ...clean, commit: "b".repeat(40) }),
  ).toBeNull();
  expect(matchingVersion(clean, null)).toBeNull();
});

test("fixed manager accepts only this uid and process and sends fixed arguments", async () => {
  const calls: string[][] = [];
  let busUid = 1000,
    pid = 42,
    group = "/user.slice/user-1000.slice/user@1000.service/app.slice/flickgrove.service";
  const host = {
    platform: "linux",
    uid: 1000,
    pid: 42,
    inspect: async (_binary: string, args: string[]) => {
      calls.push(args);
      return `Id=flickgrove.service\nMainPID=${pid}\nControlGroup=${group}\n`;
    },
    busUid: async () => busUid,
    cgroup: async () =>
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/flickgrove.service\n",
    spawn: async (_binary: string, args: string[]) => {
      calls.push(args);
    },
  };
  const manager = instanceManager(host);
  expect(await manager.available()).toBe(true);
  await manager.request();
  expect(calls.at(-1)).toEqual([
    "--user",
    "--no-block",
    "restart",
    "flickgrove.service",
  ]);
  pid = 43;
  expect(await manager.available()).toBe(false);
  pid = 42;
  busUid = 1001;
  expect(await manager.available()).toBe(false);
  busUid = 1000;
  group = "/other/flickgrove.service";
  expect(await manager.available()).toBe(false);
  const mac = instanceManager({
    ...host,
    platform: "darwin",
    inspect: async () => "pid = 42\n",
  });
  expect(await mac.available()).toBe(true);
  await mac.request();
  expect(calls.at(-1)).toEqual([
    "kickstart",
    "-k",
    "gui/1000/io.guion.flickgrove",
  ]);
});

test("restart holds admission across manager verification and unknown result without replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-instance-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  try {
    const agent = await app.createOrc("alpha");
    const notStarted = new InstanceControls(app, null, {
      available: async () => true,
      request: async () => {
        throw new ManagerNotStarted();
      },
    });
    expect(await notStarted.restart()).toEqual({ status: "unavailable" });
    expect(app.instanceBusy()).toBe(false);
    let release!: (available: boolean) => void;
    const gate = new Promise<boolean>((r) => {
      release = r;
    });
    let requests = 0;
    const controls = new InstanceControls(app, "aaaaaaa", {
      available: () => gate,
      request: async () => {
        requests++;
      },
    });
    const restart = controls.restart();
    await expect(app.send(agent.id, "new work", "operation")).rejects.toThrow(
      "maintenance",
    );
    await expect(app.createOrc("beta")).rejects.toThrow("maintenance");
    release(true);
    expect(await restart).toEqual({ status: "unknown" });
    await expect(controls.restart()).rejects.toThrow("active or pending");
    expect(requests).toBe(1);
    expect(runtime.inputs).toHaveLength(0);
  } finally {
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work in progress and asynchronous creation prevent instance maintenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-instance-busy-"));
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const runtime = new FakeRuntime();
  let delayed = true;
  const app = new Workspace({
    directory: dir,
    runtime,
    branches: { read: async () => null },
    projects: async () => {
      if (delayed) await gate;
      return fixtureProjects;
    },
  });
  try {
    const creating = app.createOrc("alpha");
    expect(app.instanceBusy()).toBe(true);
    expect(app.instanceActivity()).toMatchObject({
      busy: true,
      canConfirmBusy: false,
      sessions: [],
      instanceReasons: ["creating"],
    });
    await expect(app.reloadMcp()).rejects.toThrow("active or pending");
    await expect(app.reloadMcp(true)).rejects.toThrow("active or pending");
    delayed = false;
    release();
    const agent = await creating;
    await app.send(agent.id, "active", "operation");
    expect(app.instanceBusy()).toBe(true);
    expect(() => app.beginMaintenance()).toThrow("active or pending");
  } finally {
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reload reports Codex uncertainty and Pi session partial results independently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-instance-reload-"));
  class Runtime extends FakeRuntime {
    async models() {
      return (await super.models()).map((m) => ({
        ...m,
        backend: "pi" as const,
        provider: "fixture",
      }));
    }
    async reloadMcp() {
      throw new Error("may have partially applied");
    }
    async open(...args: Parameters<FakeRuntime["open"]>) {
      const handle = await super.open(...args);
      handle.reloadMcp = async () => ({ issues: ["fixture unavailable"] });
      return handle;
    }
  }
  const app = new Workspace({
    directory: dir,
    runtime: new Runtime(),
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  try {
    const settings = {
      fast: false,
      orc: {
        backend: "pi" as const,
        provider: "fixture",
        model: "sol",
        effort: "medium",
      },
      worker: {
        backend: "pi" as const,
        provider: "fixture",
        model: "sol",
        effort: "medium",
      },
    };
    const agent = await app.createOrc("alpha", settings);
    expect(await app.reloadMcp()).toEqual({
      results: [
        { backend: "codex", status: "partial_or_unknown" },
        { backend: "pi", session: agent.id, status: "partial" },
      ],
    });
    expect(app.instanceBusy()).toBe(false);
  } finally {
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human session and same origin are required for instance routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-instance-http-"));
  const app = new Workspace({
    directory: dir,
    runtime: new FakeRuntime(),
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  const origin = "http://localhost:4318";
  const service = new HostService(app, {
    directory: dir,
    origin: () => origin,
  });
  const auth = {
    session: async (headers: Headers) =>
      headers.get("cookie") === "human=fixture"
        ? { user: { id: "human" } }
        : null,
  } as unknown as import("./auth").GroveAuth;
  const controls = new InstanceControls(app, null, {
    available: async () => false,
    request: async () => {},
  });
  const fetch = createHandler(app, {
    service,
    auth,
    origin: () => origin,
    instance: controls,
  });
  try {
    const req = (
      originHeader: string | undefined,
      cookie?: string,
      authorization?: string,
    ) =>
      fetch(
        new Request(`${origin}/api/instance/restart`, {
          method: "POST",
          headers: {
            ...(originHeader ? { origin: originHeader } : {}),
            ...(cookie ? { cookie } : {}),
            ...(authorization ? { authorization } : {}),
          },
        }),
      );
    expect(
      (await req(origin, undefined, "Bearer fixture-agent-token")).status,
    ).toBe(401);
    expect((await req("https://evil.example", "human=fixture")).status).toBe(
      403,
    );
    expect((await req(undefined, "human=fixture")).status).toBe(403);
    expect(await (await req(origin, "human=fixture")).json()).toEqual({
      status: "unavailable",
    });
  } finally {
    service.dispose();
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const role of ["orc", "worker"] as const) {
  test(`confirmed Codex ${role} failure permits maintenance after recovery`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "grove-terminal-idle-"));
    let app: Workspace | undefined;
    let service: HostService | undefined;
    try {
      const before = new FakeRuntime();
      const options = {
        directory,
        projects: async () => fixtureProjects,
        branches: { read: async () => null },
      };
      app = new Workspace({ ...options, runtime: before });
      const orc = await app.createOrc("alpha");
      let agentId = orc.id;
      if (role === "worker") {
        const worker = (await app.tool(
          before.agents.get(orc.id)!.token,
          "worker_start",
          {
            project: "alpha",
            title: "fixture worker",
            spec: "fixture",
            message: "work",
          },
        )) as { id: string };
        agentId = worker.id;
      } else {
        await app.send(orc.id, "work", "terminal-operation");
      }
      before.emit(agentId, {
        type: "completed",
        turnId: app.detail(agentId).turnId!,
        status: "failed",
        verified: true,
        error: "fixture terminal failure",
      });
      expect(app.detail(agentId).state).toBe("error");
      expect(app.detail(agentId).turnId).toBeUndefined();
      await before.close();
      app.dispose();
      const after = new FakeRuntime();
      app = new Workspace({ ...options, runtime: after });
      for (
        let i = 0;
        i < 100 && after.agents.size < (role === "worker" ? 2 : 1);
        i++
      )
        await Bun.sleep(1);
      await Bun.sleep(1);
      expect(after.agents.size).toBe(role === "worker" ? 2 : 1);
      expect(after.inputs).toHaveLength(0);
      expect(app.detail(agentId).state).toBe("error");
      const origin = "http://localhost:4318";
      service = new HostService(app, { directory, origin: () => origin });
      const auth = {
        session: async () => ({ user: { id: "fixture" } }),
      } as unknown as import("./auth").GroveAuth;
      const instance = new InstanceControls(app, null, {
        available: async () => false,
        request: async () => {},
      });
      const fetch = createHandler(app, {
        service,
        auth,
        instance,
        origin: () => origin,
      });
      const get = await fetch(
        new Request(`${origin}/api/instance`, { headers: { origin } }),
      );
      expect(((await get.json()) as { busy: boolean }).busy).toBe(false);
      const post = await fetch(
        new Request(`${origin}/api/instance/restart`, {
          method: "POST",
          headers: { origin },
        }),
      );
      expect(post.status).toBe(200);
      expect(await post.json()).toEqual({ status: "unavailable" });
    } finally {
      service?.dispose();
      app?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("unverified failure and disconnected outcomes remain busy", async () => {
  for (const outcome of ["unverified", "disconnected"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "grove-unknown-idle-"));
    const runtime = new FakeRuntime();
    const app = new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
      branches: { read: async () => null },
    });
    try {
      const orc = await app.createOrc("alpha");
      await app.send(orc.id, "work", "operation");
      const turnId = app.detail(orc.id).turnId!;
      if (outcome === "unverified")
        runtime.emit(orc.id, {
          type: "completed",
          turnId,
          status: "failed",
          verified: false,
        });
      else
        runtime.emit(orc.id, {
          type: "disconnected",
          error: "fixture disconnect",
        });
      expect(app.detail(orc.id).state).toBe("error");
      expect(app.detail(orc.id).turnId).toBeUndefined();
      expect(app.instanceBusy()).toBe(true);
      expect(() => app.beginMaintenance()).toThrow("active or pending");
    } finally {
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("active and disconnected Codex Worker keeps an idle owner busy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-worker-disconnect-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  try {
    const orc = await app.createOrc("alpha");
    const worker = (await app.tool(
      runtime.agents.get(orc.id)!.token,
      "worker_start",
      { project: "alpha", title: "fixture", spec: "fixture", message: "work" },
    )) as { id: string };
    expect(app.detail(orc.id).state).toBe("idle");
    expect(app.detail(worker.id).state).toBe("working");
    expect(app.instanceBusy()).toBe(true);
    runtime.emit(worker.id, {
      type: "disconnected",
      error: "fixture disconnect",
    });
    expect(app.detail(worker.id).state).toBe("error");
    expect(app.detail(worker.id).turnId).toBeUndefined();
    expect(app.detail(worker.id).workUnconfirmed).toBe(true);
    expect(app.instanceBusy()).toBe(true);
    expect(app.instanceActivity().canConfirmBusy).toBe(true);
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unverified Pi completion remains busy even when its display state is idle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-pi-unverified-idle-"));
  const runtime = new FakeRuntime();
  runtime.models = async () => [
    {
      backend: "pi",
      provider: "fixture",
      id: "sol",
      name: "Sol",
      efforts: ["medium"],
      defaultEffort: "medium",
      isDefault: true,
      fastTier: null,
    },
  ];
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  try {
    const orc = await app.createOrc("alpha");
    await app.send(orc.id, "work", "operation");
    runtime.emit(orc.id, {
      type: "completed",
      turnId: app.detail(orc.id).turnId!,
      status: "completed",
      verified: false,
    });
    expect(app.detail(orc.id).state).toBe("idle");
    expect(app.detail(orc.id).turnId).toBeUndefined();
    const controls = new InstanceControls(app, null, {
      available: async () => true,
      request: async () => {},
    });
    expect((await controls.status()).busy).toBe(true);
    await expect(controls.restart()).rejects.toThrow("active or pending");
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a confirmed failure retains unknown delivery protection but permits an unanswered question", async () => {
  for (const pending of ["unknown", "question"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "grove-failure-pending-"));
    const runtime = new FakeRuntime();
    const app = new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
      branches: { read: async () => null },
    });
    try {
      const orc = await app.createOrc("alpha");
      if (pending === "unknown") {
        runtime.sendOverride = async () => {
          throw new Error("fixture unknown admission");
        };
        await app.send(orc.id, "unknown", "unknown-operation");
        runtime.sendOverride = undefined;
      }
      await app.send(orc.id, "work", "operation");
      const turnId = app.detail(orc.id).turnId!;
      if (pending === "question")
        runtime.emit(orc.id, {
          type: "item",
          turnId,
          item: {
            id: "fixture-question",
            type: "agentMessage",
            delivery: "async",
            questions: [{ question: "Proceed?" }],
          },
        });
      runtime.emit(orc.id, {
        type: "completed",
        turnId,
        status: "failed",
        verified: true,
      });
      expect(app.detail(orc.id).state).toBe("error");
      expect(app.instanceBusy()).toBe(pending === "unknown");
      if (pending === "unknown") {
        expect(
          app
            .detail(orc.id)
            .deliveries.find((d) => d.id === "unknown-operation")?.status,
        ).toBe("uncertain");
        await app.send(orc.id, "unknown", "unknown-operation");
        expect(
          runtime.inputs.filter(
            (input) => input.clientId === "unknown-operation",
          ),
        ).toHaveLength(1);
      } else {
        expect(app.detail(orc.id).questions[0]?.state).toBe("unanswered");
      }
    } finally {
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("unverified Pi Worker failure remains busy after recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-pi-worker-unknown-"));
  let app: Workspace | undefined;
  const models = async () => [
    {
      backend: "pi" as const,
      provider: "fixture",
      id: "sol",
      name: "Sol",
      efforts: ["medium"],
      defaultEffort: "medium",
      isDefault: true,
      fastTier: null,
    },
  ];
  try {
    const before = new FakeRuntime();
    before.models = models;
    const options = {
      directory,
      projects: async () => fixtureProjects,
      branches: { read: async () => null },
    };
    app = new Workspace({ ...options, runtime: before });
    const orc = await app.createOrc("alpha");
    const worker = (await app.tool(
      before.agents.get(orc.id)!.token,
      "worker_start",
      {
        project: "alpha",
        title: "fixture worker",
        spec: "fixture",
        message: "work",
      },
    )) as { id: string };
    before.emit(worker.id, {
      type: "completed",
      turnId: app.detail(worker.id).turnId!,
      status: "failed",
      verified: false,
    });
    await before.close();
    app.dispose();
    const after = new FakeRuntime();
    after.models = models;
    app = new Workspace({ ...options, runtime: after });
    for (let i = 0; i < 100 && after.agents.size < 2; i++) await Bun.sleep(1);
    await Bun.sleep(1);
    expect(after.agents.size).toBe(2);
    expect(after.inputs).toHaveLength(0);
    expect(app.detail(worker.id).state).toBe("error");
    expect(app.detail(worker.id).turnId).toBeUndefined();
    expect(app.detail(worker.id).workUnconfirmed).toBe(true);
    expect(app.instanceBusy()).toBe(true);
  } finally {
    app?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
