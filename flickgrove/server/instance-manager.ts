import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface InstanceManager {
  available(): Promise<boolean>;
  request(): Promise<void>;
}
export class ManagerNotStarted extends Error {}

/** Only this process's verified same-user service is eligible. */
type ManagerHost = {
  platform: string;
  uid: number | undefined;
  pid: number;
  inspect(
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<string>;
  busUid(path: string): Promise<number>;
  cgroup(): Promise<string>;
  spawn(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void>;
};

const host: ManagerHost = {
  platform: process.platform,
  uid: process.getuid?.(),
  pid: process.pid,
  async inspect(binary, args, env) {
    return (await exec(binary, args, { env, timeout: 3000, maxBuffer: 65536 }))
      .stdout;
  },
  async busUid(path) {
    return (await stat(path)).uid;
  },
  cgroup: () => readFile("/proc/self/cgroup", "utf8"),
  spawn(binary, args, env) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { env, stdio: "ignore" });
      child.once("error", () => reject(new ManagerNotStarted()));
      child.once("spawn", () => resolve());
    });
  },
};

function userService(cgroup: string, uid: number) {
  if (!Number.isSafeInteger(uid) || uid < 0) return null;
  const paths: string[] = [];
  const lines = cgroup.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const entry = /^(\d+):([^:]*):(\/[^\s]*)$/.exec(line);
    if (!entry) return null;
    if (
      (entry[1] === "0" && entry[2] === "") ||
      entry[2]!.split(",").includes("name=systemd")
    )
      paths.push(entry[3]!);
  }
  if (paths.length !== 1) return null;
  const group = paths[0]!;
  const prefix = `/user.slice/user-${uid}.slice/user@${uid}.service/`;
  if (!group.startsWith(prefix)) return null;
  const parts = group.slice(prefix.length).split("/");
  const unit = parts.pop()!;
  const safeName = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]*$/;
  if (
    unit.length > 255 ||
    !unit.endsWith(".service") ||
    !safeName.test(unit) ||
    parts.some((part) =>
      part.length > 255 || !part.endsWith(".slice") || !safeName.test(part),
    )
  )
    return null;
  return { unit, group };
}

export function instanceManager(target: ManagerHost = host): InstanceManager {
  const uid = target.uid;
  const linux = target.platform === "linux" && uid !== undefined;
  const mac = target.platform === "darwin" && uid !== undefined;
  const binary = linux ? "/usr/bin/systemctl" : "/bin/launchctl";
  const bus = `/run/user/${uid}/bus`;
  const env = linux
    ? {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`,
        XDG_RUNTIME_DIR: `/run/user/${uid}`,
      }
    : process.env;
  type Verified = { unit: string; group: string };
  let verified: Verified | null = null;
  async function verify(): Promise<Verified | null> {
    if ((!linux && !mac) || !Number.isSafeInteger(target.pid) || target.pid <= 0)
      return null;
    try {
      if (linux) {
        if ((await target.busUid(bus)) !== uid) return null;
        const service = userService(await target.cgroup(), uid!);
        if (!service) return null;
        const stdout = await target.inspect(
          binary,
          [
            "--user",
            "show",
            service.unit,
            "--property=Id",
            "--property=MainPID",
            "--property=ControlGroup",
          ],
          env,
        );
        const property = (name: string) => {
          const matches = [
            ...stdout.matchAll(new RegExp(`^${name}=(.*)$`, "gm")),
          ];
          return matches.length === 1 ? matches[0]![1] : null;
        };
        const after = userService(await target.cgroup(), uid!);
        return property("Id") === service.unit &&
          property("MainPID") === String(target.pid) &&
          property("ControlGroup") === service.group &&
          after?.unit === service.unit &&
          after.group === service.group
          ? service
          : null;
      }
      const stdout = await target.inspect(
        binary,
        ["print", `gui/${uid}/io.guion.flickgrove`],
        env,
      );
      const pids = [...stdout.matchAll(/^\s*pid = (\d+)\s*$/gm)];
      return pids.length === 1 && pids[0]![1] === String(target.pid)
        ? { unit: `gui/${uid}/io.guion.flickgrove`, group: "" }
        : null;
    } catch {
      return null;
    }
  }
  return {
    async available() {
      verified = await verify();
      return verified !== null;
    },
    async request() {
      const previous = verified;
      verified = null;
      if (!previous) throw new ManagerNotStarted();
      const current = await verify();
      if (
        !current ||
        current.unit !== previous.unit ||
        current.group !== previous.group
      )
        throw new ManagerNotStarted();
      await target.spawn(
        binary,
        linux
          ? ["--user", "--no-block", "restart", current.unit]
          : ["kickstart", "-k", current.unit],
        env,
      );
    },
  };
}
