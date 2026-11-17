import { expect, test } from "bun:test";
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { createHandler } from "./http";
import { FakeRuntime, memberPresetsFixtureSync } from "./testing";
import { roleTools } from "./tools";

// Installed-native discovery/config and out-of-band MCP only. No provider turn.
test("installed shared native isolates all role tool catalogs and authenticated reports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-native-mcp-"));
  const home = join(directory, "home"),
    codexHome = join(directory, "codex"),
    project = join(directory, "project");
  for (const path of [home, codexHome, project]) mkdirSync(path);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => [{ alias: "alpha", name: "Alpha", path: project }],
    reviewerSnapshot: async () => ({ prompt: "Synthetic review" }),
    researcherSnapshot: async () => ({ prompt: "Synthetic research" }),
    memberPresets: memberPresetsFixtureSync(directory),
  });
  let origin = "";
  const service = new HostService(app, { directory, origin: () => origin });
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/error"
        ? new Response("fixture failure", { status: 503 })
        : new Response(
            `<html><head><title>Fixture</title></head><body><main><h1>Fixture guide</h1><p>${"Fixture content with enough article text. ".repeat(40)}</p><a href="/linked">MCP fixture link</a></main></body></html>`,
            {
              headers: { "content-type": "text/html" },
            },
          ),
  });
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHandler(app, { service, origin: () => origin }),
  });
  origin = `http://127.0.0.1:${http.port}`;
  const client = new CodexAppServerClient({
    cwd: project,
    codexPath: "codex",
    clientInfo: {
      name: "grove-mcp-probe",
      title: "Grove MCP probe",
      version: "1",
    },
    capabilities: { experimentalApi: true },
    protocolValidation: "strict",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
    },
  });
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (
      url.startsWith("https://context7.com/api/v1/search") &&
      new URL(url).searchParams.get("query") === "rate-limit"
    )
      return new Response("fixture", { status: 429 });
    if (url.startsWith("https://context7.com/api/v1/missing/library"))
      return new Response("fixture", { status: 404 });
    if (url.startsWith("https://context7.com/api/v1/search"))
      return Response.json({
        results: [
          {
            id: "/test/library",
            title: "MCP docs library",
            description: "fixture",
            trustScore: 1,
            totalSnippets: 1,
          },
        ],
      });
    if (url.startsWith("https://context7.com/api/v1/test/library"))
      return new Response("MCP docs fixture");
    if (url.startsWith(`http://127.0.0.1:${fixture.port}/`))
      return originalFetch(input, init);
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;
  try {
    const orc = await app.createOrc("alpha");
    const token = runtime.agents.get(orc.id)!.token;
    const target = { spec: "#3607", fixedPoint: "base", reviewedHead: "head" };
    await app.tool(token, "worker_start", {
      project: "alpha",
      title: "Worker",
      spec: "#3607",
      message: "Synthetic task",
    });
    await app.tool(token, "reviewer_start", {
      ...target,
      project: "alpha",
      title: "Reviewer",
      profile: "standards",
      message: "Synthetic review",
    });
    await app.tool(token, "researcher_start", {
      project: "alpha",
      title: "Researcher",
      question: "Synthetic question",
      message: "Synthetic research",
    });
    await client.connect();
    const threads = new Map<string, string>();
    for (const agent of runtime.agents.values()) {
      const thread = await client.threadStart({
        cwd: project,
        model: "gpt-6.1-sol",
        approvalPolicy: "never",
        sandbox:
          agent.role === "reviewer" || agent.role === "researcher"
            ? "read-only"
            : "danger-full-access",
        developerInstructions: "Synthetic role context",
        config: {
          "agents.enabled": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
          "mcp_servers.flickgrove": {
            command: process.execPath,
            args: [fileURLToPath(new URL("./mcp.ts", import.meta.url))],
            env: {
              FLICKGROVE_ORIGIN: origin,
              FLICKGROVE_AGENT_TOKEN: agent.token,
            },
            enabled_tools: [...roleTools[agent.role]],
            tools: Object.fromEntries(
              roleTools[agent.role].map((name) => [
                name,
                { approval_mode: "approve" },
              ]),
            ),
          },
        },
        historyMode: "paginated",
      });
      threads.set(agent.id, thread.thread.id);
      const status = await client.call("mcpServerStatus/list", {
        threadId: thread.thread.id,
        detail: "toolsAndAuthOnly",
      });
      const grove = status.data.find((s) => s.name === "flickgrove")!;
      expect(grove.toolsError).toBeNull();
      for (const name of ["web_fetch_structured", "web_links"]) {
        const description =
          Object.values(grove.tools).find((tool) => tool?.name === name)
            ?.description ?? "";
        expect(description).toContain("localhost and private networks");
        expect(description).toContain("public targets only");
        expect(description).toContain("target domain and allowed CDNs");
      }
      expect(
        Object.values(grove.tools)
          .map((t) => t!.name)
          .sort(),
      ).toEqual([...roleTools[agent.role]].sort());
      for (const tool of Object.values(grove.tools))
        expect(tool?.annotations ?? {}).not.toMatchObject({
          readOnlyHint: true,
        });
    }
    // Re-read earlier threads after all same-name servers initialize: no role cache bleed.
    for (const agent of runtime.agents.values()) {
      const threadId = threads.get(agent.id)!;
      const status = await client.call("mcpServerStatus/list", {
        threadId,
        detail: "toolsAndAuthOnly",
      });
      expect(
        Object.values(status.data.find((s) => s.name === "flickgrove")!.tools)
          .map((t) => t!.name)
          .sort(),
      ).toEqual([...roleTools[agent.role]].sort());
      const webResult = await client.call("mcpServer/tool/call", {
        threadId,
        server: "flickgrove",
        tool: "web_links",
        arguments: { url: `http://127.0.0.1:${fixture.port}/page` },
      });
      expect(webResult.isError).not.toBe(true);
      expect(JSON.stringify(webResult)).toContain("MCP fixture link");
      const invalid = await client.call("mcpServer/tool/call", {
        threadId,
        server: "flickgrove",
        tool: "web_links",
        arguments: { url: `http://127.0.0.1:${fixture.port}/page`, waitMs: 0 },
      });
      expect(invalid.isError).toBe(true);
      for (const [tool, args, expected] of [
        [
          "web_fetch_structured",
          { url: `http://127.0.0.1:${fixture.port}/page`, mode: "full" },
          "MCP fixture link",
        ],
        ["web_docs_resolve", { query: "fixture" }, "MCP docs library"],
        ["web_docs_fetch", { library_id: "/test/library" }, "MCP docs fixture"],
      ] as const) {
        const result = await client.call("mcpServer/tool/call", {
          threadId,
          server: "flickgrove",
          tool,
          arguments: args,
        });
        if (result.isError)
          throw new Error(`${tool}: ${JSON.stringify(result)}`);
        expect(JSON.stringify(result)).toContain(expected);
      }
      for (const [tool, args, expected] of [
        [
          "web_fetch_structured",
          { url: `http://127.0.0.1:${fixture.port}/error` },
          "HTTP 503",
        ],
        [
          "web_links",
          { url: `http://127.0.0.1:${fixture.port}/error` },
          "HTTP 503",
        ],
        ["web_docs_resolve", { query: "rate-limit" }, "Settings → Web"],
        [
          "web_docs_fetch",
          { library_id: "/missing/library" },
          "web_docs_resolve",
        ],
      ] as const) {
        const errorResult = await client.call("mcpServer/tool/call", {
          threadId,
          server: "flickgrove",
          tool,
          arguments: args,
        });
        expect(errorResult.isError).toBe(true);
        expect(JSON.stringify(errorResult.content)).toContain(expected);
      }
      if (agent.role === "orc") continue;
      const args =
        agent.role === "reviewer"
          ? { ...target, message: "Synthetic report" }
          : agent.role === "researcher"
            ? { question: "Synthetic question", message: "Synthetic report" }
            : { message: "Synthetic report" };
      const result = await client.call("mcpServer/tool/call", {
        threadId,
        server: "flickgrove",
        tool: roleTools[agent.role][0],
        arguments: args,
      });
      expect(result.isError).not.toBe(true);
      expect(app.detail(orc.id).deliveries.at(-1)?.source).toBe(agent.role);
      if (agent.role === "reviewer") {
        const stale = await client.call("mcpServer/tool/call", {
          threadId,
          server: "flickgrove",
          tool: "reviewer_report",
          arguments: {
            ...target,
            reviewedHead: "stale",
            message: "Synthetic stale report",
          },
        });
        expect(stale.isError).toBe(true);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCacheHome;
    await client.close();
    await http.stop(true);
    fixture.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
