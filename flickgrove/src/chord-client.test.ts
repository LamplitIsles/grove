import { expect, test } from "bun:test";
import {
  createHost,
  webSocketLink,
  type WebSocketLike,
} from "@earendil-works/chord";
import { Grove, type GroveResult } from "./chord-contract";
import {
  MAX_FRAME,
  openGrove,
  RequestRejected,
  RequestTimeout,
} from "./chord-client";

// A test-owned ordered socket pair exercises the public Chord link without
// starting a server, reading user state or contacting a network service.
class Socket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  peer!: Socket;
  send(data: string | Uint8Array) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("closed");
    queueMicrotask(() => {
      if (this.peer.readyState === WebSocket.OPEN)
        this.peer.dispatchEvent(new MessageEvent("message", { data }));
    });
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
    if (this.peer.readyState !== WebSocket.CLOSED) {
      this.peer.readyState = WebSocket.CLOSED;
      this.peer.dispatchEvent(new Event("close"));
    }
  }
}

test("client receives the server hello sent immediately when the socket opens", async () => {
  const browser = new Socket();
  const server = new Socket();
  browser.peer = server;
  server.peer = browser;
  browser.readyState = WebSocket.CONNECTING;
  const host = createHost({ name: "server", self: "server" });
  host.serve(Grove, (_input, _principal, self) => ({
    variant: "default" as const,
    view: self.state(
      "view",
      {},
      {
        snapshot: { revision: 1, settings: null, agents: [] },
        details: {},
      },
    ),
    execute: () => ({ ok: true, value: null }),
  }));
  host.accept(webSocketLink(server as unknown as WebSocketLike), {
    principal: "browser",
    kind: "client",
  });
  const opening = openGrove(
    browser as unknown as WebSocket,
    () => {},
    () => {},
  );
  browser.readyState = WebSocket.OPEN;
  browser.dispatchEvent(new Event("open"));
  const client = await opening;
  try {
    expect(await client.call("select", { ids: [] })).toBeNull();
  } finally {
    client.close();
    await host.close();
  }
});

test("Chord client preserves explicit rejection, unknown outcomes and cleanup", async () => {
  const browser = new Socket();
  const server = new Socket();
  browser.peer = server;
  server.peer = browser;
  const host = createHost({ name: "server", self: "server" });
  const delayed = Promise.withResolvers<GroveResult>();
  let calls = 0;
  host.serve(Grove, (_input, _principal, self) => ({
    variant: "default" as const,
    view: self.state(
      "view",
      {},
      {
        snapshot: { revision: 1, settings: null, agents: [] },
        details: {},
      },
    ),
    async execute({ member }) {
      calls++;
      if (member === "identity")
        return { ok: false, outcome: "rejected", error: "Refused" };
      if (member === "projects")
        return { ok: false, outcome: "unknown", error: "Outcome unknown" };
      if (member === "environments") return await delayed.promise;
      return { ok: true, value: null };
    },
  }));
  host.accept(webSocketLink(server as unknown as WebSocketLike), {
    principal: "browser",
    kind: "client",
  });
  const views: unknown[] = [];
  const timeouts: string[] = [];
  let offline = 0;
  const client = await openGrove(
    browser as unknown as WebSocket,
    (view) => views.push(view),
    () => offline++,
    20,
    (member) => timeouts.push(member),
  );
  try {
    expect(views).toHaveLength(1);
    await expect(client.call("identity", {})).rejects.toBeInstanceOf(
      RequestRejected,
    );
    const unknown = await client.call("projects", {}).catch((error) => error);
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown).not.toBeInstanceOf(RequestRejected);
    const timeout = await client
      .call("environments", {})
      .catch((error) => error);
    expect(timeout).toBeInstanceOf(RequestTimeout);
    if (!(timeout instanceof RequestTimeout))
      throw new Error("Expected RequestTimeout");
    expect(timeout.member).toBe("environments");
    expect(timeouts).toEqual(["environments"]);
    expect(calls).toBe(3);
    delayed.resolve({ ok: true, value: [] });
    expect(await client.call("select", { ids: [] })).toBeNull();
    expect(calls).toBe(4);
  } finally {
    client.close();
    await host.close();
  }
  expect(offline).toBe(1);
});

test("Chord client closes an oversized inbound frame", async () => {
  const browser = new Socket();
  const server = new Socket();
  browser.peer = server;
  server.peer = browser;
  const host = createHost({ name: "server", self: "server" });
  host.serve(Grove, (_input, _principal, self) => ({
    variant: "default" as const,
    view: self.state(
      "view",
      {},
      {
        snapshot: { revision: 1, settings: null, agents: [] },
        details: {},
      },
    ),
    execute: () => ({ ok: true, value: null }),
  }));
  host.accept(webSocketLink(server as unknown as WebSocketLike), {
    principal: "browser",
    kind: "client",
  });
  let offline = 0;
  const client = await openGrove(
    browser as unknown as WebSocket,
    () => {},
    () => offline++,
  );
  try {
    browser.dispatchEvent(
      new MessageEvent("message", { data: "x".repeat(MAX_FRAME + 1) }),
    );
    expect(offline).toBe(1);
    await expect(client.call("identity", {})).rejects.toThrow();
  } finally {
    client.close();
    await host.close();
  }
  expect(offline).toBe(1);
});
