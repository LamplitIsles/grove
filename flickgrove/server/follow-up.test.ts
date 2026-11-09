import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { DeliveryRejected, StaleTurn } from "./runtime";
import { HostService } from "./hosts";
import { invoke } from "./chord-methods";
import { detailSchema, deliverySchema } from "../src/chord-contract";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
function fixture(backend: "codex" | "pi" = "codex") {
  const directory = mkdtempSync(join(tmpdir(), "grove-follow-up-test-"));
  const runtime = new FakeRuntime();
  if (backend === "pi")
    runtime.models = async () => [
      {
        id: "sol",
        name: "Sol",
        backend: "pi",
        provider: "fixture",
        efforts: ["medium"],
        defaultEffort: "medium",
        isDefault: true,
        fastTier: null,
      },
    ];
  const options = { directory, runtime, projects: async () => fixtureProjects };
  let app = new Workspace(options);
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
  );
  return {
    runtime,
    directory,
    get app() {
      return app;
    },
    restart() {
      app.dispose();
      app = new Workspace(options);
      return app;
    },
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for follow-up");
}

test("subscribed conversations retain inspected follow-up text and images when the native item arrives late", async () => {
  const f = fixture();
  const service = new HostService(f.app, {
    directory: f.directory,
    origin: () => "http://fixture",
  });
  const a = await f.app.createOrc("alpha");
  const qualified = `${service.identity.id}:${a.id}`;
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const images = await f.app.images.upload(a.id, "original", "original text", [
    new File([bytes], "picture.png", { type: "image/png" }),
  ]);
  const observed: Promise<Awaited<ReturnType<typeof service.detail>>>[][] = [
    [],
    [],
  ];
  const subscriptions = observed.map((views) =>
    service.subscribe(() => {
      views.push(service.detail(qualified));
    }),
  );
  try {
    await Promise.all(
      observed.map(async (views) => {
        views.push(service.detail(qualified));
        await views[0];
      }),
    );
    await f.app.enqueueFollowUp(a.id, "original text", "original", images);
    f.runtime.sendOverride = async () => {
      throw new Error("admission unknown");
    };
    f.runtime.inspectOverride = async (_id, operationId) => {
      expect(operationId).toBe("original");
      return {
        accepted: true,
        settled: true,
        completed: true,
        turnId: "native-original",
      };
    };
    f.runtime.emit(a.id, {
      type: "completed",
      turnId: first,
      status: "completed",
    });
    await until(
      () => f.app.lookupFollowUp(a.id, "original")?.status === "uncertain",
    );
    for (const views of observed) {
      const detail = await views.at(-1)!;
      expect(
        detail.followUps?.find((item) => item.id === "original")?.status,
      ).toBe("uncertain");
      expect(
        detail.messages.some((message) => message.clientId === "original"),
      ).toBe(false);
    }
    expect(
      f.runtime.inputs.filter((input) => input.clientId === "original"),
    ).toHaveLength(1);
    await until(
      () => f.app.lookupFollowUp(a.id, "original")?.status === "sent",
    );
    for (const views of observed) {
      const detail = await views.at(-1)!;
      expect(detail.followUps?.some((item) => item.id === "original")).toBe(
        false,
      );
      const messages = detail.messages.filter(
        (message) => message.clientId === "original",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        text: "original text",
        images: [{ id: images[0].id }],
      });
    }
    await service.synchronizeDetail(qualified);
    for (const views of observed) {
      const detail = await views.at(-1)!;
      const messages = detail.messages.filter(
        (message) => message.clientId === "original",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        text: "original text",
        images: [{ id: images[0].id }],
      });
    }
    f.runtime.emit(a.id, {
      type: "item",
      turnId: "native-original",
      item: {
        type: "userMessage",
        id: "native-item",
        clientId: "original",
        text: "original text",
      },
    });
    for (const views of observed) {
      const detail = await views.at(-1)!;
      const messages = detail.messages.filter(
        (message) => message.clientId === "original",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "native-item",
        text: "original text",
        images: [{ id: images[0].id }],
      });
    }
    expect(
      f.runtime.inputs.filter((input) => input.clientId === "original"),
    ).toHaveLength(1);
  } finally {
    subscriptions.forEach((unsubscribe) => unsubscribe());
  }
});

test("automatic inspection confirms the original operation but leaves the queue paused", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "uncertain", "original");
  await f.app.enqueueFollowUp(a.id, "later", "later");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  const checks: string[] = [];
  f.runtime.inspectOverride = async (_id, operationId) => {
    checks.push(operationId);
    return checks.length === 1
      ? { accepted: false, settled: false }
      : {
          accepted: true,
          settled: true,
          completed: true,
          turnId: "native-original",
        };
  };
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "completed",
  });
  await until(
    () => f.app.lookupFollowUp(a.id, "original")?.status === "uncertain",
  );
  f.runtime.sendOverride = undefined;
  await until(() => checks.length === 1);
  expect(f.app.lookupFollowUp(a.id, "original")?.status).toBe("uncertain");
  await Bun.sleep(500);
  expect(checks).toEqual(["original"]);
  for (
    let i = 0;
    i < 300 && f.app.lookupFollowUp(a.id, "original")?.status !== "sent";
    i++
  )
    await Bun.sleep(10);
  expect(checks).toEqual(["original", "original"]);
  expect(f.app.lookupFollowUp(a.id, "original")?.status).toBe("sent");
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("waiting");
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  await f.app.send(a.id, "B", "B");
  const b = f.app.detail(a.id).turnId!;
  f.runtime.emit(a.id, { type: "completed", turnId: b, status: "completed" });
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("waiting");
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  await f.app.resumeFollowUps(a.id);
  await until(() => f.app.lookupFollowUp(a.id, "later")?.status === "sent");
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("sent");
  expect(
    f.runtime.inputs.filter((x) => x.clientId === "original"),
  ).toHaveLength(1);
});

test("restart reconciles the original operation but retains a pause without in-process proof", async () => {
  const f = fixture("pi");
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "unknown", "original");
  await f.app.enqueueFollowUp(a.id, "later", "later");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "completed",
  });
  await until(
    () => f.app.lookupFollowUp(a.id, "original")?.status === "uncertain",
  );
  f.restart();
  f.runtime.sendOverride = undefined;
  f.runtime.inspectOverride = async (_id, operationId) => {
    expect(operationId).toBe("original");
    return {
      accepted: true,
      settled: true,
      completed: true,
      turnId: "native-original",
    };
  };
  await until(() => f.app.lookupFollowUp(a.id, "original")?.status === "sent");
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("waiting");
  await f.app.resumeFollowUps(a.id);
  await until(() => f.app.lookupFollowUp(a.id, "later")?.status === "sent");
  expect(
    f.runtime.inputs.filter((x) => x.clientId === "original"),
  ).toHaveLength(1);
});

test("Stop during inspection preserves the paused queue even after native confirmation", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "unknown", "original");
  await f.app.enqueueFollowUp(a.id, "later", "later");
  f.runtime.sendOverride = async () => {
    f.runtime.emit(a.id, { type: "working", turnId: "native-original" });
    throw new Error("unknown");
  };
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.runtime.inspectOverride = async () => {
    entered = true;
    await gate;
    return {
      accepted: true,
      settled: true,
      completed: true,
      turnId: "native-original",
    };
  };
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "completed",
  });
  await until(() => entered);
  await f.app.stop(a.id, "native-original");
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: "native-original",
    status: "interrupted",
  });
  release();
  await Bun.sleep(50);
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("waiting");
  expect(
    f.runtime.inputs.filter((x) => x.clientId === "original"),
  ).toHaveLength(1);
});

test("terminal native failure confirms admission but does not automatically continue", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "unknown", "original");
  await f.app.enqueueFollowUp(a.id, "later", "later");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  f.runtime.inspectOverride = async () => ({
    accepted: true,
    settled: true,
    completed: false,
    turnId: "native-original",
  });
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "completed",
  });
  await until(() => f.app.lookupFollowUp(a.id, "original")?.status === "sent");
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("waiting");
  expect(
    f.runtime.inputs.filter((x) => x.clientId === "original"),
  ).toHaveLength(1);
});

test("admission without a settled turn stays visible and protects the remaining queue", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "unknown", "original");
  await f.app.enqueueFollowUp(a.id, "later", "later");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  f.runtime.inspectOverride = async () => ({
    accepted: true,
    settled: false,
    turnId: "native-original",
  });
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "completed",
  });
  await until(() => f.app.lookupFollowUp(a.id, "original")?.status === "sent");
  expect(
    f.app.detail(a.id).followUps?.find((d) => d.id === "original")?.status,
  ).toBe("sent");
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("waiting");
  await expect(f.app.resumeFollowUps(a.id)).rejects.toThrow();
  await expect(f.app.cancelFollowUp(a.id, "original")).rejects.toThrow();
  expect(
    f.runtime.inputs.filter((x) => x.clientId === "original"),
  ).toHaveLength(1);
});

test("a new enqueue queued during claim revokes automatic continuation", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "unknown", "original");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "completed",
  });
  await f.app.enqueueFollowUp(a.id, "new", "new");
  expect(f.app.lookupFollowUp(a.id, "original")?.status).toBe("uncertain");
  f.runtime.inspectOverride = async () => ({
    accepted: true,
    settled: true,
    completed: true,
    turnId: "native-original",
  });
  await until(() => f.app.lookupFollowUp(a.id, "original")?.status === "sent");
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  expect(f.app.lookupFollowUp(a.id, "new")?.status).toBe("waiting");
});

test("Codex waits for an existing handle without opening or resending the unknown operation", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "unknown", "original");
  await f.app.enqueueFollowUp(a.id, "later", "later");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "completed",
  });
  await until(
    () => f.app.lookupFollowUp(a.id, "original")?.status === "uncertain",
  );
  let opens = 0;
  const open = f.runtime.open.bind(f.runtime);
  f.runtime.open = async (...args) => {
    opens++;
    return open(...args);
  };
  f.runtime.emit(a.id, { type: "disconnected", error: "offline" });
  let checks = 0;
  f.runtime.inspectOverride = async (_id, operationId) => {
    checks++;
    expect(operationId).toBe("original");
    return {
      accepted: true,
      settled: true,
      completed: true,
      turnId: "native-original",
    };
  };
  await Bun.sleep(1200);
  expect(opens).toBe(0);
  expect(checks).toBe(0);
  expect(f.app.lookupFollowUp(a.id, "original")?.status).toBe("uncertain");
  f.runtime.sendOverride = undefined;
  await f.app.send(a.id, "explicit new message", "new-message");
  const newTurn = f.app.detail(a.id).turnId!;
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: newTurn,
    status: "completed",
  });
  for (
    let i = 0;
    i < 300 && f.app.lookupFollowUp(a.id, "original")?.status !== "sent";
    i++
  )
    await Bun.sleep(10);
  expect(opens).toBe(1);
  expect(checks).toBe(1);
  expect(f.app.lookupFollowUp(a.id, "original")?.status).toBe("sent");
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("waiting");
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  expect(
    f.runtime.inputs.filter((x) => x.clientId === "original"),
  ).toHaveLength(1);
});

test("Pi inspects without a handle or reopening execution and retains the paused queue", async () => {
  const f = fixture("pi");
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "first", "first");
  const first = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "unknown", "original");
  await f.app.enqueueFollowUp(a.id, "later", "later");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "completed",
  });
  await until(
    () => f.app.lookupFollowUp(a.id, "original")?.status === "uncertain",
  );
  let opens = 0;
  let passiveChecks = 0;
  const open = f.runtime.open.bind(f.runtime);
  const inspect = f.runtime.inspectFollowUp.bind(f.runtime);
  f.runtime.open = async (...args) => {
    opens++;
    return open(...args);
  };
  f.runtime.inspectFollowUp = (...args) => {
    passiveChecks++;
    return inspect(...args);
  };
  f.runtime.inspectOverride = async (_id, operationId) => {
    expect(operationId).toBe("original");
    return {
      accepted: true,
      settled: true,
      completed: true,
      turnId: "native-original",
    };
  };
  f.runtime.emit(a.id, { type: "disconnected", error: "offline" });
  await until(() => f.app.lookupFollowUp(a.id, "original")?.status === "sent");
  expect(passiveChecks).toBe(1);
  expect(opens).toBe(0);
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  expect(f.app.lookupFollowUp(a.id, "later")?.status).toBe("waiting");
  expect(
    f.runtime.inputs.filter((x) => x.clientId === "original"),
  ).toHaveLength(1);
});

for (const backend of ["codex", "pi"] as const) {
  test(`${backend}: FIFO waits for completed turns while steer remains immediate`, async () => {
    const { app, runtime } = fixture(backend);
    const a = await app.createOrc("alpha");
    await app.send(a.id, "first", "first");
    const first = app.detail(a.id).turnId!;
    await app.enqueueFollowUp(a.id, "next", "q1");
    await app.enqueueFollowUp(a.id, "last", "q2");
    runtime.emit(a.id, { type: "progress", turnId: first });
    runtime.emit(a.id, {
      type: "item",
      turnId: first,
      item: { id: "answer-fragment", type: "agentMessage", text: "not done" },
    });
    await app.send(a.id, "steer", "steer");
    expect(runtime.inputs.map((x) => x.text)).toEqual(["first", "steer"]);
    expect(runtime.inputs[1].turnId).toBe(first);
    expect(app.detail(a.id).followUps?.map((d) => d.status)).toEqual([
      "waiting",
      "waiting",
    ]);
    runtime.emit(a.id, {
      type: "completed",
      turnId: first,
      status: "completed",
      verified: true,
    });
    await until(() => app.lookupFollowUp(a.id, "q1")?.status === "sent");
    expect(runtime.inputs.map((x) => x.text)).toEqual([
      "first",
      "steer",
      "next",
    ]);
    expect(runtime.inputs[2]).toMatchObject({
      clientId: "q1",
      startOnly: true,
    });
    expect(runtime.inputs[2].turnId).toBeUndefined();
    expect(app.lookupFollowUp(a.id, "q2")?.status).toBe("waiting");
    runtime.emit(a.id, {
      type: "completed",
      turnId: app.detail(a.id).turnId!,
      status: "completed",
      verified: true,
    });
    await until(() => app.lookupFollowUp(a.id, "q2")?.status === "sent");
    expect(runtime.inputs.map((x) => x.text)).toEqual([
      "first",
      "steer",
      "next",
      "last",
    ]);
    expect(app.detail(a.id).messages.map((m) => m.text)).toContain("next");
  });
}

test("cancellation is serialized and leaves an idempotent tombstone; sessions are isolated", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha"),
    b = await app.createOrc("beta");
  await app.send(a.id, "working", "initial");
  const turnId = app.detail(a.id).turnId!;
  const [created, cancelled] = await Promise.all([
    app.enqueueFollowUp(a.id, "body", "op"),
    app.cancelFollowUp(a.id, "op"),
  ]);
  expect(created.followUps?.[0].status).toBe("waiting");
  expect(cancelled.followUps).toEqual([]);
  expect(app.lookupFollowUp(a.id, "op")?.status).toBe("cancelled");
  expect(app.lookupFollowUp(b.id, "op")).toBeNull();
  await app.enqueueFollowUp(a.id, "body", "op");
  await expect(app.enqueueFollowUp(a.id, "different", "op")).rejects.toThrow(
    "bound",
  );
  runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await Bun.sleep(20);
  expect(runtime.inputs).toHaveLength(1);
  expect(app.userMessageOutline(a.id).map((x) => x.operation)).toEqual([
    "initial",
  ]);
});

test("Stop retains queue paused and Close cannot discard it", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "working", "initial");
  const turnId = app.detail(a.id).turnId!;
  await app.enqueueFollowUp(a.id, "after", "after");
  await app.stop(a.id, turnId);
  runtime.emit(a.id, { type: "completed", turnId, status: "interrupted" });
  expect(app.detail(a.id)).toMatchObject({
    state: "idle",
    followUpPaused: true,
    followUpCount: 1,
  });
  await expect(app.closeTree(a.id)).rejects.toThrow();
  await Bun.sleep(20);
  expect(runtime.inputs).toHaveLength(1);
  await app.resumeFollowUps(a.id);
  await until(() => app.lookupFollowUp(a.id, "after")?.status === "sent");
  expect(app.detail(a.id).followUpCount).toBe(0);
});

test("removing the last paused follow-up clears its summary and permits idle close", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "working", "initial");
  const turnId = app.detail(a.id).turnId!;
  await app.enqueueFollowUp(a.id, "after", "after");
  await app.stop(a.id, turnId);
  runtime.emit(a.id, { type: "completed", turnId, status: "interrupted" });
  await expect(app.closeTree(a.id)).rejects.toThrow();
  await app.cancelFollowUp(a.id, "after");
  expect(
    app.snapshot().agents.find((agent) => agent.id === a.id),
  ).toMatchObject({
    state: "idle",
    followUpCount: 0,
  });
  expect(app.lookupFollowUp(a.id, "after")?.status).toBe("cancelled");
  await app.closeTree(a.id);
  expect(runtime.inputs.map((input) => input.clientId)).toEqual(["initial"]);
});

test("a fresh queue drains after Stop and removal when no inspection candidate remains", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "first", "first");
  const first = app.detail(a.id).turnId!;
  await app.enqueueFollowUp(a.id, "remove", "remove");
  await app.stop(a.id, first);
  runtime.emit(a.id, {
    type: "completed",
    turnId: first,
    status: "interrupted",
  });
  await app.cancelFollowUp(a.id, "remove");
  await app.send(a.id, "new run", "new-run");
  const second = app.detail(a.id).turnId!;
  await app.enqueueFollowUp(a.id, "new queue", "new-queue");
  expect(app.detail(a.id).followUpPaused).toBe(false);
  runtime.emit(a.id, {
    type: "completed",
    turnId: second,
    status: "completed",
  });
  await until(() => app.lookupFollowUp(a.id, "new-queue")?.status === "sent");
  expect(runtime.inputs.map((input) => input.clientId)).toEqual([
    "first",
    "new-run",
    "new-queue",
  ]);
});

test("a rejected follow-up remains active and blocks close until removed", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "working", "initial");
  const turnId = app.detail(a.id).turnId!;
  await app.enqueueFollowUp(a.id, "after", "after");
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("busy");
  };
  runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await until(() => app.lookupFollowUp(a.id, "after")?.status === "failed");
  expect(app.detail(a.id)).toMatchObject({ state: "idle", followUpCount: 1 });
  await expect(app.closeTree(a.id)).rejects.toThrow();
  await expect(app.closeTree(a.id, ["after"])).rejects.toThrow();
  await app.cancelFollowUp(a.id, "after");
  expect(app.detail(a.id).followUpCount).toBe(0);
  await app.closeTree(a.id);
});

test("a sole unknown follow-up cannot be abandoned on close or replayed", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "initial");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "after", "after");
  f.runtime.sendOverride = async () => {
    throw new Error("admission unknown");
  };
  f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await until(
    () => f.app.lookupFollowUp(a.id, "after")?.status === "uncertain",
  );
  expect(f.app.detail(a.id).followUpCount).toBe(1);
  await expect(f.app.closeTree(a.id)).rejects.toThrow();
  await expect(f.app.closeTree(a.id, ["after"])).rejects.toThrow();
  f.restart();
  await until(() => f.runtime.listeners.has(a.id));
  await Bun.sleep(30);
  expect(f.app.detail(a.id).followUpCount).toBe(1);
  expect(f.app.lookupFollowUp(a.id, "after")?.status).toBe("uncertain");
  expect(
    f.runtime.inputs.filter((input) => input.clientId === "after"),
  ).toHaveLength(1);
});

test("start-only stale, rejection and unknown pause the FIFO without steering or replay", async () => {
  for (const problem of [
    new StaleTurn("new turn", "other"),
    new DeliveryRejected("busy"),
    new Error("connection lost"),
  ]) {
    const f = fixture();
    const a = await f.app.createOrc("alpha");
    await f.app.send(a.id, "working", "initial");
    const turnId = f.app.detail(a.id).turnId!;
    await f.app.enqueueFollowUp(a.id, "q1", "q1");
    await f.app.enqueueFollowUp(a.id, "q2", "q2");
    f.runtime.sendOverride = async (_id, _text, _turn, startOnly) => {
      if (startOnly) throw problem;
      return "ordinary";
    };
    f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
    await until(() =>
      ["failed", "uncertain"].includes(
        f.app.lookupFollowUp(a.id, "q1")!.status,
      ),
    );
    expect(f.app.lookupFollowUp(a.id, "q1")?.status).toBe(
      problem instanceof Error &&
        !(problem instanceof StaleTurn) &&
        !(problem instanceof DeliveryRejected)
        ? "uncertain"
        : "failed",
    );
    expect(f.app.lookupFollowUp(a.id, "q2")?.status).toBe("waiting");
    expect(f.runtime.inputs.filter((x) => x.clientId === "q1")).toHaveLength(1);
    expect(f.runtime.inputs.at(-1)?.turnId).toBeUndefined();
    await expect(f.app.resumeFollowUps(a.id)).rejects.toThrow();
    if (f.app.lookupFollowUp(a.id, "q1")?.status === "uncertain") {
      await expect(f.app.cancelFollowUp(a.id, "q1")).rejects.toThrow();
      await expect(f.app.closeTree(a.id, ["q1"])).rejects.toThrow();
      const before = f.runtime.inputs.length;
      f.restart();
      await Bun.sleep(30);
      expect(f.runtime.inputs).toHaveLength(before);
      expect(f.app.lookupFollowUp(a.id, "q1")?.status).toBe("uncertain");
    }
  }
});

test("restart and disconnected or unverified Pi completion cannot invent an idle boundary", async () => {
  for (const backend of ["codex", "pi"] as const) {
    const f = fixture(backend);
    const a = await f.app.createOrc("alpha");
    await f.app.send(a.id, "working", "initial");
    const turnId = f.app.detail(a.id).turnId!;
    await f.app.enqueueFollowUp(a.id, "next", "next");
    f.restart();
    await until(() => f.runtime.listeners.has(a.id));
    if (backend === "pi")
      f.runtime.emit(a.id, {
        type: "completed",
        turnId,
        status: "completed",
        verified: false,
        replayed: true,
      });
    await Bun.sleep(30);
    expect(f.runtime.inputs.map((x) => x.text)).toEqual(["working"]);
    expect(f.app.detail(a.id).followUpPaused).toBe(true);
    await expect(f.app.resumeFollowUps(a.id)).rejects.toThrow();
  }
});

test("queued images are committed before admission and survive temporary upload cleanup", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "working", "initial");
  const turnId = app.detail(a.id).turnId!;
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const images = await app.images.upload(a.id, "image-q", "caption", [
    new File([bytes], "x.png", { type: "image/png" }),
  ]);
  await app.enqueueFollowUp(a.id, "caption", "image-q", images);
  app.images.cleanup(Date.now() + 48 * 60 * 60 * 1000);
  expect(app.images.read(a.id, images[0].id, false)).not.toBeNull();
  runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await until(() => app.lookupFollowUp(a.id, "image-q")?.status === "sent");
  expect(runtime.inputs.at(-1)?.images).toHaveLength(1);
});

test("a rejected follow-up can be cancelled before the paused FIFO is explicitly resumed", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "first");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "rejected", "bad");
  await f.app.enqueueFollowUp(a.id, "remaining", "good");
  f.runtime.sendOverride = async (_id, _text, _turn, startOnly) => {
    if (startOnly) throw new DeliveryRejected("busy");
    return "unused";
  };
  f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await until(() => f.app.lookupFollowUp(a.id, "bad")?.status === "failed");
  await f.app.cancelFollowUp(a.id, "bad");
  f.runtime.sendOverride = undefined;
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  await f.app.resumeFollowUps(a.id);
  await until(() => f.app.lookupFollowUp(a.id, "good")?.status === "sent");
});

test("restart after persisted completion pauses waiting work until Continue", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "first");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "next", "next");
  f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  f.restart(); // Completion was committed; queued claim has not crossed admission.
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  expect(f.app.lookupFollowUp(a.id, "next")?.status).toBe("waiting");
  expect(f.runtime.inputs.map((x) => x.text)).toEqual(["working"]);
  await f.app.resumeFollowUps(a.id);
  await until(() => f.app.lookupFollowUp(a.id, "next")?.status === "sent");
  expect(f.runtime.inputs.map((x) => x.text)).toEqual(["working", "next"]);
});

test.each(["stop", "restart", "failed"] as const)(
  "direct input runs before a queue paused by %s, which remains paused until Continue",
  async (reason) => {
    const f = fixture();
    const a = await f.app.createOrc("alpha");
    await f.app.send(a.id, "initial", "initial");
    const first = f.app.detail(a.id).turnId!;
    await f.app.enqueueFollowUp(a.id, "A", "A");
    if (reason === "stop") await f.app.stop(a.id, first);
    f.runtime.emit(a.id, {
      type: "completed",
      turnId: first,
      status:
        reason === "stop"
          ? "interrupted"
          : reason === "failed"
            ? "failed"
            : "completed",
    });
    if (reason === "restart") f.restart();
    expect(f.app.detail(a.id).followUpPaused).toBe(true);
    await f.app.send(a.id, "B", "B");
    const second = f.app.detail(a.id).turnId!;
    f.runtime.emit(a.id, {
      type: "completed",
      turnId: second,
      status: "completed",
    });
    await Bun.sleep(30);
    expect(f.app.lookupFollowUp(a.id, "A")?.status).toBe("waiting");
    expect(f.app.detail(a.id).followUpPaused).toBe(true);
    expect(f.runtime.inputs.map((input) => input.text)).toEqual([
      "initial",
      "B",
    ]);
    await f.app.resumeFollowUps(a.id);
    await until(() => f.app.lookupFollowUp(a.id, "A")?.status === "sent");
    expect(f.runtime.inputs.map((input) => input.text)).toEqual([
      "initial",
      "B",
      "A",
    ]);
  },
);

test("cancel racing with claimed admission cannot retract or duplicate it", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "first");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "next", "next");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.runtime.sendOverride = async (_id, _text, _turn, startOnly) => {
    if (startOnly) {
      await gate;
      return "next-turn";
    }
    return "unused";
  };
  f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await until(() => f.app.lookupFollowUp(a.id, "next")?.status === "sending");
  const cancel = f.app.cancelFollowUp(a.id, "next");
  release();
  await expect(cancel).rejects.toThrow("started or its admission is unknown");
  expect(f.app.lookupFollowUp(a.id, "next")?.status).toBe("sent");
  expect(f.runtime.inputs.filter((x) => x.clientId === "next")).toHaveLength(1);
});

test("Chord follow-up methods expose qualified state and original operation lookup", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  const service = new HostService(f.app, {
    directory: f.directory,
    origin: () => "http://fixture",
  });
  const id = `${service.identity.id}:${a.id}`;
  await f.app.send(a.id, "working", "first");
  const queued = detailSchema.parse(
    await invoke(service, "enqueueFollowUp", {
      id,
      operationId: "queue",
      text: "queued body",
    }),
  );
  expect(queued.id).toBe(id);
  expect(queued.followUps?.[0]).toMatchObject({
    id: "queue",
    mode: "follow_up",
    status: "waiting",
    text: "queued body",
  });
  expect(
    deliverySchema.parse(
      await invoke(service, "lookupFollowUp", { id, operationId: "queue" }),
    ),
  ).toMatchObject({ text: "queued body", status: "waiting" });
  await invoke(service, "cancelFollowUp", { id, operationId: "queue" });
  expect(
    deliverySchema.parse(
      await invoke(service, "lookupFollowUp", { id, operationId: "queue" }),
    ).status,
  ).toBe("cancelled");
});

test("a new run observed during claim never turns a follow-up into a steer", async () => {
  const f = fixture("pi");
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "first");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "next", "next");
  let injected = false;
  const off = f.app.subscribe(() => {
    if (!injected && f.app.lookupFollowUp(a.id, "next")?.status === "sending") {
      injected = true;
      f.runtime.emit(a.id, { type: "working", turnId: "competing-turn" });
    }
  });
  f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await until(() => f.app.lookupFollowUp(a.id, "next")?.status === "failed");
  off();
  expect(f.runtime.inputs.map((x) => x.text)).toEqual(["working"]);
  expect(f.app.detail(a.id).turnId).toBe("competing-turn");
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
});

test("verified Pi recovery completion drains waiting work once", async () => {
  const f = fixture("pi");
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "first");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "next", "next");
  f.restart();
  await until(() => f.runtime.listeners.has(a.id));
  f.runtime.emit(a.id, {
    type: "completed",
    turnId,
    status: "completed",
    verified: true,
    replayed: true,
    recoveredActivityAt: Date.now(),
  });
  await until(() => f.app.lookupFollowUp(a.id, "next")?.status === "sent");
  expect(f.runtime.inputs.map((x) => x.text)).toEqual(["working", "next"]);
});

test("a failed run pauses its waiting queue until explicitly continued", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "first");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "next", "next");
  f.runtime.emit(a.id, {
    type: "error",
    turnId,
    error: "failed",
    willRetry: false,
  });
  f.runtime.emit(a.id, {
    type: "completed",
    turnId,
    status: "failed",
    error: "failed",
  });
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  expect(f.app.lookupFollowUp(a.id, "next")?.status).toBe("waiting");
  await f.app.resumeFollowUps(a.id);
  await until(() => f.app.lookupFollowUp(a.id, "next")?.status === "sent");
  expect(f.runtime.inputs.map((x) => x.text)).toEqual(["working", "next"]);
});

test("a failed durable claim never crosses the provider boundary", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "first");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "next", "next");
  const db = new Database(join(f.directory, "workspace.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER reject_followup_claim BEFORE UPDATE ON deliveries WHEN NEW.operation_id='next' AND NEW.status='sending' BEGIN SELECT RAISE(ABORT,'claim failed'); END",
    );
    f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
    await until(() => {
      try {
        f.app.detail(a.id);
        return false;
      } catch {
        return true;
      }
    });
    expect(f.runtime.inputs.map((x) => x.text)).toEqual(["working"]);
    expect(
      db.query("SELECT status FROM deliveries WHERE operation_id='next'").get(),
    ).toEqual({ status: "waiting" });
  } finally {
    db.close();
  }
});

test("an unknown ordinary steer pauses waiting follow-ups", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "working", "first");
  const turnId = f.app.detail(a.id).turnId!;
  await f.app.enqueueFollowUp(a.id, "next", "next");
  f.runtime.sendOverride = async () => {
    throw new Error("connection lost");
  };
  await f.app.send(a.id, "uncertain steer", "steer");
  expect(f.app.detail(a.id).followUpPaused).toBe(true);
  f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await Bun.sleep(20);
  expect(f.app.lookupFollowUp(a.id, "next")?.status).toBe("waiting");
  expect(f.runtime.inputs.map((x) => x.text)).toEqual([
    "working",
    "uncertain steer",
  ]);
});
