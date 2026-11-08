import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixtureSync,
} from "./testing";
import { HostService } from "./hosts";
import { createHandler } from "./http";
import type { MemberPresetsStatus } from "../src/contracts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-presets-http-"));
  const memberPresets = memberPresetsFixtureSync(directory);
  const app = new Workspace({
    directory: join(directory, "state"),
    runtime: new FakeRuntime(),
    projects: async () => fixtureProjects,
    memberPresets,
  });
  const origin = "http://localhost:4318";
  const service = new HostService(app, { directory, origin: () => origin });
  const auth = {
    session: async (headers: Headers) =>
      headers.get("cookie") === "human=fixture"
        ? { user: { id: "human" } }
        : null,
  } as unknown as import("./auth").GroveAuth;
  const handler = createHandler(app, {
    service,
    auth,
    origin: () => origin,
  });
  cleanups.push(
    () => app.dispose(),
    () => rmSync(directory, { recursive: true, force: true }),
  );
  const call = (
    method: string,
    body?: unknown,
    headers: Record<string, string> = {
      Origin: origin,
      Cookie: "human=fixture",
      "X-Grove-Peer": service.identity.id,
    },
  ) =>
    handler(
      new Request(new URL("/member-presets", origin), {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { directory, app, memberPresets, origin, service, call };
}

test("authenticated GET /member-presets returns the discovered presets and shared current selection", async () => {
  const f = fixture();
  expect(
    (
      await f.call("GET", undefined, {
        Origin: f.origin,
        "X-Grove-Peer": f.service.identity.id,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.call("GET", undefined, {
        Origin: "http://other.invalid",
        Cookie: "human=fixture",
        "X-Grove-Peer": f.service.identity.id,
      })
    ).status,
  ).toBe(403);
  const response = await f.call("GET");
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Grove-Peer")).toBe(f.service.identity.id);
  expect((await response.json()) as MemberPresetsStatus).toEqual({
    presets: [{ id: "codex-only", name: "codex-only" }],
    current: "codex-only",
  });
});

test("PUT /member-presets validates the selected file before the shared write", async () => {
  const f = fixture();
  const saved = await f.call("PUT", { preset: "codex-only" });
  expect(saved.status).toBe(200);
  expect((await saved.json()) as MemberPresetsStatus).toMatchObject({
    current: "codex-only",
  });
  expect((await f.call("PUT", { preset: "absent" })).status).toBe(400);
  expect(
    (
      (await (await f.call("PUT", { preset: "absent" })).json()) as {
        error: string;
      }
    ).error,
  ).toContain("was not found");
  expect((await f.call("PUT", { preset: 7 })).status).toBe(400);
  expect(
    (await f.call("PUT", { preset: "codex-only", extra: true })).status,
  ).toBe(400);
  expect((await f.call("POST", { preset: "codex-only" })).status).toBe(405);
  // A broken file cannot be selected and the stored selection is unchanged.
  writeFileSync(join(f.memberPresets.directory, "broken.toml"), "name = ");
  const broken = await f.call("PUT", { preset: "broken" });
  expect(broken.status).toBe(400);
  expect(((await broken.json()) as { error: string }).error).toContain(
    "is not valid TOML",
  );
  expect((await f.app.memberPresetsStatus()).current).toBe("codex-only");
  // The next read reflects a newly added file without a restart.
  writeFileSync(
    join(f.memberPresets.directory, "added.toml"),
    (await import("./testing")).memberPresetToml({ name: "Added" }, "added"),
  );
  const status = (await (await f.call("GET")).json()) as MemberPresetsStatus;
  expect(status.presets).toEqual([
    { id: "added", name: "Added" },
    { id: "broken", name: "broken", error: expect.any(String) },
    { id: "codex-only", name: "codex-only" },
  ]);
});

test("a changed instance identity is refused before reading or writing the shared selection", async () => {
  const f = fixture();
  const stale = {
    Origin: f.origin,
    Cookie: "human=fixture",
    "X-Grove-Peer": "former-instance",
  };
  const get = await f.call("GET", undefined, stale);
  expect(get.status).toBe(403);
  expect(await get.json()).toEqual({ error: "Peer identity changed" });
  expect(
    (await f.call("GET", undefined, { ...stale, "X-Grove-Peer": "" })).status,
  ).toBe(403);
  const put = await f.call("PUT", { preset: "codex-only" }, stale);
  expect(put.status).toBe(403);
  expect(await put.json()).toEqual({ error: "Peer identity changed" });
  // The refused write never reaches the shared selection.
  expect((await f.app.memberPresetsStatus()).current).toBe("codex-only");
  writeFileSync(
    join(f.memberPresets.directory, "added.toml"),
    (await import("./testing")).memberPresetToml({ name: "Added" }, "added"),
  );
  expect((await f.call("PUT", { preset: "added" }, stale)).status).toBe(403);
  expect((await f.app.memberPresetsStatus()).current).toBe("codex-only");
  // The current identity still writes normally.
  expect((await f.call("PUT", { preset: "added" })).status).toBe(200);
  expect((await f.app.memberPresetsStatus()).current).toBe("added");
});
