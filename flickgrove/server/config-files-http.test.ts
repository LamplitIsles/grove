import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigFilesStatus } from "../src/contracts";
import { HostService } from "./hosts";
import { createHandler } from "./http";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { configFileSecret, configFilesFixture } from "./config-files-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-config-files-http-"));
  const locations = configFilesFixture(directory);
  const app = new Workspace({
    directory: join(directory, "state"),
    runtime: new FakeRuntime(),
    projects: async () => fixtureProjects,
    configFiles: locations,
  });
  const origin = "http://localhost:4318";
  const service = new HostService(app, { directory, origin: () => origin });
  const auth = {
    session: async (headers: Headers) =>
      headers.get("cookie") === "human=fixture"
        ? { user: { id: "human" } }
        : null,
  } as unknown as import("./auth").GroveAuth;
  const handler = createHandler(app, { service, auth, origin: () => origin });
  // Registered in teardown order: the reversed loop disposes the workspace
  // before the test-owned SQLite directory is removed.
  cleanups.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
  );
  const call = (
    method = "GET",
    headers: Record<string, string> = {
      Origin: origin,
      Cookie: "human=fixture",
      "X-Grove-Peer": service.identity.id,
    },
    path = "/config-files",
  ) => handler(new Request(new URL(path, origin), { method, headers }));
  return { directory, locations, app, origin, service, call };
}

test("GET /config-files requires the existing authenticated instance identity", async () => {
  const f = fixture();
  expect(
    (
      await f.call("GET", {
        Origin: f.origin,
        "X-Grove-Peer": f.service.identity.id,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.call("GET", {
        Origin: "http://other.invalid",
        Cookie: "human=fixture",
        "X-Grove-Peer": f.service.identity.id,
      })
    ).status,
  ).toBe(403);
  const stale = await f.call("GET", {
    Origin: f.origin,
    Cookie: "human=fixture",
    "X-Grove-Peer": "former-instance",
  });
  expect(stale.status).toBe(403);
  expect(await stale.json()).toEqual({ error: "Peer identity changed" });
  expect(
    (
      await f.call("GET", {
        Origin: f.origin,
        Cookie: "human=fixture",
        "X-Grove-Peer": "",
      })
    ).status,
  ).toBe(403);
});

test("authenticated GET /config-files returns the resolved locations as no-store peer data", async () => {
  const f = fixture();
  const response = await f.call();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Vary")).toBe("Origin");
  expect(response.headers.get("X-Grove-Peer")).toBe(f.service.identity.id);
  const status = (await response.json()) as ConfigFilesStatus;
  expect(status.issues).toEqual([]);
  expect(
    status.files.map((file) => [file.source, file.name, file.path]),
  ).toEqual([
    ["grove", "Grove configuration", f.locations.configPath],
    ["grove", "Task division", join(f.directory, "prompts/role-division.md")],
    ["grove", "Orc instructions", join(f.directory, "prompts/orc.md")],
    [
      "grove",
      "Researcher instructions",
      join(f.directory, "prompts/researcher.md"),
    ],
    [
      "grove",
      "Standards reviewer instructions",
      join(f.directory, "prompts/standards.md"),
    ],
    [
      "grove",
      "Spec reviewer instructions",
      join(f.directory, "prompts/spec.md"),
    ],
    [
      "grove",
      "High-risk Spec reviewer instructions",
      join(f.directory, "prompts/high-risk-spec.md"),
    ],
    [
      "grove",
      "Member preset codex-only",
      join(f.locations.memberPresetsDirectory, "codex-only.toml"),
    ],
    ["pi", "Pi settings", join(f.locations.piAgentDir, "settings.json")],
    ["pi", "Pi models", join(f.locations.piAgentDir, "models.json")],
    ["pi", "Pi MCP servers", join(f.locations.piAgentDir, "mcp.json")],
    ["pi", "Pi credentials", join(f.locations.piAgentDir, "auth.json")],
    [
      "codex",
      "Codex configuration",
      join(f.locations.codexHome, "config.toml"),
    ],
    [
      "codex",
      "Codex environments",
      join(f.locations.codexHome, "environments.toml"),
    ],
    ["codex", "Codex credentials", join(f.locations.codexHome, "auth.json")],
  ]);
  // The credential files exist in the fixture; their contents never cross this
  // boundary and no request path can select an arbitrary file.
  expect(await (await f.call()).text()).not.toContain(configFileSecret);
  const queried = await f.call(
    "GET",
    {
      Origin: f.origin,
      Cookie: "human=fixture",
      "X-Grove-Peer": f.service.identity.id,
    },
    "/config-files?path=%2Fetc%2Fpasswd",
  );
  expect(((await queried.json()) as ConfigFilesStatus).files.length).toBe(
    status.files.length,
  );
  expect(queried.headers.get("Cache-Control")).toBe("no-store");
});

test("GET /config-files keeps listing other sources when Grove prompts cannot be resolved", async () => {
  const f = fixture();
  writeFileSync(f.locations.configPath, "orc = ");
  const status = (await (await f.call()).json()) as ConfigFilesStatus;
  expect(status.issues).toEqual([
    "Could not resolve the Grove role instruction files",
  ]);
  expect(status.files.filter((file) => file.source === "pi")).toHaveLength(4);
  expect(status.files.filter((file) => file.source === "codex")).toHaveLength(
    3,
  );
  expect((await f.call("POST")).status).toBe(405);
});
