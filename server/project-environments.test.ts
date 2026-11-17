import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ProjectEnvironments,
  type ProjectReadCommand,
} from "./project-environments";
import { Workspace } from "./workspace";
import {
  FakeRuntime,
  memberPresetsFixture,
  writeMemberPreset,
} from "./testing";
import { createHandler } from "./http";
import { invoke } from "./chord-methods";
import { HostService } from "./hosts";
import { filePreview, PREVIEW_TTL } from "./file-preview";
import { DeliveryRejected } from "./runtime";
import { CodexRuntime } from "./codex";
import { viewSchema, jsonValue } from "../src/chord-contract";
import { fileURLToPath } from "node:url";
import type { RuntimeAgent, RuntimeEvent } from "./runtime";

const exec = promisify(execFile);
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
}, 20000);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grove-project-environments-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const codex = join(root, "codex"),
    local = join(root, "local"),
    mac = join(root, "mac"),
    other = join(root, "other-remote");
  for (const path of [
    codex,
    local,
    mac,
    other,
    join(mac, "reports"),
    join(local, "reports"),
  ])
    await mkdir(path);
  const config = join(root, "config.toml");
  const og = join(root, "fixture-og");
  await writeFile(
    og,
    `#!/bin/sh
printf '%s' '${JSON.stringify({
      projects: [
        {
          alias: "same",
          name: "Remote same",
          path: local,
          remote: "https://example.invalid/Owner/repo",
        },
        { alias: "other", name: "Other remote", path: other },
      ],
    })}'
`,
    { mode: 0o700 },
  );
  await writeFile(
    config,
    `[[project_environments]]\nid="mac"\nname="Mac device"\nssh="owned-mac"\nog=${JSON.stringify(og)}\n`,
  );
  await writeFile(
    join(codex, "environments.toml"),
    'include_local=true\n[[environments]]\nid="mac"\nprogram="ssh"\nargs=["-T","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=5","owned-mac","codex exec-server --listen stdio"]\n',
  );
  let host = "owned-mac.test",
    hostKey = "OWNED_TEST_KEY",
    unavailable = false,
    remoteCalls = 0;
  const commands: Array<{ program: string; args: string[]; options: unknown }> =
    [];
  const command: ProjectReadCommand = async (program, args, options) => {
    commands.push({ program, args, options });
    if (program === "ssh-keygen")
      return {
        stdout: `owned-mac.test ssh-ed25519 ${hostKey}\n`,
        stderr: "",
      };
    expect(program).toBe("ssh");
    if (args[0] === "-G")
      return {
        stdout: `hostname ${host}\nuser fixture\nport 22\nstricthostkeychecking yes\nuserknownhostsfile /owned/known_hosts\n`,
        stderr: "",
      };
    if (unavailable)
      throw Object.assign(new Error("private transport detail"), { code: 255 });
    remoteCalls++;
    // Test-owned SSH seam rewrites the simulated device's checkout namespace.
    // The real bounded reader, shell escaping and file checks still execute.
    const original = args.at(-1)!;
    const encoded = / '([^']+)'$/.exec(original)![1];
    const request = JSON.parse(Buffer.from(encoded, "base64").toString());
    for (const key of ["target", "root", "path"])
      if (typeof request[key] === "string")
        request[key] = request[key].replace(local, mac);
    if (request.allowed)
      request.allowed = request.allowed.map((p: string) =>
        p.replace(local, mac),
      );
    const script =
      original.slice(0, original.length - encoded.length - 1) +
      Buffer.from(JSON.stringify(request)).toString("base64") +
      "'";
    const result = await exec("/bin/sh", ["-c", script], {
      ...options,
      env: { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root },
      cwd: root,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  const environments = new ProjectEnvironments(config, codex, command);
  const binding = await environments.binding("mac");
  const runtime = new FakeRuntime();
  const memberPresets = await memberPresetsFixture(join(root, "state"));
  await writeMemberPreset(memberPresets.directory, "pi-members", {
    worker: {
      backend: "pi",
      provider: "fixture",
      model: "sol",
      effort: "medium",
    },
    researcher: {
      backend: "pi",
      provider: "fixture",
      model: "sol",
      effort: "medium",
    },
    standards: {
      backend: "pi",
      provider: "fixture",
      model: "sol",
      effort: "medium",
    },
  });
  const options = {
    directory: join(root, "state"),
    runtime,
    environments,
    projects: async (id = "local") =>
      id === "local"
        ? [{ alias: "same", name: "Local same", path: local }]
        : environments.projects(id),
    reviewerSnapshot: async () => ({ prompt: "owned reviewer" }),
    researcherSnapshot: async () => ({ prompt: "owned researcher" }),
    memberPresets,
    branches: { read: async () => null, intervalMs: 60000 },
  };
  let app = new Workspace(options);
  cleanup.push(() => app.dispose());
  const service = new HostService(app, {
    directory: join(root, "peer"),
    origin: () => "http://fixture.invalid",
  });
  const settings = {
    fast: false,
    orc: { backend: "codex" as const, model: "sol", effort: "medium" },
  };
  return {
    root,
    codex,
    local,
    mac,
    environments,
    binding,
    runtime,
    service,
    settings,
    config,
    commands,
    other,
    options,
    get app() {
      return app;
    },
    setRole: (id: string) => app.selectMemberPreset(id),
    retarget: () => (host = "other-device.test"),
    rotateKey: () => (hostKey = "OTHER_TEST_KEY"),
    disconnect: () => (unavailable = true),
    get remoteCalls() {
      return remoteCalls;
    },
    restart: () => {
      app.dispose();
      app = new Workspace(options);
      return app;
    },
  };
}

test("catalogue captures environment and destination; missing, changed and unreachable targets never fall back", async () => {
  const f = await fixture();
  expect((await f.environments.list()).map((e) => e.id)).toEqual([
    "local",
    "mac",
  ]);
  const remote = await f.environments.projects("mac");
  expect(remote[0]).toMatchObject({
    alias: "same",
    path: f.local,
    environment: f.binding,
    owner: "owner",
  });
  expect(f.commands.at(-1)!.args).toContain("BatchMode=yes");
  expect(f.commands.at(-1)!.args).toContain("StrictHostKeyChecking=yes");
  f.rotateKey();
  await expect(f.environments.assert(f.binding)).rejects.toThrow(
    "target changed",
  );
  f.retarget();
  await expect(f.environments.assert(f.binding)).rejects.toThrow(
    "target changed",
  );
  await writeFile(f.config, "");
  await expect(f.environments.assert(f.binding)).rejects.toThrow(
    "no longer configured",
  );
  expect(await f.environments.assert(undefined)).toMatchObject({ id: "local" });
  await writeFile(f.config, "[[project_environments]]\nid = 123\n");
  expect((await f.environments.targets()).size).toBe(0);
  expect(await f.environments.assert(undefined)).toMatchObject({ id: "local" });
  await expect(f.environments.binding("mac")).rejects.toThrow(
    "configuration is invalid",
  );
}, 20000);

test("same aliases/paths remain isolated through delegation, history, restart and Pi pre-admission guards", async () => {
  const f = await fixture();
  const local = await f.app.createOrc("same", f.settings);
  const remote = await f.app.createOrc("mac:same", f.settings);
  expect(local.project.path).toBe(remote.project.path);
  expect(remote.project.environment).toEqual(f.binding);
  const wire = viewSchema.parse(
    jsonValue({ snapshot: f.service.snapshot(), details: {} }),
  );
  const wireProject = wire.snapshot.agents.find((a) =>
    a.id.endsWith(":" + remote.id),
  )!.project;
  expect(wireProject.owner).toBe("owner");
  expect(wireProject.environment).toEqual(f.binding);
  expect(
    (await f.app.history("same", "")).sessions.map((s) => s.agentId),
  ).toEqual([local.id]);
  expect(
    (await f.app.history("mac:same", "")).sessions.map((s) => s.agentId),
  ).toEqual([remote.id]);
  await expect(f.app.historySession("same", remote.threadId!)).rejects.toThrow(
    "does not belong",
  );
  for (let index = 0; index < 65; index++)
    f.runtime.historySessions.set(`remote-${index}`, {
      threadId: `remote-${index}`,
      environmentId: "mac",
      environmentTarget: f.binding.target,
      title: "Remote",
      preview: "",
      cwd: f.local,
      role: "orc",
      archived: false,
      source: "appServer",
      updatedAt: 1000,
    });
  const remotePage = await f.app.history("mac:same", "");
  expect(remotePage.nextCursor).not.toBeNull();
  await expect(
    f.app.history("same", "", remotePage.nextCursor!),
  ).rejects.toThrow("Search changed");
  const orc = f.runtime.agents.get(remote.id)!;
  await expect(
    f.app.tool(orc.token, "worker_start", {
      project: "local:same",
      title: "cross",
      spec: "#4424",
      message: "work",
    }),
  ).rejects.toThrow("cannot change");
  const worker = (await f.app.tool(orc.token, "worker_start", {
    project: "same",
    title: "same environment",
    spec: "#4424",
    message: "work",
  })) as { id: string };
  expect(f.runtime.agents.get(worker.id)!.project.environment).toEqual(
    f.binding,
  );
  const otherWorker = (await f.app.tool(orc.token, "worker_start", {
    project: "other",
    title: "Other project",
    spec: "#4424",
    message: "work",
  })) as { id: string };
  expect(f.runtime.agents.get(otherWorker.id)!.project).toMatchObject({
    alias: "other",
    path: f.other,
    environment: f.binding,
  });
  const before = f.app.snapshot().agents.length;
  await expect(
    f.app.createOrc("mac:same", {
      ...f.settings,
      orc: { ...f.settings.orc, backend: "pi" },
    }),
  ).rejects.toThrow("Pi supports");
  expect(f.app.snapshot().agents.length).toBe(before);
  await f.setRole("pi-members");
  for (const [tool, args] of [
    [
      "worker_start",
      {
        project: "same",
        title: "work",
        spec: "#4424",
        message: "work",
      },
    ],
    [
      "reviewer_start",
      {
        project: "same",
        title: "review",
        profile: "standards",
        spec: "#4424",
        fixedPoint: "base",
        reviewedHead: "head",
        message: "review",
      },
    ],
    [
      "researcher_start",
      {
        project: "same",
        title: "research",
        question: "find evidence",
        message: "research",
      },
    ],
  ] as const) {
    await expect(f.app.tool(orc.token, tool, args)).rejects.toThrow(
      "Pi supports",
    );
  }
  expect(f.app.snapshot().agents.length).toBe(before);
  expect(f.runtime.agents.size).toBe(before);
  const restarted = f.restart();
  expect(restarted.detail(remote.id).project.environment).toEqual(f.binding);
  f.retarget();
  expect((await restarted.history("mac:same", "")).sessions).toHaveLength(0);
  const submitted = f.runtime.inputs.length;
  expect(
    (
      await restarted.send(remote.id, "must not move", "changed-target")
    ).deliveries.find((d) => d.id === "changed-target")?.error,
  ).toContain("target changed");
  expect(f.runtime.inputs.length).toBe(submitted);
  expect(restarted.detail(remote.id).project.environment).toEqual(f.binding);
  await restarted.send(local.id, "local still usable", "local-input");
  expect(f.runtime.inputs.at(-1)!.agentId).toBe(local.id);
}, 20000);

test("remote preview HTML/Markdown/resources bind canonical device roots, limits, TTL and target identity", async () => {
  const f = await fixture();
  await writeFile(join(f.local, "reports", "page.html"), "LOCAL MUST NOT LEAK");
  await writeFile(
    join(f.mac, "reports", "page.html"),
    '<h1>Remote</h1><link rel="stylesheet" href="style.css"><img src="plot.png">',
  );
  await writeFile(join(f.mac, "reports", "style.css"), "body{color:blue}");
  await writeFile(join(f.mac, "reports", "plot.png"), "REMOTE IMAGE");
  await writeFile(
    join(f.mac, "reports", "note.md"),
    "# Remote\n\n![Plot](plot.png)",
  );
  await writeFile(join(f.root, "outside.png"), "PRIVATE");
  await symlink(
    join(f.root, "outside.png"),
    join(f.mac, "reports", "escape.png"),
  );
  const agent = await f.service.createOrc("mac:same", f.settings);
  let clock = 100;
  const preview = filePreview(f.service, () => clock);
  const origin = "http://fixture.invalid";
  const grant = async (href: string) => {
    const response = await preview(
      new Request(origin + "/api/file-preview", {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Grove-Peer": f.service.identity.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agent: agent.id, href }),
      }),
      [origin],
    );
    expect(response!.ok).toBe(true);
    return (await response!.json()).url as string;
  };
  const html = await grant("reports/page.html");
  const response = await preview(new Request(html), [origin]);
  expect(await response!.text()).toContain("<h1>Remote</h1>");
  expect(response!.headers.get("Content-Security-Policy")).toBe(
    "sandbox allow-scripts",
  );
  const css = new URL("style.css", html).href;
  expect(await (await preview(new Request(css), [origin]))!.text()).toBe(
    "body{color:blue}",
  );
  const png = new URL("plot.png", html).href;
  expect(await (await preview(new Request(png), [origin]))!.text()).toBe(
    "REMOTE IMAGE",
  );
  const md = await grant("reports/note.md");
  expect(await (await preview(new Request(md), [origin]))!.text()).toContain(
    "plot.png",
  );
  await writeFile(
    join(f.other, "other.html"),
    "<h1>Other registered remote</h1>",
  );
  const otherGrant = await grant(join(f.other, "other.html"));
  expect(
    await (await preview(new Request(otherGrant), [origin]))!.text(),
  ).toContain("Other registered remote");
  await rm(join(f.root, "fixture-og"));
  await expect(f.environments.projects("mac")).rejects.toThrow("Check og");
  expect(await grant("reports/page.html")).toContain("/preview/");
  expect(
    (await preview(new Request(new URL("escape.png", html)), [origin]))!.ok,
  ).toBe(false);
  await writeFile(join(f.mac, "reports", "big.png"), "");
  await truncate(join(f.mac, "reports", "big.png"), 20 * 1024 * 1024 + 1);
  const oversized = await preview(new Request(new URL("big.png", html)), [
    origin,
  ]);
  expect(oversized!.ok).toBe(false);
  expect(await oversized!.text()).toContain("exceeds 20 MiB");
  await writeFile(
    join(f.mac, "reports", "private.env"),
    "PRIVATE MUST NOT LEAK",
  );
  const unsupported = await preview(new Request(new URL("private.env", html)), [
    origin,
  ]);
  expect(unsupported!.ok).toBe(false);
  expect(await unsupported!.text()).not.toContain("PRIVATE MUST NOT LEAK");
  const calls = f.remoteCalls;
  f.retarget();
  expect((await preview(new Request(css), [origin]))!.ok).toBe(false);
  expect(f.remoteCalls).toBe(calls);
  clock += PREVIEW_TTL;
  expect((await preview(new Request(html), [origin]))!.status).toBe(410);
}, 20000);

test("strict runtime wire binds creation, original resume, new turns, og and central skill queries without changing steer", async () => {
  const f = await fixture();
  const options = {
    cwd: f.root,
    origin: () => "http://127.0.0.1:12345",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    environments: f.environments,
    env: {
      ...Object.fromEntries(
        Object.keys(process.env).map((k) => [k, undefined]),
      ),
      PATH: process.env.PATH,
      HOME: f.root,
      CODEX_HOME: f.codex,
      FAKE_SERVER_ROOT: f.root,
    },
  };
  let runtime = new CodexRuntime(options);
  cleanup.push(() => runtime.close());
  const agent: RuntimeAgent = {
    id: "remote-agent",
    token: "owned-token",
    role: "orc",
    project: {
      alias: "same",
      name: "Remote",
      path: f.local,
      environment: f.binding,
    },
    title: "Owned",
    model: "fixture-model",
    effort: "medium",
    serviceTier: "default",
    state: "idle",
    closed: false,
    messages: [],
    questions: [],
    deliveries: [],
  };
  await writeFile(
    join(f.root, ".fake-app-server-control.json"),
    JSON.stringify({ hold: true }),
  );
  const handle = await runtime.open(agent, () => {});
  const turn = await handle.send("initial");
  await handle.send("steer", turn);
  await runtime.skills(f.local, "codex", f.binding);
  await runtime.close();
  runtime = new CodexRuntime(options);
  const resumed = await runtime.open(
    { ...agent, threadId: handle.threadId },
    () => {},
  );
  await resumed.send("after restart");
  const requests = (
    await readFile(join(f.root, ".fake-app-server-requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  const start = requests.find(
    (r) => r.method === "thread/start" && !r.params.ephemeral,
  );
  expect(start.params.environments).toEqual([
    { environmentId: "mac", cwd: f.local },
  ]);
  expect(start.params.config["mcp_servers.flickgrove"]).toMatchObject({
    environment_id: "local",
    env: { FLICKGROVE_AGENT_TOKEN: "owned-token" },
  });
  expect(start.params.config["mcp_servers.og"]).toMatchObject({
    environment_id: "mac",
    cwd: f.local,
    args: ["mcp"],
  });
  expect(JSON.stringify(start.params.config["mcp_servers.og"])).not.toContain(
    "owned-token",
  );
  const turns = requests.filter((r) => r.method === "turn/start");
  expect(turns).toHaveLength(2);
  expect(
    turns.every(
      (r) =>
        r.params.threadId === handle.threadId &&
        r.params.environments?.[0].environmentId === "mac",
    ),
  ).toBe(true);
  const steer = requests.find((r) => r.method === "turn/steer");
  expect(steer.params.expectedTurnId).toBe(turn);
  expect(steer.params.environments).toBeUndefined();
  const skill = requests.find((r) => r.method === "skills/list");
  expect(skill.params.cwds).toEqual([f.codex]);
  await writeFile(
    join(f.root, ".fake-app-server-control.json"),
    JSON.stringify({ hold: true, missingEnvironment: "mac" }),
  );
  await expect(resumed.send("missing executor")).rejects.toBeInstanceOf(
    DeliveryRejected,
  );
  await writeFile(
    join(f.root, ".fake-app-server-control.json"),
    JSON.stringify({ hold: true }),
  );
  f.retarget();
  await expect(resumed.send("no fallback")).rejects.toBeInstanceOf(
    DeliveryRejected,
  );
  expect(
    (await readFile(join(f.root, ".fake-app-server-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s))
      .filter((r) => r.method === "turn/start"),
  ).toHaveLength(2);
}, 20000);

test("WSS disconnect notifications preserve native errors and ordinary MCP results", async () => {
  const f = await fixture();
  await writeFile(
    f.config,
    (await readFile(f.config, "utf8")) +
      `\n[[project_environments]]\nid="owned-wss"\nname="Owned WSS"\ntransport="wss"\nog="/owned/og"\n`,
  );
  const nativeConfig = join(f.codex, "environments.toml");
  await writeFile(
    nativeConfig,
    (await readFile(nativeConfig, "utf8")) +
      `\n[[environments]]\nid="owned-wss"\nurl="wss://owned.invalid/exec"\nauth_bearer_token="private-token-must-not-leak"\n`,
  );
  await import("node:fs/promises").then(({ chmod }) =>
    chmod(nativeConfig, 0o600),
  );
  const wssBinding = await f.environments.binding("owned-wss");
  const control = join(f.root, ".fake-app-server-control.json");
  const runtime = new CodexRuntime({
    cwd: f.root,
    origin: () => "http://127.0.0.1:12345",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    environments: f.environments,
    env: {
      ...Object.fromEntries(
        Object.keys(process.env).map((key) => [key, undefined]),
      ),
      PATH: process.env.PATH,
      HOME: f.root,
      CODEX_HOME: f.codex,
      FAKE_SERVER_ROOT: f.root,
    },
  });
  const observed: RuntimeEvent[] = [];
  const open = runtime.open.bind(runtime);
  runtime.open = (agent, notify) =>
    open(agent, (event) => {
      observed.push(event);
      notify(event);
    });
  const app = new Workspace({
    ...f.options,
    directory: join(f.root, "wire-state"),
    runtime,
    projects: async (id = "local") =>
      id === "owned-wss"
        ? [
            {
              alias: "same",
              name: "WSS same",
              path: f.local,
              environment: wssBinding,
            },
          ]
        : f.options.projects(id),
  });
  cleanup.push(
    () => runtime.close(),
    () => app.dispose(),
  );
  const notifications: Array<{ id: number; method: string; params: unknown }> =
    [];
  const push = (method: string, params: unknown) =>
    notifications.push({ id: notifications.length + 1, method, params });
  let interruptNoEvent = false;
  const flush = () =>
    writeFile(
      control,
      JSON.stringify({ hold: true, interruptNoEvent, notifications }),
    );
  const waitUntil = async (condition: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error("notification timed out");
      await Bun.sleep(10);
    }
  };
  const start = async (project: string) => {
    const agent = await app.createOrc(project);
    await app.send(agent.id, "begin", `operation-${agent.id}`);
    const { threadId, turnId } = app.detail(agent.id);
    expect(threadId).toBeTruthy();
    expect(turnId).toBeTruthy();
    return { id: agent.id, threadId: threadId!, turnId: turnId! };
  };
  const mcp = (
    a: { threadId: string; turnId: string },
    isError: boolean,
    server = "og",
    tool = "project_get",
  ) => {
    push("item/completed", {
      threadId: a.threadId,
      turnId: a.turnId,
      completedAtMs: Date.now(),
      item: {
        type: "mcpToolCall",
        id: `tool-${notifications.length}`,
        server,
        tool,
        status: "failed",
        arguments:
          tool === "issue_create"
            ? { project: "owned", title: "owned test issue" }
            : { project: "owned" },
        result: isError
          ? {
              content: [{ type: "text", text: "owned application error" }],
              structuredContent: null,
              _meta: null,
            }
          : null,
        error: isError ? null : { message: "private-token-must-not-leak" },
        durationMs: 0,
        appContext: null,
        pluginId: null,
        readOnlyHint: tool !== "issue_create",
      },
    });
  };
  const connection = (
    a: { threadId: string },
    environmentId: string,
    method = "thread/environment/disconnected",
  ) => push(method, { threadId: a.threadId, environmentId });
  const mcpSuccess = (a: { threadId: string; turnId: string }) =>
    push("item/completed", {
      threadId: a.threadId,
      turnId: a.turnId,
      completedAtMs: Date.now(),
      item: {
        type: "mcpToolCall",
        id: `tool-${notifications.length}`,
        server: "og",
        tool: "project_list",
        status: "completed",
        arguments: {},
        result: { content: [], structuredContent: null, _meta: null },
        error: null,
        durationMs: 0,
        appContext: null,
        pluginId: null,
        readOnlyHint: true,
      },
    });
  const complete = (
    a: { threadId: string; turnId: string },
    error: unknown = null,
  ) =>
    push("turn/completed", {
      threadId: a.threadId,
      turn: {
        id: a.turnId,
        status: error ? "failed" : "completed",
        items: [],
        error,
      },
    });
  await flush();

  // An isError result is a tool answer, including on the existing SSH path.
  for (const project of ["mac:same", "owned-wss:same", "same"]) {
    const a = await start(project);
    if (project !== "same")
      await app.enqueueFollowUp(a.id, "queued work", "owned-follow-up");
    mcp(a, true);
    if (project === "owned-wss:same") {
      mcp(a, false, "other");
      push("item/completed", {
        threadId: a.threadId,
        turnId: a.turnId,
        completedAtMs: Date.now(),
        item: {
          type: "agentMessage",
          id: `other-${a.id}`,
          text: "Other tool handled",
          phase: null,
          delivery: null,
          questions: null,
          memoryCitation: null,
        },
      });
      await flush();
      await waitUntil(() =>
        app.detail(a.id).messages.some((m) => m.text === "Other tool handled"),
      );
      expect(app.detail(a.id).error).toBeUndefined();
    }
    if (project !== "owned-wss:same") mcp(a, false);
    push("item/completed", {
      threadId: a.threadId,
      turnId: a.turnId,
      completedAtMs: Date.now(),
      item: {
        type: "agentMessage",
        id: `answer-${a.id}`,
        text: "Corrected after the tool result",
        phase: "final_answer",
        delivery: null,
        questions: null,
        memoryCitation: null,
      },
    });
    connection(a, "other-environment");
    connection({ threadId: "other-thread" }, "owned-wss");
    if (project !== "owned-wss:same")
      connection(a, project === "same" ? "local" : "mac");
    await flush();
    await waitUntil(() =>
      app
        .detail(a.id)
        .messages.some((m) => m.text === "Corrected after the tool result"),
    );
    if (project !== "same") {
      expect(app.lookupFollowUp(a.id, "owned-follow-up")?.status).toBe(
        "waiting",
      );
      expect(app.detail(a.id).followUpPaused).not.toBe(true);
      await app.cancelFollowUp(a.id, "owned-follow-up");
    }
    complete(a);
    await flush();
    await waitUntil(() => app.detail(a.id).turnId === undefined);
    expect(app.detail(a.id).state).toBe("idle");
    expect(app.detail(a.id).error).toBeUndefined();
    expect(
      app
        .detail(a.id)
        .messages.some((m) => m.text === "Corrected after the tool result"),
    ).toBe(true);
    expect(
      observed.some((e) => e.type === "error" && e.turnId === a.turnId),
    ).toBe(false);
  }
  // A different successful call does not resolve an earlier unknown outcome.
  for (const tool of ["project_get", "issue_create"]) {
    const a = await start("owned-wss:same");
    await app.enqueueFollowUp(a.id, "queued work", `follow-${tool}`);
    mcp(a, false, "og", tool);
    await flush();
    const warning =
      "Remote og MCP call failed. Inspect the operation before continuing.";
    await waitUntil(() => app.detail(a.id).error === warning);
    expect(app.detail(a.id).state).toBe("working");
    expect(JSON.stringify(app.detail(a.id))).not.toContain(
      "private-token-must-not-leak",
    );
    mcpSuccess(a);
    push("item/completed", {
      threadId: a.threadId,
      turnId: a.turnId,
      completedAtMs: Date.now(),
      item: {
        type: "agentMessage",
        id: `after-${tool}`,
        text: "A different call completed",
        phase: "final_answer",
        delivery: null,
        questions: null,
        memoryCitation: null,
      },
    });
    await flush();
    await waitUntil(() =>
      app
        .detail(a.id)
        .messages.some((m) => m.text === "A different call completed"),
    );
    expect(app.detail(a.id).error).toBe(warning);
    expect(app.lookupFollowUp(a.id, `follow-${tool}`)?.status).toBe("waiting");
    expect(app.detail(a.id).followUpPaused).not.toBe(true);
    complete(a);
    await flush();
    await waitUntil(() => app.detail(a.id).turnId === undefined);
    expect(app.detail(a.id).state).toBe("error");
    expect(app.detail(a.id).error).toBe(warning);
    expect(app.detail(a.id).followUpPaused).toBe(true);
    expect(
      observed.some(
        (e) =>
          e.type === "completed" &&
          e.turnId === a.turnId &&
          e.status === "completed",
      ),
    ).toBe(true);
  }
  // A failure without a later successful og call remains visible at terminal.
  const failed = await start("owned-wss:same");
  mcp(failed, false);
  complete(failed);
  await flush();
  await waitUntil(() => app.detail(failed.id).turnId === undefined);
  expect(app.detail(failed.id).state).toBe("error");
  expect(app.detail(failed.id).error).toBe(
    "Remote og MCP call failed. Inspect the operation before continuing.",
  );
  expect(
    observed.some(
      (e) =>
        e.type === "completed" &&
        e.turnId === failed.turnId &&
        e.status === "completed",
    ),
  ).toBe(true);

  // Native errors retain precedence over a separate og invocation failure.
  const toolCapacity = await start("owned-wss:same");
  mcp(toolCapacity, false);
  complete(toolCapacity, {
    message: "Selected model is at capacity",
    codexErrorInfo: "serverOverloaded",
    additionalDetails: null,
  });
  await flush();
  await waitUntil(() => app.detail(toolCapacity.id).turnId === undefined);
  expect(app.detail(toolCapacity.id).error).toBe(
    "Selected model is at capacity",
  );
  expect(app.detail(toolCapacity.id).execution?.kind).toBe("capacity");
  // A native capacity error wins even when disconnection preceded the MCP item.
  const capacity = await start("owned-wss:same");
  connection(capacity, "owned-wss");
  mcp(capacity, false);
  complete(capacity, {
    message: "Selected model is at capacity",
    codexErrorInfo: "serverOverloaded",
    additionalDetails: null,
  });
  await flush();
  await waitUntil(() => app.detail(capacity.id).turnId === undefined);
  expect(app.detail(capacity.id).error).toBe("Selected model is at capacity");
  expect(app.detail(capacity.id).execution?.kind).toBe("capacity");
  connection(capacity, "owned-wss");
  await flush();
  await Bun.sleep(100);
  expect(app.detail(capacity.id).error).toBe("Selected model is at capacity");
  expect(app.detail(capacity.id).execution?.kind).toBe("capacity");

  // MCP item first, then a confirmed WSS disconnect and successful native terminal.
  const during = await start("owned-wss:same");
  mcp(during, false);
  connection(during, "owned-wss");
  complete(during);
  await flush();
  await waitUntil(() => app.detail(during.id).turnId === undefined);
  const message =
    "Project device disconnected. Check the connection and retry.";
  expect(app.detail(during.id).state).toBe("error");
  expect(app.detail(during.id).error).toBe(message);
  expect(
    observed.some(
      (e) =>
        e.type === "completed" &&
        e.turnId === during.turnId &&
        e.status === "completed",
    ),
  ).toBe(true);

  // A thread-scoped disconnect can also arrive after turn/completed.
  const late = await start("owned-wss:same");
  complete(late);
  connection(late, "owned-wss");
  await flush();
  await waitUntil(() => app.detail(late.id).error === message);
  expect(app.detail(late.id).turnId).toBeUndefined();
  expect(app.detail(late.id).state).toBe("error");

  // The real 0.165.0 probe observes disconnect before the next turn starts.
  const next = { ...late, turnId: "owned-after-disconnect" };
  push("turn/started", {
    threadId: next.threadId,
    turn: {
      id: next.turnId,
      status: "inProgress",
      items: [],
      itemsView: "full",
      error: null,
      startedAt: Math.floor(Date.now() / 1000),
      completedAt: null,
    },
  });
  mcp(next, false);
  complete(next);
  await flush();
  await waitUntil(() =>
    observed.some((e) => e.type === "completed" && e.turnId === next.turnId),
  );
  expect(app.detail(next.id).state).toBe("error");
  expect(app.detail(next.id).error).toBe(message);

  // A connected notification clears the connection state for later turns.
  const recovered = { ...late, turnId: "owned-after-reconnect" };
  connection(recovered, "owned-wss", "thread/environment/connected");
  push("turn/started", {
    threadId: recovered.threadId,
    turn: {
      id: recovered.turnId,
      status: "inProgress",
      items: [],
      itemsView: "full",
      error: null,
      startedAt: Math.floor(Date.now() / 1000),
      completedAt: null,
    },
  });
  mcp(recovered, true);
  complete(recovered);
  await flush();
  await waitUntil(() =>
    observed.some(
      (e) => e.type === "completed" && e.turnId === recovered.turnId,
    ),
  );
  expect(app.detail(recovered.id).state).toBe("idle");
  expect(app.detail(recovered.id).error).toBeUndefined();

  // Stop confirms the native interruption without discarding an unknown write.
  const stoppedWrite = await start("owned-wss:same");
  await app.enqueueFollowUp(
    stoppedWrite.id,
    "queued work",
    "stop-write-follow",
  );
  mcp(stoppedWrite, false, "og", "issue_create");
  await flush();
  const toolWarning =
    "Remote og MCP call failed. Inspect the operation before continuing.";
  await waitUntil(() => app.detail(stoppedWrite.id).error === toolWarning);
  await app.stop(stoppedWrite.id, stoppedWrite.turnId);
  await waitUntil(
    () => app.detail(stoppedWrite.id).stop?.status === "confirmed",
  );
  expect(app.detail(stoppedWrite.id).state).toBe("error");
  expect(app.detail(stoppedWrite.id).error).toBe(toolWarning);
  expect(app.detail(stoppedWrite.id).followUpPaused).toBe(true);
  expect(app.lookupFollowUp(stoppedWrite.id, "stop-write-follow")?.status).toBe(
    "waiting",
  );
  expect(
    observed.some(
      (e) =>
        e.type === "completed" &&
        e.turnId === stoppedWrite.turnId &&
        e.status === "interrupted" &&
        e.toolFailure === true,
    ),
  ).toBe(true);

  // Disconnect after Stop starts but before its interrupted terminal event.
  const stoppedEnvironment = await start("owned-wss:same");
  await app.enqueueFollowUp(
    stoppedEnvironment.id,
    "queued work",
    "stop-env-follow",
  );
  interruptNoEvent = true;
  await flush();
  expect(
    (await app.stop(stoppedEnvironment.id, stoppedEnvironment.turnId)).stop
      ?.status,
  ).toBe("pending");
  connection(stoppedEnvironment, "owned-wss");
  push("turn/completed", {
    threadId: stoppedEnvironment.threadId,
    turn: {
      id: stoppedEnvironment.turnId,
      status: "interrupted",
      items: [],
      error: null,
    },
  });
  await flush();
  await waitUntil(
    () => app.detail(stoppedEnvironment.id).stop?.status === "confirmed",
  );
  expect(app.detail(stoppedEnvironment.id).state).toBe("error");
  expect(app.detail(stoppedEnvironment.id).error).toBe(message);
  expect(app.detail(stoppedEnvironment.id).followUpPaused).toBe(true);
  expect(
    app.lookupFollowUp(stoppedEnvironment.id, "stop-env-follow")?.status,
  ).toBe("waiting");
  expect(
    observed.some(
      (e) =>
        e.type === "completed" &&
        e.turnId === stoppedEnvironment.turnId &&
        e.status === "interrupted" &&
        e.environmentFailure === true,
    ),
  ).toBe(true);

  // A native terminal error and kind still win when Stop is confirmed.
  const stoppedCapacity = await start("owned-wss:same");
  mcp(stoppedCapacity, false, "og", "issue_create");
  await flush();
  await waitUntil(() => app.detail(stoppedCapacity.id).error === toolWarning);
  expect(
    (await app.stop(stoppedCapacity.id, stoppedCapacity.turnId)).stop?.status,
  ).toBe("pending");
  push("turn/completed", {
    threadId: stoppedCapacity.threadId,
    turn: {
      id: stoppedCapacity.turnId,
      status: "interrupted",
      items: [],
      error: {
        message: "Selected model is at capacity",
        codexErrorInfo: "serverOverloaded",
        additionalDetails: null,
      },
    },
  });
  await flush();
  await waitUntil(
    () => app.detail(stoppedCapacity.id).stop?.status === "confirmed",
  );
  expect(app.detail(stoppedCapacity.id).state).toBe("error");
  expect(app.detail(stoppedCapacity.id).error).toBe(
    "Selected model is at capacity",
  );
  expect(app.detail(stoppedCapacity.id).execution?.kind).toBe("capacity");

  // Stop without either failure keeps the existing idle result.
  interruptNoEvent = false;
  await flush();
  const stoppedNormally = await start("owned-wss:same");
  await app.stop(stoppedNormally.id, stoppedNormally.turnId);
  await waitUntil(
    () => app.detail(stoppedNormally.id).stop?.status === "confirmed",
  );
  expect(app.detail(stoppedNormally.id).state).toBe("idle");
  expect(app.detail(stoppedNormally.id).error).toBeUndefined();
  expect(JSON.stringify(observed)).not.toContain("private-token-must-not-leak");
  expect(JSON.stringify(app.detail(late.id))).not.toContain(
    "private-token-must-not-leak",
  );
}, 20000);

test("remote uncertainty is never replayed after restart, and device disconnection cannot grant local reads", async () => {
  const f = await fixture();
  const agent = await f.app.createOrc("mac:same", f.settings);
  f.runtime.sendOverride = async () => {
    throw new Error("native reception unknown");
  };
  const first = await f.app.send(
    agent.id,
    "keep original identity",
    "uncertain-op",
  );
  expect(first.deliveries.find((d) => d.id === "uncertain-op")?.status).toBe(
    "uncertain",
  );
  const count = f.runtime.inputs.length;
  await f.app.send(agent.id, "keep original identity", "uncertain-op");
  await f.restart().send(agent.id, "keep original identity", "uncertain-op");
  expect(f.runtime.inputs.length).toBe(count);
  expect(f.app.detail(agent.id).project.environment).toEqual(f.binding);
  expect(f.app.lookup(agent.id, "uncertain-op")).toBeNull();
  f.disconnect();
  await expect(f.environments.projects("mac")).rejects.toThrow(
    "could not read the project device",
  );
  const error = await f.environments
    .operation(f.binding, {
      operation: "preview-read",
      root: f.local,
      target: join(f.local, "reports", "page.html"),
    })
    .catch((e) => e.message);
  expect(error).toContain("could not read the project device");
  expect(error).not.toContain("private transport detail");
  expect((await f.app.projects("local"))[0].name).toBe("Local same");
}, 20000);

test("saved history references and cursors isolate local and retargeted devices with identical aliases and paths", async () => {
  const f = await fixture();
  const local = await f.app.createOrc("same", f.settings);
  const original = await f.app.createOrc("mac:same", f.settings);
  await f.app.closeTree(original.id);
  f.retarget();
  const replacement = await f.app.createOrc("mac:same", f.settings);
  await f.app.closeTree(replacement.id);
  const saved = f.app.historyProjects();
  const ref = (id: string) =>
    saved.find((p) => p.historyRef === `@saved:${id}`)!.historyRef!;
  expect(
    (await f.app.history(ref(original.id), "")).sessions.map((s) => s.threadId),
  ).toEqual([original.threadId!]);
  expect(
    (await f.app.history(ref(replacement.id), "")).sessions.map(
      (s) => s.threadId,
    ),
  ).toEqual([replacement.threadId!]);
  expect(
    (await f.app.history(ref(local.id), "")).sessions.map((s) => s.threadId),
  ).toEqual([local.threadId!]);
  await expect(
    f.app.historySession(ref(replacement.id), original.threadId!),
  ).rejects.toThrow("does not belong");
  for (let i = 0; i < 75; i++)
    f.runtime.historySessions.set(`original-${i}`, {
      threadId: `original-${i}`,
      title: "Original target",
      preview: "",
      cwd: f.local,
      environmentId: "mac",
      environmentTarget: f.binding.target,
      updatedAt: i,
      source: "appServer",
      role: "orc",
      archived: false,
    });
  const page = await f.app.history(ref(original.id), "");
  expect(page.nextCursor).toBeTruthy();
  await expect(
    f.app.history(ref(replacement.id), "", page.nextCursor!),
  ).rejects.toThrow("Search changed");
  await expect(
    f.app.history(ref(local.id), "", page.nextCursor!),
  ).rejects.toThrow("Search changed");
}, 20000);

for (const fault of ["offline", "removed", "retarget"] as const) {
  test(`closed managed history stays readable without execution ${fault}`, async () => {
    const f = await fixture();
    let writerOpens = 0;
    const open = f.runtime.open.bind(f.runtime);
    f.runtime.open = async (...args) => {
      writerOpens++;
      return open(...args);
    };
    const remote = await f.app.createOrc("mac:same", f.settings);
    const sent = await f.app.send(
      remote.id,
      "original remote transcript",
      "owned-history-input",
    );
    f.runtime.emit(remote.id, {
      type: "item",
      turnId: sent.turnId!,
      item: {
        type: "agentMessage",
        id: "owned-assistant",
        text: "original remote response",
      },
    });
    f.runtime.emit(remote.id, {
      type: "completed",
      turnId: sent.turnId!,
      status: "completed",
    });
    await f.app.closeTree(remote.id);
    await Bun.sleep(50); // settle the fixture's previously scheduled branch read
    const app = f.restart();
    const origin = "http://fixture.invalid";
    const service = new HostService(app, {
      directory: join(f.root, "peer"),
      origin: () => origin,
    });
    expect(app.snapshot().agents).toHaveLength(0);
    if (fault === "offline") f.disconnect();
    if (fault === "removed") await writeFile(f.config, "");
    if (fault === "retarget") f.retarget();
    const before = {
      commands: f.commands.length,
      writerOpens,
      sends: f.runtime.inputs.length,
    };
    const saved = service.historyProjects()[0];
    expect(await invoke(service, "historyProjects", {})).toEqual([saved]);
    expect((await service.environments()).some((e) => e.id === "mac")).toBe(
      true,
    );
    expect(
      await invoke(service, "history", {
        project: saved.historyRef!,
        query: "",
      }),
    ).toMatchObject({
      sessions: [{ threadId: remote.threadId!, closed: true }],
    });
    expect(
      await invoke(service, "historySession", {
        project: saved.historyRef!,
        threadId: remote.threadId!,
      }),
    ).toMatchObject({
      threadId: remote.threadId!,
      environmentTarget: f.binding.target,
    });
    const handler = createHandler(app, { service, origin: () => origin });
    for (const [path, expected] of [
      [
        "messages",
        {
          messages: [
            { text: "original remote transcript" },
            { text: "original remote response" },
          ],
        },
      ],
      ["body", { text: "original remote response" }],
    ] as const) {
      const params = new URLSearchParams({
        project: saved.historyRef!,
        thread: remote.threadId!,
        item: "owned-assistant",
      });
      const response = await handler(
        new Request(`${origin}/api/read/${path}?${params}`, {
          headers: { origin, "x-grove-peer": service.identity.id },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject(expected);
    }
    expect(f.commands.length).toBe(before.commands);
    expect(writerOpens).toBe(before.writerOpens);
    expect(f.runtime.inputs.length).toBe(before.sends);
    if (fault !== "offline")
      await expect(
        app.resumeHistory(saved.historyRef!, remote.threadId!, false),
      ).rejects.toThrow();
    expect(writerOpens).toBe(before.writerOpens);
    expect(f.runtime.inputs.length).toBe(before.sends);
  }, 20000);
}
