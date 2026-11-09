import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { Database } from "bun:sqlite";

const [packageArg, workArg, sha] = process.argv.slice(2);
if (!packageArg || !workArg || !/^[a-f0-9]{40}$/.test(sha ?? ""))
  throw new Error(
    "Usage: package-smoke <installed package> <new test directory> <SHA>",
  );
const pkg = resolve(packageArg),
  work = resolve(workArg);
await mkdir(work);
await mkdir(join(work, "home"));
const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
assert.equal(manifest.name, "@lamplitisles/flickgrove");
assert.ok(manifest.version.endsWith(`snapshot.g${sha}`));
for (const resource of [
  "server/main.ts",
  "server/mcp.ts",
  "server/remote-project-read.py",
  "drizzle/meta/_journal.json",
  "skills/grove-code-review/SKILL.md",
  "templates/config.toml",
  "dist/index.html",
])
  await access(join(pkg, resource));
const { instanceVersion } = await import(
  join(pkg, "server/instance-version.ts")
);
assert.equal(instanceVersion(pkg, join(pkg, "dist")), sha.slice(0, 7));
const env = {
  HOME: join(work, "home"),
  XDG_CONFIG_HOME: join(work, "home", ".config"),
  XDG_DATA_HOME: join(work, "home", ".local/share"),
  PATH: process.env.PATH!,
  PI_CODING_AGENT_DIR: join(work, "pi"),
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
};
const fake = join(work, "fake-codex");
await writeFile(fake, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const socket = createServer();
await new Promise<void>((ok) => socket.listen(0, "127.0.0.1", ok));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((ok, fail) =>
  socket.close((error) => (error ? fail(error) : ok())),
);
const origin = `http://127.0.0.1:${port}`;
const child = Bun.spawn(
  [
    process.execPath,
    "--no-install",
    join(pkg, "server/main.ts"),
    "--port",
    String(port),
    "--origin",
    origin,
    "--state",
    join(work, "state"),
    "--config",
    join(work, "config", "config.toml"),
    "--codex",
    fake,
    "--pi-agent-dir",
    join(work, "pi"),
  ],
  { env, cwd: work, stdout: "pipe", stderr: "pipe" },
);
try {
  let response: Response | undefined;
  for (let i = 0; i < 100; i++) {
    try {
      response = await fetch(origin);
      break;
    } catch {
      await Bun.sleep(100);
    }
    if (child.exitCode !== null)
      throw new Error(
        `Server exited: ${await new Response(child.stderr).text()}`,
      );
  }
  assert.equal(response?.status, 200);
  assert.match(await response!.text(), /<html/);
  const version = await fetch(`${origin}/version.json`);
  assert.deepEqual(await version.json(), { commit: sha, dirty: false });
  assert.equal((await fetch(`${origin}/api/instance`)).status, 401);
  assert.deepEqual(
    await (
      await fetch(`${origin}/api/auth/status`, { headers: { Origin: origin } })
    ).json(),
    { state: "setup" },
  );
  const db = new Database(join(work, "state", "workspace.sqlite"), {
    readonly: true,
  });
  assert.ok(
    db.query("SELECT count(*) AS n FROM __drizzle_migrations").get().n > 0,
  );
  db.close();
  const fakeBridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      assert.equal(new URL(request.url).pathname, "/api/mcp/info");
      assert.equal(
        request.headers.get("authorization"),
        "Bearer fixture-token",
      );
      return Response.json({ tools: [] });
    },
  });
  const mcp = Bun.spawn(
    [process.execPath, "--no-install", join(pkg, "server/mcp.ts")],
    {
      env: {
        ...env,
        FLICKGROVE_ORIGIN: `http://127.0.0.1:${fakeBridge.port}`,
        FLICKGROVE_AGENT_TOKEN: "fixture-token",
      },
      cwd: work,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    mcp.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "package-fixture", version: "1" },
        },
      }) + "\n",
    );
    const reader = mcp.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(5000).then(() => {
        throw new Error("MCP fixture timed out");
      }),
    ]);
    assert.equal(JSON.parse(new TextDecoder().decode(first.value)).id, 1);
  } finally {
    mcp.kill();
    await mcp.exited;
    fakeBridge.stop();
  }
  console.log(`Installed package smoke passed for ${manifest.version}`);
} finally {
  child.kill();
  await child.exited;
}
