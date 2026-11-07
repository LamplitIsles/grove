import { socketWithHeaders } from "./socket-testing";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService, qualify } from "./hosts";
import { FakeRuntime, fixtureProjects } from "./testing";
import { createHandler, createUpgrade } from "./http";
import { groveWebsocket, type SocketData } from "./chord-socket";
import type { ServerWebSocket } from "bun";
import { openGrove } from "../src/chord-client";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const settings = {
  fast: false,
  orc: { model: "sol", effort: "medium" },
  worker: { model: "luna", effort: "low" },
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-peer-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, {
    directory,
    name: "Test Peer",
    origin: () => origin,
  });
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      ...groveWebsocket,
      open(socket) {
        sockets.add(socket);
        groveWebsocket.open(socket);
      },
    },
    fetch: (req, s) => {
      const options = { service, origin: () => origin };
      const result = createUpgrade(app, options)(req, s);
      return result === true
        ? undefined
        : (result ?? createHandler(app, options)(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanup.push(() => {
    server.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, runtime, app, service, origin, sockets };
}
async function client(f: ReturnType<typeof fixture>, token?: string) {
  const socket = socketWithHeaders(
    f.origin.replace("http:", "ws:") + "/api/socket",
    {
      Origin: f.origin,
      "Sec-WebSocket-Protocol": token
        ? `grove.v1, grove-auth.${token}`
        : "grove.v1",
    },
  );
  const c = await openGrove(
    socket,
    () => {},
    () => {},
    2000,
  );
  cleanup.push(() => c.close());
  return c;
}
test("local browser executes directly and preserves receipt ownership", async () => {
  const f = fixture();
  const c = await client(f, "stale");
  expect(await c.call<{ id: string; name: string }>("identity", {})).toEqual(
    f.service.identity,
  );
  const agent = await c.call<{ id: string }>("createOrc", {
    project: "alpha",
    settings,
  });
  expect(agent.id.startsWith(f.service.identity.id + ":")).toBe(true);
  const { operationId } = await c.call<{ operationId: string }>(
    "reserveSubmission",
    { id: agent.id },
  );
  await c.call("send", {
    id: agent.id,
    text: "Direct input",
    operationId,
  });
  expect(f.runtime.inputs.map((i) => i.text)).toEqual(["Direct input"]);
  expect(
    (
      await c.call<{ state: string }>("lookup", {
        id: agent.id,
        operationId,
      })
    ).state,
  ).toBe("accepted");
  await expect(c.call("detail", { id: "foreign:agent" })).rejects.toThrow(
    "another Peer",
  );
  expect(JSON.stringify(f.service.snapshot())).not.toContain("credential");
});
test("Peer identity survives restart and owns only local state", async () => {
  const f = fixture(),
    other = fixture();
  const first = await f.service.createOrc("alpha", settings);
  const identity = new HostService(f.app, {
    directory: f.directory,
    origin: () => f.origin,
  });
  expect(identity.identity.id).toBe(f.service.identity.id);
  expect(f.service.snapshot().hosts).toHaveLength(1);
  expect(other.service.snapshot().agents).toHaveLength(0);
  expect(
    JSON.parse(readFileSync(join(f.directory, "hosts.json"), "utf8")),
  ).toEqual({ id: f.service.identity.id });
  await expect(other.service.detail(first.id)).rejects.toThrow("another Peer");
});
test("independent Bun caller cannot cross Peer and does not replay its own input", async () => {
  const left = fixture(),
    right = fixture();
  const agent = await left.service.createOrc("alpha", settings);
  const old = await left.service.reserveSubmission(agent.id);
  const envelope = { source: "user" as const, text: "peer-bound" };
  expect(
    await left.service.finalizeSubmission(agent.id, old.operationId, envelope),
  ).toMatchObject({ state: "rejected" });
  const current = await left.service.reserveSubmission(agent.id);
  const data = {
    left: left.origin,
    right: right.origin,
    id: agent.id,
    old: old.operationId,
    current: current.operationId,
    envelope,
  };
  const script = `
    import { openGrove } from "./src/chord-client";
    import { socketWithHeaders } from "./server/socket-testing";
    const data = ${JSON.stringify(data)};
    const connect = (origin) => openGrove(socketWithHeaders(origin.replace("http:", "ws:") + "/api/socket", { Origin: origin }), () => {}, () => {}, 2000);
    const remote = await connect(data.right);
    const failures = [];
    for (const [member, input] of [
      ["reserveRetry", { id: data.id, operationId: data.old }],
      ["inspectRetry", { id: data.id, operationId: data.old, envelope: data.envelope }],
      ["finalizeSubmission", { id: data.id, operationId: data.old, envelope: data.envelope }],
      ["send", { id: data.id, operationId: data.old, text: data.envelope.text }],
    ]) {
      try { await remote.call(member, input); failures.push("accepted"); }
      catch (error) { failures.push(error.message); }
    }
    remote.close();
    const local = await connect(data.left);
    await local.call("send", { id: data.id, operationId: data.current, text: "once" });
    await local.call("send", { id: data.id, operationId: data.current, text: "once" });
    const receipt = await local.call("lookup", { id: data.id, operationId: data.current });
    local.close();
    console.log(JSON.stringify({ failures, receipt }));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new Response(child.stdout).text(),
    err = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    expect(await child.exited).toBe(0);
    const stderr = await err;
    expect(stderr).not.toContain("invalid/protocol");
    const result = JSON.parse(await out) as {
      failures: string[];
      receipt: { state: string };
    };
    expect(result.failures).toHaveLength(4);
    expect(
      result.failures.every((value) => value.includes("another Peer")),
    ).toBe(true);
    expect(result.receipt.state).toBe("accepted");
    expect(left.runtime.inputs.map((input) => input.clientId)).toEqual([
      current.operationId,
    ]);
    expect(right.runtime.inputs).toHaveLength(0);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
}, 15000);
test("single-session history qualifies known identities like the history list", async () => {
  const { app, runtime, service } = fixture();
  const agent = await app.createOrc("alpha", settings);
  const knownThread = agent.threadId!;
  const unknown = {
    ...runtime.historySessions.get(knownThread)!,
    threadId: "unknown-thread",
  };
  runtime.historySessions.set(unknown.threadId, unknown);

  const list = (await service.history("alpha", "")).sessions;
  for (const threadId of [knownThread, unknown.threadId]) {
    const raw = await app.historySession("alpha", threadId);
    const single = await service.historySession("alpha", threadId);
    const listed = list.find((session) => session.threadId === threadId)!;
    expect(single).toEqual({ ...raw, agentId: listed.agentId });
    expect(single.agentId).toBe(
      threadId === knownThread
        ? qualify(service.identity.id, agent.id)
        : undefined,
    );
  }
  expect((await app.historySession("alpha", knownThread)).agentId).toBe(
    agent.id,
  );
  await expect(service.historySession("beta", knownThread)).rejects.toThrow(
    "does not belong",
  );
});
test("captured Worker settings survive workspace restart without browser or global settings", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha", settings);
  await f.app.createOrc("beta", {
    ...settings,
    worker: { model: "sol", effort: "high" },
  });
  f.app.dispose();
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: f.directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => app.dispose());
  await app.send(agent.id, "Resume", "resume");
  const token = runtime.agents.get(agent.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Child",
    spec: "spec",
    message: "Go",
  })) as { id: string };
  expect(app.detail(worker.id)).toMatchObject({
    model: "luna",
    effort: "low",
    serviceTier: "default",
  });
  expect(qualify(f.service.identity.id, worker.id)).toContain(":");
});

test("native WebSocket Pong clears only its matching liveness deadline", async () => {
  const f = fixture();
  await client(f);
  const socket = [...f.sockets][0];
  let expired = false;
  socket.data.ping = "test-owned-probe";
  socket.data.deadline = setTimeout(() => {
    expired = true;
  }, 100);
  groveWebsocket.pong(socket, Buffer.from("unrelated"));
  expect(socket.data.ping).toBe("test-owned-probe");
  socket.ping("test-owned-probe");
  const until = Date.now() + 500;
  while (socket.data.ping && Date.now() < until) await Bun.sleep(5);
  expect(socket.data.ping).toBeUndefined();
  await Bun.sleep(110);
  expect(expired).toBe(false);
});

test("a Peer exposes its local browser identity alongside its advertised proxy origin", async () => {
  const f = fixture();
  const handler = createHandler(f.app, {
    service: f.service,
    origin: () => "https://advertised.invalid",
    localOrigin: () => f.origin,
  });
  const local = await handler(
    new Request(f.origin + "/api/identity", { headers: { Origin: f.origin } }),
  );
  expect(local.status).toBe(200);
  expect(await local.json()).toEqual(f.service.identity);
  const foreign = await handler(
    new Request(f.origin + "/api/identity", {
      headers: { Origin: "https://foreign.invalid" },
    }),
  );
  expect(foreign.status).toBe(403);
});
