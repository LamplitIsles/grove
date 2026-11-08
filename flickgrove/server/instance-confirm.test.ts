import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixtureSync,
} from "./testing";
import { HostService } from "./hosts";
import { InstanceControls } from "./instance-controls";
import { createHandler } from "./http";

function gate() {
  let release!: () => void, enter!: () => void;
  const waiting = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (enter = r));
  return { release, enter, waiting, entered };
}
function fixture(
  runtime = new FakeRuntime(),
  manager = { available: async () => true, request: async () => {} },
) {
  const directory = mkdtempSync(join(tmpdir(), "grove-confirm-"));
  const options = {
    directory,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  };
  let app = new Workspace({ ...options, runtime });
  let service: HostService;
  let controls: InstanceControls;
  const origin = "http://localhost:4318";
  let handler: ReturnType<typeof createHandler>;
  function setup() {
    service = new HostService(app, { directory, origin: () => origin });
    controls = new InstanceControls(app, null, manager);
    const auth = {
      session: async (h: Headers) =>
        h.get("cookie") === "human=fixture"
          ? { user: { id: "fixture" } }
          : null,
    } as unknown as import("./auth").GroveAuth;
    handler = createHandler(app, {
      service,
      instance: controls,
      auth,
      origin: () => origin,
    });
  }
  setup();
  return {
    get app() {
      return app;
    },
    get controls() {
      return controls;
    },
    runtime,
    async restart() {
      service.dispose();
      await runtime.close();
      app.dispose();
      app = new Workspace({ ...options, runtime });
      setup();
      for (
        let i = 0;
        i < 300 &&
        app
          .instanceActivity()
          .sessions.some(
            (s) => s.reasons.includes("opening") || s.reasons.includes("queue"),
          );
        i++
      )
        await Bun.sleep(2);
    },
    request(
      path: string,
      opts: {
        method?: string;
        body?: string;
        origin?: string;
        cookie?: string;
      } = {},
    ) {
      return handler(
        new Request(origin + path, {
          method: opts.method ?? "GET",
          headers: {
            origin: opts.origin ?? origin,
            cookie: opts.cookie ?? "human=fixture",
          },
          body: opts.body,
        }),
      );
    },
    cleanup() {
      service.dispose();
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const reload = "/api/instance/mcp/reload",
  restart = "/api/instance/restart";
const confirmation = (id: string) =>
  JSON.stringify({ confirmBusy: true, instanceId: id });
async function status(f: ReturnType<typeof fixture>) {
  return (await (await f.request("/api/instance")).json()) as {
    id: string;
    busy: boolean;
    canConfirmBusy: boolean;
    sessions: { id: string; reasons: string[] }[];
  };
}

test("HTTP confirmation covers current work only with explicit valid instance identity", async () => {
  const f = fixture();
  try {
    const a = await f.app.createOrc("alpha");
    expect(await status(f)).toMatchObject({
      busy: false,
      canConfirmBusy: false,
    });
    await f.app.send(a.id, "work", "first");
    const s = await status(f);
    expect(s).toMatchObject({ busy: true, canConfirmBusy: true });
    for (const path of [reload, restart]) {
      for (const body of [
        undefined,
        "{}",
        JSON.stringify({ confirmBusy: false, instanceId: s.id }),
        confirmation("wrong"),
        JSON.stringify({ confirmBusy: true, instanceId: s.id, extra: true }),
        "{",
      ]) {
        expect((await f.request(path, { method: "POST", body })).status).toBe(
          400,
        );
      }
      expect(
        (
          await f.request(path, {
            method: "POST",
            body: confirmation(s.id),
            cookie: "wrong",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await f.request(path, {
            method: "POST",
            body: confirmation(s.id),
            origin: "https://wrong.example",
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await f.request(reload, { method: "POST", body: confirmation(s.id) }))
        .status,
    ).toBe(200);
    expect(f.app.detail(a.id).state).toBe("working");
  } finally {
    f.cleanup();
  }
});

test("confirmed reload holds barrier, records events and resumes deferred question reports", async () => {
  const g = gate();
  class Runtime extends FakeRuntime {
    async reloadMcp() {
      g.enter();
      await g.waiting;
    }
  }
  const f = fixture(new Runtime());
  try {
    const owner = await f.app.createOrc("alpha");
    const token = f.runtime.agents.get(owner.id)!.token;
    const worker = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "worker",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    const turn = f.app.detail(worker.id).turnId!;
    const s = await status(f);
    const action = f.request(reload, {
      method: "POST",
      body: confirmation(s.id),
    });
    await g.entered;
    expect(await status(f)).toMatchObject({
      busy: true,
      canConfirmBusy: false,
    });
    await expect(f.app.send(owner.id, "new", "new")).rejects.toThrow(
      "maintenance",
    );
    await expect(f.app.createOrc("beta")).rejects.toThrow("maintenance");
    expect(
      (await f.request(reload, { method: "POST", body: confirmation(s.id) }))
        .status,
    ).toBe(400);
    f.runtime.emit(worker.id, {
      type: "item",
      turnId: turn,
      item: {
        id: "ask",
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: "Keep?" }],
      },
    });
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: turn,
      status: "completed",
      verified: true,
    });
    expect(f.app.detail(worker.id).questions[0]!.id).toBe("ask:0");
    expect(f.app.detail(owner.id).deliveries.at(-1)?.status).toBe("queued");
    expect(f.runtime.inputs.filter((i) => i.agentId === owner.id)).toHaveLength(
      0,
    );
    g.release();
    expect((await action).status).toBe(200);
    for (
      let i = 0;
      i < 200 && !f.runtime.inputs.some((input) => input.agentId === owner.id);
      i++
    )
      await Bun.sleep(2);
    expect(f.runtime.inputs.filter((i) => i.agentId === owner.id)).toHaveLength(
      1,
    );
    expect(f.app.detail(worker.id).questions[0]!.state).toBe("delegated");
  } finally {
    g.release();
    f.cleanup();
  }
});

test("confirmed restart keeps barrier after unknown manager outcome and never replays on reconstruction", async () => {
  const g = gate();
  let calls = 0;
  const f = fixture(new FakeRuntime(), {
    available: async () => {
      g.enter();
      await g.waiting;
      return true;
    },
    request: async () => {
      calls++;
      throw new Error("unknown manager response");
    },
  });
  try {
    const a = await f.app.createOrc("alpha");
    await f.app.send(a.id, "work", "first");
    const turn = f.app.detail(a.id).turnId!;
    f.runtime.emit(a.id, {
      type: "item",
      turnId: turn,
      item: {
        id: "ask",
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: "Proceed?" }],
      },
    });
    await f.app.enqueueFollowUp(a.id, "later", "later");
    const action = f.request(restart, {
      method: "POST",
      body: confirmation(f.controls.id),
    });
    await g.entered;
    await expect(f.app.send(a.id, "new", "new")).rejects.toThrow("maintenance");
    expect(
      (
        await f.request(reload, {
          method: "POST",
          body: confirmation(f.controls.id),
        })
      ).status,
    ).toBe(400);
    g.release();
    expect(await (await action).json()).toEqual({ status: "unknown" });
    expect(calls).toBe(1);
    expect(
      (
        await f.request(restart, {
          method: "POST",
          body: confirmation(f.controls.id),
        })
      ).status,
    ).toBe(400);
    await f.restart();
    expect(f.app.detail(a.id).questions[0]).toMatchObject({
      id: "ask:0",
      state: "unanswered",
    });
    expect(f.app.detail(a.id).followUpPaused).toBe(true);
    expect(f.app.lookupFollowUp(a.id, "later")).toMatchObject({
      id: "later",
      status: "waiting",
      text: "later",
    });
    expect(f.runtime.inputs.map((i) => i.clientId)).toEqual(["first"]);
  } finally {
    g.release();
    f.cleanup();
  }
});

test("in-flight stateful send and Stop are hard blockers even with confirmation", async () => {
  const sendGate = gate(),
    stopGate = gate();
  const f = fixture();
  try {
    const a = await f.app.createOrc("alpha");
    f.runtime.sendOverride = async () => {
      sendGate.enter();
      await sendGate.waiting;
      return "turn";
    };
    const sending = f.app.send(a.id, "work", "first");
    await sendGate.entered;
    let s = await status(f);
    expect(s).toMatchObject({ busy: true, canConfirmBusy: false });
    expect(s.sessions[0]!.reasons).toContain("queue");
    expect(
      (await f.request(reload, { method: "POST", body: confirmation(s.id) }))
        .status,
    ).toBe(400);
    sendGate.release();
    await sending;
    f.runtime.interruptOverride = async () => {
      stopGate.enter();
      await stopGate.waiting;
    };
    const stopping = f.app.stop(a.id, "turn");
    await stopGate.entered;
    s = await status(f);
    expect(s).toMatchObject({ busy: true, canConfirmBusy: false });
    expect(
      (await f.request(restart, { method: "POST", body: confirmation(s.id) }))
        .status,
    ).toBe(400);
    stopGate.release();
    await stopping;
    expect(await status(f)).toMatchObject({ busy: true, canConfirmBusy: true });
    expect(
      (await f.request(reload, { method: "POST", body: confirmation(s.id) }))
        .status,
    ).toBe(200);
  } finally {
    sendGate.release();
    stopGate.release();
    f.cleanup();
  }
});

test("Pi pending Stop becomes unknown after confirmed restart and retains original identity", async () => {
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
  const f = fixture(runtime, {
    available: async () => true,
    request: async () => {},
  });
  try {
    const a = await f.app.createOrc("alpha");
    await f.app.send(a.id, "work", "first");
    const turn = f.app.detail(a.id).turnId!;
    await f.app.enqueueFollowUp(a.id, "later", "later");
    await f.app.stop(a.id, turn);
    expect(f.app.detail(a.id).stop).toMatchObject({
      turnId: turn,
      status: "pending",
    });
    expect(await status(f)).toMatchObject({ busy: true, canConfirmBusy: true });
    expect(
      await (
        await f.request(restart, {
          method: "POST",
          body: confirmation(f.controls.id),
        })
      ).json(),
    ).toEqual({ status: "unknown" });
    await f.restart();
    expect(f.app.detail(a.id).stop).toMatchObject({
      turnId: turn,
      status: "unknown",
    });
    expect(f.app.detail(a.id).followUpPaused).toBe(true);
    expect(f.app.lookupFollowUp(a.id, "later")).toMatchObject({
      id: "later",
      status: "waiting",
    });
    expect(runtime.inputs.map((i) => i.clientId)).toEqual(["first"]);
  } finally {
    f.cleanup();
  }
});

test("Pi reload returns partial or unknown rather than claiming a failed replacement is untouched", async () => {
  class Runtime extends FakeRuntime {
    outcomes = new Map<string, "partial" | "unknown">();
    async models() {
      return (await super.models()).map((model) => ({
        ...model,
        backend: "pi" as const,
        provider: "fixture",
      }));
    }
    async open(...args: Parameters<FakeRuntime["open"]>) {
      const handle = await super.open(...args);
      handle.reloadMcp = async () => {
        if (this.outcomes.get(args[0].id) === "unknown")
          throw new Error("replacement outcome unknown");
        return { issues: ["old connection could not be closed"] };
      };
      return handle;
    }
  }
  const runtime = new Runtime();
  const f = fixture(runtime);
  try {
    const a = await f.app.createOrc("alpha");
    const b = await f.app.createOrc("beta");
    runtime.outcomes.set(a.id, "partial");
    runtime.outcomes.set(b.id, "unknown");
    await f.app.send(a.id, "work", "first");
    const response = await f.request(reload, {
      method: "POST",
      body: confirmation(f.controls.id),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: expect.arrayContaining([
        { backend: "pi", session: a.id, status: "partial" },
        { backend: "pi", session: b.id, status: "partial_or_unknown" },
      ]),
    });
  } finally {
    f.cleanup();
  }
});

test("automatic child closure waits for the reload barrier and then continues", async () => {
  const g = gate();
  class Runtime extends FakeRuntime {
    async reloadMcp() {
      g.enter();
      await g.waiting;
    }
  }
  const f = fixture(new Runtime());
  try {
    const owner = await f.app.createOrc("alpha");
    const token = f.runtime.agents.get(owner.id)!.token;
    const worker = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "worker",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    const turn = f.app.detail(worker.id).turnId!;
    expect(
      await f.app.tool(token, "worker_close", { workerId: worker.id }),
    ).toMatchObject({ closing: true });
    const action = f.request(reload, {
      method: "POST",
      body: confirmation(f.controls.id),
    });
    await g.entered;
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: turn,
      status: "completed",
      verified: true,
    });
    await Bun.sleep(10);
    expect(f.app.snapshot().agents.some((a) => a.id === worker.id)).toBe(true);
    g.release();
    expect((await action).status).toBe(200);
    for (
      let i = 0;
      i < 200 && f.app.snapshot().agents.some((a) => a.id === worker.id);
      i++
    )
      await Bun.sleep(2);
    expect(f.app.snapshot().agents.some((a) => a.id === worker.id)).toBe(false);
  } finally {
    g.release();
    f.cleanup();
  }
});

test("unknown delivery stays inspectable and is never automatically replayed after confirmed restart", async () => {
  const runtime = new FakeRuntime();
  const f = fixture(runtime);
  try {
    const a = await f.app.createOrc("alpha");
    runtime.sendOverride = async () => {
      throw new Error("admission unknown");
    };
    await f.app.send(a.id, "unknown input", "original");
    expect(f.app.detail(a.id).deliveries[0]).toMatchObject({
      id: "original",
      status: "uncertain",
    });
    expect(await status(f)).toMatchObject({ busy: true, canConfirmBusy: true });
    expect(
      await (
        await f.request(restart, {
          method: "POST",
          body: confirmation(f.controls.id),
        })
      ).json(),
    ).toEqual({ status: "unknown" });
    runtime.sendOverride = undefined;
    await f.restart();
    expect(f.app.detail(a.id).deliveries[0]).toMatchObject({
      id: "original",
      status: "uncertain",
    });
    expect(
      runtime.inputs.filter((i) => i.clientId === "original"),
    ).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test("persistence failure and disposed workspace cannot be forced", async () => {
  const f = fixture();
  try {
    const a = await f.app.createOrc("alpha");
    f.app.store.sqlite.exec(
      "CREATE TRIGGER reject_fixture BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
    );
    await expect(f.app.send(a.id, "work", "op")).rejects.toThrow();
    expect(await status(f)).toMatchObject({
      busy: true,
      canConfirmBusy: false,
    });
    expect(
      (
        await f.request(reload, {
          method: "POST",
          body: confirmation(f.controls.id),
        })
      ).status,
    ).toBe(400);
    f.app.dispose();
    expect(await status(f)).toMatchObject({
      busy: true,
      canConfirmBusy: false,
    });
    expect(
      (
        await f.request(restart, {
          method: "POST",
          body: confirmation(f.controls.id),
        })
      ).status,
    ).toBe(400);
  } finally {
    f.cleanup();
  }
});

test("restart does not call manager if an admitted native event encounters a write failure", async () => {
  const g = gate();
  let calls = 0;
  const f = fixture(new FakeRuntime(), {
    available: async () => {
      g.enter();
      await g.waiting;
      return true;
    },
    request: async () => {
      calls++;
    },
  });
  try {
    const a = await f.app.createOrc("alpha");
    await f.app.send(a.id, "work", "first");
    const turn = f.app.detail(a.id).turnId!;
    const action = f.request(restart, {
      method: "POST",
      body: confirmation(f.controls.id),
    });
    await g.entered;
    f.app.store.sqlite.exec(
      "CREATE TRIGGER reject_event BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
    );
    expect(() =>
      f.runtime.emit(a.id, {
        type: "completed",
        turnId: turn,
        status: "completed",
        verified: true,
      }),
    ).toThrow();
    g.release();
    expect((await action).status).toBe(400);
    expect(calls).toBe(0);
    expect(await status(f)).toMatchObject({
      busy: true,
      canConfirmBusy: false,
    });
  } finally {
    g.release();
    f.cleanup();
  }
});

test("question arriving during restart retains its forwarding identity as unknown without replay", async () => {
  const g = gate();
  const f = fixture(new FakeRuntime(), {
    available: async () => {
      g.enter();
      await g.waiting;
      return true;
    },
    request: async () => {},
  });
  try {
    const owner = await f.app.createOrc("alpha");
    const token = f.runtime.agents.get(owner.id)!.token;
    const worker = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "worker",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    const turn = f.app.detail(worker.id).turnId!;
    const action = f.request(restart, {
      method: "POST",
      body: confirmation(f.controls.id),
    });
    await g.entered;
    f.runtime.emit(worker.id, {
      type: "item",
      turnId: turn,
      item: {
        id: "ask-during",
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: "Keep?" }],
      },
    });
    const report = f.app.detail(owner.id).deliveries.at(-1)!;
    expect(report).toMatchObject({
      status: "queued",
      reportingWorkerId: worker.id,
    });
    expect(f.runtime.inputs.filter((i) => i.agentId === owner.id)).toHaveLength(
      0,
    );
    g.release();
    expect(await (await action).json()).toEqual({ status: "unknown" });
    await f.restart();
    expect(f.app.detail(worker.id).questions[0]).toMatchObject({
      id: "ask-during:0",
      state: "delegated",
    });
    expect(
      f.app.detail(owner.id).deliveries.find((d) => d.id === report.id),
    ).toMatchObject({
      id: report.id,
      reportingWorkerId: worker.id,
      status: "uncertain",
    });
    expect(f.runtime.inputs.filter((i) => i.agentId === owner.id)).toHaveLength(
      0,
    );
  } finally {
    g.release();
    f.cleanup();
  }
});
