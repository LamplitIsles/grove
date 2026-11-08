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
import { HostService, qualify } from "./hosts";
import { InstanceControls } from "./instance-controls";
import { createHandler } from "./http";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-blockers-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
    branches: { read: async () => null },
  });
  const origin = "http://localhost:4318";
  const service = new HostService(app, { directory, origin: () => origin });
  const auth = {
    session: async (h: Headers) =>
      h.get("cookie") === "human=fixture" ? { user: { id: "human" } } : null,
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
    voice: { configPath: join(directory, "config.toml") },
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(new Request(origin + path, { headers }));
  return {
    app,
    runtime,
    directory,
    origin,
    service,
    instance,
    get,
    cleanup() {
      service.dispose();
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("authenticated instance reasons use visible qualified identities and coexist with voice settings", async () => {
  const f = fixture();
  try {
    const a = await f.app.createOrc("alpha");
    const secret = "private-message-token-path-exception";
    f.runtime.sendOverride = async () => {
      throw new Error(secret);
    };
    await f.app.send(a.id, secret, "unknown-fixture-operation");
    f.runtime.sendOverride = undefined;
    await f.app.send(a.id, "another fixture", "active-operation");
    const turnId = f.app.detail(a.id).turnId!;
    await f.app.enqueueFollowUp(
      a.id,
      "later private text",
      "waiting-operation",
    );
    f.runtime.emit(a.id, {
      type: "item",
      turnId,
      item: {
        id: secret,
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: secret }],
      },
    });
    const headers = { origin: f.origin, cookie: "human=fixture" };
    expect(
      (
        await f.get("/api/instance", {
          origin: f.origin,
          authorization: "Bearer fake-token",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.get("/api/instance", {
          origin: "https://wrong.example",
          cookie: "human=fixture",
        })
      ).status,
    ).toBe(403);
    const response = await f.get("/api/instance", headers);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      busy: boolean;
      sessions: Array<{
        id: string;
        title: string;
        role: string;
        reasons: string[];
      }>;
      instanceReasons: string[];
    };
    const visible = f.service
      .snapshot()
      .agents.find(
        (agent) => agent.id === qualify(f.service.identity.id, a.id),
      )!;
    expect(body.busy).toBe(true);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: visible.id,
      title: visible.title,
      role: visible.role,
    });
    expect(body.sessions[0]!.reasons).toEqual(
      expect.arrayContaining(["working", "turn", "delivery_uncertain"]),
    );
    expect(body.instanceReasons).toEqual([]);
    const serialized = JSON.stringify(body);
    for (const value of [
      secret,
      "unknown-fixture-operation",
      "waiting-operation",
      f.directory,
      f.runtime.agents.get(a.id)!.token,
    ])
      expect(serialized).not.toContain(value);
    const voice = await f.get("/api/voice/settings", {
      ...headers,
      "x-grove-peer": f.service.identity.id,
    });
    expect(voice.status).toBe(200);
    expect(await voice.json()).toEqual({
      region: "beijing",
      configured: false,
    });
    expect(
      (
        await f.get("/api/voice/settings", {
          origin: f.origin,
          "x-grove-peer": f.service.identity.id,
        })
      ).status,
    ).toBe(401);
  } finally {
    f.cleanup();
  }
});

test("in-flight opening and queue are attributed while creation is instance-wide", async () => {
  const f = fixture();
  let releaseOpen!: () => void,
    opened!: () => void,
    releaseRead!: () => void,
    reading!: () => void;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const openStarted = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const open = f.runtime.open.bind(f.runtime);
  f.runtime.open = async (...args) => {
    opened();
    await openGate;
    const handle = await open(...args),
      read = handle.readSettings;
    handle.readSettings = async () => {
      reading();
      await readGate;
      return read();
    };
    return handle;
  };
  try {
    const creating = f.app.createOrc("alpha");
    await openStarted;
    let status = await f.instance.status();
    expect(status.busy).toBe(true);
    expect(status.canConfirmBusy).toBe(false);
    expect(status.instanceReasons).toContain("creating");
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]!.reasons).toContain("opening");
    releaseOpen();
    const a = await creating;
    const reconcile = f.app.reconcileSettings(a.id);
    await readStarted;
    status = await f.instance.status();
    expect(status.sessions[0]!.reasons).toContain("queue");
    expect(status.canConfirmBusy).toBe(false);
    expect(() => f.app.beginMaintenance()).toThrow("active or pending");
    expect(() => f.app.beginMaintenance(true)).toThrow("active or pending");
    releaseRead();
    await reconcile;
    status = await f.instance.status();
    expect(status.busy).toBe(false);
    expect(status.sessions).toEqual([]);
    expect(status.instanceReasons).toEqual([]);
  } finally {
    releaseOpen();
    releaseRead();
    f.cleanup();
  }
});

test("status samples reasons and busy together after manager availability completes", async () => {
  const f = fixture();
  let release!: (value: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  try {
    const a = await f.app.createOrc("alpha");
    const controls = new InstanceControls(f.app, null, {
      available: () => gate,
      request: async () => {},
    });
    const pending = controls.status();
    await f.app.send(a.id, "work", "op");
    release(true);
    const status = await pending;
    expect(status.busy).toBe(true);
    expect(status.sessions[0]?.reasons).toContain("working");
    expect(
      status.sessions.length + status.instanceReasons.length,
    ).toBeGreaterThan(0);
    expect(() => f.app.beginMaintenance()).toThrow("active or pending");
    let releaseSecond!: (value: boolean) => void;
    const secondGate = new Promise<boolean>((resolve) => {
      releaseSecond = resolve;
    });
    const second = new InstanceControls(f.app, null, {
      available: () => secondGate,
      request: async () => {},
    }).status();
    f.runtime.emit(a.id, {
      type: "completed",
      turnId: f.app.detail(a.id).turnId!,
      status: "completed",
      verified: true,
    });
    releaseSecond(true);
    const idle = await second;
    expect(idle.busy).toBe(false);
    expect(idle.sessions).toEqual([]);
    expect(idle.instanceReasons).toEqual([]);
  } finally {
    release(true);
    f.cleanup();
  }
});

test("maintenance barrier is an instance reason without a fabricated session", async () => {
  const f = fixture();
  try {
    await f.app.createOrc("alpha");
    f.app.beginMaintenance();
    const status = await f.instance.status();
    expect(status.busy).toBe(true);
    expect(status.sessions).toEqual([]);
    expect(status.instanceReasons).toEqual(["maintenance"]);
    f.app.endMaintenance();
    expect((await f.instance.status()).busy).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("delivery being sent is distinct from waiting and uncertain delivery", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const a = await f.app.createOrc("alpha");
    f.runtime.sendOverride = async () => {
      entered();
      await gate;
      return "fixture-turn";
    };
    const sending = f.app.send(a.id, "work", "operation");
    await started;
    const status = await f.instance.status();
    expect(status.busy).toBe(true);
    expect(status.sessions[0]!.reasons).toEqual(
      expect.arrayContaining(["delivery_sending", "queue"]),
    );
    expect(status.sessions[0]!.reasons).not.toContain("delivery_uncertain");
    release();
    await sending;
  } finally {
    release();
    f.cleanup();
  }
});

test("multiple sessions and stop outcomes retain their own reasons", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const orc = await f.app.createOrc("alpha");
    const worker = (await f.app.tool(
      f.runtime.agents.get(orc.id)!.token,
      "worker_start",
      {
        project: "alpha",
        title: "fixture worker",
        spec: "fixture",
        message: "work",
      },
    )) as { id: string };
    await f.app.send(orc.id, "work", "operation");
    f.runtime.interruptOverride = async () => {
      entered();
      await gate;
      throw new Error("unknown fixture stop");
    };
    const stopping = f.app.stop(orc.id, f.app.detail(orc.id).turnId!);
    await started;
    let state = await f.instance.status();
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.find((s) => s.id === orc.id)?.reasons).toEqual(
      expect.arrayContaining(["stopping", "turn", "stop_pending"]),
    );
    expect(state.sessions.find((s) => s.id === worker.id)?.reasons).toEqual(
      expect.arrayContaining(["working", "turn"]),
    );
    release();
    await stopping;
    state = await f.instance.status();
    expect(state.sessions.find((s) => s.id === orc.id)?.reasons).toContain(
      "stop_unknown",
    );
    expect(state.busy).toBe(true);
  } finally {
    release();
    f.cleanup();
  }
});

test("tree actions and close are attributed to their real owner", async () => {
  const f = fixture();
  let releaseModels!: () => void,
    enteredModels!: () => void,
    releaseClose!: () => void,
    enteredClose!: () => void;
  const modelGate = new Promise<void>((resolve) => {
    releaseModels = resolve;
  });
  const modelStarted = new Promise<void>((resolve) => {
    enteredModels = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const closeStarted = new Promise<void>((resolve) => {
    enteredClose = resolve;
  });
  try {
    const a = await f.app.createOrc("alpha");
    const models = f.runtime.models.bind(f.runtime);
    f.runtime.models = async () => {
      enteredModels();
      await modelGate;
      return models();
    };
    const updating = f.app.updateTreeFast(a.id, false);
    await modelStarted;
    let state = await f.instance.status();
    expect(state.sessions.find((s) => s.id === a.id)?.reasons).toContain(
      "tree_action",
    );
    expect(state.canConfirmBusy).toBe(false);
    expect(() => f.app.beginMaintenance(true)).toThrow("active or pending");
    expect(state.instanceReasons).not.toContain("tree_action");
    releaseModels();
    await updating;
    let unattributedClose = false;
    const unsubscribe = f.app.subscribe(() => {
      const activity = f.app.instanceActivity();
      if (
        activity.busy &&
        activity.sessions.length === 0 &&
        activity.instanceReasons.includes("tree_closing")
      )
        unattributedClose = true;
    });
    f.runtime.closeOverride = async () => {
      enteredClose();
      await closeGate;
    };
    const closing = f.app.closeTree(a.id);
    await closeStarted;
    state = await f.instance.status();
    expect(state.sessions.find((s) => s.id === a.id)?.reasons).toContain(
      "tree_closing",
    );
    expect(state.canConfirmBusy).toBe(false);
    expect(() => f.app.beginMaintenance(true)).toThrow("active or pending");
    expect(state.busy).toBe(true);
    releaseClose();
    await closing;
    unsubscribe();
    expect(unattributedClose).toBe(true);
    expect((await f.instance.status()).busy).toBe(false);
  } finally {
    releaseModels();
    releaseClose();
    f.cleanup();
  }
});

test("automatic follow-up inspection retains unknown admission and blocks maintenance", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const enteredCheck = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const a = await f.app.createOrc("alpha");
    await f.app.send(a.id, "first", "first");
    const turnId = f.app.detail(a.id).turnId!;
    await f.app.enqueueFollowUp(a.id, "unknown input", "unknown");
    await f.app.enqueueFollowUp(a.id, "later", "later");
    f.runtime.sendOverride = async (_id, _text, _turn, startOnly) => {
      if (startOnly) throw new Error("fixture lost admission");
      return "ordinary";
    };
    f.runtime.inspectOverride = async () => {
      entered();
      await gate;
      return { accepted: false, settled: false };
    };
    f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
    for (
      let i = 0;
      i < 500 && f.app.lookupFollowUp(a.id, "unknown")?.status !== "uncertain";
      i++
    )
      await Bun.sleep(2);
    expect(f.app.lookupFollowUp(a.id, "unknown")?.status).toBe("uncertain");
    await Promise.race([
      enteredCheck,
      Bun.sleep(2500).then(() => {
        throw new Error("automatic inspection did not start");
      }),
    ]);
    const status = await f.instance.status();
    expect(status.busy).toBe(true);
    expect(status.sessions[0]!.reasons).toEqual(
      expect.arrayContaining(["queue", "delivery_uncertain"]),
    );
    expect(() => f.app.beginMaintenance()).toThrow("active or pending");
    expect(
      f.runtime.inputs.filter((input) => input.clientId === "unknown"),
    ).toHaveLength(1);
    release();
    for (
      let i = 0;
      i < 100 &&
      f.app.instanceActivity().sessions[0]?.reasons.includes("queue");
      i++
    )
      await Bun.sleep(2);
    expect(f.app.lookupFollowUp(a.id, "unknown")?.status).toBe("uncertain");
    expect(f.app.instanceBusy()).toBe(true);
    expect(
      f.runtime.inputs.filter((input) => input.clientId === "unknown"),
    ).toHaveLength(1);
  } finally {
    release();
    f.cleanup();
  }
});
