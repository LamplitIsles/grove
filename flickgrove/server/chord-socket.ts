// Provider framing adapted from LamplitIsles/lamplit-app contracts/server.ts (Apache-2.0).
// See licenses/lamplit-app-Apache-2.0.txt. Socket disposal never cancels execution.
import {
  createHost,
  webSocketLink,
  type Cell,
  type WebSocketLike,
} from "@earendil-works/chord";
import type { ServerWebSocket } from "bun";
import {
  Grove,
  inputs,
  jsonValue,
  type Method,
  type View,
  type GroveResult,
} from "../src/chord-contract";
const MAX_FRAME = 2 * 1024 * 1024;
import { invoke } from "./chord-methods";
import { DeliveryRejected, RequestRefused } from "./runtime";
import type { HostService } from "./hosts";
import { voiceRelay, type VoiceSocketData } from "./voice";

type Channel = ReturnType<typeof connect>;
export type SocketData = {
  voice?: VoiceSocketData;
  auth?: import("./auth").GroveAuth;
  human?: import("./auth").HumanSession | null;
  authHeaders?: Headers;
  unbindAuth?: () => void;
  authExpiry?: ReturnType<typeof setTimeout>;
  app: HostService;
  service: HostService;
  channel?: Channel;
  heartbeat?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  ping?: string;
};
function connect(socket: ServerWebSocket<SocketData>) {
  const { app, service } = socket.data;
  const users = () =>
    socket.data.auth && socket.data.human
      ? { users: socket.data.auth.users() }
      : {};
  let view: Cell<unknown> | undefined;
  const host = createHost<{ userId: string | undefined }>({
    name: "server",
    self: { userId: undefined as string | undefined },
  });
  let disposed = false,
    selection: string[] = [],
    generation = 0,
    dirty = false;
  let refreshTask: Promise<void> | undefined,
    unobserve = () => {};
  const refresh = () => {
    dirty = true;
    return (refreshTask ??= (async () => {
      while (dirty && !disposed) {
        dirty = false;
        const gen = generation;
        const ids = [...selection];
        const details = Object.fromEntries(
          (
            await Promise.all(
              ids.map(async (id) => {
                try {
                  return [id, await app.detail(id)] as const;
                } catch {
                  return null;
                }
              }),
            )
          ).filter((x) => x !== null),
        );
        if (disposed) return;
        if (gen !== generation) {
          dirty = true;
          continue;
        }
        const next = jsonValue<View>({
          snapshot: app.snapshot(),
          details,
          ...users(),
        });
        if (view && JSON.stringify(view.value) !== JSON.stringify(next))
          await host.root((ctx) => {
            if (!disposed && view) view.replace(ctx, next);
          });
      }
    })().finally(() => {
      refreshTask = undefined;
      if (dirty && !disposed)
        void refresh().catch(() => socket.close(1011, "State unavailable"));
    }));
  };
  // One Chord host per socket keeps selection, subscriptions and principal local
  // to the authenticated connection. The client cannot choose the principal.
  host.serve(Grove, (_input, principal, self) => {
    view = self.state(
      "view",
      {},
      jsonValue<View>({ snapshot: app.snapshot(), details: {}, ...users() }),
    );
    return {
      variant: "default" as const,
      view,
      async execute(args): Promise<GroveResult> {
        let invoked = false;
        try {
          const { member, input } = args as { member: string; input: unknown };
          if (!Object.hasOwn(inputs, member)) throw new Error("Invalid method");
          if (member === "select") {
            const p = inputs.select.parse(input);
            if (p.ids.length > 1)
              throw new Error("Select one visible conversation");
            const gen = ++generation;
            const background: string[] = [];
            for (const id of p.ids) {
              const detail = await app.detail(id);
              if (
                (detail.backend ?? "codex") === "codex" &&
                (detail.project.environment?.id ?? "local") === "local"
              )
                background.push(id);
              else {
                await app.synchronizeDetail(id).catch(() => app.detail(id));
                await app.reconcileSettings(id).catch(() => {});
              }
            }
            if (gen === generation && !disposed) {
              selection = p.ids;
              unobserve();
              unobserve = () => {};
              await refresh();
              for (const id of background) {
                void app.synchronizeDetail(id).catch(() => {});
                void app.reconcileSettings(id).catch(() => {});
              }
            }
            return { ok: true, value: null };
          }
          if (member === "identity") {
            inputs.identity.parse(input);
            return { ok: true, value: jsonValue(service.identity) };
          }
          if (socket.data.auth) {
            const session =
              socket.data.authHeaders &&
              (await socket.data.auth.session(socket.data.authHeaders));
            if (
              !session ||
              session.user.id !== principal.userId ||
              session.sessionId !== socket.data.human?.sessionId
            ) {
              socket.close(1008, "Session expired");
              throw new Error("Authentication required");
            }
          }
          const parsed = inputs[member as Method].parse(input);
          invoked = true;
          return {
            ok: true,
            value: jsonValue(
              (await invoke(app, member as Method, parsed, principal.userId)) ??
                null,
            ),
          };
        } catch (error) {
          return {
            ok: false,
            outcome:
              !invoked ||
              error instanceof DeliveryRejected ||
              error instanceof RequestRefused
                ? "rejected"
                : "unknown",
            error: error instanceof Error ? error.message : "Request failed",
          };
        }
      },
    };
  });
  const off = app.subscribe(() => {
    void refresh().catch(() => socket.close(1011, "State unavailable"));
  });
  const offUsers = socket.data.human
    ? socket.data.auth?.onUsersChanged(() => {
        void refresh().catch(() => socket.close(1011, "State unavailable"));
      })
    : undefined;
  // Bun's server socket is not a WHATWG WebSocket. This adapter preserves the
  // existing text-only, 2 MiB and backpressure boundaries around Chord's link.
  const events = new Map<string, Array<(event?: any) => void>>();
  const adapter: WebSocketLike = {
    get readyState() {
      return disposed ? 3 : 1;
    },
    send(raw) {
      if (typeof raw !== "string") {
        socket.close(1002, "Text frames required");
        dispose();
        return;
      }
      const bytes = new TextEncoder().encode(raw).byteLength;
      if (
        bytes > MAX_FRAME ||
        socket.getBufferedAmount() + bytes > 2 * MAX_FRAME ||
        socket.send(raw) === 0
      ) {
        socket.close(1013, "Reconnect to synchronize");
        dispose();
      }
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    addEventListener(type: string, listener: (event: any) => void) {
      const listeners = events.get(type) ?? [];
      listeners.push(listener);
      events.set(type, listeners);
    },
  };
  const link = webSocketLink(adapter, { acceptPacked: false });
  host.accept(link, {
    principal: { userId: socket.data.human?.user.id },
    kind: "client",
    maxCalls: 256,
  });
  const holds = new Set<number>();
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    off();
    offUsers?.();
    unobserve();
    for (const listener of events.get("close") ?? []) listener();
    events.clear();
    void host.close().catch(() => {});
  }
  function receive(raw: string) {
    if (disposed) return;
    try {
      if (new TextEncoder().encode(raw).byteLength > MAX_FRAME)
        throw new Error("Frame too large");
      const frame: unknown = JSON.parse(raw);
      if (!frame || typeof frame !== "object" || Array.isArray(frame))
        throw new Error("Invalid frame");
      const f = frame as { t?: unknown; id?: unknown };
      if (f.t === "hold" && typeof f.id === "number") {
        if (holds.size >= 1 || holds.has(f.id))
          throw new Error("Already subscribed");
        holds.add(f.id);
      } else if (
        f.t === "release" &&
        typeof f.id === "number" &&
        holds.has(f.id)
      ) {
        // This connection owns exactly one view. Releasing it ends observation.
        socket.close(1000, "View released");
        dispose();
        return;
      }
      for (const listener of events.get("message") ?? [])
        listener({ data: raw });
    } catch {
      socket.close(1002, "Invalid frame");
      dispose();
    }
  }

  return { receive, dispose };
}
export const groveWebsocket = {
  maxPayloadLength: MAX_FRAME,
  idleTimeout: 0,
  sendPings: false,
  open(socket: ServerWebSocket<SocketData>) {
    if (socket.data.auth && socket.data.human) {
      const human = socket.data.human;
      const expire = () => {
        const remaining = human.expiresAt - Date.now();
        if (remaining <= 0) socket.terminate();
        else
          socket.data.authExpiry = setTimeout(
            expire,
            Math.min(remaining, 2_147_483_647),
          );
      };
      expire();
      socket.data.unbindAuth = socket.data.auth.onRevoke(
        (userId, sessionId) => {
          if (
            human.user.id === userId &&
            (!sessionId || human.sessionId === sessionId)
          )
            socket.terminate();
        },
      );
    }
    if (socket.data.voice) {
      socket.data.voice.relay = voiceRelay(socket, socket.data.voice);
      return;
    }
    socket.data.channel = connect(socket);
    socket.data.heartbeat = setInterval(() => {
      if (socket.data.ping) return;
      socket.data.ping = crypto.randomUUID();
      socket.ping(socket.data.ping);
      socket.data.deadline = setTimeout(() => {
        console.warn("[grove] browser pong timed out", {
          peerId: socket.data.service.identity.id,
        });
        socket.terminate();
      }, 10_000);
    }, 15_000);
  },
  message(socket: ServerWebSocket<SocketData>, message: string | Buffer) {
    if (socket.data.voice) {
      socket.data.voice.relay?.receive(message);
      return;
    }
    if (typeof message !== "string") {
      socket.close(1002, "Text frames required");
      return;
    }
    void socket.data.channel?.receive(message);
  },
  pong(socket: ServerWebSocket<SocketData>, payload: Buffer) {
    if (payload.toString() !== socket.data.ping) return;
    clearTimeout(socket.data.deadline);
    socket.data.ping = undefined;
  },
  close(socket: ServerWebSocket<SocketData>) {
    socket.data.unbindAuth?.();
    clearTimeout(socket.data.authExpiry);
    if (socket.data.voice) {
      socket.data.voice.relay?.dispose();
      return;
    }
    clearInterval(socket.data.heartbeat);
    clearTimeout(socket.data.deadline);
    socket.data.channel?.dispose();
  },
};
