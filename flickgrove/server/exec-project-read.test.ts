import { expect, test } from "bun:test";
import { execProjectRead } from "./exec-project-read";

test("executor reads are isolated, bounded and fail closed", async () => {
  let connections = 0;
  const sockets = new Set<import("bun").ServerWebSocket<{ mode: string }>>();
  let started!: () => void,
    terminated = false;
  const processStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = Bun.serve<{ mode: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      expect(request.headers.get("authorization")).toBe("Bearer owned-token");
      if (
        server.upgrade(request, {
          data: { mode: new URL(request.url).pathname },
        })
      )
        return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        connections++;
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, data) {
        const message = JSON.parse(String(data));
        if (message.method === "initialize")
          ws.send(JSON.stringify({ id: 1, result: { sessionId: "owned" } }));
        if (message.method === "process/start") {
          expect(message.params.argv).toEqual([
            "python3",
            "-c",
            "script",
            "data",
          ]);
          expect(message.params.envPolicy.includeOnly).toContain("HOME");
          ws.send(JSON.stringify({ id: 2, result: { processId: "read" } }));
          if (ws.data.mode === "/disconnect") return ws.close();
          if (ws.data.mode === "/wait") {
            started();
            return;
          }
          const send = (method: string, params: object) =>
            ws.send(
              JSON.stringify({
                method,
                params: { processId: "read", ...params },
              }),
            );
          send("process/output", {
            seq: ws.data.mode === "/gap" ? 2 : 1,
            stream: "stdout",
            chunk: Buffer.from('{"ok":true}').toString("base64"),
          });
          send("process/exited", { seq: 2, exitCode: 0 });
          send("process/closed", { seq: 3 });
        }
        if (message.method === "process/terminate") {
          terminated = true;
          ws.send(JSON.stringify({ id: 3, result: { running: true } }));
        }
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}`;
  try {
    const results = await Promise.all(
      ["/one", "/two"].map((path) =>
        execProjectRead(url + path, "owned-token", "script", "data"),
      ),
    );
    expect(results).toEqual(['{"ok":true}', '{"ok":true}']);
    await expect(
      execProjectRead(url + "/gap", "owned-token", "script", "data"),
    ).rejects.toThrow();
    await expect(
      execProjectRead(url + "/disconnect", "owned-token", "script", "data"),
    ).rejects.toThrow();
    const controller = new AbortController();
    const pending = execProjectRead(
      url + "/wait",
      "owned-token",
      "script",
      "data",
      controller.signal,
    );
    await Promise.race([
      processStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("wait fixture did not start")), 3000),
      ),
    ]);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(terminated).toBe(true);
    expect(connections).toBeGreaterThanOrEqual(4);
  } finally {
    for (const socket of sockets) socket.terminate();
    void server.stop(true);
  }
}, 30000);
