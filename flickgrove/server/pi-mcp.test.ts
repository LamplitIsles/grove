import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { openPiMcp, loadPiMcpConfig, piMcpExposure } from "./pi-mcp";

test("official HTTP MCP static auth/resources, OAuth rejection, redaction, and trusted project overrides", async () => {
  if (!process.env.GROVE_HTTP_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-http-home-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        PATH: process.env.PATH,
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        HOME: home,
        CODEX_HOME: join(home, "codex"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        GROVE_HTTP_CHILD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code ? out + err : "" }).toEqual({
        code: 0,
        output: "",
      });
    } finally {
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "grove-mcp-http-")),
    agentDir = join(home, "agent"),
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });
  const server = new McpServer({ name: "owned-http", version: "1" });
  let calls = 0,
    unauthorized = 0,
    configuredOAuthCalls = 0,
    headerChecks = 0;
  const secret = "OWNED-STATIC-SECRET";
  server.registerTool(
    "echo",
    { inputSchema: { value: z.string() } },
    async ({ value }) => {
      calls++;
      return {
        content: [{ type: "text", text: value }],
        ...(value === "fail"
          ? { isError: true, content: [{ type: "text", text: secret }] }
          : {}),
      };
    },
  );
  server.registerResource("owned", "owned://http", {}, async (uri) => ({
    contents: [{ uri: uri.href, text: "owned HTTP resource" }],
  }));
  await server.connect(transport);
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/oauth") {
        unauthorized++;
        return new Response(secret, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://secret.invalid/metadata"',
          },
        });
      }
      if (path === "/configured-oauth") {
        configuredOAuthCalls++;
        return new Response("Unexpected call", { status: 500 });
      }
      if (req.headers.get("authorization") !== `Bearer ${secret}`)
        return new Response(secret, { status: 401 });
      headerChecks++;
      return transport.handleRequest(req);
    },
  });
  const url = `http://127.0.0.1:${endpoint.port}`;
  const authPath = join(agentDir, "mcp-auth.json");
  await writeFile(authPath, "deliberately-invalid-unused-MCP-auth");
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        http: {
          url: url + "/good",
          headers: { Authorization: `Bearer ${secret}` },
          exposure: "deferred",
          toolExposure: { echo: "direct" },
        },
        oauth: { url: url + "/oauth" },
        configured: {
          url: url + "/configured-oauth",
          oauth: { clientId: secret },
          headers: {
            Authorization: `!printf should-not-run > "${join(home, "oauth-command")}"; printf ${secret}`,
          },
        },
        disabled: { url: url + "/must-not-run", enabled: false },
      },
    }),
  );
  await writeFile(
    join(cwd, ".pi/mcp.json"),
    JSON.stringify({
      mcpServers: {
        http: { exposure: "codemode", toolExposure: { echo: "direct" } },
        disabled: { enabled: false },
      },
    }),
  );
  let host: Awaited<ReturnType<typeof openPiMcp>> | undefined;
  try {
    const global = await loadPiMcpConfig(agentDir, cwd, false),
      trusted = await loadPiMcpConfig(agentDir, cwd, true);
    expect(global.get("http")?.exposure).toBe("deferred");
    expect(trusted.get("http")?.exposure).toBe("codemode");
    expect(piMcpExposure(trusted.get("http")!, "echo")).toBe("direct");
    expect(
      "url" in trusted.get("http")! &&
        (trusted.get("http")! as { headers: Record<string, string> }).headers
          .Authorization,
    ).toBe(`Bearer ${secret}`);
    host = await openPiMcp({ agentDir, cwd, trusted: true });
    expect(host.issues).toHaveLength(2);
    expect(JSON.stringify(host.issues)).not.toContain(secret);
    expect(JSON.stringify(host.issues)).not.toContain(url);
    expect(host.issues.join(" ")).toContain("OAuth is unsupported");
    expect(unauthorized).toBe(1);
    expect(configuredOAuthCalls).toBe(0);
    expect(await Bun.file(join(home, "oauth-command")).exists()).toBe(false);
    const invoke = (name: string, args: unknown) => {
      const tool = host!.extension.tools?.find((t) => t.name === name);
      if (!tool) throw new Error("Fixture tool missing");
      return tool.execute(args, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    };
    expect(
      JSON.stringify(
        await invoke("mcp__http__echo", { value: "HTTP actual call" }),
      ),
    ).toContain("HTTP actual call");
    expect(
      JSON.stringify(await invoke("list_mcp_resources", { server: "http" })),
    ).toContain("owned://http");
    expect(
      JSON.stringify(
        await invoke("read_mcp_resource", {
          server: "http",
          uri: "owned://http",
        }),
      ),
    ).toContain("owned HTTP resource");
    const error = await invoke("mcp__http__echo", { value: "fail" });
    expect(error.isError).toBe(true);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(calls).toBe(2);
    expect(
      host.extension.tools?.some((t) => t.name.startsWith("mcp__oauth__")),
    ).toBe(false);
    expect(headerChecks).toBeGreaterThan(3);
    expect(await readFile(authPath, "utf8")).toBe(
      "deliberately-invalid-unused-MCP-auth",
    );
    await host.close();
    await host.close();
  } finally {
    await host?.close();
    await server.close();
    endpoint.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 15000);

test("expired Streamable HTTP session is retried once, then reported and reconnected", async () => {
  const home = await mkdtemp(join(tmpdir(), "grove-mcp-expiry-")),
    agentDir = join(home, "agent"),
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  const transports = new Map<
    string,
    WebStandardStreamableHTTPServerTransport
  >();
  const servers: McpServer[] = [];
  const forgotten = new Set<string>();
  let forgetEverySession = false,
    calls = 0;
  const handle = async (req: Request) => {
    const session = req.headers.get("mcp-session-id");
    if (session) {
      const transport =
        forgetEverySession || forgotten.has(session)
          ? undefined
          : transports.get(session);
      return transport
        ? transport.handleRequest(req)
        : new Response("Session not found", { status: 404 });
    }
    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
    const server = new McpServer({ name: "expiring", version: "1" });
    server.registerTool(
      "echo",
      { inputSchema: { value: z.string() } },
      async ({ value }) => {
        calls++;
        return { content: [{ type: "text", text: value }] };
      },
    );
    await server.connect(transport);
    servers.push(server);
    return transport.handleRequest(req);
  };
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handle,
  });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        expiring: { url: `http://127.0.0.1:${endpoint.port}/mcp` },
      },
    }),
  );
  let host: Awaited<ReturnType<typeof openPiMcp>> | undefined;
  try {
    host = await openPiMcp({ agentDir, cwd, trusted: false });
    expect(host.issues).toEqual([]);
    const invoke = (value: string) => {
      const tool = host!.extension.tools?.find(
        (t) => t.name === "mcp__expiring__echo",
      );
      if (!tool) throw new Error("Fixture tool missing");
      return tool.execute(
        { value },
        {} as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
    };
    expect(JSON.stringify(await invoke("first"))).toContain("first");
    expect(calls).toBe(1);
    // The server forgot this session, so the call was not run and is retried on a new one.
    for (const id of transports.keys()) forgotten.add(id);
    expect(JSON.stringify(await invoke("second"))).toContain("second");
    expect(calls).toBe(2);
    expect(await mcpStatus(host)).toBeUndefined();
    // When even the retried session is gone, the loss is reported instead of looping.
    forgetEverySession = true;
    const lost = await invoke("third");
    expect(lost.isError).toBe(true);
    expect(JSON.stringify(lost)).toContain("connection was lost");
    expect(calls).toBe(2);
    forgetEverySession = false;
    expect(JSON.stringify(await invoke("fourth"))).toContain("fourth");
    expect(calls).toBe(3);
  } finally {
    await host?.close();
    await Promise.all(servers.map((server) => server.close()));
    endpoint.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 15000);

/** The rendered MCP status section, which carries both open issues and persistent degradation. */
async function mcpStatus(
  host: Awaited<ReturnType<typeof openPiMcp>>,
): Promise<string | undefined> {
  const section = host.extension.sections?.find(
    (entry) => entry.key === "mcp_status",
  );
  if (!section) throw new Error("Fixture section missing");
  return (await section.render({} as never, BACKGROUND_CONTEXT)) ?? undefined;
}

/** Owned MCP server whose new sessions can refuse or forget existing ones. */
async function ownedServer() {
  const home = await mkdtemp(join(tmpdir(), "grove-mcp-owner-")),
    agentDir = join(home, "agent"),
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  const transports = new Map<
    string,
    WebStandardStreamableHTTPServerTransport
  >();
  const servers: McpServer[] = [];
  const forgotten = new Set<string>();
  const state = {
    /** Number of new sessions still to refuse with a transient HTTP error. */
    refusing: 0,
    /** Answer every known session with "Session not found". */
    forgetting: false,
    calls: 0,
  };
  const handle = async (req: Request) => {
    const session = req.headers.get("mcp-session-id");
    if (session) {
      const transport =
        state.forgetting || forgotten.has(session)
          ? undefined
          : transports.get(session);
      return transport
        ? transport.handleRequest(req)
        : new Response("Session not found", { status: 404 });
    }
    if (state.refusing > 0) {
      state.refusing--;
      return new Response("Starting", { status: 503 });
    }
    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
    const server = new McpServer({ name: "owned", version: "1" });
    server.registerTool(
      "echo",
      { inputSchema: { value: z.string() } },
      async ({ value }) => {
        state.calls++;
        return { content: [{ type: "text", text: value }] };
      },
    );
    await server.connect(transport);
    servers.push(server);
    return transport.handleRequest(req);
  };
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: { owned: { url: `http://127.0.0.1:${endpoint.port}/mcp` } },
    }),
  );
  return {
    agentDir,
    cwd,
    state,
    forgotten,
    transports,
    async cleanup(host: Awaited<ReturnType<typeof openPiMcp>> | undefined) {
      await host?.close();
      await Promise.all(servers.map((server) => server.close()));
      endpoint.stop(true);
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("connect retries a transient failure instead of losing the server", async () => {
  const owned = await ownedServer();
  owned.state.refusing = 1;
  let host: Awaited<ReturnType<typeof openPiMcp>> | undefined;
  try {
    host = await openPiMcp({
      agentDir: owned.agentDir,
      cwd: owned.cwd,
      trusted: false,
    });
    expect(host.issues).toEqual([]);
    const tool = host.extension.tools?.find(
      (entry) => entry.name === "mcp__owned__echo",
    );
    if (!tool) throw new Error("Fixture tool missing");
    expect(
      JSON.stringify(
        await tool.execute(
          { value: "after retry" },
          {} as ToolExecutionApi,
          BACKGROUND_CONTEXT,
        ),
      ),
    ).toContain("after retry");
  } finally {
    await owned.cleanup(host);
  }
}, 15000);

test("a server that stays unreachable is reported in the MCP status until it recovers", async () => {
  const owned = await ownedServer();
  let host: Awaited<ReturnType<typeof openPiMcp>> | undefined;
  try {
    host = await openPiMcp({
      agentDir: owned.agentDir,
      cwd: owned.cwd,
      trusted: false,
    });
    const tool = host.extension.tools?.find(
      (entry) => entry.name === "mcp__owned__echo",
    );
    if (!tool) throw new Error("Fixture tool missing");
    const invoke = (value: string) =>
      tool.execute({ value }, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    expect(JSON.stringify(await invoke("first"))).toContain("first");
    expect(await mcpStatus(host)).toBeUndefined();
    // The session is gone and no new one can be opened, so the loss persists.
    owned.forgotten.clear();
    for (const id of owned.transports.keys()) owned.forgotten.add(id);
    owned.state.forgetting = true;
    owned.state.refusing = 10;
    const lost = await invoke("second");
    expect(lost.isError).toBe(true);
    expect(String(await mcpStatus(host))).toContain(
      "is unavailable after its connection was lost",
    );
    owned.state.forgetting = false;
    owned.state.refusing = 0;
    expect(JSON.stringify(await invoke("third"))).toContain("third");
    expect(await mcpStatus(host)).toBeUndefined();
  } finally {
    await owned.cleanup(host);
  }
}, 20000);
