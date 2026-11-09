import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DeliveryRejected } from "./runtime";
import { lookupSchema, receiptSchema } from "../src/chord-contract";
import { Workspace } from "./workspace";
import { HostService, qualify } from "./hosts";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixtureSync,
} from "./testing";
import { createUpgrade, createHandler } from "./http";
import { groveWebsocket } from "./chord-socket";
import { socketWithHeaders } from "./socket-testing";
import {
  openGrove,
  RequestRejected,
  RequestTimeout,
} from "../src/chord-client";
import type { Detail } from "../src/contracts";
import type { Receipt, View } from "../src/chord-contract";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
export async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
// Exercise the real Grove socket adapter without relying on Bun's client-side
// WebSocket event ordering. This pair does not exercise HTTP upgrade or TCP.
function orderedSocket(service: HostService): WebSocket {
  class Client extends EventTarget {
    readyState: number = WebSocket.CONNECTING;
    bufferedAmount = 0;
    opened = false;
    private listeners: Array<{
      type: string;
      listener: EventListenerOrEventListenerObject;
      options?: boolean | AddEventListenerOptions;
    }> = [];
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      super.addEventListener(type, listener, options);
      if (listener) this.listeners.push({ type, listener, options });
    }
    send(data: string | Uint8Array) {
      if (this.readyState !== WebSocket.OPEN) throw new Error("Socket closed");
      queueMicrotask(() => {
        if (this.readyState === WebSocket.OPEN)
          groveWebsocket.message(server, data as string);
      });
    }
    close() {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.CLOSED;
      if (this.opened) groveWebsocket.close(server);
      this.dispatchEvent(new Event("close"));
      for (const { type, listener, options } of this.listeners)
        super.removeEventListener(type, listener, options);
      this.listeners = [];
    }
  }
  const client = new Client();
  const server = {
    data: { app: service, service },
    getBufferedAmount: () => 0,
    send(data: string) {
      queueMicrotask(() => {
        if (client.readyState === WebSocket.OPEN)
          client.dispatchEvent(new MessageEvent("message", { data }));
      });
      return Buffer.byteLength(data);
    },
    close: () => client.close(),
    ping: () => {},
  } as unknown as Parameters<typeof groveWebsocket.open>[0];
  queueMicrotask(() => {
    if (client.readyState !== WebSocket.CONNECTING) return;
    client.readyState = WebSocket.OPEN;
    client.opened = true;
    groveWebsocket.open(server);
    if (client.readyState === WebSocket.OPEN)
      client.dispatchEvent(new Event("open"));
  });
  return client as unknown as WebSocket;
}

function fixture(transport: "tcp" | "ordered" = "tcp") {
  const directory = mkdtempSync(join(tmpdir(), "grove-chord-"));
  const runtime = new FakeRuntime();
  let app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets: memberPresetsFixtureSync(directory),
  });
  let origin = "";
  let service = new HostService(app, { directory, origin: () => origin });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch: (req, server) => {
      const options = { service, origin: () => origin };
      const result = createUpgrade(app, options)(req, server);
      return result === true
        ? undefined
        : (result ?? createHandler(app, options)(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanups.push(() => {
    server.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    runtime,
    get service() {
      return service;
    },
    origin,
    async client(
      changed: (view: View) => void = () => {},
      offline: () => void = () => {},
      timeoutMs = 30_000,
    ) {
      const client = await openGrove(
        transport === "ordered"
          ? orderedSocket(service)
          : socketWithHeaders(origin.replace("http:", "ws:") + "/api/socket", {
              Origin: origin,
            }),
        changed,
        offline,
        timeoutMs,
      );
      cleanups.push(() => client.close());
      return client;
    },
    restart(orcPrompt?: () => Promise<string>) {
      app.dispose();
      const restoredRuntime = new FakeRuntime();
      app = new Workspace({
        directory,
        orcPrompt,
        runtime: restoredRuntime,
        projects: async () => fixtureProjects,
        memberPresets: memberPresetsFixtureSync(directory),
      });
      service = new HostService(app, { directory, origin: () => origin });
      return restoredRuntime;
    },
  };
}
async function reserve(
  client: Awaited<ReturnType<typeof openGrove>>,
  id: string,
) {
  return (
    await client.call<{ operationId: string }>("reserveSubmission", { id })
  ).operationId;
}
test("#5335 a held send does not block the next reservation or reorder native inputs", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client(
    () => {},
    () => {},
    300,
  );
  const first = await reserve(client, id);
  const gate = Promise.withResolvers<string>();
  f.runtime.sendOverride = async (_id, text, turn) =>
    text === "First" ? gate.promise : turn!;
  const sending = client
    .call("send", { id, operationId: first, text: "First" })
    .catch((error) => error);
  try {
    await until(() => f.runtime.inputs.length === 1);
    const second = await reserve(client, id);
    expect(second).not.toBe(first);
    const next = client.call("send", {
      id,
      operationId: second,
      text: "Second",
    });
    await Bun.sleep(10);
    expect(f.runtime.inputs.map((input) => input.text)).toEqual(["First"]);
    gate.resolve("first-turn");
    await sending;
    await next;
    await client.call("send", { id, operationId: second, text: "Second" });
    expect(
      f.runtime.inputs.map((input) => [
        input.text,
        input.clientId,
        input.turnId,
      ]),
    ).toEqual([
      ["First", first, undefined],
      ["Second", second, "first-turn"],
    ]);
  } finally {
    gate.resolve("first-turn");
    await sending;
  }
});
for (const firstAction of ["finalize", "submit"] as const) {
  test(`#5335 ${firstAction} wins for a reservation made while an earlier send is held`, async () => {
    const f = fixture("ordered");
    const agent = await f.app.createOrc("alpha");
    const id = qualify(f.service.identity.id, agent.id);
    const client = await f.client(
      () => {},
      () => {},
      2000,
    );
    const first = await reserve(client, id);
    const gate = Promise.withResolvers<string>();
    f.runtime.sendOverride = async (_id, text, turn) =>
      text === "First" ? gate.promise : turn!;
    const sending = client
      .call("send", { id, operationId: first, text: "First" })
      .catch((error) => error);
    const invoked: string[] = [];
    const send = f.service.send.bind(f.service);
    const finalize = f.service.finalizeSubmission.bind(f.service);
    f.service.send = (...args) => {
      if (args[1] === "Second") invoked.push("submit");
      return send(...args);
    };
    f.service.finalizeSubmission = (...args) => {
      invoked.push("finalize");
      return finalize(...args);
    };
    try {
      await until(() => f.runtime.inputs.length === 1);
      const second = await reserve(client, id);
      const submit = () =>
        client
          .call("send", { id, operationId: second, text: "Second" })
          .catch((error) => error);
      const final = () =>
        client.call<Receipt | null>("finalizeSubmission", {
          id,
          operationId: second,
          envelope: { source: "user", text: "Second" },
        });
      let submitted: Promise<unknown>, finalized: Promise<Receipt | null>;
      if (firstAction === "finalize") {
        finalized = final();
        submitted = submit();
      } else {
        submitted = submit();
        finalized = final();
      }
      await until(() => invoked.length === 2);
      expect(invoked).toEqual(
        firstAction === "finalize"
          ? ["finalize", "submit"]
          : ["submit", "finalize"],
      );
      expect(f.runtime.inputs.map((input) => input.text)).toEqual(["First"]);
      gate.resolve("first-turn");
      await sending;
      const result = await submitted;
      const receipt = await finalized;
      if (firstAction === "finalize") {
        expect(result).toBeInstanceOf(Error);
        expect(receipt?.state).toBe("rejected");
        expect(
          f.runtime.inputs.filter((input) => input.clientId === second),
        ).toHaveLength(0);
      } else {
        expect(result).not.toBeInstanceOf(Error);
        expect(receipt?.state).toBe("accepted");
        expect(
          f.runtime.inputs.filter((input) => input.clientId === second),
        ).toHaveLength(1);
      }
    } finally {
      gate.resolve("first-turn");
      await sending;
    }
  });
}
test("real socket admits A/B/C in order, start then steer, with operation-bound results and independent requests", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const opA = await reserve(client, id),
    opB = await reserve(client, id),
    opC = await reserve(client, id);
  const hold = Promise.withResolvers<string>();
  f.runtime.sendOverride = async (_id, text, turn) =>
    text === "A" ? hold.promise : turn!;
  const a = client.call<Detail>("send", { id, text: "A", operationId: opA });
  await until(() => f.runtime.inputs.length === 1);
  expect(
    await client.call<Receipt | null>("lookup", { id, operationId: opA }),
  ).toBeNull();
  const b = client.call("send", { id, text: "B", operationId: opB });
  const c = client.call("send", { id, text: "C", operationId: opC });
  // A slow submission neither blocks lookup nor another Orc on this socket.
  expect(
    await client.call<Receipt | null>("lookup", { id, operationId: opB }),
  ).toBeNull();
  const other = await client.call<{ id: string }>("createOrc", {
    project: "alpha",
    settings: {
      fast: false,
      orc: { model: "sol", effort: "medium" },
      worker: { model: "sol", effort: "medium" },
    },
  });
  expect(other.id).not.toBe(id);
  expect(f.runtime.inputs.map((i) => i.text)).toEqual(["A"]);
  hold.resolve("turn-A");
  await Promise.all([a, b, c]);
  expect(f.runtime.inputs.map((i) => [i.text, i.turnId])).toEqual([
    ["A", undefined],
    ["B", "turn-A"],
    ["C", "turn-A"],
  ]);
  await client.call("send", { id, text: "A", operationId: opA });
  await expect(
    client.call("send", { id, text: "altered", operationId: opA }),
  ).rejects.toThrow("bound");
  expect(f.runtime.inputs).toHaveLength(3);
  expect(
    await client.call<Receipt>("lookup", { id, operationId: opB }),
  ).toMatchObject({ state: "accepted", turnId: "turn-A" });
  client.close();
  expect(f.app.detail(agent.id).state).toBe("working");
  expect(f.runtime.interruptions).toHaveLength(0);
});
test("durable lookup after restart preserves accepted and null outcomes without native replay", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const acceptedOp = await reserve(client, id),
    unknownOp = await reserve(client, id);
  await client.call("send", { id, text: "accepted", operationId: acceptedOp });
  f.runtime.sendOverride = async () => {
    throw new Error("No native confirmation");
  };
  await client.call("send", { id, text: "unknown", operationId: unknownOp });
  client.close();
  f.restart();
  const reconnected = await f.client();
  expect(
    (await reconnected.call<Receipt>("lookup", { id, operationId: acceptedOp }))
      .state,
  ).toBe("accepted");
  expect(
    await reconnected.call<Receipt | null>("lookup", {
      id,
      operationId: unknownOp,
    }),
  ).toBeNull();
  expect(f.runtime.inputs).toHaveLength(2);
  await reconnected.call("send", {
    id,
    text: "unknown",
    operationId: unknownOp,
  });
  expect(f.runtime.inputs).toHaveLength(2);
});
test("two browser selections and rapid switching are independent; detail pushes follow completed output", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha"),
    b = await f.app.createOrc("beta");
  const aid = qualify(f.service.identity.id, a.id),
    bid = qualify(f.service.identity.id, b.id);
  let left: View | undefined, right: View | undefined;
  const l = await f.client((v) => (left = v)),
    r = await f.client((v) => (right = v));
  const workOp = await reserve(r, bid);
  await l.call("select", { ids: [aid] });
  await r.call("select", { ids: [bid] });
  await until(() => !!left?.details[aid] && !!right?.details[bid]);
  const gate = Promise.withResolvers<void>();
  const originalDetail = f.service.detail.bind(f.service);
  let held = false;
  f.service.detail = async (id) => {
    if (id === aid && !held) {
      held = true;
      await gate.promise;
    }
    return originalDetail(id);
  };
  const late = l.call("select", { ids: [aid] });
  await until(() => held);
  await l.call("select", { ids: [bid] });
  gate.resolve();
  await late;
  await until(() => !!left?.details[bid]);
  expect(left?.details[aid]).toBeUndefined();
  await r.call("send", { id: bid, text: "work", operationId: workOp });
  const turnId = f.app.detail(b.id).turnId!;
  f.runtime.emit(b.id, {
    type: "item",
    turnId,
    item: {
      id: "complete",
      type: "agentMessage",
      phase: "final_answer",
      text: "Complete answer",
    },
  });
  f.runtime.emit(b.id, { type: "completed", turnId, status: "completed" });
  await until(
    () =>
      left?.details[bid]?.messages.some((m) => m.text === "Complete answer") ===
      true,
  );
  expect(Object.keys(right!.details)).toEqual([bid]);
  await l.call("select", { ids: [] });
  await until(() => Object.keys(left!.details).length === 0);
});

test("independent clients share the durable FIFO and observe pending counts without duplicate admission", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  let left: View | undefined, right: View | undefined;
  const l = await f.client((v) => (left = v));
  const r = await f.client((v) => (right = v));
  const initialOp = await reserve(l, id);
  await Promise.all([
    l.call("select", { ids: [id] }),
    r.call("select", { ids: [id] }),
  ]);
  await l.call("send", { id, text: "initial", operationId: initialOp });
  const initialTurn = f.app.detail(agent.id).turnId!;
  await Promise.all([
    l.call("enqueueFollowUp", { id, text: "from left", operationId: "left" }),
    r.call("enqueueFollowUp", { id, text: "from right", operationId: "right" }),
  ]);
  const order = f.app.detail(agent.id).followUps!.map((d) => d.id);
  expect(new Set(order)).toEqual(new Set(["left", "right"]));
  await until(
    () =>
      left?.snapshot.agents.find((a) => a.id === id)?.followUpCount === 2 &&
      right?.snapshot.agents.find((a) => a.id === id)?.followUpCount === 2,
  );
  expect(left?.details[id]?.followUpCount).toBe(2);
  expect(right?.details[id]?.followUpCount).toBe(2);
  const gate = Promise.withResolvers<string>();
  f.runtime.sendOverride = async (_id, _text, _turn, startOnly) =>
    startOnly ? gate.promise : "unexpected";
  f.runtime.emit(agent.id, {
    type: "completed",
    turnId: initialTurn,
    status: "completed",
  });
  await until(
    () => f.app.lookupFollowUp(agent.id, order[0])?.status === "sending",
  );
  expect(f.app.detail(agent.id).followUpCount).toBe(2);
  gate.resolve("first-follow-up-turn");
  await until(
    () => f.app.lookupFollowUp(agent.id, order[0])?.status === "sent",
  );
  await until(
    () =>
      left?.snapshot.agents.find((a) => a.id === id)?.followUpCount === 1 &&
      right?.snapshot.agents.find((a) => a.id === id)?.followUpCount === 1,
  );
  f.runtime.sendOverride = undefined;
  f.runtime.emit(agent.id, {
    type: "completed",
    turnId: "first-follow-up-turn",
    status: "completed",
  });
  await until(
    () => f.app.lookupFollowUp(agent.id, order[1])?.status === "sent",
  );
  await until(
    () =>
      left?.snapshot.agents.find((a) => a.id === id)?.followUpCount === 0 &&
      right?.snapshot.agents.find((a) => a.id === id)?.followUpCount === 0,
  );
  await r.call("enqueueFollowUp", {
    id,
    text: "from left",
    operationId: "left",
  });
  expect(f.runtime.inputs.map((input) => input.clientId)).toEqual([
    initialOp,
    ...order,
  ]);
  expect(f.app.detail(agent.id).state).toBe("working");
});
test("large selected state updates and rehydrates over a real socket", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  await f.app.send(agent.id, "start", "view-start");
  f.runtime.historyItems.set(
    agent.threadId!,
    Array.from({ length: 140 }, (_, i) => ({
      id: `view-item-${i}`,
      role: "assistant",
      text: "body".repeat(10_000),
      at: i + 1,
    })),
  );
  const id = qualify(f.service.identity.id, agent.id);
  await f.service.synchronizeDetail(id);
  const bytes: number[] = [];
  const socket = () => {
    const ws = socketWithHeaders(
      f.origin.replace("http:", "ws:") + "/api/socket",
      {
        Origin: f.origin,
      },
    );
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string")
        bytes.push(new TextEncoder().encode(event.data).byteLength);
    });
    return ws;
  };
  let latest: View | undefined;
  const client = await openGrove(
    socket(),
    (value) => (latest = value),
    () => {},
  );
  cleanups.push(() => client.close());
  await client.call("select", { ids: [id] });
  await until(
    () => latest?.details[id]?.messages.at(-1)?.id === "view-item-139",
  );
  for (let i = 0; i < 102; i++) {
    f.runtime.emit(agent.id, {
      type: "item",
      turnId: f.app.detail(agent.id).turnId!,
      item: {
        id: `burst-${i}`,
        type: "agentMessage",
        phase: "final_answer",
        text: `Update ${i}`,
      },
    });
  }
  await until(
    () =>
      latest?.details[id]?.messages.some((item) => item.id === "burst-101") ===
      true,
  );
  expect(Math.max(...bytes)).toBeLessThan(2 * 1024 * 1024);
  client.close();
  let hydrated: View | undefined;
  const fresh = await openGrove(
    socket(),
    (value) => (hydrated = value),
    () => {},
  );
  cleanups.push(() => fresh.close());
  await fresh.call("select", { ids: [id] });
  await until(
    () =>
      hydrated?.details[id]?.messages.some(
        (item) => item.id === "burst-101",
      ) === true,
  );
});

test("slow read and late result leave the socket and other calls alive", async () => {
  const f = fixture();
  let disconnected = 0;
  const client = await f.client(
    () => {},
    () => disconnected++,
    80,
  );
  const hold =
    Promise.withResolvers<Awaited<ReturnType<FakeRuntime["weekly"]>>>();
  f.runtime.weekly = () => hold.promise;
  await expect(client.call("weekly", {})).rejects.toThrow("Response timed out");
  expect(disconnected).toBe(0);
  expect(await client.call<unknown>("projects", {})).toEqual(fixtureProjects);
  hold.resolve({ remaining: 42, fetchedAt: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await client.call<unknown>("projects", {})).toEqual(fixtureProjects);
  expect(disconnected).toBe(0);
});

test("selection publishes cached detail while history loads and ignores late results after switching", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha"),
    b = await f.app.createOrc("beta");
  const aid = qualify(f.service.identity.id, a.id),
    bid = qualify(f.service.identity.id, b.id);
  const runtime = f.restart();
  runtime.historyItems.set(a.threadId!, [
    {
      id: "native-after-restart",
      role: "assistant",
      text: "Updated history",
      at: 1,
    },
  ]);
  let gate = Promise.withResolvers<void>();
  const read = runtime.historyMessages.bind(runtime);
  let slowReads = 0,
    completedReads = 0;
  runtime.historyMessages = async (thread, cursor) => {
    if (thread === a.threadId) {
      slowReads++;
      await gate.promise;
      completedReads++;
    }
    return read(thread, cursor);
  };
  let view: View | undefined,
    offline = 0;
  const client = await f.client(
    (value) => (view = value),
    () => offline++,
    80,
  );
  await client.call("select", { ids: [aid] });
  await until(() => !!view?.details[aid] && slowReads === 1);
  expect(
    view?.details[aid]?.messages.some((m) => m.id === "native-after-restart"),
  ).toBe(false);
  gate.resolve();
  await until(
    () =>
      view?.details[aid]?.messages.some(
        (m) => m.id === "native-after-restart",
      ) === true,
  );
  expect(runtime.inputs).toHaveLength(0);
  expect(offline).toBe(0);
  gate = Promise.withResolvers<void>();
  await client.call("select", { ids: [aid] });
  await until(() => slowReads === 2);
  await client.call("select", { ids: [bid] });
  await until(() => !!view?.details[bid]);
  gate.resolve();
  await until(() => completedReads === 2);
  expect(view?.details[aid]).toBeUndefined();
  await expect(
    client.call("select", { ids: ["foreign:missing"] }),
  ).rejects.toBeInstanceOf(RequestRejected);
});

test("timed out mutation is reconciled by receipt without replay or disconnect", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  let disconnected = 0;
  const client = await f.client(
    () => {},
    () => disconnected++,
    80,
  );
  const hold = Promise.withResolvers<string>();
  const operationId = await reserve(client, id);
  f.runtime.sendOverride = () => hold.promise;
  const failure = await client
    .call("send", { id, text: "once", operationId: operationId })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RequestTimeout);
  expect((failure as RequestTimeout).member).toBe("send");
  expect((failure as RequestTimeout).message).toBe(
    "Response timed out. Outcome unknown.",
  );
  expect(f.runtime.inputs).toHaveLength(1);
  expect(disconnected).toBe(0);
  hold.resolve("fixture-turn");
  await until(() => f.app.detail(agent.id).deliveries[0]?.status === "sent");
  const receipt = await client.call<Receipt>("lookup", {
    id,
    operationId: operationId,
  });
  expect(receipt.state).toBe("accepted");
  expect(f.runtime.inputs).toHaveLength(1);
  expect(disconnected).toBe(0);
});

test("nullable receipts over real Chord preserve image and answer admission boundaries", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, a.id);
  const client = await f.client();
  const imageOp = await reserve(client, id),
    answerOp = await reserve(client, id);
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 4, background: "blue" },
  })
    .png()
    .toBuffer();
  const refs = await f.app.images.upload(a.id, imageOp, "caption", [
    new File([bytes], "image.png", { type: "image/png" }),
  ]);
  expect(
    lookupSchema.parse(
      await client.call("lookup", { id, operationId: imageOp }),
    ),
  ).toBeNull();
  const imageGate = Promise.withResolvers<string>();
  f.runtime.sendOverride = () => imageGate.promise;
  const image = client.call("send", {
    id,
    text: "caption",
    images: refs,
    operationId: imageOp,
  });
  await until(() => f.runtime.inputs.length === 1);
  expect(
    lookupSchema.parse(
      await client.call("lookup", { id, operationId: imageOp }),
    ),
  ).toBeNull();
  imageGate.resolve("image-turn");
  await image;
  expect(
    receiptSchema.parse(
      await client.call("lookup", { id, operationId: imageOp }),
    ).state,
  ).toBe("accepted");
  await client.call("send", {
    id,
    text: "caption",
    images: refs,
    operationId: imageOp,
  });
  expect(f.runtime.inputs).toHaveLength(1);
  const ask = (itemId: string) =>
    f.runtime.emit(a.id, {
      type: "item",
      turnId: "image-turn",
      item: {
        id: itemId,
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: itemId }],
      },
    });
  ask("original");
  const answers = [
    {
      questionId: f.app.detail(a.id).questions[0].id,
      answer: "immutable answer",
    },
  ];
  const answerGate = Promise.withResolvers<string>();
  f.runtime.sendOverride = () => answerGate.promise;
  const answer = client.call("answerBatch", {
    id,
    answers,
    operationId: answerOp,
  });
  await until(() => f.runtime.inputs.length === 2);
  expect(
    lookupSchema.parse(
      await client.call("lookup", { id, operationId: answerOp }),
    ),
  ).toBeNull();
  expect(f.app.detail(a.id).questions[0].state).toBe("unanswered");
  ask("new arrival");
  answerGate.reject(new DeliveryRejected("Native rejected the answer"));
  await answer;
  expect(
    receiptSchema.parse(
      await client.call("lookup", { id, operationId: answerOp }),
    ),
  ).toMatchObject({ state: "rejected", error: "Native rejected the answer" });
  expect(
    f.app.detail(a.id).questions.every((q) => q.state === "unanswered"),
  ).toBe(true);
  f.runtime.sendOverride = async () => "image-turn";
  const retry = await client.call<{
    state: "won";
    operationId: string;
    claimToken: string;
  }>("reserveRetry", { id, operationId: answerOp });
  expect(retry.state).toBe("won");
  const predecessor = { source: "question", answers };
  await client.call("answerBatch", {
    id,
    answers,
    operationId: retry.operationId,
    predecessor,
    claimToken: retry.claimToken,
  });
  expect(
    receiptSchema.parse(
      await client.call("lookup", { id, operationId: retry.operationId }),
    ).state,
  ).toBe("accepted");
  expect(f.app.detail(a.id).questions.map((q) => q.state)).toEqual([
    "answered",
    "unanswered",
  ]);
  expect(f.runtime.inputs).toHaveLength(3);
  await expect(
    client.call("answerBatch", { id, answers, operationId: answerOp }),
  ).rejects.toThrow("replaced");
  await client.call("answerBatch", {
    id,
    answers,
    operationId: retry.operationId,
    predecessor,
    claimToken: retry.claimToken,
  });
  expect(f.runtime.inputs).toHaveLength(3);
  expect(
    receiptSchema.safeParse({
      operationId: answerOp,
      state: "pending",
      turnId: null,
      error: null,
    }).success,
  ).toBe(false);
});

test("passive Chord select and reconnect preserve prefeature Orc until explicit restoration", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  let captures = 0,
    prompt = "Explicit captured scope";
  const runtime = f.restart(async () => {
    captures++;
    return prompt;
  });
  const id = qualify(f.service.identity.id, a.id);
  const first = await f.client();
  await first.call("select", { ids: [id] });
  first.close();
  const reconnected = await f.client();
  const explicitOp = await reserve(reconnected, id);
  await reconnected.call("select", { ids: [id] });
  expect(captures).toBe(0);
  expect(runtime.agents.has(a.id)).toBe(false);
  expect(runtime.settingsReads).toEqual([]);
  await f.app.resumeHistory("alpha", a.threadId!, false);
  expect(captures).toBe(1);
  expect(runtime.agents.get(a.id)?.orcPromptSnapshot).toBe(prompt);
  prompt = "Later configuration";
  await reconnected.call("select", { ids: [id] });
  await f.app.resumeHistory("alpha", a.threadId!, false);
  await reconnected.call("send", {
    id,
    text: "Continue explicitly",
    operationId: explicitOp,
  });
  expect(captures).toBe(1);
  expect(runtime.agents.get(a.id)?.orcPromptSnapshot).toBe(
    "Explicit captured scope",
  );
  expect(runtime.settingsReads).toContain(a.id);
});

test("failed submission deletion is owning-Peer durable, serialized and rejected-user-only", async () => {
  const f = fixture("ordered");
  const a = await f.app.createOrc("alpha"),
    b = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, a.id),
    other = qualify(f.service.identity.id, b.id);
  const client = await f.client();
  const failedOp = await reserve(client, id),
    acceptedOp = await reserve(client, id),
    unknownOp = await reserve(client, id);
  const remove = (target = id, operationId = failedOp) =>
    client.call<Detail>("deleteFailedSubmission", { id: target, operationId });
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await client.call("send", {
    id,
    text: "Rejected content",
    operationId: failedOp,
  });
  await expect(remove(`foreign:${a.id}`)).rejects.toThrow();
  await expect(remove(other)).rejects.toThrow();
  const save = (f.app as any).save;
  (f.app as any).save = () => {
    throw new Error("Synthetic delete save failure");
  };
  await expect(remove()).rejects.toThrow("Synthetic delete save failure");
  (f.app as any).save = save;
  expect(f.app.lookup(a.id, failedOp)?.state).toBe("rejected");
  expect((await remove()).deliveries).toHaveLength(0);
  expect((await remove()).deliveries).toHaveLength(0);
  expect((await remove(id, "local-rejected-only")).deliveries).toHaveLength(0);
  const runtime = f.restart();
  const fresh = await f.client();
  expect(await fresh.call("lookup", { id, operationId: failedOp })).toBeNull();
  const hold = Promise.withResolvers<string>();
  runtime.sendOverride = async () => hold.promise;
  const accepted = fresh.call("send", {
    id,
    text: "Accepted content",
    operationId: acceptedOp,
  });
  await until(() => runtime.inputs.length === 1);
  let settled = false;
  const deleting = fresh
    .call("deleteFailedSubmission", { id, operationId: acceptedOp })
    .then(
      () => {
        settled = true;
        return "deleted";
      },
      (e) => {
        settled = true;
        return e.message;
      },
    );
  await new Promise((r) => setTimeout(r, 10));
  expect(settled).toBe(false);
  hold.resolve("turn");
  await accepted;
  expect(await deleting).toBe("Only a rejected user submission can be deleted");
  expect(
    (await fresh.call<Detail>("detail", { id })).messages.some(
      (m) => m.clientId === acceptedOp,
    ),
  ).toBe(true);
  runtime.sendOverride = async () => {
    throw new Error("Synthetic unknown admission");
  };
  await fresh.call("send", {
    id,
    text: "Unknown content",
    operationId: unknownOp,
  });
  await expect(
    fresh.call("deleteFailedSubmission", { id, operationId: unknownOp }),
  ).rejects.toThrow();
  expect(await fresh.call("lookup", { id, operationId: unknownOp })).toBeNull();
  expect(runtime.inputs.length).toBe(2);
  runtime.sendOverride = undefined;
  const token = runtime.agents.get(a.id)!.token;
  const worker = (await f.app.tool(token, "worker_start", {
    project: "alpha",
    title: "Synthetic Worker",
    spec: "test",
    message: "Synthetic task",
  })) as { id: string };
  const workerToken = runtime.agents.get(worker.id)!.token;
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic report rejection");
  };
  await f.app.tool(workerToken, "worker_report", {
    message: "Synthetic report",
  });
  const report = f.app
    .detail(a.id)
    .deliveries.find((d) => d.source === "worker")!;
  await expect(
    fresh.call("deleteFailedSubmission", { id, operationId: report.id }),
  ).rejects.toThrow();
  await expect(
    fresh.call("deleteFailedSubmission", {
      id: qualify(f.service.identity.id, worker.id),
      operationId: "missing",
    }),
  ).rejects.toThrow();
  expect(
    f.app.detail(a.id).deliveries.find((d) => d.id === report.id)?.status,
  ).toBe("failed");
});

test("selection returns while native recovery is pending and a newly sent input waits once", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  await f.app.send(agent.id, "previous", "previous");
  f.runtime.emit(agent.id, {
    type: "completed",
    turnId: f.app.detail(agent.id).turnId!,
    status: "completed",
  });
  const runtime = f.restart();
  const gate = Promise.withResolvers<void>();
  const originalOpen = runtime.open.bind(runtime);
  runtime.open = async (...args) => {
    await gate.promise;
    return originalOpen(...args);
  };
  let view: View | undefined;
  const client = await f.client((v) => (view = v));
  const id = qualify(f.service.identity.id, agent.id);
  const newOp = await reserve(client, id);
  try {
    await client.call("select", { ids: [id] });
    await until(() => view?.details[id]?.connection?.state === "connecting");
    const send = client.call("send", { id, text: "new", operationId: newOp });
    await Bun.sleep(50);
    expect(runtime.inputs).toHaveLength(0);
    expect(view?.details[id]?.state).toBe("idle");
    gate.resolve();
    await send;
    expect(runtime.inputs.map((input) => input.text)).toEqual(["new"]);
    expect(runtime.inputs[0]?.clientId).toBe(newOp);
    expect(f.app.detail(agent.id).threadId).toBe(agent.threadId);
  } finally {
    gate.resolve();
  }
});

test("follow-up guards and failures without a durable barrier remain unknown", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const foreign = await client
    .call("enqueueFollowUp", {
      id: "foreign:missing",
      text: "guard",
      operationId: "guard",
    })
    .catch((error) => error);
  expect(foreign).toBeInstanceOf(Error);
  expect(foreign).not.toBeInstanceOf(RequestRejected);
  const missing = await client
    .call("enqueueFollowUp", {
      id: qualify(f.service.identity.id, "missing"),
      text: "guard",
      operationId: "missing",
    })
    .catch((error) => error);
  expect(missing).toBeInstanceOf(Error);
  expect(missing).not.toBeInstanceOf(RequestRejected);
  let admissions = 0;
  f.app.enqueueFollowUp = async () => {
    admissions++;
    throw new Error("Fixture failed after admission");
  };
  const error = await client
    .call("enqueueFollowUp", {
      id,
      text: "once",
      operationId: "uncertain",
    })
    .catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RequestRejected);
  expect(admissions).toBe(1);
});

test("image ownership mismatch remains unknown until the original is finalized", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const operationId = await reserve(client, id);
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const images = await f.app.images.upload(agent.id, operationId, "original", [
    new File([png], "owned.png", { type: "image/png" }),
  ]);
  const send = { id, text: "original", operationId, images };
  const refusal = await client
    .call("send", { ...send, text: "changed" })
    .catch((e: unknown) => e);
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal).not.toBeInstanceOf(RequestRejected);
  expect((refusal as Error).message).toContain("Images do not belong");
  expect(f.runtime.inputs).toHaveLength(0);
  expect(f.app.lookup(agent.id, operationId)).toBeNull();
  const followUp = await client
    .call("enqueueFollowUp", { ...send, text: "changed" })
    .catch((e: unknown) => e);
  expect(followUp).toBeInstanceOf(Error);
  expect(followUp).not.toBeInstanceOf(RequestRejected);
  expect(f.app.lookupFollowUp(agent.id, operationId)).toBeNull();
  expect(
    await client.call("finalizeSubmission", {
      id,
      operationId,
      envelope: { source: "user", text: "original", images },
    }),
  ).toMatchObject({ state: "rejected" });
  await expect(client.call("send", send)).rejects.toThrow("not admitted");
  expect(f.runtime.inputs).toHaveLength(0);
});

test("image validation infrastructure errors stay unknown", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const operationId = await reserve(client, id);
  f.app.images.validate = () => {
    throw new Error("Synthetic storage error");
  };
  const error = await client
    .call("send", {
      id,
      text: "test",
      operationId,
      images: [
        {
          id: "0".repeat(64),
          name: "test.png",
          width: 1,
          height: 1,
          bytes: 1,
          mediaType: "image/png",
        },
      ],
    })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RequestRejected);
  expect((error as Error).message).toContain("Synthetic storage error");
  expect(f.runtime.inputs).toHaveLength(0);
});

test("unreadable history leaves the original rejection and does not authorize a retry", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const operationId = await reserve(client, id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("First rejected");
  };
  await client.call("send", { id, text: "original", operationId });
  expect(f.app.lookup(agent.id, operationId)?.state).toBe("rejected");
  const history = f.runtime.historyMessages.bind(f.runtime);
  f.runtime.historyMessages = async () => {
    throw new Error("History unavailable");
  };
  const error = await client
    .call("reserveRetry", { id, operationId })
    .catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RequestRejected);
  expect((error as Error).message).toContain("History unavailable");
  expect(f.runtime.inputs.map((input) => input.clientId)).toEqual([
    operationId,
  ]);
  f.runtime.historyMessages = history;
  f.runtime.sendOverride = async () => {
    throw new Error("Synthetic unknown admission");
  };
  const retry = await client.call<{
    state: "won";
    operationId: string;
    claimToken: string;
  }>("reserveRetry", { id, operationId });
  expect(retry.state).toBe("won");
  await client.call("send", {
    id,
    text: "original",
    operationId: retry.operationId,
    predecessor: { source: "user", text: "original" },
    claimToken: retry.claimToken,
  });
  expect(f.app.lookup(agent.id, operationId)?.state).toBe("rejected");
  expect(f.app.lookup(agent.id, retry.operationId)).toBeNull();
  expect(f.runtime.inputs.map((input) => input.clientId)).toEqual([
    operationId,
    retry.operationId,
  ]);
});

test("native acceptance and failed persistence never become a retry rejection", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const operationId = await reserve(client, id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("First rejected");
  };
  await client.call("send", { id, text: "original", operationId });
  f.runtime.historyItems.set(agent.threadId!, [
    {
      id: "native-item",
      clientId: operationId,
      role: "user",
      text: "original",
      at: 1,
    },
  ]);
  const save = (f.app as any).save;
  (f.app as any).save = () => {
    throw new Error("Synthetic persistence failure");
  };
  const error = await client
    .call("reserveRetry", { id, operationId })
    .catch((e) => e);
  (f.app as any).save = save;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RequestRejected);
  expect((error as Error).message).toContain("Synthetic persistence failure");
  expect(f.runtime.inputs.map((input) => input.clientId)).toEqual([
    operationId,
  ]);
  expect(f.app.lookup(agent.id, operationId)?.state).toBe("accepted");
});

test("native history acceptance prevents retry and remains authoritative", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const operationId = await reserve(client, id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("First rejected");
  };
  await client.call("send", { id, text: "original", operationId });
  f.runtime.historyItems.set(agent.threadId!, [
    {
      id: "native-item",
      clientId: operationId,
      role: "user",
      text: "original",
      at: 1,
    },
  ]);
  const error = await client
    .call("reserveRetry", { id, operationId })
    .catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RequestRejected);
  expect(f.app.lookup(agent.id, operationId)?.state).toBe("accepted");
  expect(f.runtime.inputs.map((input) => input.clientId)).toEqual([
    operationId,
  ]);
});

test("native acceptance observed during a retry history read prevents another admission", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const operationId = await reserve(client, id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("First rejected");
  };
  await client.call("send", { id, text: "original", operationId });
  const entered = Promise.withResolvers<void>();
  const history = Promise.withResolvers<{
    messages: never[];
    nextCursor: null;
  }>();
  f.runtime.historyMessages = async () => {
    entered.resolve();
    return history.promise;
  };
  const retry = client
    .call("reserveRetry", { id, operationId })
    .catch((e) => e);
  try {
    await entered.promise;
    f.runtime.emit(agent.id, {
      type: "item",
      turnId: "native-turn",
      item: {
        type: "userMessage",
        id: "native-race",
        clientId: operationId,
        text: "original",
      },
    });
    history.resolve({ messages: [], nextCursor: null });
    const error = await retry;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RequestRejected);
    expect(f.app.lookup(agent.id, operationId)?.state).toBe("accepted");
    expect(f.runtime.inputs.map((input) => input.clientId)).toEqual([
      operationId,
    ]);
  } finally {
    history.resolve({ messages: [], nextCursor: null });
  }
});

test("disconnect releases observation while an admitted send completes once", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const subscribe = f.service.subscribe.bind(f.service);
  let observers = 0;
  f.service.subscribe = (listener) => {
    observers++;
    const off = subscribe(listener);
    return () => {
      observers--;
      return off();
    };
  };
  const gate = Promise.withResolvers<string>();
  f.runtime.sendOverride = () => gate.promise;
  let offline = 0;
  const client = await f.client(
    () => {},
    () => offline++,
  );
  try {
    expect(observers).toBe(1);
    const disconnectOp = await reserve(client, id);
    const pending = client
      .call("send", {
        id,
        text: "once across disconnect",
        operationId: disconnectOp,
      })
      .catch((error: unknown) => error);
    await until(() => f.runtime.inputs.length === 1);
    client.close();
    const result = await pending;
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(RequestRejected);
    await until(() => observers === 0);
    expect(offline).toBe(1);
    gate.resolve("disconnect-turn");
    await until(() => f.app.detail(agent.id).deliveries[0]?.status === "sent");
    const fresh = await f.client();
    const receipt = await fresh.call<Receipt>("lookup", {
      id,
      operationId: disconnectOp,
    });
    expect(receipt.state).toBe("accepted");
    expect(f.runtime.inputs).toHaveLength(1);
  } finally {
    gate.resolve("disconnect-turn");
    client.close();
  }
});

test("#5335 timed out native input completes once and remains queryable by original ID", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client(
    () => {},
    () => {},
    100,
  );
  const { operationId } = await client.call<{ operationId: string }>(
    "reserveSubmission",
    { id },
  );
  const gate = Promise.withResolvers<string>();
  f.runtime.sendOverride = () => gate.promise;
  try {
    const submitted = client
      .call("send", { id, operationId, text: "once" })
      .catch((error) => error);
    await until(() => f.runtime.inputs.length === 1);
    expect(await submitted).toBeInstanceOf(RequestTimeout);
    expect(await client.call("lookup", { id, operationId })).toBeNull();
    gate.resolve("native-turn");
    await until(
      () => f.app.lookup(agent.id, operationId)?.state === "accepted",
    );
    expect(await client.call("lookup", { id, operationId })).toMatchObject({
      state: "accepted",
      operationId,
    });
    await client.call("send", { id, operationId, text: "once" });
    expect(
      f.runtime.inputs.filter((input) => input.clientId === operationId),
    ).toHaveLength(1);
    expect(await client.call("select", { ids: [] })).toBeNull();
  } finally {
    gate.resolve("native-turn");
  }
});

test("#5335 follow-up full barrier defeats a late same-ID call after room and restart", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  await f.app.send(agent.id, "start", "fixture-start");
  for (let i = 0; i < 50; i++)
    await f.app.enqueueFollowUp(agent.id, `queued ${i}`, `queued-${i}`);
  const id = qualify(f.service.identity.id, agent.id);
  const first = await f.client();
  const second = await f.client();
  const gate = Promise.withResolvers<void>();
  const enqueue = f.app.enqueueFollowUp.bind(f.app);
  let held = false;
  f.app.enqueueFollowUp = async (...args) => {
    if (args[2] === "same-id" && !held) {
      held = true;
      await gate.promise;
    }
    return enqueue(...args);
  };
  try {
    const late = first
      .call("enqueueFollowUp", { id, operationId: "same-id", text: "once" })
      .catch((error) => error);
    await until(() => held);
    const rejected = await second
      .call("enqueueFollowUp", { id, operationId: "same-id", text: "once" })
      .catch((error) => error);
    expect(rejected).toBeInstanceOf(RequestRejected);
    expect((rejected as Error).message).toContain("queue is full");
    await second.call("cancelFollowUp", { id, operationId: "queued-0" });
    gate.resolve();
    expect(await late).toBeInstanceOf(RequestRejected);
    expect(
      f.runtime.inputs.filter((input) => input.clientId === "same-id"),
    ).toHaveLength(0);
    f.restart();
    const reconnected = await f.client();
    expect(
      await reconnected.call("lookupFollowUp", { id, operationId: "same-id" }),
    ).toMatchObject({ status: "cancelled", error: "Follow-up queue is full" });
    await expect(
      reconnected.call("enqueueFollowUp", {
        id,
        operationId: "same-id",
        text: "once",
      }),
    ).rejects.toBeInstanceOf(RequestRejected);
    expect(f.app.lookupFollowUp(agent.id, "same-id")?.status).toBe("cancelled");
  } finally {
    gate.resolve();
  }
});

test("#5335 follow-up barrier storage failure remains unknown", async () => {
  const f = fixture("ordered");
  const agent = await f.app.createOrc("alpha");
  await f.app.send(agent.id, "start", "fixture-start");
  for (let i = 0; i < 50; i++)
    await f.app.enqueueFollowUp(agent.id, `queued ${i}`, `queued-${i}`);
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  f.app.store.sqlite.exec(
    "CREATE TRIGGER fail_rejection BEFORE INSERT ON deliveries WHEN NEW.operation_id='storage-failure' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END",
  );
  const error = await client
    .call("enqueueFollowUp", {
      id,
      operationId: "storage-failure",
      text: "once",
    })
    .catch((value) => value);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RequestRejected);
  expect(
    f.runtime.inputs.filter((input) => input.clientId === "storage-failure"),
  ).toHaveLength(0);
});

test("reservation and retry relations cannot cross the owning Peer", async () => {
  const left = fixture("ordered"),
    right = fixture("ordered");
  const agent = await left.app.createOrc("alpha");
  const agentId = qualify(left.service.identity.id, agent.id);
  const rc = await right.client();
  const { operationId } = await left.service.reserveSubmission(agentId);
  const envelope = { source: "user" as const, text: "peer-bound" };
  expect(
    await left.service.finalizeSubmission(agentId, operationId, envelope),
  ).toMatchObject({ state: "rejected" });
  for (const [member, input] of [
    ["reserveRetry", { id: agentId, operationId }],
    ["inspectRetry", { id: agentId, operationId, envelope }],
    ["finalizeSubmission", { id: agentId, operationId, envelope }],
    ["send", { id: agentId, operationId, text: envelope.text }],
  ] as const)
    await expect(rc.call(member, input)).rejects.toThrow("another Peer");
  const current = await left.service.reserveSubmission(agentId);
  const lc = await left.client();
  await lc.call("send", {
    id: agentId,
    operationId: current.operationId,
    text: "once",
  });
  await lc.call("send", {
    id: agentId,
    operationId: current.operationId,
    text: "once",
  });
  expect(
    await lc.call("lookup", { id: agentId, operationId: current.operationId }),
  ).toMatchObject({ state: "accepted" });
  expect(left.runtime.inputs.map((input) => input.clientId)).toEqual([
    current.operationId,
  ]);
  expect(right.runtime.inputs).toHaveLength(0);
  expect(await left.service.lookup(agentId, operationId)).toBeNull();
});
