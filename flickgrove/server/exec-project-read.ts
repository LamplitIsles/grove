// A single connection owns a single bounded read. It is never exposed as a
// general-purpose execution API and is never resumed or replayed.
export async function execProjectRead(
  url: string,
  token: string,
  script: string,
  data: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined;
    let done = false,
      terminating = false,
      phase = 0,
      sequence = 1,
      exit: number | undefined,
      closed = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const pending = new Map<
      number,
      { method: string; chunk?: Buffer; stream?: string; exitCode?: number }
    >();
    const complete = (value?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(terminateTimer);
      signal?.removeEventListener("abort", abort);
      socket?.close();
      if (value === undefined) reject(new Error("Remote project read failed"));
      else resolve(value);
    };
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: string) => {
      if (done || terminating) return;
      if (
        value !== undefined ||
        closed ||
        phase === 0 ||
        socket?.readyState !== WebSocket.OPEN
      )
        return complete(value);
      terminating = true;
      try {
        socket.send(
          JSON.stringify({
            id: 3,
            method: "process/terminate",
            params: { processId: "read" },
          }),
        );
        terminateTimer = setTimeout(() => complete(), 500);
      } catch {
        complete();
      }
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 15000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    try {
      socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      socket.onopen = () =>
        socket!.send(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: { clientName: "flickgrove-project-read" },
          }),
        );
      socket.onerror = () => complete();
      socket.onclose = () => complete();
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (terminating) {
            if (message.id === 3) complete();
            return;
          }
          if (message.error) return finish();
          if (phase === 0 && message.id === 1 && message.result?.sessionId) {
            phase = 1;
            socket!.send(JSON.stringify({ method: "initialized", params: {} }));
            socket!.send(
              JSON.stringify({
                id: 2,
                method: "process/start",
                params: {
                  processId: "read",
                  argv: ["python3", "-c", script, data],
                  cwd: "file:///",
                  env: {},
                  tty: false,
                  pipeStdin: false,
                  arg0: null,
                  envPolicy: {
                    inherit: "all",
                    ignoreDefaultExcludes: false,
                    exclude: [],
                    set: {},
                    includeOnly: ["HOME", "PATH", "XDG_CONFIG_HOME"],
                  },
                },
              }),
            );
            return;
          }
          if (message.id === 2 && message.result?.processId === "read") {
            phase = 2;
            if (closed)
              finish(
                exit === 0 ? Buffer.concat(stdout).toString("utf8") : undefined,
              );
            return;
          }
          if (message.params?.processId !== "read") return finish();
          const seq = message.params.seq;
          if (
            !Number.isSafeInteger(seq) ||
            seq < sequence ||
            pending.has(seq) ||
            pending.size >= 10000
          )
            return finish();
          if (message.method === "process/output") {
            const { stream, chunk } = message.params;
            if (
              (stream !== "stdout" && stream !== "stderr") ||
              typeof chunk !== "string" ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                chunk,
              )
            )
              return finish();
            const decoded = Buffer.from(chunk, "base64");
            bytes += decoded.length;
            if (bytes > 29 * 1024 * 1024) return finish();
            pending.set(seq, {
              method: message.method,
              stream,
              chunk: decoded,
            });
          } else if (message.method === "process/exited") {
            if (!Number.isInteger(message.params.exitCode)) return finish();
            pending.set(seq, {
              method: message.method,
              exitCode: message.params.exitCode,
            });
          } else if (message.method === "process/closed") {
            pending.set(seq, { method: message.method });
          } else return finish();
          while (pending.has(sequence)) {
            const item = pending.get(sequence)!;
            pending.delete(sequence++);
            if (closed) return finish();
            if (item.method === "process/output" && item.stream === "stdout")
              stdout.push(item.chunk!);
            if (item.method === "process/exited") {
              if (exit !== undefined) return finish();
              exit = item.exitCode;
            }
            if (item.method === "process/closed") {
              if (exit === undefined || pending.size) return finish();
              closed = true;
              if (phase === 2)
                return finish(
                  exit === 0
                    ? Buffer.concat(stdout).toString("utf8")
                    : undefined,
                );
            }
          }
        } catch {
          finish();
        }
      };
    } catch {
      finish();
    }
  });
}
