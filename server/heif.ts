import { Worker } from "node:worker_threads";

/** Decode a bounded primary HEIF image off the server event loop. */
export function decodeHeif(bytes: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./heif-worker.ts", import.meta.url));
    let settled = false;
    const finish = (error?: Error, output?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(Buffer.from(output!));
    };
    const timer = setTimeout(
      () => finish(new Error("HEIF image decoding timed out")),
      60_000,
    );
    worker.once("error", (error) =>
      finish(error instanceof Error ? error : new Error("HEIF decoder failed")),
    );
    worker.once("exit", (code) =>
      finish(new Error(`HEIF decoder stopped (${code})`)),
    );
    worker.once(
      "message",
      (result: { output?: Uint8Array; error?: string }) => {
        if (result.error || !result.output)
          finish(new Error(result.error ?? "Could not decode HEIF image"));
        else finish(undefined, result.output);
      },
    );
    worker.postMessage({ bytes, maxBytes });
  });
}
