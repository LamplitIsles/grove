import { expect, test as base } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const test = base.extend({
  launchOptions: [
    async ({ launchOptions }, use) => {
      const directory = mkdtempSync(join(tmpdir(), "grove-browser-home-"));
      try {
        await use({
          ...launchOptions,
          args: [...(launchOptions.args ?? []), "--no-proxy-server"],
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_CACHE_HOME: join(directory, "cache"),
            TMPDIR: directory,
            NO_PROXY: "localhost,127.0.0.1",
            no_proxy: "localhost,127.0.0.1",
          },
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});

// Run the real CLI without --origin, using a free port and disposable state.
test("the advertised default address supports bootstrap and passkey sign-in", async ({
  browser,
}) => {
  test.setTimeout(45_000);
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const directory = mkdtempSync(join(tmpdir(), "grove-default-auth-"));
  for (const path of ["home", "state", "pi", "tmp"])
    mkdirSync(join(directory, path));
  const env = {
    PATH: process.env.PATH!,
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "home/config"),
    XDG_CACHE_HOME: join(directory, "home/cache"),
    TMPDIR: join(directory, "tmp"),
    PI_CODING_AGENT_DIR: join(directory, "pi"),
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  };
  const args = [
    "server/main.ts",
    "--port",
    String(port),
    "--state",
    join(directory, "state"),
    "--config",
    join(directory, "home/config/config.toml"),
    "--pi-agent-dir",
    join(directory, "pi"),
  ];
  const cwd = resolve(import.meta.dirname, "..");
  const server = spawn("bun", args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const advertised = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Server startup timed out")),
        15_000,
      );
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited during startup: ${code}`));
      });
      let output = "";
      server.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(
          /FlickGrove is available at (https?:\/\/\S+)/,
        );
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    const bootstrap = spawnSync("bun", [...args, "--auth", "bootstrap"], {
      cwd,
      env,
      encoding: "utf8",
    });
    expect(bootstrap.status).toBe(0);
    const code = JSON.parse(bootstrap.stdout).code;
    expect(code).toBeTruthy();
    // Bundle the same Better Auth client used by the UI, in memory. The test
    // document does not depend on the ignored production dist directory.
    const bundle = spawnSync(
      "bun",
      [
        "build",
        "tests/auth-default-client.ts",
        "--target",
        "browser",
        "--format",
        "iife",
      ],
      { cwd, env, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
    );
    expect(bundle.status).toBe(0);
    const html = `<html><body><script>${bundle.stdout.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
    context = await browser.newContext();
    const unexpectedRequests: string[] = [];
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== advertised) return route.abort();
      if (route.request().resourceType() === "document" && url.pathname === "/")
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: html,
        });
      if (!url.pathname.startsWith("/api/"))
        unexpectedRequests.push(url.pathname);
      return route.continue();
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    await page.addInitScript(() => {
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = async (...args) => {
        try {
          return await create(...args);
        } catch (error) {
          (window as any).__registrationError =
            `${(error as Error).name}: ${(error as Error).message}`;
          throw error;
        }
      };
    });
    await page.goto(advertised);
    await page.waitForFunction(() => (window as any).groveTest);
    expect(
      await page.evaluate(async (pairingCode) => {
        try {
          await (window as any).groveTest.register(pairingCode);
          return null;
        } catch (error) {
          return (
            (window as any).__registrationError ?? (error as Error).message
          );
        }
      }, code),
    ).toBeNull();
    const status = () =>
      page.evaluate(async () => (await fetch("/api/auth/status")).json());
    expect(await status()).toMatchObject({
      state: "signed_in",
      user: { name: "Test User" },
    });
    expect(unexpectedRequests).toEqual([]);
    await page.evaluate(() => (window as any).groveTest.signOut());
    expect(await status()).toMatchObject({ state: "signed_out" });
    await page.evaluate(() => (window as any).groveTest.signIn());
    expect(await status()).toMatchObject({
      state: "signed_in",
      user: { name: "Test User" },
    });
    const loopback = `http://127.0.0.1:${port}`;
    const proxyStatus = await fetch(`${loopback}/api/auth/status`, {
      headers: { Origin: loopback },
    });
    expect(proxyStatus.status).toBe(200);
    expect((await proxyStatus.json()).state).toBe("signed_out");
    expect((await fetch(`${advertised}/api/identity`)).status).toBe(401);
    expect((await fetch(`${loopback}/api/mcp/info`)).status).toBe(401);
    expect((await fetch(`${advertised}/api/mcp/info`)).status).toBe(403);
    expect(
      (
        await fetch(`${loopback}/api/auth/status`, {
          headers: { Origin: "https://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(advertised).toBe(`http://localhost:${port}`);
  } finally {
    await context?.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await once(server, "exit");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
