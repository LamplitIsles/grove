import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { HostService } from "./hosts";
import { InstanceControls } from "./instance-controls";
import { createHandler } from "./http";
import { DeliveryRejected } from "./runtime";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-pi-terminal-"));
  const runtime = new FakeRuntime();
  let assertEnvironment = async () => {};
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
  const options = {
    directory,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
    environments: {
      assert: () => assertEnvironment(),
    } as unknown as import("./project-environments").ProjectEnvironments,
  };
  let app = new Workspace(options);
  let service: HostService | undefined;
  const origin = "http://localhost:4318";
  function http() {
    service?.dispose();
    service = new HostService(app, { directory, origin: () => origin });
    const instance = new InstanceControls(app, null, {
      available: async () => false,
      request: async () => {},
    });
    const auth = {
      session: async () => ({ user: { id: "fixture" } }),
    } as unknown as import("./auth").GroveAuth;
    const handler = createHandler(app, {
      service,
      instance,
      auth,
      origin: () => origin,
    });
    return (path: string, method = "GET") =>
      handler(new Request(origin + path, { method, headers: { origin } }));
  }
  return {
    runtime,
    setAssertEnvironment(assert: () => Promise<void>) {
      assertEnvironment = assert;
    },
    get app() {
      return app;
    },
    get service() {
      return service!;
    },
    http,
    async recreate() {
      service?.dispose();
      service = undefined;
      await runtime.close();
      app.dispose();
      app = new Workspace(options);
      for (
        let i = 0;
        i < 300 &&
        (runtime.listeners.size < app.snapshot().agents.length ||
          app
            .instanceActivity()
            .sessions.some(
              (s) =>
                s.reasons.includes("queue") || s.reasons.includes("opening"),
            ));
        i++
      )
        await Bun.sleep(2);
    },
    cleanup() {
      service?.dispose();
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a rejected pre-send project check retains verified member failure across recreation", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const token = f.runtime.agents.get(owner.id)!.token;
    const worker = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "worker",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: f.app.detail(worker.id).turnId!,
      status: "failed",
      verified: true,
      error: "confirmed failure",
    });
    f.setAssertEnvironment(async () => {
      throw new Error("project unavailable");
    });
    const result = (await f.app.tool(token, "worker_send", {
      workerId: worker.id,
      message: "rejected before send",
    })) as ReturnType<Workspace["detail"]>;
    expect(result.workUnconfirmed).toBe(false);
    expect(result.deliveries.at(-1)).toMatchObject({ status: "failed" });
    expect(
      f.runtime.inputs.filter((i) => i.agentId === worker.id),
    ).toHaveLength(1);
    expect(
      f.app.instanceActivity().sessions.find((s) => s.id === worker.id)
        ?.reasons,
    ).toContain("delivery_failed");
    f.setAssertEnvironment(async () => {});
    await f.recreate();
    expect(f.app.detail(worker.id)).toMatchObject({
      state: "error",
      workUnconfirmed: false,
      error: "confirmed failure",
    });
    expect(
      f.app.instanceActivity().sessions.find((s) => s.id === worker.id)
        ?.reasons,
    ).toContain("delivery_failed");
    expect((await f.http()("/api/instance/restart", "POST")).status).toBe(400);
    expect(
      f.runtime.inputs.filter((i) => i.agentId === worker.id),
    ).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test("a native event during a rejected project check prevents restoring terminal evidence", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const token = f.runtime.agents.get(owner.id)!.token;
    const worker = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "worker",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: f.app.detail(worker.id).turnId!,
      status: "failed",
      verified: true,
    });
    let entered!: () => void;
    let rejectCheck!: (error: Error) => void;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.setAssertEnvironment(() => {
      entered();
      return new Promise<void>((_resolve, reject) => {
        rejectCheck = reject;
      });
    });
    const sending = f.app.tool(token, "worker_send", {
      workerId: worker.id,
      message: "not sent",
    });
    await checking;
    f.runtime.emit(worker.id, {
      type: "submission",
      turnId: "other-turn",
      operationId: "other-input",
      status: "queued",
    });
    rejectCheck(new Error("project unavailable"));
    await sending;
    expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
    expect(
      f.app.instanceActivity().sessions.find((s) => s.id === worker.id)
        ?.reasons,
    ).toContain("delivery_failed");
    f.setAssertEnvironment(async () => {});
    await f.recreate();
    expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
    expect(f.app.instanceBusy()).toBe(true);
    expect(
      f.runtime.inputs.filter((i) => i.agentId === worker.id),
    ).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

for (const rejected of [true, false])
  test(`${rejected ? "a rejected" : "an unknown"} send never restores old terminal evidence or replays`, async () => {
    const f = fixture();
    try {
      const owner = await f.app.createOrc("alpha");
      const token = f.runtime.agents.get(owner.id)!.token;
      const worker = (await f.app.tool(token, "worker_start", {
        project: "alpha",
        title: "worker",
        spec: "fixture",
        message: "work",
      })) as { id: string };
      f.runtime.emit(worker.id, {
        type: "completed",
        turnId: f.app.detail(worker.id).turnId!,
        status: "failed",
        verified: true,
      });
      f.runtime.sendOverride = async () => {
        throw rejected
          ? new DeliveryRejected("rejected")
          : new Error("unknown");
      };
      await f.app.tool(token, "worker_send", {
        workerId: worker.id,
        message: "new work",
      });
      const delivery = f.app.detail(worker.id).deliveries.at(-1)!;
      expect(delivery.status).toBe(rejected ? "failed" : "uncertain");
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
      expect(
        f.runtime.inputs.filter((i) => i.clientId === delivery.id),
      ).toHaveLength(1);
      const inputs = f.runtime.inputs.filter(
        (i) => i.agentId === worker.id,
      ).length;
      f.runtime.sendOverride = undefined;
      await f.recreate();
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
      expect(
        f.app.detail(worker.id).deliveries.find((d) => d.id === delivery.id)
          ?.status,
      ).toBe(rejected ? "failed" : "uncertain");
      expect(f.app.instanceBusy()).toBe(true);
      expect(
        f.runtime.inputs.filter((i) => i.agentId === worker.id),
      ).toHaveLength(inputs);
      expect(
        f.runtime.inputs.filter((i) => i.clientId === delivery.id),
      ).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });

test("a verified Pi Worker failure remains stopped and permits maintenance after recreation", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const token = f.runtime.agents.get(owner.id)!.token;
    const worker = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "worker",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: f.app.detail(worker.id).turnId!,
      status: "failed",
      verified: true,
      error: "terminal fixture failure",
    });
    for (const phase of ["initial", "recreated"]) {
      if (phase === "recreated") await f.recreate();
      const fetch = f.http();
      expect(f.app.detail(worker.id)).toMatchObject({
        state: "error",
        workUnconfirmed: false,
        error: "terminal fixture failure",
      });
      expect(
        f.service.snapshot().agents.find((a) => a.id.endsWith(`:${worker.id}`)),
      ).toMatchObject({ state: "error", workUnconfirmed: false });
      expect(f.app.detail(worker.id)).not.toHaveProperty(
        "piMemberTerminalVerified",
      );
      expect(await (await fetch("/api/instance")).json()).toMatchObject({
        busy: false,
        sessions: [],
      });
      expect((await fetch("/api/instance/mcp/reload", "POST")).status).toBe(
        200,
      );
      expect((await fetch("/api/instance/restart", "POST")).status).toBe(200);
    }
    expect(
      f.runtime.inputs.filter((i) => i.agentId === worker.id),
    ).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

for (const status of ["queued", "placed", "done", "unanswered"] as const)
  test(`a new ${status} native submission revokes a previous verified terminal boundary`, async () => {
    const f = fixture();
    try {
      const owner = await f.app.createOrc("alpha");
      const worker = (await f.app.tool(
        f.runtime.agents.get(owner.id)!.token,
        "worker_start",
        { project: "alpha", title: "worker", spec: "fixture", message: "work" },
      )) as { id: string };
      f.runtime.emit(worker.id, {
        type: "completed",
        turnId: f.app.detail(worker.id).turnId!,
        status: "failed",
        verified: true,
      });
      expect(f.app.instanceBusy()).toBe(false);
      f.runtime.emit(worker.id, {
        type: "submission",
        turnId: "new-turn",
        operationId: "other-input",
        status,
      });
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
      expect(f.app.instanceBusy()).toBe(true);
      await f.recreate();
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
      expect(f.app.instanceBusy()).toBe(true);
    } finally {
      f.cleanup();
    }
  });

for (const verified of [false, undefined])
  test(`an unverified completion (${verified}) for another observed turn revokes old terminal evidence`, async () => {
    const f = fixture();
    try {
      const owner = await f.app.createOrc("alpha");
      const worker = (await f.app.tool(
        f.runtime.agents.get(owner.id)!.token,
        "worker_start",
        { project: "alpha", title: "worker", spec: "fixture", message: "work" },
      )) as { id: string };
      f.runtime.emit(worker.id, {
        type: "completed",
        turnId: f.app.detail(worker.id).turnId!,
        status: "failed",
        verified: true,
      });
      f.runtime.emit(worker.id, {
        type: "completed",
        turnId: "unknown-turn",
        status: "failed",
        verified,
      });
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
      expect(f.app.instanceBusy()).toBe(true);
      await f.recreate();
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
    } finally {
      f.cleanup();
    }
  });

test("a verified interruption is stopped while an unverified one stays guarded", async () => {
  for (const verified of [true, false, undefined]) {
    const f = fixture();
    try {
      const owner = await f.app.createOrc("alpha");
      const worker = (await f.app.tool(
        f.runtime.agents.get(owner.id)!.token,
        "worker_start",
        { project: "alpha", title: "worker", spec: "fixture", message: "work" },
      )) as { id: string };
      f.runtime.emit(worker.id, {
        type: "completed",
        turnId: f.app.detail(worker.id).turnId!,
        status: "interrupted",
        verified,
      });
      for (const phase of ["initial", "recreated"]) {
        if (phase === "recreated") await f.recreate();
        const fetch = f.http();
        expect(f.app.detail(worker.id)).toMatchObject({
          state: "error",
          workUnconfirmed: verified !== true,
        });
        expect(await (await fetch("/api/instance")).json()).toMatchObject({
          busy: verified !== true,
        });
        for (const path of [
          "/api/instance/mcp/reload",
          "/api/instance/restart",
        ])
          expect((await fetch(path, "POST")).status).toBe(
            verified === true ? 200 : 400,
          );
      }
      expect(
        f.runtime.inputs.filter((i) => i.agentId === worker.id),
      ).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  }
});

test("legacy Pi member error without terminal evidence remains guarded after recreation", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const worker = (await f.app.tool(
      f.runtime.agents.get(owner.id)!.token,
      "worker_start",
      { project: "alpha", title: "worker", spec: "fixture", message: "work" },
    )) as { id: string };
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: f.app.detail(worker.id).turnId!,
      status: "failed",
      verified: true,
    });
    // Construct a pre-feature record in this fixture's own database.
    f.app.store.sqlite.run(
      "UPDATE sessions SET recovery=json_remove(recovery, '$.piMemberTerminalVerified') WHERE id=?",
      [worker.id],
    );
    await f.recreate();
    expect(f.app.detail(worker.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    expect(f.app.instanceBusy()).toBe(true);
    expect((await f.http()("/api/instance/restart", "POST")).status).toBe(400);
  } finally {
    f.cleanup();
  }
});

test("other working members and unconfirmed deliveries still block a verified Pi failure", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const token = f.runtime.agents.get(owner.id)!.token;
    const first = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "first",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    const second = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "second",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    f.runtime.emit(first.id, {
      type: "completed",
      turnId: f.app.detail(first.id).turnId!,
      status: "failed",
      verified: true,
    });
    const fetch = f.http();
    const status = (await (await fetch("/api/instance")).json()) as {
      busy: boolean;
      sessions: { id: string; reasons: string[] }[];
    };
    expect(status.busy).toBe(true);
    expect(
      status.sessions.some(
        (s) => s.id.endsWith(`:${second.id}`) && s.reasons.includes("working"),
      ),
    ).toBe(true);
    expect((await fetch("/api/instance/mcp/reload", "POST")).status).toBe(400);
    f.runtime.emit(second.id, {
      type: "completed",
      turnId: f.app.detail(second.id).turnId!,
      status: "completed",
      verified: true,
    });
    f.runtime.sendOverride = async () => {
      throw new Error("unknown admission");
    };
    await f.app.send(owner.id, "unknown", "unknown-operation");
    expect(f.app.detail(first.id).workUnconfirmed).toBe(false);
    expect(
      f.app
        .detail(owner.id)
        .deliveries.find((d) => d.id === "unknown-operation")?.status,
    ).toBe("uncertain");
    expect((await fetch("/api/instance/restart", "POST")).status).toBe(400);
    await f.recreate();
    expect(
      f.runtime.inputs.filter((i) => i.clientId === "unknown-operation"),
    ).toHaveLength(1);
    expect(f.app.instanceBusy()).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("new work and disconnection invalidate verified evidence across restart without replay", async () => {
  for (const cause of ["working", "disconnected", "unknown-send"] as const) {
    const f = fixture();
    try {
      const owner = await f.app.createOrc("alpha");
      const token = f.runtime.agents.get(owner.id)!.token;
      const worker = (await f.app.tool(token, "worker_start", {
        project: "alpha",
        title: "worker",
        spec: "fixture",
        message: "work",
      })) as { id: string };
      f.runtime.emit(worker.id, {
        type: "completed",
        turnId: f.app.detail(worker.id).turnId!,
        status: "failed",
        verified: true,
      });
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(false);
      if (cause === "working") {
        f.runtime.emit(worker.id, { type: "working", turnId: "next-turn" });
        f.runtime.emit(worker.id, {
          type: "completed",
          turnId: "next-turn",
          status: "failed",
          verified: false,
        });
      } else if (cause === "disconnected") {
        f.runtime.emit(worker.id, {
          type: "disconnected",
          error: "fixture disconnect",
        });
      } else {
        f.runtime.sendOverride = async () => {
          throw new Error("unknown admission");
        };
        await f.app.tool(token, "worker_send", {
          workerId: worker.id,
          message: "new work",
        });
      }
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
      expect(f.app.instanceBusy()).toBe(true);
      const inputs = f.runtime.inputs.length;
      f.runtime.sendOverride = undefined;
      await f.recreate();
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
      expect(f.app.instanceBusy()).toBe(true);
      expect(f.runtime.inputs).toHaveLength(inputs);
    } finally {
      f.cleanup();
    }
  }
});

test("a verified failure for another turn cannot establish terminal evidence", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const worker = (await f.app.tool(
      f.runtime.agents.get(owner.id)!.token,
      "worker_start",
      { project: "alpha", title: "worker", spec: "fixture", message: "work" },
    )) as { id: string };
    const active = f.app.detail(worker.id).turnId!;
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: "different-turn",
      status: "failed",
      verified: true,
    });
    expect(f.app.detail(worker.id)).toMatchObject({
      state: "working",
      turnId: active,
      workUnconfirmed: true,
    });
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: active,
      status: "failed",
      verified: false,
    });
    expect(f.app.detail(worker.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    await f.recreate();
    expect(f.app.instanceBusy()).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("verified and unverified terminal events preserve existing member close behavior", async () => {
  for (const verified of [true, false]) {
    const f = fixture();
    try {
      const owner = await f.app.createOrc("alpha");
      const token = f.runtime.agents.get(owner.id)!.token;
      const worker = (await f.app.tool(token, "worker_start", {
        project: "alpha",
        title: "worker",
        spec: "fixture",
        message: "work",
      })) as { id: string };
      f.runtime.emit(worker.id, {
        type: "completed",
        turnId: f.app.detail(worker.id).turnId!,
        status: "failed",
        verified,
      });
      expect(
        await f.app.tool(token, "worker_close", { workerId: worker.id }),
      ).toMatchObject({ closed: true });
    } finally {
      f.cleanup();
    }
  }
});

test("an unreplayed item from another turn invalidates the old terminal boundary", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const worker = (await f.app.tool(
      f.runtime.agents.get(owner.id)!.token,
      "worker_start",
      { project: "alpha", title: "worker", spec: "fixture", message: "work" },
    )) as { id: string };
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: f.app.detail(worker.id).turnId!,
      status: "failed",
      verified: true,
    });
    f.runtime.emit(worker.id, {
      type: "item",
      turnId: "new-turn",
      item: { id: "new-item", type: "agentMessage", text: "new work" },
    });
    expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
    await f.recreate();
    expect(f.app.instanceBusy()).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("a verified completion for a different turn cannot reuse an earlier terminal boundary", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const worker = (await f.app.tool(
      f.runtime.agents.get(owner.id)!.token,
      "worker_start",
      { project: "alpha", title: "worker", spec: "fixture", message: "work" },
    )) as { id: string };
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: f.app.detail(worker.id).turnId!,
      status: "failed",
      verified: true,
    });
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId: "unmatched-turn",
      status: "failed",
      verified: true,
    });
    expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
    await f.recreate();
    expect(f.app.instanceBusy()).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("disconnected member close still needs explicit interrupted confirmation", async () => {
  const f = fixture();
  try {
    const owner = await f.app.createOrc("alpha");
    const token = f.runtime.agents.get(owner.id)!.token;
    const worker = (await f.app.tool(token, "worker_start", {
      project: "alpha",
      title: "worker",
      spec: "fixture",
      message: "work",
    })) as { id: string };
    await expect(
      f.app.tool(token, "worker_close", {
        workerId: worker.id,
        confirmInterrupted: true,
      }),
    ).rejects.toThrow();
    f.runtime.emit(worker.id, {
      type: "disconnected",
      error: "fixture disconnected",
    });
    expect(
      await f.app.tool(token, "worker_close", { workerId: worker.id }),
    ).toMatchObject({ closed: false, closing: true });
    expect(
      await f.app.tool(token, "worker_close", {
        workerId: worker.id,
        confirmInterrupted: true,
      }),
    ).toMatchObject({ closed: true });
  } finally {
    f.cleanup();
  }
});

for (const kind of ["error", "progress"] as const)
  test(`a new ${kind} for an unobserved turn invalidates old evidence`, async () => {
    const f = fixture();
    try {
      const owner = await f.app.createOrc("alpha");
      const worker = (await f.app.tool(
        f.runtime.agents.get(owner.id)!.token,
        "worker_start",
        { project: "alpha", title: "worker", spec: "fixture", message: "work" },
      )) as { id: string };
      f.runtime.emit(worker.id, {
        type: "completed",
        turnId: f.app.detail(worker.id).turnId!,
        status: "failed",
        verified: true,
      });
      f.runtime.emit(
        worker.id,
        kind === "error"
          ? {
              type: "error",
              turnId: "new-turn",
              error: "unconfirmed",
              willRetry: false,
            }
          : { type: "progress", turnId: "new-turn" },
      );
      expect(f.app.detail(worker.id).workUnconfirmed).toBe(true);
      await f.recreate();
      expect(f.app.instanceBusy()).toBe(true);
    } finally {
      f.cleanup();
    }
  });
