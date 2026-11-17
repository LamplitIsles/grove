import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OrganizationReviewStore,
  organizationKey,
  organizationReviewSettings,
} from "./organization-review";
import { projectCatalogue } from "./projects";
import { Workspace } from "./workspace";
import { FakeRuntime } from "./testing";
import { HostService } from "./hosts";
import { invoke } from "./chord-methods";
import { organizationReviewHttp } from "./organization-review-http";
import { externalMcp } from "./external-mcp";
import { fileURLToPath } from "node:url";
import { routeCall } from "../src/chord-contract";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-org-review-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new OrganizationReviewStore(directory) };
}

test("atomic independent owner files survive restart, and malformed storage never means off", async () => {
  const { directory, store } = fixture();
  expect(await store.readEnabled("alpha")).toBe(false);
  await Promise.all([store.write("alpha", true), store.write("beta", false)]);
  const reopened = new OrganizationReviewStore(directory);
  expect(await reopened.readEnabled("alpha")).toBe(true);
  expect(await reopened.readEnabled("beta")).toBe(false);
  await Promise.all([
    store.write("alpha", false),
    reopened.write("alpha", true),
  ]);
  expect(await store.readEnabled("alpha")).toBe(true);
  expect(await store.readEnabled("beta")).toBe(false);
  for (const invalid of ["../alpha", ".", "a/b", "a\\b", "", "ALPHA"]) {
    await expect(store.write(invalid, true)).rejects.toThrow();
  }
  expect(organizationKey("AcMe-1.x")).toBe("acme-1.x");
  const files = readdirSync(join(directory, "organization-review")).filter(
    (name) => name.endsWith(".json"),
  );
  const alphaFile = files.find((name) =>
    readFileSync(join(directory, "organization-review", name), "utf8").includes(
      '"alpha"',
    ),
  )!;
  const alphaPath = join(directory, "organization-review", alphaFile);
  writeFileSync(alphaPath, "not json");
  await expect(store.readEnabled("alpha")).rejects.toThrow();
  unlinkSync(alphaPath);
  symlinkSync(join(directory, "missing"), alphaPath);
  await expect(store.readEnabled("alpha")).rejects.toThrow();
});

test("independent processes atomically update distinct owners and one contested owner", async () => {
  const { directory, store } = fixture();
  const module = fileURLToPath(
    new URL("./organization-review.ts", import.meta.url),
  );
  const script = `import { OrganizationReviewStore } from ${JSON.stringify(module)}; const s = new OrganizationReviewStore(process.argv[1]); for (let i=0;i<20;i++) { await s.write(process.argv[2], true); await s.write("contested", process.argv[3] === "true"); }`;
  const processes = ["one", "two", "three"].map((owner, i) =>
    Bun.spawn(
      [process.execPath, "-e", script, directory, owner, String(i % 2 === 0)],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  for (const process of processes) {
    const [code, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  }
  for (const owner of ["one", "two", "three"])
    expect(await store.readEnabled(owner)).toBe(true);
  expect(typeof (await store.readEnabled("contested"))).toBe("boolean");
  await store.write("contested", false);
  expect(await store.readEnabled("contested")).toBe(false);
  expect(
    readdirSync(join(directory, "organization-review")).every(
      (name) => !name.startsWith(".tmp-"),
    ),
  ).toBe(true);
});

test("catalogue combines normalized owner groups and honestly reports unavailable environments", async () => {
  const { store } = fixture();
  await store.write("acme", true);
  await store.write("saved", true);
  let offline = true;
  const environments = async () => [
    { id: "local", name: "Local" },
    { id: "remote", name: "Remote" },
  ];
  const projects = async (id: string) => {
    if (id === "remote" && offline) throw new Error("private error");
    return projectCatalogue(
      id === "local"
        ? [
            {
              alias: "a",
              name: "A",
              path: "/a",
              remote: "https://github.com/ACME/repo",
            },
            {
              alias: "b",
              name: "B",
              path: "/b",
              remote: "ssh://git@forge.invalid/acme/repo",
            },
            { alias: "u", name: "U", path: "/u" },
          ]
        : [
            {
              alias: "s",
              name: "S",
              path: "/s",
              remote: "https://example.invalid/Saved/repo",
            },
          ],
    );
  };
  expect(
    await organizationReviewSettings(store, environments, projects),
  ).toEqual({
    organizations: [{ organization: "acme", enabled: true }],
    unavailableEnvironments: [{ id: "remote", name: "Remote" }],
  });
  offline = false;
  expect(
    await organizationReviewSettings(store, environments, projects),
  ).toEqual({
    organizations: [
      { organization: "acme", enabled: true },
      { organization: "saved", enabled: true },
    ],
    unavailableEnvironments: [],
  });
  await expect(
    organizationReviewSettings(store, environments, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow();
});

test("protected endpoint validates peer, origin, auth, DTO and storage errors", async () => {
  const { directory, store } = fixture();
  const runtime = new FakeRuntime();
  const projects = async () => [
    { alias: "a", name: "A", path: "/a", owner: "acme" },
  ];
  const app = new Workspace({ directory, runtime, projects });
  cleanup.push(() => app.dispose());
  const service = new HostService(app, {
    directory,
    origin: () => "http://localhost:4318",
  });
  const options = {
    store,
    projects,
    environments: async () => [{ id: "local", name: "Local" }],
  };
  const call = (
    method: string,
    body?: unknown,
    changes: {
      origin?: string;
      peer?: string;
      url?: string;
      auth?: boolean;
    } = {},
  ) =>
    organizationReviewHttp(
      new Request(
        changes.url ?? "http://localhost:4318/api/organization-review-settings",
        {
          method,
          headers: {
            origin: changes.origin ?? "http://localhost:4318",
            "x-grove-peer": changes.peer ?? service.identity.id,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
      service,
      ["http://localhost:4318"],
      options,
      changes.auth ?? true,
    ).then((r) => r!);
  expect((await call("GET", undefined, { auth: false })).status).toBe(401);
  expect((await call("GET", undefined, { peer: "other" })).status).toBe(403);
  expect(
    (
      await call(
        "PUT",
        { organization: "acme", enabled: true },
        { origin: "http://evil.invalid" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call("GET", undefined, {
        url: "http://other.invalid/api/organization-review-settings",
      })
    ).status,
  ).toBe(403);
  for (const body of [
    { organization: "../bad", enabled: true },
    { organization: "acme", enabled: "yes" },
    { organization: "acme", enabled: true, extra: 1 },
    { organization: "acme" },
  ])
    expect((await call("PUT", body)).status).toBe(400);
  const saved = await call("PUT", { organization: "ACME", enabled: true });
  expect(saved.headers.get("cache-control")).toBe("no-store");
  expect(saved.headers.get("x-grove-peer")).toBe(service.identity.id);
  expect(await saved.json()).toEqual({ organization: "acme", enabled: true });
  expect(await (await call("GET")).json()).toEqual({
    organizations: [{ organization: "acme", enabled: true }],
    unavailableEnvironments: [],
  });
  expect((await call("DELETE")).status).toBe(405);
  const file = readdirSync(join(directory, "organization-review"))[0]!;
  writeFileSync(join(directory, "organization-review", file), "bad");
  expect((await call("GET")).status).toBe(500);
  rmSync(join(directory, "organization-review"), { recursive: true });
  writeFileSync(join(directory, "organization-review"), "not a directory");
  const failed = await call("PUT", { organization: "acme", enabled: true });
  expect(failed.status).toBe(500);
  expect(((await failed.json()) as { code: string }).code).toBe(
    "setting_save_unconfirmed",
  );
});

test("new sessions capture a single pre-start read; restart and history retain old snapshots", async () => {
  const { directory, store } = fixture();
  const runtime = new FakeRuntime();
  const projects = async (environment = "local") =>
    environment === "remote"
      ? [
          {
            alias: "r",
            name: "Remote",
            path: "/remote",
            owner: "acme",
            environment: { id: "remote", name: "Remote", target: "fixture" },
          },
        ]
      : [
          { alias: "a", name: "A", path: "/a", owner: "acme" },
          { alias: "b", name: "B", path: "/b", owner: "other" },
          { alias: "u", name: "U", path: "/u", owner: null },
        ];
  const reads: string[] = [];
  let fail = false;
  const open = () =>
    new Workspace({
      directory,
      runtime,
      projects,
      readOrganizationReviewEnabled: async (owner) => {
        reads.push(owner);
        if (fail) throw new Error("storage failure");
        return store.readEnabled(owner);
      },
    });
  let app = open();
  cleanup.push(() => app.dispose());
  await store.write("acme", true);
  const a = await app.createOrc("a");
  expect(app.store.byId(a.id)?.autoReviewSnapshot).toEqual({
    organization: "acme",
    enabled: true,
  });
  expect(runtime.agents.get(a.id)?.autoReviewSnapshot?.enabled).toBe(true);
  expect(a).not.toHaveProperty("autoReviewSnapshot");
  const b = await app.createOrc("b");
  const u = await app.createOrc("u");
  expect(app.store.byId(b.id)?.autoReviewSnapshot).toEqual({
    organization: "other",
    enabled: false,
  });
  expect(app.store.byId(u.id)?.autoReviewSnapshot).toEqual({
    organization: null,
    enabled: false,
  });
  expect(reads).toEqual(["acme", "other"]);
  await store.write("acme", false);
  const service = new HostService(app, {
    directory,
    origin: () => "http://localhost:4318",
  });
  const chord = (await invoke(service, "createOrc", {
    project: "a",
    settings: { fast: false, orc: { model: "sol", effort: "medium" } },
  })) as {
    id: string;
  };
  const chordId = chord.id.slice(service.identity.id.length + 1);
  expect(app.store.byId(chordId)?.autoReviewSnapshot?.enabled).toBe(false);
  const uiRoute = routeCall("/agents", {
    project: "a",
    settings: { fast: false, orc: { model: "sol", effort: "medium" } },
  });
  const ui = (await invoke(service, uiRoute.member, uiRoute.input)) as {
    id: string;
  };
  expect(
    app.store.byId(ui.id.slice(service.identity.id.length + 1))
      ?.autoReviewSnapshot,
  ).toEqual({ organization: "acme", enabled: false });
  const remote = await app.createOrc("remote:r");
  expect(app.store.byId(remote.id)?.autoReviewSnapshot).toEqual({
    organization: "acme",
    enabled: false,
  });
  await store.write("acme", true);
  const mcp = await externalMcp(
    new Request("http://localhost:4318/external-mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_session", arguments: { project: "a" } },
      }),
    }),
    service,
    { id: "fixture", name: "Fixture", color: "#000000" },
  );
  expect(mcp.status).toBe(200);
  const response = (await mcp.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(response.result.isError).not.toBe(true);
  const externalId = JSON.parse(response.result.content[0]!.text).session
    .id as string;
  expect(
    app.store.byId(externalId.slice(service.identity.id.length + 1))
      ?.autoReviewSnapshot,
  ).toEqual({ organization: "acme", enabled: true });
  const before = runtime.agents.size;
  fail = true;
  await expect(app.createOrc("a")).rejects.toThrow("storage failure");
  expect(runtime.agents.size).toBe(before);
  fail = false;
  const thread = app.detail(a.id).threadId!;
  await app.closeTree(a.id);
  app.dispose();
  app = open();
  expect(app.store.byId(a.id)?.autoReviewSnapshot?.enabled).toBe(true);
  const readsBefore = reads.length;
  await app.resumeHistory("a", thread, false);
  expect(reads.length).toBe(readsBefore);
  expect(app.store.byId(a.id)?.autoReviewSnapshot?.enabled).toBe(true);
  app.store.sqlite
    .query(
      "UPDATE session_config SET captured=json_remove(captured,'$.autoReviewSnapshot') WHERE session_id=?",
    )
    .run(b.id);
  app.dispose();
  app = open();
  expect(app.store.byId(b.id)?.autoReviewSnapshot).toBeUndefined();
  await app.resumeHistory("b", app.detail(b.id).threadId!, false);
  expect(reads.length).toBe(readsBefore);
  expect(app.store.byId(b.id)?.autoReviewSnapshot).toBeUndefined();
  runtime.historySessions.set("outside-thread", {
    threadId: "outside-thread",
    title: "Outside",
    preview: "",
    cwd: "/a",
    role: "session",
    source: "appServer",
    archived: false,
    updatedAt: Date.now(),
  });
  const outside = await app.resumeHistory("a", "outside-thread", false);
  expect(app.store.byId(outside.id)?.autoReviewSnapshot).toBeUndefined();
  expect(reads.length).toBe(readsBefore);
});
