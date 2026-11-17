// Opt-in native regression. Use test-owned executables or a specifically
// authorized exception. No real provider, credentials, SSH, or live state.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "../server/codex";
import { ProjectEnvironments } from "../server/project-environments";
import { roleTools } from "../server/tools";
import type { ProjectEnvironment } from "../src/contracts";

const binary = process.env.TEST_CODEX_BINARY;
if (!binary?.startsWith("/"))
  throw Error(
    "TEST_CODEX_BINARY must be an absolute test-owned or authorized native Codex binary",
  );
const root = await mkdtemp("/tmp/grove-native-mcp-");
const home = join(root, "home"),
  codex = join(root, "codex"),
  local = join(root, "local"),
  emptyPath = join(root, "empty-path");
const remote = join(root, "remote-only", "project"),
  log = join(root, "executor.log");
const cwdLog = join(root, "bridge-cwd.log"),
  cwdPreload = join(root, "bridge-cwd.ts");
const fakeExecutor = fileURLToPath(
  new URL("./fake-remote-executor.ts", import.meta.url),
);
const binding = {
  id: "owned-remote",
  name: "Owned executor",
  target: "owned-target",
};
const roles = ["orc", "worker", "reviewer", "researcher"] as const;
type Role = (typeof roles)[number];
const tokens = new Map(roles.map((role) => [`owned-${role}-token`, role]));
const calls: string[] = [];
let providerRequests = 0;
let providerHasGrove = false;
let runtime: CodexRuntime | undefined;
const env = {
  HOME: home,
  CODEX_HOME: codex,
  TMPDIR: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  PATH: emptyPath,
  SHELL: join(root, "no-shell"),
  CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
  DO_NOT_TRACK: "1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  BUN_OPTIONS: "--no-env-file --no-install",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
};
let bridge: ReturnType<typeof Bun.serve> | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
try {
  bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const role = tokens.get(
        (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
      );
      if (!role) return new Response("unauthorized", { status: 401 });
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/mcp/info")
        return Response.json({ tools: roleTools[role] });
      if (pathname === "/api/mcp/call") {
        const body = await request.json();
        calls.push(`${role}:${body.name}`);
        return Response.json({ fixtureRole: role });
      }
      return new Response("not found", { status: 404 });
    },
  });
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      assert(!request.headers.has("authorization"));
      const body = await request.json();
      providerRequests++;
      providerHasGrove = JSON.stringify(body.tools ?? []).includes(
        "mcp__flickgrove",
      );
      const id = `owned-response-${providerRequests}`;
      const events = [
        { type: "response.created", response: { id } },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: `owned-message-${providerRequests}`,
            content: [{ type: "output_text", text: "Owned fixture complete" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      return new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  class OwnedEnvironments extends ProjectEnvironments {
    async targets() {
      return new Map([[binding.id, binding.target]]);
    }
    async assert(value?: ProjectEnvironment) {
      return value ?? { id: "local", name: "Local", target: "local" };
    }
    async og() {
      return "/virtual/owned-og";
    }
  }
  const projects = new Map<string, any>();
  const options = {
    cwd: local,
    codexPath: binary,
    env,
    origin: () => `http://127.0.0.1:${bridge!.port}`,
    environments: new OwnedEnvironments(join(root, "unused"), codex),
    projectForThread: (id: string) => projects.get(id),
  };
  const toolCalls: Record<
    Role,
    { name: string; arguments: Record<string, string> }
  > = {
    orc: { name: "worker_list", arguments: {} },
    worker: { name: "worker_report", arguments: { message: "Owned report" } },
    reviewer: {
      name: "reviewer_report",
      arguments: {
        message: "Owned report",
        spec: "fixture",
        fixedPoint: "base",
        reviewedHead: "head",
      },
    },
    researcher: {
      name: "researcher_report",
      arguments: { question: "Owned question", message: "Owned report" },
    },
  };
  async function openRuntime() {
    runtime = new CodexRuntime(options);
    const client = await (runtime as any).getCatalog();
    // Codex intentionally forwards only selected MCP env variables. These test
    // switches prevent Bun reading dotenv files, installing or writing caches.
    for (const method of ["threadStart", "threadResume"]) {
      const original = client[method].bind(client);
      client[method] = (params: any) => {
        const grove = params.config["mcp_servers.flickgrove"];
        grove.env.BUN_OPTIONS = `--no-env-file --no-install --preload ${cwdPreload}`;
        grove.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
        grove.env.OWNED_CWD_LOG = cwdLog;
        return original(params);
      };
    }
    return client;
  }
  async function check(
    client: any,
    threadId: string,
    role: Role,
    isRemote: boolean,
  ) {
    const status = await client.call("mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
    });
    if (isRemote) {
      const og = status.data.find((item: any) => item.name === "og");
      assert(
        og && !og.toolsError && Object.keys(og.tools).length === 1,
        "fake remote og must be ready",
      );
    }
    const grove = status.data.find((item: any) => item.name === "flickgrove");
    assert(
      grove && !grove.toolsError,
      `Grove MCP unavailable: ${grove?.toolsError ?? "missing"}`,
    );
    const names = Object.values(grove.tools)
      .map((tool: any) => tool.name)
      .sort();
    assert.deepEqual(
      names,
      [...roleTools[role]].sort(),
      `${role} role tool catalog`,
    );
    assert.equal(
      (await readFile(cwdLog, "utf8")).trim().split("\n").at(-1),
      local,
      "real bridge process cwd",
    );
    const tool = toolCalls[role];
    const result = await client.call("mcpServer/tool/call", {
      threadId,
      server: "flickgrove",
      tool: tool.name,
      arguments: tool.arguments,
    });
    assert.notEqual(result.isError, true, `${role} authenticated tool call`);
    assert.equal(calls.at(-1), `${role}:${tool.name}`);
  }
  async function turn(handle: any, completed: Promise<any>) {
    const before = providerRequests;
    await handle.send("Run the owned fixture");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const event = await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("fixture turn timed out")),
            12000,
          );
        }),
      ]);
      assert.equal(event.status, "completed");
      assert.equal(providerRequests, before + 1);
      assert(providerHasGrove, "native provider tool list must include Grove");
    } finally {
      clearTimeout(timer);
    }
  }
  for (const directory of [home, codex, local, emptyPath])
    await mkdir(directory);
  await assert.rejects(stat(remote), { code: "ENOENT" });
  await writeFile(
    cwdPreload,
    'import { appendFileSync } from "node:fs"; appendFileSync(process.env.OWNED_CWD_LOG!, process.cwd() + "\\n");\n',
  );
  await writeFile(
    join(codex, "config.toml"),
    `model = "mock-model"\nmodel_provider = "owned"\ncli_auth_credentials_store = "file"\n[model_providers.owned]\nname = "Owned"\nbase_url = "http://127.0.0.1:${provider.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nplugins = false\nshell_snapshot = false\n`,
  );
  await writeFile(
    join(codex, "environments.toml"),
    `include_local = true\ndefault = "local"\n[[environments]]\nid = "owned-remote"\nprogram = ${JSON.stringify(process.execPath)}\nargs = ["--no-env-file", "--no-install", ${JSON.stringify(fakeExecutor)}]\ncwd = ${JSON.stringify(local)}\n[environments.env]\nOWNED_EXECUTOR_LOG = ${JSON.stringify(log)}\nOWNED_REMOTE_PATH = ${JSON.stringify(remote)}\nHOME = ${JSON.stringify(home)}\nBUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"\n`,
  );
  for (const role of roles) {
    const project = {
      alias: "owned",
      name: "Owned",
      path: remote,
      environment: binding,
    };
    const agent: any = {
      id: `owned-${role}`,
      token: `owned-${role}-token`,
      role,
      project,
      title: `Owned ${role}`,
      model: "mock-model",
      effort: "low",
      serviceTier: "default",
      state: "idle",
      closed: false,
      messages: [],
      questions: [],
      deliveries: [],
    };
    let client = await openRuntime();
    const info = await client.call("environment/info", {
      environmentId: binding.id,
    });
    assert.equal(info.cwd, `file://${remote}`);
    let settle: ((event: any) => void) | undefined;
    let completed = new Promise<any>((resolve) => (settle = resolve));
    let handle = await runtime!.open(agent, (event) => {
      if (event.type === "completed") settle?.(event);
    });
    projects.set(handle.threadId, project);
    await check(client, handle.threadId, role, true);
    if (role === "orc") await turn(handle, completed);
    const threadId = handle.threadId;
    await runtime!.close();
    client = await openRuntime();
    completed = new Promise<any>((resolve) => (settle = resolve));
    handle = await runtime!.open({ ...agent, threadId }, (event) => {
      if (event.type === "completed") settle?.(event);
    });
    await check(client, threadId, role, true);
    if (role === "orc") await turn(handle, completed);
    await runtime!.close();
    runtime = undefined;
    console.log(
      `PASS ${role}: remote start and resume retain authenticated role tools`,
    );
  }
  const client = await openRuntime();
  const agent: any = {
    id: "owned-local",
    token: "owned-orc-token",
    role: "orc",
    project: {
      alias: "local",
      name: "Local",
      path: local,
      environment: { id: "local", name: "Local", target: "local" },
    },
    title: "Owned local",
    model: "mock-model",
    effort: "low",
    serviceTier: "default",
    state: "idle",
    closed: false,
    messages: [],
    questions: [],
    deliveries: [],
  };
  const handle = await runtime!.open(agent, () => {});
  await check(client, handle.threadId, "orc", false);
  console.log("PASS local project retains authenticated Grove tools");
  const methods = await readFile(log, "utf8");
  assert(
    !methods.includes("UNSUPPORTED") && !methods.includes("unexpected"),
    "fake executor must support all requested methods",
  );
  const starts = methods
    .split("\n")
    .filter((line) => line.startsWith("og-start "));
  assert(
    starts.length > 0 &&
      starts.every((line) => line === "og-start cwd=remote token=absent"),
    "every remote og must use its own cwd and never receive a Grove token",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    "FAIL",
    message
      .replaceAll(root, "<fixture>")
      .replace(
        /owned-(orc|worker|reviewer|researcher)-token/g,
        "<fixture-token>",
      ),
  );
  const methods = await readFile(log, "utf8").catch(() => "");
  console.error(
    "EXECUTOR_METHODS",
    JSON.stringify(methods.trim().split("\n").filter(Boolean)),
  );
  process.exitCode = 1;
} finally {
  await runtime?.close().catch(() => {});
  await bridge?.stop(true);
  await provider?.stop(true);
  await rm(root, { recursive: true, force: true });
}
