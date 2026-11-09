import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceManager, ManagerNotStarted } from "./instance-manager";
import { InstanceControls } from "./instance-controls";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { HostService } from "./hosts";
import { createHandler } from "./http";

const uid = 1000;
const pid = 45786;
const group = (unit: string) =>
  `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;

function fixture(unit = "grove-isolated.service") {
  const calls: { binary: string; args: string[] }[] = [];
  const state = {
    owner: uid,
    cgroup: `0::${group(unit)}\n`,
    reportedUnit: unit,
    reportedPid: pid,
    reportedGroup: group(unit),
    extra: "",
    inspectFails: false,
    moveDuringInspect: false,
  };
  const host = {
    platform: "linux",
    uid,
    pid,
    busUid: async () => state.owner,
    cgroup: async () => state.cgroup,
    inspect: async (binary: string, args: string[]) => {
      calls.push({ binary, args });
      if (state.inspectFails) throw new Error("fixture manager unavailable");
      if (state.moveDuringInspect)
        state.cgroup = `0::${group("other.service")}\n`;
      return `Id=${state.reportedUnit}\nMainPID=${state.reportedPid}\nControlGroup=${state.reportedGroup}\n${state.extra}`;
    },
    spawn: async (binary: string, args: string[]) => {
      calls.push({ binary, args });
    },
  };
  return { host, state, calls, manager: instanceManager(host) };
}

for (const unit of ["grove-isolated.service", "flickgrove.service"]) {
  test(`human status and restart select the verified current ${unit}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-manager-http-"));
    const app = new Workspace({
      directory: dir,
      runtime: new FakeRuntime(),
      projects: async () => fixtureProjects,
      branches: { read: async () => null },
    });
    const origin = "http://localhost:4318";
    const service = new HostService(app, {
      directory: dir,
      origin: () => origin,
    });
    const auth = {
      session: async () => ({ user: { id: "fixture-human" } }),
    } as unknown as import("./auth").GroveAuth;
    const { manager, calls } = fixture(unit);
    const handler = createHandler(app, {
      service,
      auth,
      origin: () => origin,
      instance: new InstanceControls(app, null, manager),
    });
    try {
      const response = await handler(
        new Request(`${origin}/api/instance`, { headers: { origin } }),
      );
      expect(response.status).toBe(200);
      const status = (await response.json()) as {
        busy: boolean;
        restartAvailable: boolean;
      };
      expect(status.busy).toBe(false);
      expect(status.restartAvailable).toBe(true);
      expect(calls[0]).toEqual({
        binary: "/usr/bin/systemctl",
        args: [
          "--user",
          "show",
          unit,
          "--property=Id",
          "--property=MainPID",
          "--property=ControlGroup",
        ],
      });
      const result = await handler(
        new Request(`${origin}/api/instance/restart`, {
          method: "POST",
          headers: { origin },
        }),
      );
      expect(await result.json()).toEqual({ status: "unknown" });
      expect(calls.at(-1)).toEqual({
        binary: "/usr/bin/systemctl",
        args: ["--user", "--no-block", "restart", unit],
      });
    } finally {
      app.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("rejects unowned, unsafe, ambiguous or mismatched user services", async () => {
  for (const change of [
    (s: ReturnType<typeof fixture>["state"]) => (s.owner = 1001),
    (s: ReturnType<typeof fixture>["state"]) => (s.reportedPid = pid + 1),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.reportedUnit = "other.service"),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.reportedGroup = group("other.service")),
    (s: ReturnType<typeof fixture>["state"]) => (s.extra = `MainPID=${pid}\n`),
    (s: ReturnType<typeof fixture>["state"]) => (s.inspectFails = true),
    (s: ReturnType<typeof fixture>["state"]) => (s.moveDuringInspect = true),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup = "0::/system.slice/grove-isolated.service\n"),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup =
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/grove-isolated.service\n"),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup = `0::${group("-unsafe.service")}\n`),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup = `0::${group("unsafe;command.service")}\n`),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup = `0::${group("../other.service")}\n`),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup = `0::${group("nested.scope/other.service")}\n`),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup = ` 0::${group("grove-isolated.service")}\n`),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup += `0::${group("other.service")}\n`),
    (s: ReturnType<typeof fixture>["state"]) => (s.cgroup = "not a cgroup"),
  ]) {
    const { manager, state, calls } = fixture();
    change(state);
    expect(await manager.available()).toBe(false);
    await expect(manager.request()).rejects.toBeInstanceOf(ManagerNotStarted);
    expect(calls.some(({ args }) => args.includes("restart"))).toBe(false);
  }
});

test("rechecks the verified service before requesting restart", async () => {
  for (const change of [
    (s: ReturnType<typeof fixture>["state"]) => s.reportedPid++,
    (s: ReturnType<typeof fixture>["state"]) => (s.owner = 1001),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.cgroup = `0::${group("other.service")}\n`),
  ]) {
    const { manager, state, calls } = fixture();
    expect(await manager.available()).toBe(true);
    change(state);
    await expect(manager.request()).rejects.toBeInstanceOf(ManagerNotStarted);
    expect(calls.some(({ args }) => args.includes("restart"))).toBe(false);
  }
});

test("accepts an unambiguous systemd v1 user cgroup", async () => {
  const { manager, state } = fixture();
  state.cgroup = `3:cpu:/\n1:name=systemd:${group("grove-isolated.service")}\n`;
  expect(await manager.available()).toBe(true);
});
