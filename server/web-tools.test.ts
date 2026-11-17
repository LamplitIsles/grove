import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWebPage, fetchWebLinks } from "./vendor/guion-web/fetch";
import { callWebTool } from "./web-tools";
import {
  readContext7Key,
  writeContext7Key,
  deleteContext7Key,
} from "./web-config";
import { roleTools, webToolNames } from "./tools";

test("web roles, static navigation, links, argument errors and local redirects", async () => {
  for (const role of Object.keys(roleTools) as (keyof typeof roleTools)[])
    for (const name of webToolNames) expect(roleTools[role]).toContain(name);
  const dir = mkdtempSync(join(tmpdir(), "grove-web-static-"));
  const page = `<html><title>Fixture</title><body><main><h1>Guide</h1><p>${"some content ".repeat(800)}</p><h2>Next steps</h2><p>navigation marker</p><a href="/one">One</a><a href="/two">Two</a></main></body></html>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      return new URL(req.url).pathname === "/redirect"
        ? Response.redirect(new URL("/page", req.url), 302)
        : new Response(page, { headers: { "content-type": "text/html" } });
    },
  });
  const url = `http://127.0.0.1:${server.port}/redirect`;
  try {
    const tree = await fetchWebPage({ url, mode: "tree" }, undefined, {
      cacheDirectory: dir,
    });
    expect(tree.content).toContain("Guide");
    const section = /\[([^\]]+)\]/.exec(tree.content)?.[1];
    expect(section).toBeDefined();
    const selected = await fetchWebPage(
      { url, section_id: section },
      undefined,
      { cacheDirectory: dir },
    );
    expect(selected.mode).toBe("section");
    expect(selected.content).toContain("Guide");
    const links = await fetchWebLinks({ url, limit: 1 });
    expect(links.links).toHaveLength(1);
    expect(links.truncated).toBe(true);
    await expect(
      callWebTool("web_fetch_structured", { url, waitMs: 0 }),
    ).rejects.toThrow("waitMs");
    await expect(
      callWebTool("web_links", { url, limit: 101 }),
    ).rejects.toThrow();
    await expect(
      callWebTool("web_fetch_structured", {
        url,
        mode: "tree",
        section_id: "x",
      }),
    ).rejects.toThrow("section_id");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context7 credentials are private, refreshed per call and never returned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-web-key-"));
  const config = join(dir, "config.toml");
  const original = globalThis.fetch;
  const seen: (string | null)[] = [];
  globalThis.fetch = (async (_url, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    seen.push(auth);
    const key = auth?.replace("Bearer ", "") ?? "anonymous";
    if (String(_url).includes("/api/v1/test/library"))
      return new Response(`docs ${key}`);
    if (String(_url).includes("query=error"))
      return new Response(`rejected ${key}`, { status: 500 });
    return new Response(
      JSON.stringify({
        results: [
          {
            id: "/test/library",
            title: `Fixture ${key}`,
            description: "d",
            trustScore: 1,
            totalSnippets: 2,
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    expect(
      (
        (await callWebTool(
          "web_docs_resolve",
          { query: "library" },
          config,
        )) as any
      ).libraries[0].title,
    ).toContain("anonymous");
    writeContext7Key(config, "fixture-secret");
    expect(statSync(join(dir, "context7-api-key")).mode & 0o777).toBe(0o600);
    expect(
      JSON.stringify(
        await callWebTool("web_docs_resolve", { query: "library" }, config),
      ),
    ).not.toContain("fixture-secret");
    expect(
      JSON.stringify(
        await callWebTool(
          "web_docs_fetch",
          { library_id: "/test/library", topic: "intro", tokens: 100 },
          config,
        ),
      ),
    ).not.toContain("fixture-secret");
    await expect(
      callWebTool("web_docs_resolve", { query: "error" }, config),
    ).rejects.toThrow("[redacted]");
    writeContext7Key(config, "rotated-secret");
    expect(readContext7Key(config)).toBe("rotated-secret");
    expect(
      JSON.stringify(
        await callWebTool("web_docs_resolve", { query: "library" }, config),
      ),
    ).not.toContain("rotated-secret");
    writeContext7Key(config, 'quoted"fixture');
    expect(
      (
        (await callWebTool(
          "web_docs_resolve",
          { query: "library" },
          config,
        )) as any
      ).libraries[0].title,
    ).toBe("Fixture [redacted]");
    deleteContext7Key(config);
    await callWebTool("web_docs_resolve", { query: "library" }, config);
    expect(seen).toEqual([
      null,
      "Bearer fixture-secret",
      "Bearer fixture-secret",
      "Bearer fixture-secret",
      "Bearer rotated-secret",
      'Bearer quoted"fixture',
      null,
    ]);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit browser calls use isolated sessions and clean temporary state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-browser-fake-"));
  const log = join(dir, "log");
  const oldPath = process.env.PATH;
  const script = `#!/usr/bin/env node\nconst fs = require('node:fs'); const args = process.argv.slice(2); const command = ['open','eval','close'].find(x => args.includes(x)); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,cwd:process.cwd(),home:process.env.HOME,config:fs.readFileSync(process.env.AGENT_BROWSER_CONFIG,'utf8')})+'\\n'); console.log(JSON.stringify({success:true,data:command==='eval'?{result:JSON.stringify({html:'<html><body><a href="/next">Rendered link</a></body></html>',url:'https://example.test/page'})}:{}}));`;
  writeFileSync(join(dir, "agent-browser"), script, { mode: 0o700 });
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const options = { resolveHost: async () => ["93.184.216.34"] };
    const links = await fetchWebLinks(
      { url: "https://example.test/page", render: "browser", waitMs: 0 },
      undefined,
      options,
    );
    expect(links.links[0].text).toBe("Rendered link");
    const rendered = await fetchWebPage(
      { url: "https://example.test/page", render: "browser", waitMs: 0 },
      undefined,
      options,
    );
    expect(rendered.content).toContain("Rendered link");
    const entries = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.args.at(-1))).toContain("close");
    expect(entries[0].args).toContain("--allowed-domains");
    expect(entries[0].args.join(" ")).toContain("cdn.jsdelivr.net");
    expect(entries[0].args[1]).not.toBe(entries[3].args[1]);
    expect(entries[0].home).toBeUndefined();
    expect(entries[0].config.trim()).toBe("{}");
    expect(existsSync(entries[0].cwd)).toBe(false);
    await expect(
      fetchWebLinks({
        url: "http://127.0.0.1/private",
        render: "browser",
        waitMs: 0,
      }),
    ).rejects.toThrow("private");
    process.env.PATH = join(dir, "missing");
    await expect(
      fetchWebLinks(
        { url: "https://example.test/page", render: "browser", waitMs: 0 },
        undefined,
        options,
      ),
    ).rejects.toThrow("render_unavailable");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context7 errors give Grove-specific advice without changing other errors or exposing keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-web-errors-"));
  const config = join(dir, "config.toml");
  const original = globalThis.fetch;
  let status = 404;
  const secret = "fixture-private-key";
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(`provider says ${secret}: set CONTEXT7_API_KEY`, {
      status,
    })) as typeof fetch;
  try {
    writeContext7Key(config, secret);
    await expect(
      callWebTool("web_docs_fetch", { library_id: "/missing/library" }, config),
    ).rejects.toThrow("Use web_docs_resolve to find the correct library ID");
    status = 429;
    for (const [name, args] of [
      ["web_docs_resolve", { query: "missing" }],
      ["web_docs_fetch", { library_id: "/missing/library" }],
    ] as const) {
      await expect(callWebTool(name, args, config)).rejects.toThrow(
        "Settings → Web",
      );
    }
    status = 500;
    await expect(
      callWebTool("web_docs_fetch", { library_id: "/missing/library" }, config),
    ).rejects.toThrow("provider says [redacted]: set CONTEXT7_API_KEY");
    status = 401;
    for (const [name, args, operation] of [
      ["web_docs_resolve", { query: "missing" }, "resolve"],
      ["web_docs_fetch", { library_id: "/missing/library" }, "docs"],
    ] as const) {
      const error = await callWebTool(name, args, config).then(
        () => {
          throw new Error("Expected Context7 failure");
        },
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected an Error");
      expect(error.message).toBe(
        `context7 ${operation}: invalid Context7 key (HTTP 401) — keys start with 'ctx7sk'; replace or delete it in Settings → Web`,
      );
      expect(error.message).not.toContain("CONTEXT7_API_KEY");
      expect(error.message).not.toContain(secret);
    }
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
