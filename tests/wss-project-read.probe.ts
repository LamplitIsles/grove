// Invoked only by the isolated native WSS fixture; never against a live server.
import assert from "node:assert/strict";
import { readFile, writeFile, symlink, truncate } from "node:fs/promises";
import { join } from "node:path";
import { ProjectEnvironments } from "../server/project-environments";
import { execProjectRead } from "../server/exec-project-read";

const root = process.env.OWNED_WSS_ROOT!;
const codexHome = join(root, "app-codex");
const nativePath = join(codexHome, "environments.toml");
const environments = new ProjectEnvironments(
  join(root, "grove.toml"),
  codexHome,
);
const binding = await environments.binding("owned-wss");
if (
  process.env.OWNED_WSS_OFFLINE === "1" ||
  process.env.OWNED_WSS_UNTRUSTED === "1"
) {
  await assert.rejects(
    environments.operation(binding, { operation: "projects" }),
    /could not read/,
  );
  console.log("PASS disconnected or untrusted executor fails closed");
  process.exit(0);
}
const native = await readFile(nativePath, "utf8");
const entry = (Bun.TOML.parse(native) as any).environments[0];
const diagnostic = await execProjectRead(
  entry.url,
  entry.auth_bearer_token,
  `import json,os,subprocess
r=subprocess.run([${JSON.stringify(process.env.OWNED_OG_BINARY)},'project','list','--json'],capture_output=True,text=True)
print(json.dumps({'home':os.getenv('HOME'),'path':os.getenv('PATH'),'code':r.returncode,'stderr':r.stderr,'stdout':r.stdout}))`,
  "unused",
);
const executorEnv = JSON.parse(diagnostic);
assert.equal(executorEnv.home, join(root, "remote-home"));
assert.equal(executorEnv.code, 0);
assert(executorEnv.path.includes("/usr/bin"));
assert(executorEnv.stdout.includes("owned"));
const marker = join(root, "remote-cancel.pid");
const slowOg = join(root, "slow-og");
await writeFile(
  slowOg,
  `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(marker)}\nexec /bin/sleep 30\n`,
  { mode: 0o700 },
);
const grovePath = join(root, "grove.toml");
const groveConfig = await readFile(grovePath, "utf8");
await writeFile(
  grovePath,
  groveConfig.replace(
    JSON.stringify(process.env.OWNED_OG_BINARY),
    JSON.stringify(slowOg),
  ),
);
const slowBinding = await environments.binding("owned-wss");
const controller = new AbortController();
const running = environments.operation(
  slowBinding,
  { operation: "projects" },
  controller.signal,
);
let pid: number | undefined;
for (let i = 0; i < 100 && !pid; i++) {
  try {
    pid = Number(await readFile(marker, "utf8"));
  } catch {
    await Bun.sleep(20);
  }
}
assert(pid && Number.isInteger(pid));
controller.abort();
await assert.rejects(running);
let alive = true;
for (let i = 0; i < 100 && alive; i++) {
  try {
    process.kill(pid, 0);
    await Bun.sleep(20);
  } catch {
    alive = false;
  }
}
assert.equal(alive, false, "cancelled executor process must terminate");
await writeFile(grovePath, groveConfig);
for (const failure of ["timeout", "overflow"]) {
  const childMarker = join(root, `${failure}-grandchild.pid`);
  const failingOg = join(root, `${failure}-og`);
  await writeFile(
    failingOg,
    `#!/bin/sh\n/bin/sleep 30 &\nprintf '%s' "$!" > ${JSON.stringify(childMarker)}\n${failure === "overflow" ? "/usr/bin/head -c 600000 /dev/zero" : "wait"}\n`,
    { mode: 0o700 },
  );
  await writeFile(
    grovePath,
    groveConfig.replace(
      JSON.stringify(process.env.OWNED_OG_BINARY),
      JSON.stringify(failingOg),
    ),
  );
  const failingBinding = await environments.binding("owned-wss");
  const failureResult = assert.rejects(
    environments.operation(failingBinding, { operation: "projects" }),
    /could not read/,
  );
  let childPid: number | undefined;
  for (let i = 0; i < 100 && !childPid; i++) {
    try {
      childPid = Number(await readFile(childMarker, "utf8"));
    } catch {
      await Bun.sleep(20);
    }
  }
  assert(childPid && Number.isInteger(childPid));
  await failureResult;
  let childAlive = true;
  for (let i = 0; i < 100 && childAlive; i++) {
    try {
      const status = await readFile(`/proc/${childPid}/stat`, "utf8");
      childAlive = !/^\d+ \(.*\) Z /.test(status);
      if (childAlive) await Bun.sleep(20);
    } catch {
      childAlive = false;
    }
  }
  assert.equal(
    childAlive,
    false,
    `${failure} must terminate the tool grandchild`,
  );
}
await writeFile(grovePath, groveConfig);
const projects = await environments.projects("owned-wss");
assert.equal(
  projects.find((project) => project.alias === "owned")?.path,
  join(root, "project"),
);
assert.equal(
  await environments.branch(
    projects.find((project) => project.alias === "owned")!,
    new AbortController().signal,
  ),
  "owned-branch",
);
const file = join(root, "project", "index.html");
const grant = await environments.operation(binding, {
  operation: "preview-grant",
  target: file,
  allowed: [join(root, "project")],
  extensions: [".html"],
});
assert.equal(Buffer.from(grant.bytes, "base64").toString(), "owned preview");
const read = await environments.operation(binding, {
  operation: "preview-read",
  root: grant.root,
  target: file,
  extensions: [".html"],
});
assert.equal(Buffer.from(read.bytes, "base64").toString(), "owned preview");
await assert.rejects(
  environments.operation(binding, {
    operation: "preview-read",
    root: grant.root,
    target: join(root, "outside.html"),
    extensions: [".html"],
  }),
  /outside the preview/,
);
await symlink(join(root, "outside.html"), join(root, "project", "escape.html"));
await assert.rejects(
  environments.operation(binding, {
    operation: "preview-read",
    root: grant.root,
    target: join(root, "project", "escape.html"),
    extensions: [".html"],
  }),
  /outside the preview/,
);
const large = join(root, "project", "large.html");
await writeFile(large, "");
await truncate(large, 20 * 1024 * 1024);
const maximum = await environments.operation(binding, {
  operation: "preview-read",
  root: grant.root,
  target: large,
  extensions: [".html"],
});
assert.equal(Buffer.from(maximum.bytes, "base64").length, 20 * 1024 * 1024);
await truncate(large, 20 * 1024 * 1024 + 1);
await assert.rejects(
  environments.operation(binding, {
    operation: "preview-read",
    root: grant.root,
    target: large,
    extensions: [".html"],
  }),
  /exceeds 20 MiB/,
);
const original = await readFile(nativePath, "utf8");
try {
  await writeFile(
    nativePath,
    original.replace("owned-token", "bad-owned-token"),
    { mode: 0o600 },
  );
  assert.equal(
    (await environments.binding("owned-wss")).target,
    binding.target,
  );
  await assert.rejects(environments.projects("owned-wss"), /could not read/);
  await writeFile(
    nativePath,
    original.replace(/localhost:\d+/, "localhost:443"),
    { mode: 0o600 },
  );
  await assert.rejects(
    environments.operation(binding, { operation: "projects" }),
    /target changed/,
  );
} finally {
  await writeFile(nativePath, original, { mode: 0o600 });
}
console.log(
  "PASS native WSS discovery, branch, preview containment, authentication and binding",
);
