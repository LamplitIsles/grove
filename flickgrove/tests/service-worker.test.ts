import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Evaluate the shipped service worker in an in-memory scope: no browser, no
// network and no source-text assertions.
const source = readFileSync(
  fileURLToPath(new URL("../public/sw.js", import.meta.url)),
  "utf8",
);

function workerScope() {
  const origin = "https://grove.test";
  const cached = new Map<string, Response>();
  const writes: string[] = [];
  const cache = {
    async put(request: Request | string, response: Response) {
      const key = typeof request === "string" ? request : request.url;
      writes.push(key);
      cached.set(key, response.clone());
    },
    async match(request: Request | string) {
      const key = typeof request === "string" ? request : request.url;
      return cached.get(key)?.clone();
    },
  };
  const caches = {
    async open() {
      return cache;
    },
    async keys() {
      return [];
    },
    async delete() {
      return true;
    },
  };
  let online = true;
  const reads: string[] = [];
  const fetch = async (request: Request) => {
    reads.push(request.url);
    if (!online) throw new TypeError("offline");
    return new Response("network", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const self = {
    location: { origin },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetch);
  const dispatch = async (path: string) => {
    const request = new Request(new URL(path, origin));
    let handled: Promise<Response> | undefined;
    const event = {
      request,
      respondWith(value: Response | Promise<Response>) {
        handled = Promise.resolve(value);
      },
    };
    for (const listener of listeners.get("fetch") ?? []) listener(event);
    return handled ? await handled : undefined;
  };
  return {
    origin,
    writes,
    reads,
    dispatch,
    offline: () => (online = false),
  };
}

test("GET /config-files is left to the network and never enters Cache Storage", async () => {
  const scope = workerScope();
  expect(await scope.dispatch("/config-files")).toBeUndefined();
  expect(
    await scope.dispatch("/config-files?path=%2Fetc%2Fpasswd"),
  ).toBeUndefined();
  // The worker neither fetched nor stored anything for that path.
  expect(scope.reads).toEqual([]);
  expect(scope.writes).toEqual([]);
});

test("ordinary same-origin GETs keep network-first caching and offline fallback", async () => {
  const scope = workerScope();
  const online = await scope.dispatch("/assets/app.js");
  expect(await online!.text()).toBe("network");
  expect(scope.reads).toEqual([`${scope.origin}/assets/app.js`]);
  expect(scope.writes).toEqual([`${scope.origin}/assets/app.js`]);
  // The cached response still serves the same asset when the network fails.
  scope.offline();
  const offline = await scope.dispatch("/assets/app.js");
  expect(await offline!.text()).toBe("network");
  // API and preview requests stay outside the cache on the same path rules.
  expect(await scope.dispatch("/api/snapshot")).toBeUndefined();
  expect(await scope.dispatch("/preview/file")).toBeUndefined();
});
