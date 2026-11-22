import { afterEach, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Workspace } from "./workspace";
import {
  ProjectEnvironments,
  type ProjectReadCommand,
} from "./project-environments";
import { FakeRuntime, memberPresetsFixtureSync } from "./testing";
import { HostService } from "./hosts";
import { createHandler } from "./http";
import { readDirectoryBranch } from "./directory-branches";

const exec = promisify(execFile);
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(candidate?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "grove-worktree-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "registered"),
    linked = join(root, "linked"),
    clone = join(root, "clone"),
    other = join(root, "other"),
    home = join(root, "home");
  await mkdir(project);
  await mkdir(other);
  await mkdir(home);
  await mkdir(join(home, ".config", "ttal"), { recursive: true });
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { env, stdio: "pipe" });
  git("-C", project, "init", "-q");
  git(
    "-C",
    project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  git(
    "-C",
    project,
    "remote",
    "add",
    "origin",
    "https://example.invalid/owner/repo.git",
  );
  git("-C", project, "worktree", "add", "-qb", "feature", linked);
  git("clone", "-q", project, clone);
  git(
    "-C",
    clone,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/owner/repo.git",
  );
  await mkdir(join(linked, "reports"));
  await writeFile(join(linked, "reports", "page.md"), "# Linked report");
  await writeFile(
    join(linked, "reports", "source.ts"),
    "export const linked = true;\n",
  );
  await writeFile(join(clone, "page.md"), "# Independent");
  await writeFile(
    join(home, ".config", "ttal", "projects.toml"),
    `[test]\npath = ${JSON.stringify(project)}\nremote = "https://example.invalid/owner/repo.git"\n`,
  );
  const alias = join(root, "alias");
  await symlink(linked, alias);
  const config = join(root, "config.toml");
  await writeFile(config, "");
  let calls = 0;
  const command: ProjectReadCommand = async (_program, args, options) => {
    calls++;
    if (candidate) return exec(candidate, args, { ...options, env });
    const input = await realpath(args[2]);
    if (input !== linked && !input.startsWith(linked + "/"))
      throw new Error("not linked");
    return {
      stdout: JSON.stringify({ project: "test", worktree: linked }),
      stderr: "",
    };
  };
  const environments = new ProjectEnvironments(
    config,
    join(root, "codex"),
    command,
  );
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: join(root, "state"),
    runtime,
    environments,
    projects: async () => [
      { alias: "test", name: "Test", path: project },
      { alias: "other", name: "Other", path: other },
    ],
    reviewerSnapshot: async () => ({ prompt: "owned" }),
    memberPresets: memberPresetsFixtureSync(join(root, "state")),
    branches: { read: readDirectoryBranch, intervalMs: 60000 },
  });
  cleanups.push(() => app.dispose());
  const orc = await app.createOrc("test", {
    fast: false,
    orc: { model: "sol", effort: "medium" },
  });
  const token = runtime.agents.get(orc.id)!.token;
  const service = new HostService(app, {
    directory: join(root, "peer"),
    origin: () => origin,
  });
  let origin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHandler(app, { service, origin: () => origin }),
  });
  origin = server.url.origin;
  cleanups.push(() => server.stop(true));
  const grant = (agent: string, href: string) =>
    fetch(origin + "/api/file-preview", {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Grove-Peer": service.identity.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agent: `${service.identity.id}:${agent}`, href }),
    });
  return {
    root,
    project,
    linked,
    clone,
    alias,
    runtime,
    app,
    orc,
    token,
    grant,
    get calls() {
      return calls;
    },
  };
}

async function exercise(candidate?: string) {
  const f = await fixture(candidate);
  const start = {
    project: "test",
    title: "Owned",
    spec: "#6190",
    message: "Work",
  };
  const before = f.runtime.agents.size;
  const count = f.calls;
  expect(
    (await f.grant(f.orc.id, join(f.linked, "reports", "page.md"))).status,
  ).toBe(200);
  expect(f.calls).toBeGreaterThan(count);
  expect(f.runtime.agents.size).toBe(before);
  for (const worktree of [
    "relative",
    join(f.linked, "reports"),
    join(f.root, "missing"),
    f.clone,
  ])
    await expect(
      f.app.tool(f.token, "worker_start", { ...start, worktree }),
    ).rejects.toThrow();
  await expect(
    f.app.tool(f.token, "worker_start", {
      ...start,
      project: "other",
      worktree: f.linked,
    }),
  ).rejects.toThrow();
  expect(f.runtime.agents.size).toBe(before);
  const worker = (await f.app.tool(f.token, "worker_start", {
    ...start,
    worktree: f.alias,
  })) as { id: string };
  const reviewer = (await f.app.tool(f.token, "reviewer_start", {
    ...start,
    worktree: f.linked,
    profile: "standards",
    fixedPoint: "base",
    reviewedHead: "head",
  })) as { id: string };
  const priorPlain = f.calls;
  const plain = (await f.app.tool(f.token, "worker_start", start)) as {
    id: string;
  };
  expect(f.calls).toBe(priorPlain);
  for (const id of [worker.id, reviewer.id])
    expect(f.runtime.agents.get(id)!.project).toMatchObject({
      alias: "test",
      path: f.linked,
    });
  expect(f.runtime.agents.get(plain.id)!.project.path).toBe(f.project);
  expect(
    await readDirectoryBranch(f.linked, new AbortController().signal),
  ).toBe("feature");
  const priorPreview = f.calls;
  expect((await f.grant(worker.id, "reports/page.md")).status).toBe(200);
  expect(f.calls).toBe(priorPreview);
  expect((await f.grant(f.orc.id, join(f.clone, "page.md"))).status).toBe(403);
  const outside = join(f.root, "outside.md");
  await writeFile(outside, "outside");
  expect((await f.grant(f.orc.id, outside)).status).toBe(403);
  const source = await f.grant(
    f.orc.id,
    join(f.linked, "reports", "source.ts"),
  );
  expect(source.status).toBe(200);
  const { url } = await source.json();
  expect((await fetch(url)).status).toBe(200);
  expect((await fetch(new URL("page.md", url))).status).toBe(403);
  for (const id of [worker.id, reviewer.id])
    f.runtime.emit(id, {
      type: "completed",
      turnId: f.app.detail(id).turnId!,
      status: "completed",
    });
  await rm(f.linked, { recursive: true });
  expect(f.app.detail(worker.id).project.path).toBe(f.linked);
  expect(
    await f.app.tool(f.token, "worker_read", { workerId: worker.id }),
  ).toBeTruthy();
  expect((await f.grant(worker.id, "reports/page.md")).ok).toBe(false);
  const threads = [worker.id, reviewer.id].map(
    (id) => f.app.detail(id).threadId!,
  );
  expect(
    await f.app.tool(f.token, "worker_close", { workerId: worker.id }),
  ).toMatchObject({ closed: true, closing: false });
  expect(
    await f.app.tool(f.token, "reviewer_close", { reviewerId: reviewer.id }),
  ).toMatchObject({ closed: true, closing: false });
  for (const [index, id] of [worker.id, reviewer.id].entries()) {
    const reference = `@saved:${id}`;
    expect(await f.app.historySession(reference, threads[index])).toMatchObject(
      { closed: true },
    );
    expect(
      (await f.app.historyMessages(reference, threads[index])).messages.some(
        (m) => m.text.includes("Work"),
      ),
    ).toBe(true);
  }
}

test("linked worktree delegation and HTTP preview with isolated resolver", () =>
  exercise());
if (process.env.GROVE_TEST_WORKTREE_OG)
  test(
    "actual og candidate accepts isolated linked worktree and rejects independent clone",
    () => exercise(process.env.GROVE_TEST_WORKTREE_OG),
    20000,
  );

test("resolver rejects malformed and noncanonical tool output", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "grove-worktree-output-")),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, "linked"),
    alias = join(root, "alias"),
    other = join(root, "other");
  await mkdir(linked);
  await mkdir(other);
  await symlink(linked, alias);
  let stdout = "";
  const environments = new ProjectEnvironments(
    join(root, "unused"),
    root,
    async () => ({ stdout, stderr: "" }),
  );
  for (const value of [
    "not json",
    JSON.stringify({ project: "test", worktree: "relative" }),
    JSON.stringify({ project: "test", worktree: other }),
    JSON.stringify({ project: "test", worktree: alias }),
    JSON.stringify({ project: "test", worktree: linked, extra: true }),
  ]) {
    stdout = value;
    await expect(
      environments.resolveWorktree(undefined, linked, true),
    ).rejects.toThrow("Cannot verify worktree");
  }
});
