import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { HostService } from "./hosts";
import { InstanceControls } from "./instance-controls";
import { createHandler } from "./http";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-maintenance-idle-"));
  let runtime = new FakeRuntime();
  const options = {
    directory,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  };
  let app = new Workspace({ ...options, runtime });
  let service: HostService | undefined;
  const origin = "http://localhost:4318";
  function http() {
    service?.dispose();
    service = new HostService(app, { directory, origin: () => origin });
    const instance = new InstanceControls(app, null, {
      available: async () => false,
      request: async () => {
        throw new Error("unexpected manager request");
      },
    });
    const auth = {
      session: async () => ({ user: { id: "fixture" } }),
    } as unknown as import("./auth").GroveAuth;
    const handler = createHandler(app, {
      service,
      auth,
      instance,
      origin: () => origin,
    });
    return (path: string, method = "GET") =>
      handler(new Request(origin + path, { method, headers: { origin } }));
  }
  return {
    get app() {
      return app;
    },
    get runtime() {
      return runtime;
    },
    get service() {
      return service!;
    },
    http,
    async restart() {
      service?.dispose();
      service = undefined;
      await runtime.close();
      app.dispose();
      runtime = new FakeRuntime();
      app = new Workspace({ ...options, runtime });
      for (
        let i = 0;
        i < 200 &&
        app.instanceActivity().busy &&
        app
          .instanceActivity()
          .sessions.some(
            (s) => s.reasons.includes("queue") || s.reasons.includes("opening"),
          );
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

async function maintenance(
  fetch: ReturnType<ReturnType<typeof fixture>["http"]>,
  busy: boolean,
) {
  const status = (await (await fetch("/api/instance")).json()) as {
    busy: boolean;
    sessions: { reasons: string[] }[];
  };
  expect(status.busy).toBe(busy);
  for (const path of ["/api/instance/mcp/reload", "/api/instance/restart"]) {
    const response = await fetch(path, "POST");
    expect(response.status).toBe(busy ? 400 : 200);
  }
  return status;
}

test("a question can coexist with work; once ended it survives maintenance and can be answered by original ID", async () => {
  const f = fixture();
  try {
    const agent = await f.app.createOrc("alpha");
    await f.app.send(agent.id, "work", "first");
    const turnId = f.app.detail(agent.id).turnId!;
    f.runtime.emit(agent.id, {
      type: "item",
      turnId,
      item: {
        id: "question",
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: "Proceed?" }],
      },
    });
    let fetch = f.http();
    expect((await maintenance(fetch, true)).sessions[0]!.reasons).toContain(
      "working",
    );
    f.runtime.emit(agent.id, {
      type: "completed",
      turnId,
      status: "completed",
      verified: true,
    });
    await maintenance(fetch, false);
    await f.restart();
    fetch = f.http();
    await maintenance(fetch, false);
    expect(f.app.detail(agent.id).questions[0]).toMatchObject({
      id: "question:0",
      state: "unanswered",
    });
    expect(f.runtime.inputs).toHaveLength(0);
    await f.app.answerBatch(
      agent.id,
      [{ questionId: "question:0", answer: "Yes" }],
      "answer-original",
    );
    expect(f.app.detail(agent.id).questions[0]!.state).toBe("answered");
    expect(f.runtime.inputs.map((i) => i.clientId)).toEqual([
      "answer-original",
    ]);
  } finally {
    f.cleanup();
  }
});

test("delegated question survives recreation with owner identity and can be answered", async () => {
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
    const turnId = f.app.detail(worker.id).turnId!;
    f.runtime.emit(worker.id, {
      type: "item",
      turnId,
      item: {
        id: "delegated",
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: "Which?" }],
      },
    });
    for (let i = 0; i < 200 && !f.app.detail(owner.id).turnId; i++)
      await Bun.sleep(2);
    const ownerTurn = f.app.detail(owner.id).turnId!;
    expect(ownerTurn).toBeTruthy();
    f.runtime.emit(worker.id, {
      type: "completed",
      turnId,
      status: "completed",
      verified: true,
    });
    f.runtime.emit(owner.id, {
      type: "completed",
      turnId: ownerTurn,
      status: "completed",
      verified: true,
    });
    await maintenance(f.http(), false);
    await f.restart();
    await maintenance(f.http(), false);
    expect(f.app.detail(worker.id)).toMatchObject({
      ownerId: owner.id,
      questions: [{ id: "delegated:0", state: "delegated" }],
    });
    expect(f.runtime.inputs).toHaveLength(0);
    await f.app.tool(f.runtime.agents.get(owner.id)!.token, "worker_send", {
      workerId: worker.id,
      message: "This one",
      questionIds: ["delegated:0"],
    });
    expect(f.app.detail(worker.id).questions[0]!.state).toBe("answered");
  } finally {
    f.cleanup();
  }
});

test("public snapshots distinguish confirmed failures from unconfirmed execution and stop", async () => {
  const f = fixture();
  try {
    const agent = await f.app.createOrc("alpha");
    let fetch = f.http();
    const projected = () =>
      f.service
        .snapshot()
        .agents.find((a) => a.id.endsWith(`:${agent.id}`)) as typeof agent & {
        workUnconfirmed: boolean;
      };
    expect(projected().workUnconfirmed).toBe(false);
    await f.app.send(agent.id, "work", "first");
    let turnId = f.app.detail(agent.id).turnId!;
    f.runtime.emit(agent.id, {
      type: "completed",
      turnId,
      status: "failed",
      verified: true,
      error: "terminal failure",
    });
    expect(projected()).toMatchObject({
      state: "error",
      workUnconfirmed: false,
    });
    await maintenance(fetch, false);
    await f.app.send(agent.id, "work again", "second");
    turnId = f.app.detail(agent.id).turnId!;
    f.runtime.emit(agent.id, {
      type: "completed",
      turnId,
      status: "failed",
      verified: false,
    });
    expect(projected()).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    await maintenance(fetch, true);
    await f.restart();
    fetch = f.http();
    expect(projected()).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    await maintenance(fetch, true);
    await f.app.send(agent.id, "resume", "third");
    turnId = f.app.detail(agent.id).turnId!;
    f.runtime.interruptOverride = async () => {
      throw new Error("stop unknown");
    };
    await f.app.stop(agent.id, turnId);
    expect(projected()).toMatchObject({
      state: "stopping",
      stop: { status: "unknown" },
      workUnconfirmed: true,
    });
    await maintenance(fetch, true);
    f.runtime.emit(agent.id, {
      type: "completed",
      turnId,
      status: "interrupted",
      verified: true,
    });
    expect(projected()).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
    });
    await maintenance(fetch, false);
  } finally {
    f.cleanup();
  }
});

test("paused unsent follow-up remains paused through reload and restart until explicit resume", async () => {
  const f = fixture();
  try {
    const agent = await f.app.createOrc("alpha");
    await f.app.send(agent.id, "first", "first");
    const turnId = f.app.detail(agent.id).turnId!;
    await f.app.enqueueFollowUp(agent.id, "later", "follow-up");
    await f.app.stop(agent.id, turnId);
    f.runtime.emit(agent.id, {
      type: "completed",
      turnId,
      status: "interrupted",
      verified: true,
    });
    expect(f.app.detail(agent.id).followUpPaused).toBe(true);
    await maintenance(f.http(), false);
    await f.restart();
    await maintenance(f.http(), false);
    expect(f.app.detail(agent.id).followUpPaused).toBe(true);
    expect(f.app.lookupFollowUp(agent.id, "follow-up")).toMatchObject({
      id: "follow-up",
      text: "later",
      status: "waiting",
    });
    expect(f.runtime.inputs).toHaveLength(0);
    await f.app.resumeFollowUps(agent.id);
    for (let i = 0; i < 200 && !f.runtime.inputs.length; i++)
      await Bun.sleep(2);
    expect(f.runtime.inputs.map((i) => i.clientId)).toEqual(["follow-up"]);
  } finally {
    f.cleanup();
  }
});
