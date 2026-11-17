// Isolated browser contract check: no live data, production assets, or frames
// intercepted. Run with an isolated HOME/TMPDIR and the applicable resource approval.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { Workspace } from "../server/workspace";
import { FakeRuntime, fixtureProjects } from "../server/testing";
import { HostService, qualify } from "../server/hosts";
import { createHandler, createUpgrade } from "../server/http";
import { groveWebsocket } from "../server/chord-socket";

const root = await mkdtemp(join(tmpdir(), "grove-chord-browser-"));
const cleanup: Array<() => void | Promise<void>> = [];
const gate = Promise.withResolvers<string>();
try {
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: root,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => app.dispose());
  let origin = "";
  const service = new HostService(app, {
    directory: root,
    origin: () => origin,
  });
  let observers = 0;
  const subscribe = service.subscribe.bind(service);
  service.subscribe = (listener) => {
    observers++;
    const release = subscribe(listener);
    return () => {
      observers--;
      return release();
    };
  };
  runtime.sendOverride = async () => gate.promise;
  const agent = await app.createOrc("alpha");
  const id = qualify(service.identity.id, agent.id);
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "chord-browser-client.ts")],
    target: "browser",
  });
  if (!build.success || !build.outputs[0])
    throw new Error("Browser bundle failed");
  const bundle = await build.outputs[0].text();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(
          '<script type="module" src="/fixture.js"></script>',
          {
            headers: { "content-type": "text/html" },
          },
        );
      if (path === "/fixture.js")
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      const options = { service, origin: () => origin };
      const upgraded = createUpgrade(app, options)(request, server);
      return upgraded === true
        ? undefined
        : (upgraded ?? createHandler(app, options)(request));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanup.push(() => {
    server.stop(true);
  });
  const until = async (check: () => boolean) => {
    const end = Date.now() + 5000;
    while (!check()) {
      if (Date.now() >= end) throw new Error("Fixture condition timed out");
      await Bun.sleep(10);
    }
  };
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-dev-shm-usage",
    ],
  });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => !!(globalThis as any).probe);
  await page.evaluate(() => (globalThis as any).probe.connect());
  await page.waitForFunction(
    () => (globalThis as any).probe.state.views.length > 0,
  );
  assert.equal(
    await page.evaluate(() => (globalThis as any).probe.rejected()),
    true,
  );
  await page.evaluate(async () => {
    const p = (globalThis as any).probe;
    await Promise.all(Array.from({ length: 20 }, () => p.call("projects", {})));
  });
  const models = await page.evaluate(() =>
    (globalThis as any).probe.call("models", {}),
  );
  assert.ok(Array.isArray(models) && models.length > 0);
  await page.evaluate(
    (id) => (globalThis as any).probe.call("select", { ids: [id] }),
    id,
  );
  await page.waitForFunction(
    (id) =>
      (globalThis as any).probe.state.views.some((v: any) => !!v.details[id]),
    id,
  );
  await page.evaluate((id) => (globalThis as any).probe.startSend(id), id);
  await until(() => runtime.inputs.length === 1);
  await page.evaluate(() => (globalThis as any).probe.close());
  assert.equal(
    await page.evaluate(() => (globalThis as any).probe.outcome()),
    "unknown",
  );
  await until(() => observers === 0);
  gate.resolve("browser-turn");
  await until(() => app.detail(agent.id).deliveries[0]?.status === "sent");
  await page.evaluate(() => (globalThis as any).probe.connect());
  const receipt = await page.evaluate(
    (id) =>
      (globalThis as any).probe.call("lookup", {
        id,
        operationId: "browser-once",
      }),
    id,
  );
  assert.equal(receipt.state, "accepted");
  assert.equal(runtime.inputs.length, 1);
  assert.deepEqual(pageErrors, []);
  console.log("Real Chromium Chord contract passed");
} finally {
  gate.resolve("browser-cleanup");
  let cleanupError: unknown;
  for (const close of cleanup.reverse()) {
    try {
      await close();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    console.error("Browser fixture cleanup failed");
    process.exitCode = 1;
  }
}
