import {
  createHost,
  webSocketLink,
  type WebSocketLike,
} from "@earendil-works/chord";
import {
  Grove,
  inputs,
  jsonValue,
  viewSchema,
  type Method,
  type View,
} from "./chord-contract";

export const MAX_FRAME = 2 * 1024 * 1024;

export class RequestRejected extends Error {}
export class RequestTimeout extends Error {
  constructor(readonly member: string) {
    super("Response timed out. Outcome unknown.");
    this.name = "RequestTimeout";
  }
}

export async function openGrove(
  socket: WebSocket,
  changed: (view: View) => void,
  offline: () => void,
  timeoutMs = 30_000,
  timedOut: (member: string) => void = () => {},
) {
  let closed = false;
  let pending = 0;
  let unsubscribe = () => {};
  const encoder = new TextEncoder();
  // Chord's WebSocket link supplies framing; keep Grove's existing frame and
  // backpressure limits around it, including on the browser side.
  const bounded: WebSocketLike = {
    get readyState() {
      return socket.readyState;
    },
    send(data) {
      if (
        typeof data !== "string" ||
        encoder.encode(data).byteLength > MAX_FRAME ||
        socket.bufferedAmount > 2 * MAX_FRAME
      ) {
        socket.close(1002, "Connection overloaded");
        throw new Error("Connection overloaded");
      }
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    addEventListener(type: string, listener: (event: any) => void) {
      if (type === "message") {
        socket.addEventListener("message", (event) => {
          if (
            typeof event.data !== "string" ||
            encoder.encode(event.data).byteLength > MAX_FRAME
          ) {
            socket.close(1002, "Invalid frame");
            return;
          }
          listener(event);
        });
      } else {
        socket.addEventListener(type as "open" | "close" | "error", listener);
      }
    },
  };
  const link = webSocketLink(bounded, { acceptPacked: false });
  const host = createHost({
    name: "browser",
    self: "browser",
    kind: "client",
    readyTimeout: 10_000,
    upstream: { link, principal: "server" },
  });
  let release = () => {};
  const finish = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    release();
    void host.close().catch(() => {});
    offline();
  };
  link.onClose(finish);
  socket.addEventListener("error", () => socket.close());

  try {
    // Register the Chord link before awaiting open: the server may send its
    // hello immediately, and that message must not be lost between events.
    if (socket.readyState !== WebSocket.OPEN)
      await new Promise<void>((resolve, reject) => {
        if (socket.readyState !== WebSocket.CONNECTING) {
          reject(new Error("Connection failed"));
          return;
        }
        const timer = setTimeout(() => {
          socket.close();
          done();
          reject(new Error("Connection timed out"));
        }, 10_000);
        const done = () => {
          clearTimeout(timer);
          socket.removeEventListener("open", opened);
          socket.removeEventListener("close", failed);
          socket.removeEventListener("error", failed);
        };
        const opened = () => {
          done();
          resolve();
        };
        const failed = () => {
          done();
          reject(new Error("Connection failed"));
        };
        socket.addEventListener("open", opened, { once: true });
        socket.addEventListener("close", failed, { once: true });
        socket.addEventListener("error", failed, { once: true });
      });
    const service = await host.get(Grove, {});
    if (closed) {
      service.release();
      throw new Error("Connection offline. Outcome unknown.");
    }
    release = () => service.release();
    unsubscribe = service.view.subscribe((value) => {
      try {
        changed(viewSchema.parse(value));
      } catch {
        socket.close(1002, "Invalid view");
        finish();
      }
    });
    if (closed) throw new Error("Invalid view");
    return {
      async call<T>(member: Method, input: unknown): Promise<T> {
        if (closed || socket.readyState !== WebSocket.OPEN)
          throw new Error("Connection offline. Outcome unknown.");
        if (pending >= 256) throw new Error("Too many pending requests");
        const parsed = jsonValue(inputs[member].parse(input));
        const controller = new AbortController();
        const operation = host.root(
          (ctx) => service.execute({ member, input: parsed }, ctx),
          { signal: controller.signal },
        );
        pending++;
        void operation.then(
          () => pending--,
          () => pending--,
        );
        const result = await new Promise<Awaited<typeof operation>>(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new RequestTimeout(member));
              controller.abort();
              timedOut(member);
            }, timeoutMs);
            operation.then(
              (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              (error) => {
                clearTimeout(timer);
                reject(error);
              },
            );
          },
        );
        if (result.ok) return result.value as T;
        if (result.outcome === "rejected")
          throw new RequestRejected(result.error);
        throw new Error(result.error);
      },
      close() {
        socket.close();
        finish();
      },
    };
  } catch (error) {
    socket.close();
    finish();
    throw error;
  }
}

export type GroveClient = Awaited<ReturnType<typeof openGrove>>;
