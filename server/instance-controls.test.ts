import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchingVersion } from "./instance-version";
import { instanceManager, ManagerNotStarted } from "./instance-manager";
import { InstanceControls } from "./instance-controls";
import { Workspace } from "./workspace";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixtureSync,
} from "./testing";
import { StaleTurn } from "./runtime";
import { Database } from "bun:sqlite";
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
    group =
      "/user.slice/user-1000.slice/user@1000.service/app.slice/flickgrove.service";
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
    memberPresets: memberPresetsFixtureSync(dir),
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
    memberPresets: memberPresetsFixtureSync(dir),
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
    memberPresets: memberPresetsFixtureSync(dir),
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
        memberPresets: memberPresetsFixtureSync(directory),
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
      for (let i = 0; i < 100 && !after.agents.has(agentId); i++)
        await Bun.sleep(1);
      await Bun.sleep(1);
      expect(after.agents.has(agentId)).toBe(true);
      if (role === "worker") expect(after.agents.has(orc.id)).toBe(false);
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
      memberPresets: memberPresetsFixtureSync(directory),
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
    memberPresets: memberPresetsFixtureSync(directory),
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
    memberPresets: memberPresetsFixtureSync(directory),
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
      memberPresets: memberPresetsFixtureSync(directory),
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
      memberPresets: memberPresetsFixtureSync(directory, {
        worker: {
          backend: "pi",
          provider: "fixture",
          model: "sol",
          effort: "medium",
        },
      }),
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

test.each(["orc", "worker"] as const)(
  "verified interrupted %s stays idle and retains interruption across restart",
  async (role) => {
    const directory = mkdtempSync(
      join(tmpdir(), "grove-terminal-interrupted-"),
    );
    const runtime = new FakeRuntime();
    const options = {
      directory,
      runtime,
      projects: async () => fixtureProjects,
      memberPresets: memberPresetsFixtureSync(directory),
      branches: { read: async () => null },
    };
    let app = new Workspace(options);
    try {
      const owner = await app.createOrc("alpha");
      const token = runtime.agents.get(owner.id)!.token;
      const member =
        role === "worker"
          ? ((await app.tool(token, "worker_start", {
              project: "alpha",
              title: "fixture",
              spec: "fixture",
              message: "work",
            })) as { id: string })
          : owner;
      if (role === "orc") await app.send(owner.id, "work", "first");
      const turnId = app.detail(member.id).turnId!;
      runtime.emit(member.id, {
        type: "completed",
        turnId,
        status: "interrupted",
        verified: true,
        ...(role === "worker" ? { error: "native interruption detail" } : {}),
      });
      expect(app.detail(member.id)).toMatchObject({
        state: "idle",
        workUnconfirmed: false,
        lastInterrupted: true,
      });
      expect(app.detail(member.id).error).toBe(
        role === "worker" ? "native interruption detail" : undefined,
      );
      app.dispose();
      app = new Workspace(options);
      expect(app.detail(member.id)).toMatchObject({
        state: "idle",
        workUnconfirmed: false,
        lastInterrupted: true,
      });
      expect(app.detail(member.id).error).toBe(
        role === "worker" ? "native interruption detail" : undefined,
      );
      if (role === "orc") await app.send(member.id, "new work", "next");
      else
        await app.tool(token, "worker_send", {
          workerId: member.id,
          message: "new work",
        });
      expect(app.detail(member.id)).toMatchObject({
        state: "working",
        workUnconfirmed: true,
      });
      expect(app.detail(member.id).lastInterrupted).toBeUndefined();
    } finally {
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("unverified member completion followed by disconnect does not create an idle boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-unverified-member-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    const token = runtime.agents.get(owner.id)!.token;
    const worker = (await app.tool(token, "worker_start", {
      project: "alpha",
      title: "fixture",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    runtime.emit(worker.id, {
      type: "completed",
      turnId: app.detail(worker.id).turnId!,
      status: "completed",
      verified: false,
    });
    expect(app.detail(worker.id).workUnconfirmed).toBe(true);
    expect(
      await app.tool(token, "worker_close", { workerId: worker.id }),
    ).toMatchObject({ closed: false, closing: true });
    expect(app.snapshot().agents.some((agent) => agent.id === worker.id)).toBe(
      true,
    );
    runtime.emit(worker.id, {
      type: "disconnected",
      error: "fixture disconnected",
    });
    expect(app.detail(worker.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    expect(app.instanceBusy()).toBe(true);
    expect(
      await app.tool(token, "worker_close", { workerId: worker.id }),
    ).toMatchObject({ closed: false, closing: true });
    expect(app.snapshot().agents.some((agent) => agent.id === worker.id)).toBe(
      true,
    );
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an idle-looking unverified Orc completion cannot close its tree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-unverified-root-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "work", "first");
    runtime.emit(owner.id, {
      type: "completed",
      turnId: app.detail(owner.id).turnId!,
      status: "completed",
      verified: false,
    });
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: true,
    });
    await expect(app.closeTree(owner.id)).rejects.toThrow("still working");
    expect(app.snapshot().agents.some((agent) => agent.id === owner.id)).toBe(
      true,
    );
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unverified interruption cannot confirm Stop or establish an idle boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-stop-unverified-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "work", "first");
    const turnId = app.detail(owner.id).turnId!;
    await app.stop(owner.id, turnId);
    runtime.emit(owner.id, {
      type: "completed",
      turnId,
      status: "interrupted",
      verified: false,
    });
    expect(app.detail(owner.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
      stop: { turnId, status: "unknown" },
    });
    expect(app.detail(owner.id).lastInterrupted).toBeUndefined();
    await expect(app.closeTree(owner.id)).rejects.toThrow();
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["worker", "reviewer", "researcher"] as const)(
  "completed %s stays idle after native disconnect",
  async (role) => {
    const directory = mkdtempSync(join(tmpdir(), "grove-idle-member-"));
    const runtime = new FakeRuntime();
    const app = new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
      memberPresets: memberPresetsFixtureSync(directory),
      branches: { read: async () => null },
      reviewerSnapshot: async () => ({ prompt: "fixture" }),
      researcherSnapshot: async () => ({ prompt: "fixture" }),
    });
    try {
      const owner = await app.createOrc("alpha");
      const token = runtime.agents.get(owner.id)!.token;
      const args =
        role === "worker"
          ? {
              project: "alpha",
              title: "fixture",
              spec: "fixture",
              message: "work",
            }
          : role === "reviewer"
            ? {
                project: "alpha",
                title: "fixture",
                profile: "standards",
                spec: "fixture",
                fixedPoint: "base",
                reviewedHead: "head",
                message: "work",
              }
            : {
                project: "alpha",
                title: "fixture",
                question: "fixture question",
                message: "work",
              };
      const member = (await app.tool(token, `${role}_start`, args)) as {
        id: string;
      };
      runtime.emit(member.id, {
        type: "completed",
        turnId: app.detail(member.id).turnId!,
        status: "completed",
      });
      const threadId = app.detail(member.id).threadId;
      runtime.emit(member.id, {
        type: "disconnected",
        error: "App-server disconnected. Send a message to resume the thread.",
      });
      expect(app.detail(member.id)).toMatchObject({
        state: "idle",
        workUnconfirmed: false,
        role,
        ownerId: owner.id,
        threadId,
      });
      expect(app.detail(member.id).error).toBeUndefined();
      expect(runtime.inputs).toHaveLength(1);
    } finally {
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("shutdown does not retry an unknown Stop admission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-stop-shutdown-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "work", "first");
    const turnId = app.detail(owner.id).turnId!;
    runtime.interruptOverride = async () => {
      throw new Error("interrupt outcome unknown");
    };
    await app.stop(owner.id, turnId);
    expect(app.detail(owner.id).stop?.status).toBe("unknown");
    setTimeout(
      () =>
        runtime.emit(owner.id, {
          type: "completed",
          turnId,
          status: "interrupted",
          verified: false,
        }),
      20,
    );
    await app.prepareShutdown();
    expect(runtime.interruptions).toHaveLength(1);
    expect(app.detail(owner.id)).toMatchObject({
      workUnconfirmed: true,
      stop: { status: "unknown", turnId },
    });
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("graceful shutdown does not start a waiting follow-up when the original turn completes naturally", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-shutdown-queue-"));
  const runtime = new FakeRuntime();
  let app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "work", "first");
    const turnId = app.detail(owner.id).turnId!;
    await app.enqueueFollowUp(owner.id, "A", "queued-A");
    runtime.interruptOverride = async () =>
      runtime.emit(owner.id, {
        type: "completed",
        turnId,
        status: "completed",
      });
    await app.prepareShutdown();
    await Bun.sleep(30);
    expect(runtime.inputs.map((input) => input.text)).toEqual(["work"]);
    expect(app.lookupFollowUp(owner.id, "queued-A")?.status).toBe("waiting");
    app.dispose();
    app = new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
      memberPresets: memberPresetsFixtureSync(directory),
      branches: { read: async () => null },
    });
    expect(app.detail(owner.id).followUpPaused).toBe(true);
    expect(app.lookupFollowUp(owner.id, "queued-A")?.status).toBe("waiting");
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("graceful shutdown preserves an unknown admission and its original identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-shutdown-admission-"));
  const runtime = new FakeRuntime();
  const options = {
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  };
  let app = new Workspace(options);
  try {
    const owner = await app.createOrc("alpha");
    runtime.sendOverride = async () => {
      throw new Error("admission unknown");
    };
    await app.send(owner.id, "uncertain input", "original-operation");
    expect(
      app.detail(owner.id).deliveries.find((d) => d.id === "original-operation")
        ?.status,
    ).toBe("uncertain");
    await app.prepareShutdown();
    expect(
      runtime.inputs.filter((input) => input.clientId === "original-operation"),
    ).toHaveLength(1);
    expect(runtime.interruptions).toHaveLength(0);
    app.dispose();
    app = new Workspace(options);
    expect(
      app.detail(owner.id).deliveries.find((d) => d.id === "original-operation")
        ?.status,
    ).toBe("uncertain");
    expect(app.lookup(owner.id, "original-operation")).toBeNull();
    expect(app.recovery(owner.id, "original-operation").text).toBe(
      "uncertain input",
    );
    expect(
      runtime.inputs.filter((input) => input.clientId === "original-operation"),
    ).toHaveLength(1);
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy disconnected turn with only a delivery turn ID remains unconfirmed through later shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-legacy-disconnect-"));
  const runtime = new FakeRuntime();
  const options = {
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  };
  let app = new Workspace(options);
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "original work", "original-operation");
    const originalTurn = app.detail(owner.id).turnId!;
    runtime.emit(owner.id, {
      type: "disconnected",
      error: "App-server disconnected. Send a message to resume the thread.",
    });
    expect(app.detail(owner.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    expect(app.detail(owner.id).turnId).toBeUndefined();
    expect(app.lookup(owner.id, "original-operation")).toMatchObject({
      state: "accepted",
      turnId: originalTurn,
    });
    app.dispose();
    app = new Workspace(options);
    await Bun.sleep(10);
    await app.prepareShutdown();
    expect(app.detail(owner.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    expect(app.detail(owner.id).turnId).toBeUndefined();
    expect(app.lookup(owner.id, "original-operation")).toMatchObject({
      state: "accepted",
      turnId: originalTurn,
    });
    expect(runtime.interruptions).toHaveLength(0);
    expect(
      runtime.inputs.filter((input) => input.clientId === "original-operation"),
    ).toHaveLength(1);
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unknown start is not tied to a terminal by timing alone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-shutdown-distinct-"));
  const runtime = new FakeRuntime();
  const options = {
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  };
  let app = new Workspace(options);
  try {
    const owner = await app.createOrc("alpha");
    runtime.sendOverride = async (id) => {
      runtime.emit(id, { type: "working", turnId: "observed-turn" });
      throw new Error("admission response lost");
    };
    await app.send(owner.id, "original input", "original-operation");
    expect(
      app.detail(owner.id).deliveries.find((d) => d.id === "original-operation")
        ?.status,
    ).toBe("uncertain");
    runtime.interruptOverride = async (id, turnId) =>
      runtime.emit(id, {
        type: "completed",
        turnId,
        status: "interrupted",
        verified: true,
      });
    await app.prepareShutdown();
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: true,
      lastInterrupted: true,
    });
    expect(app.lookup(owner.id, "original-operation")).toBeNull();
    expect(
      app.detail(owner.id).deliveries.find((d) => d.id === "original-operation")
        ?.status,
    ).toBe("uncertain");
    expect(app.instanceBusy()).toBe(true);
    expect(
      runtime.inputs.filter((input) => input.clientId === "original-operation"),
    ).toHaveLength(1);
    app.dispose();
    app = new Workspace(options);
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: true,
      lastInterrupted: true,
    });
    expect(app.lookup(owner.id, "original-operation")).toBeNull();
    expect(app.recovery(owner.id, "original-operation").text).toBe(
      "original input",
    );
    await expect(app.closeTree(owner.id)).rejects.toThrow();
    expect(
      runtime.inputs.filter((input) => input.clientId === "original-operation"),
    ).toHaveLength(1);
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a verified interrupted turn stays idle through disconnect and restart with an uncertain steer", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "grove-shutdown-uncertain-steer-"),
  );
  const runtime = new FakeRuntime();
  const options = {
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  };
  let app = new Workspace(options);
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "original work", "original-operation");
    const threadId = app.detail(owner.id).threadId;
    const turnId = app.detail(owner.id).turnId!;
    runtime.sendOverride = async (_id, _text, target) => {
      expect(target).toBe(turnId);
      throw new Error("steer response lost");
    };
    await app.send(owner.id, "additional input", "uncertain-operation");
    expect(app.lookup(owner.id, "uncertain-operation")).toBeNull();
    expect(
      app.store
        .byId(owner.id)!
        .deliveries.find((d) => d.id === "uncertain-operation")?.steerEvidence,
    ).toEqual({ attemptId: "uncertain-operation", turnId });
    runtime.interruptOverride = async (id, observed) =>
      runtime.emit(id, {
        type: "completed",
        turnId: observed,
        status: "interrupted",
        verified: true,
      });
    await app.prepareShutdown();
    expect(
      app.store
        .byId(owner.id)!
        .deliveries.find((d) => d.id === "uncertain-operation")?.steerEvidence,
    ).toEqual({
      attemptId: "uncertain-operation",
      turnId,
      terminalObserved: true,
    });
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      lastInterrupted: true,
    });
    runtime.emit(owner.id, {
      type: "disconnected",
      error: "App-server disconnected. Send a message to resume the thread.",
    });
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      lastInterrupted: true,
      threadId,
    });
    app.dispose();
    app = new Workspace(options);
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      lastInterrupted: true,
      threadId,
    });
    expect(app.lookup(owner.id, "uncertain-operation")).toBeNull();
    expect(
      app
        .detail(owner.id)
        .deliveries.find((d) => d.id === "uncertain-operation")?.status,
    ).toBe("uncertain");
    expect(app.recovery(owner.id, "uncertain-operation").text).toBe(
      "additional input",
    );
    await app.reconcileSettings(owner.id);
    runtime.emit(owner.id, {
      type: "disconnected",
      error: "another disconnect after restart",
    });
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      lastInterrupted: true,
      threadId,
    });
    await expect(app.closeTree(owner.id)).rejects.toThrow();
    expect(
      runtime.inputs.filter(
        (input) => input.clientId === "uncertain-operation",
      ),
    ).toHaveLength(1);
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a terminal before an uncertain steer response preserves its verified target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-terminal-before-steer-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "original", "first");
    const turnId = app.detail(owner.id).turnId!;
    runtime.sendOverride = async (id, _text, target) => {
      expect(target).toBe(turnId);
      runtime.emit(id, {
        type: "completed",
        turnId,
        status: "interrupted",
        verified: true,
      });
      throw new Error("steer response lost");
    };
    await app.send(owner.id, "steer", "second");
    expect(
      app.store.byId(owner.id)!.deliveries.find((d) => d.id === "second")
        ?.steerEvidence,
    ).toEqual({ attemptId: "second", turnId, terminalObserved: true });
    runtime.emit(owner.id, { type: "disconnected", error: "connection lost" });
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      lastInterrupted: true,
    });
    expect(app.lookup(owner.id, "second")).toBeNull();
    await expect(app.closeTree(owner.id)).rejects.toThrow();
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pending start remains unconfirmed when another turn terminates", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "grove-pending-start-terminal-"),
  );
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<string>();
  let pending: Promise<unknown> | undefined;
  try {
    const owner = await app.createOrc("alpha");
    runtime.sendOverride = async (_id, _text, target) => {
      expect(target).toBeUndefined();
      entered.resolve();
      return response.promise;
    };
    pending = app.send(owner.id, "pending input", "pending-operation");
    await entered.promise;
    expect(
      app.detail(owner.id).deliveries.find((d) => d.id === "pending-operation")
        ?.status,
    ).toBe("sending");
    runtime.emit(owner.id, { type: "working", turnId: "other-turn" });
    runtime.emit(owner.id, {
      type: "completed",
      turnId: "other-turn",
      status: "interrupted",
      verified: true,
    });
    expect(app.detail(owner.id).workUnconfirmed).toBe(true);
    expect(app.lookup(owner.id, "pending-operation")).toBeNull();
    expect(app.instanceBusy()).toBe(true);
    response.reject(new Error("start response lost"));
    await pending;
    expect(app.detail(owner.id).workUnconfirmed).toBe(true);
    expect(app.lookup(owner.id, "pending-operation")).toBeNull();
    expect(
      runtime.inputs.filter((input) => input.clientId === "pending-operation"),
    ).toHaveLength(1);
    await expect(app.closeTree(owner.id)).rejects.toThrow();
  } finally {
    response.reject(new Error("test cleanup"));
    await pending?.catch(() => {});
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pending same-turn steer can remain idle after its verified terminal", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "grove-pending-steer-terminal-"),
  );
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<string>();
  let pending: Promise<unknown> | undefined;
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "original", "first");
    const turnId = app.detail(owner.id).turnId!;
    runtime.sendOverride = async (_id, _text, target) => {
      expect(target).toBe(turnId);
      entered.resolve();
      return response.promise;
    };
    pending = app.send(owner.id, "pending steer", "steer-operation");
    await entered.promise;
    runtime.emit(owner.id, {
      type: "completed",
      turnId,
      status: "interrupted",
      verified: true,
    });
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      lastInterrupted: true,
    });
    expect(
      app.store
        .byId(owner.id)!
        .deliveries.find((d) => d.id === "steer-operation")?.steerEvidence,
    ).toEqual({ attemptId: "steer-operation", turnId, terminalObserved: true });
    expect(app.lookup(owner.id, "steer-operation")).toBeNull();
    await expect(app.closeTree(owner.id)).rejects.toThrow();
    response.reject(new Error("steer response lost"));
    await pending;
    expect(app.detail(owner.id).workUnconfirmed).toBe(false);
    expect(app.lookup(owner.id, "steer-operation")).toBeNull();
    await expect(app.closeTree(owner.id)).rejects.toThrow();
    expect(
      runtime.inputs.filter((input) => input.clientId === "steer-operation"),
    ).toHaveLength(1);
  } finally {
    response.reject(new Error("test cleanup"));
    await pending?.catch(() => {});
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed steer evidence write never crosses the native admission seam", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-steer-evidence-write-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "original", "first");
    app.store.sqlite.exec(`CREATE TRIGGER reject_steer_evidence
      BEFORE UPDATE ON deliveries
      WHEN NEW.operation_id = 'second' AND json_extract(NEW.report, '$.steerEvidence') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'evidence write failed'); END`);
    await expect(app.send(owner.id, "steer", "second")).rejects.toThrow(
      "evidence write failed",
    );
    expect(
      runtime.inputs.filter((input) => input.clientId === "second"),
    ).toHaveLength(0);
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale steer followed by an unknown start does not reuse the old target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-stale-steer-start-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "original", "first");
    const oldTurn = app.detail(owner.id).turnId!;
    runtime.sendOverride = async (id, _text, target) => {
      if (target) {
        runtime.emit(id, {
          type: "completed",
          turnId: oldTurn,
          status: "interrupted",
          verified: true,
        });
        throw new StaleTurn("no active turn");
      }
      throw new Error("start response lost");
    };
    await app.send(owner.id, "new request", "second");
    expect(runtime.inputs.slice(-2).map((input) => input.turnId)).toEqual([
      oldTurn,
      undefined,
    ]);
    expect(
      app.store.byId(owner.id)!.deliveries.find((d) => d.id === "second")
        ?.steerEvidence,
    ).toBeUndefined();
    expect(app.lookup(owner.id, "second")).toBeNull();
    runtime.emit(owner.id, { type: "disconnected", error: "connection lost" });
    expect(app.detail(owner.id).workUnconfirmed).toBe(true);
    await expect(app.closeTree(owner.id)).rejects.toThrow();
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const kind of ["replayed", "unverified"] as const) {
  test(`${kind} terminal does not prove an uncertain steer stopped`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "grove-steer-unverified-"));
    const runtime = new FakeRuntime();
    const app = new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
      memberPresets: memberPresetsFixtureSync(directory),
      branches: { read: async () => null },
    });
    try {
      const owner = await app.createOrc("alpha");
      await app.send(owner.id, "original", "first");
      const turnId = app.detail(owner.id).turnId!;
      runtime.sendOverride = async () => {
        throw new Error("steer response lost");
      };
      await app.send(owner.id, "steer", "second");
      runtime.emit(owner.id, {
        type: "completed",
        turnId,
        status: "interrupted",
        ...(kind === "replayed" ? { replayed: true } : { verified: false }),
      });
      expect(
        app.store.byId(owner.id)!.deliveries.find((d) => d.id === "second")
          ?.steerEvidence,
      ).toEqual({ attemptId: "second", turnId });
      runtime.emit(owner.id, {
        type: "disconnected",
        error: "connection lost",
      });
      expect(app.detail(owner.id).workUnconfirmed).toBe(true);
      expect(app.lookup(owner.id, "second")).toBeNull();
      await expect(app.closeTree(owner.id)).rejects.toThrow();
    } finally {
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("stored evidence for a different attempt cannot prove an uncertain steer stopped", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "grove-steer-attempt-mismatch-"),
  );
  const runtime = new FakeRuntime();
  const options = {
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  };
  let app = new Workspace(options);
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "original", "first");
    const turnId = app.detail(owner.id).turnId!;
    runtime.sendOverride = async () => {
      throw new Error("steer response lost");
    };
    await app.send(owner.id, "steer", "second");
    runtime.emit(owner.id, {
      type: "completed",
      turnId,
      status: "interrupted",
      verified: true,
    });
    expect(
      app.store.byId(owner.id)!.deliveries.find((d) => d.id === "second")
        ?.steerEvidence,
    ).toEqual({ attemptId: "second", turnId, terminalObserved: true });
    app.dispose();
    const db = new Database(join(directory, "workspace.sqlite"));
    db.query(
      "UPDATE deliveries SET attempt_id = ? WHERE session_id = ? AND operation_id = ?",
    ).run("attempt-two", owner.id, "second");
    db.close();
    app = new Workspace(options);
    await app.reconcileSettings(owner.id);
    runtime.emit(owner.id, { type: "disconnected", error: "connection lost" });
    expect(app.detail(owner.id).workUnconfirmed).toBe(true);
    expect(app.lookup(owner.id, "second")).toBeNull();
    await expect(app.closeTree(owner.id)).rejects.toThrow();
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a terminal for another turn cannot resolve an unknown start on disconnect", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "grove-shutdown-unrelated-start-"),
  );
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    runtime.sendOverride = async () => {
      throw new Error("start response lost");
    };
    await app.send(owner.id, "unknown start", "unknown-operation");
    runtime.sendOverride = undefined;
    await app.send(owner.id, "separate work", "separate-operation");
    const turnId = app.detail(owner.id).turnId!;
    runtime.sendOverride = async () => {
      throw new Error("steer response lost");
    };
    await app.send(owner.id, "same turn steer", "steer-operation");
    runtime.interruptOverride = async (id, observed) =>
      runtime.emit(id, {
        type: "completed",
        turnId: observed,
        status: "interrupted",
        verified: true,
      });
    await app.prepareShutdown();
    expect(runtime.interruptions).toEqual([{ agentId: owner.id, turnId }]);
    expect(app.detail(owner.id).workUnconfirmed).toBe(true);
    expect(
      app.store
        .byId(owner.id)!
        .deliveries.find((d) => d.id === "steer-operation")?.steerEvidence,
    ).toEqual({ attemptId: "steer-operation", turnId, terminalObserved: true });
    runtime.emit(owner.id, { type: "disconnected", error: "connection lost" });
    expect(app.detail(owner.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    expect(app.lookup(owner.id, "unknown-operation")).toBeNull();
    expect(app.lookup(owner.id, "steer-operation")).toBeNull();
    expect(
      runtime.inputs.filter((input) => input.clientId === "unknown-operation"),
    ).toHaveLength(1);
    await expect(app.closeTree(owner.id)).rejects.toThrow();
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown observes an errored local turn when its original turn ID is still known", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-shutdown-error-turn-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  try {
    const owner = await app.createOrc("alpha");
    await app.send(owner.id, "work", "first");
    const turnId = app.detail(owner.id).turnId!;
    runtime.emit(owner.id, {
      type: "error",
      turnId,
      error: "fixture failure",
      willRetry: false,
    });
    expect(app.detail(owner.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
      turnId,
    });
    runtime.interruptOverride = async (id, observed) =>
      runtime.emit(id, {
        type: "completed",
        turnId: observed,
        status: "interrupted",
        verified: true,
      });
    await app.prepareShutdown();
    expect(runtime.interruptions).toEqual([{ agentId: owner.id, turnId }]);
    expect(app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      lastInterrupted: true,
    });
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
