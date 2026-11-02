import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface InstanceManager {
  available(): Promise<boolean>;
  request(): Promise<void>;
}
export class ManagerNotStarted extends Error {}

/** Only the fixed user service whose main process is this process is eligible. */
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
  const inspectArgs = linux
    ? [
        "--user",
        "show",
        "flickgrove.service",
        "--property=MainPID",
        "--property=ControlGroup",
      ]
    : ["print", `gui/${uid}/io.guion.flickgrove`];
  const requestArgs = linux
    ? ["--user", "--no-block", "restart", "flickgrove.service"]
    : ["kickstart", "-k", `gui/${uid}/io.guion.flickgrove`];
  return {
    async available() {
      if (!linux && !mac) return false;
      try {
        if (linux && (await target.busUid(bus)) !== uid) return false;
        const stdout = await target.inspect(binary, inspectArgs, env);
        if (linux) {
          const pid = /^MainPID=(\d+)$/m.exec(stdout)?.[1];
          const group = /^ControlGroup=(\/.+)$/m.exec(stdout)?.[1];
          const current = await target.cgroup();
          return (
            pid === String(target.pid) &&
            !!group &&
            group.endsWith("/flickgrove.service") &&
            current.split("\n").some((line) => line.endsWith(`:${group}`))
          );
        }
        const pids = [...stdout.matchAll(/^\s*pid = (\d+)\s*$/gm)];
        return pids.length === 1 && pids[0]![1] === String(target.pid);
      } catch {
        return false;
      }
    },
    request() {
      return target.spawn(binary, requestArgs, env);
    },
  };
}
