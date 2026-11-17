import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Project, ProjectEnvironment } from "../src/contracts";
import { projectCatalogue, registeredProjects } from "./projects";
import { environmentId } from "../src/project-identity";
import { execProjectRead } from "./exec-project-read";

const exec = promisify(execFile);
const remoteFields = {
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .refine((v) => v !== "local"),
  name: z.string().trim().min(1).max(120),
  og: z.string().min(1).default("og"),
};
const remoteSchema = z.union([
  z
    .object({
      ...remoteFields,
      ssh: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    })
    .strict(),
  z.object({ ...remoteFields, transport: z.literal("wss") }).strict(),
]);
type Remote = z.infer<typeof remoteSchema>;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// OpenSSH prints quoted path words for these configuration fields. Decode only
// that documented word format; never evaluate configuration as shell code.
function words(value: string) {
  const result: string[] = [];
  let word = "",
    quoted = false,
    escape = false;
  for (const char of value) {
    if (escape) {
      word += char;
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (word) {
        result.push(word);
        word = "";
      }
    } else word += char;
  }
  if (quoted || escape) throw new Error("Unsupported SSH known-hosts path");
  if (word) result.push(word);
  return result;
}
const LOCAL: ProjectEnvironment = {
  id: "local",
  name: "This machine",
  target: "local",
};
const readErrors = new Set([
  "Preview directory changed",
  "File is outside the preview directory",
  "Only regular files can be previewed",
  "File exceeds 20 MiB",
  "File changed while reading; retry",
  "File type is not supported",
  "File is outside the session and registered project directories",
  "Could not read project branch",
  "Unsupported project read",
  "Invalid project read",
  "Project file or tool is unavailable; check the device and retry",
  "Project catalogue is unavailable. Check og and its project registration on this device.",
]);
export type ProjectReadCommand = (
  program: string,
  args: string[],
  options: {
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
    killSignal?: NodeJS.Signals;
  },
) => Promise<{ stdout: string; stderr: string }>;
const runCommand: ProjectReadCommand = async (program, args, options) => {
  const result = await exec(program, args, {
    ...options,
    env: {
      ...process.env,
      FLICKGROVE_AGENT_TOKEN: undefined,
      FLICKGROVE_ORIGIN: undefined,
    },
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

/** Only trusted administrator destinations and fixed operations enter SSH. */
export class ProjectEnvironments {
  constructor(
    private readonly configPath: string,
    private readonly codexHome = process.env.CODEX_HOME ??
      join(homedir(), ".codex"),
    private readonly command: ProjectReadCommand = runCommand,
  ) {}
  private async configured(): Promise<Remote[]> {
    try {
      const config = z
        .object({ project_environments: z.unknown().optional() })
        .parse(Bun.TOML.parse(await readFile(this.configPath, "utf8")));
      const entries = z
        .array(remoteSchema)
        .parse(config.project_environments ?? []);
      if (new Set(entries.map((e) => e.id)).size !== entries.length)
        throw new Error("Duplicate project execution environment");
      return entries;
    } catch {
      throw new Error(
        "Project execution environment configuration is invalid. Check the instance configuration and retry.",
      );
    }
  }
  private async capture(entry: Remote): Promise<ProjectEnvironment> {
    if ("transport" in entry) {
      const { target } = await this.wss(entry);
      return { id: entry.id, name: entry.name, target };
    }
    const native = z
      .object({ environments: z.unknown().optional() })
      .parse(
        Bun.TOML.parse(
          await readFile(join(this.codexHome, "environments.toml"), "utf8"),
        ),
      );
    const selections = z
      .array(
        z
          .object({
            id: z.string(),
            program: z.string().optional(),
            args: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .parse(native.environments ?? []);
    const selected = selections.find((s) => s.id === entry.id);
    const prefix = [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=5",
      entry.ssh,
    ];
    if (
      !selected ||
      selected.program !== "ssh" ||
      selected.args?.length !== prefix.length + 1 ||
      !prefix.every((value, i) => selected.args![i] === value)
    )
      throw new Error(
        `${entry.name}: configure the matching native environment with the documented non-interactive SSH arguments`,
      );
    const { stdout } = await this.command("ssh", ["-G", ...prefix], {
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    // Hash effective destination as well as the captured native transport. A changed
    // SSH alias cannot silently rebind existing sessions/grants after a restart.
    const destination = stdout
      .split("\n")
      .filter((l) =>
        /^(hostname|user|port|hostkeyalias|proxyjump|proxycommand|identityfile|stricthostkeychecking|userknownhostsfile) /.test(
          l,
        ),
      )
      .join("\n");
    if (/stricthostkeychecking (false|no|off)/.test(destination))
      throw new Error(`${entry.name}: SSH host key checking must be enabled`);
    const fields = new Map(
      stdout
        .trim()
        .split("\n")
        .map((line) => {
          const at = line.indexOf(" ");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    const alias = fields.get("hostkeyalias");
    const hostname = alias && alias !== "none" ? alias : fields.get("hostname");
    if (!hostname)
      throw new Error(`${entry.name}: SSH destination is unavailable`);
    const query =
      fields.get("port") === "22"
        ? hostname
        : `[${hostname}]:${fields.get("port")}`;
    const keys: string[] = [];
    for (let path of words(
      [fields.get("userknownhostsfile"), fields.get("globalknownhostsfile")]
        .filter(Boolean)
        .join(" "),
    )) {
      if (path === "none") continue;
      if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
      try {
        const match = await this.command(
          "ssh-keygen",
          ["-F", query, "-f", path],
          { timeout: 5000, maxBuffer: 256 * 1024 },
        );
        for (const line of match.stdout.split("\n"))
          if (line && !line.startsWith("#")) {
            const parts = line.trim().split(/\s+/);
            keys.push(
              parts[0].startsWith("@")
                ? parts[0] + " " + parts.slice(2, 4).join(" ")
                : parts.slice(1, 3).join(" "),
            );
          }
      } catch (error) {
        if (
          typeof (error as NodeJS.ErrnoException).code !== "number" &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw new Error(
            `${entry.name}: could not verify the configured SSH host key`,
          );
      }
    }
    if (!keys.length)
      throw new Error(
        `${entry.name}: register the device host key in the configured known-hosts file before connecting`,
      );
    const target = createHash("sha256")
      .update(
        JSON.stringify([
          entry,
          selected,
          destination,
          [...new Set(keys)].sort(),
        ]),
      )
      .digest("hex");
    return { id: entry.id, name: entry.name, target };
  }
  private async wss(entry: Extract<Remote, { transport: "wss" }>) {
    try {
      const path = join(this.codexHome, "environments.toml");
      const file = await open(path, "r");
      let contents: string;
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          (info.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" &&
            info.uid !== process.getuid())
        )
          throw new Error();
        contents = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      const native = z
        .object({
          environments: z.array(
            z
              .object({
                id: z.string(),
                url: z.string().optional(),
                auth_bearer_token: z.string().optional(),
                program: z.unknown().optional(),
                args: z.unknown().optional(),
              })
              .passthrough(),
          ),
        })
        .parse(Bun.TOML.parse(contents));
      const matches = native.environments.filter(
        (value) => value.id === entry.id,
      );
      const selected = matches[0];
      if (
        matches.length !== 1 ||
        !selected.url ||
        !selected.auth_bearer_token ||
        selected.program !== undefined ||
        selected.args !== undefined ||
        !/^[\x21-\x7e]+$/.test(selected.auth_bearer_token)
      )
        throw new Error();
      const url = new URL(selected.url);
      if (
        url.protocol !== "wss:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      const target = createHash("sha256")
        .update(JSON.stringify([entry, url.href]))
        .digest("hex");
      return { target, url: url.href, token: selected.auth_bearer_token };
    } catch {
      throw new Error(
        `${entry.name}: configure a matching WSS environment and bearer token in an owner-only environments.toml`,
      );
    }
  }
  async list() {
    return [
      LOCAL,
      ...(await this.configured()).map(({ id, name }) => ({
        id,
        name,
        target: "",
      })),
    ];
  }
  async binding(id = "local") {
    if (id === "local") return LOCAL;
    const entry = (await this.configured()).find((e) => e.id === id);
    if (!entry)
      throw new Error("Project execution environment is no longer configured");
    return this.capture(entry);
  }
  async assert(binding: ProjectEnvironment | undefined) {
    const current = await this.binding(binding?.id);
    if (binding && binding.target !== current.target)
      throw new Error(
        `${binding.name}: execution target changed; the original session cannot move to another device`,
      );
    return current;
  }
  async targets() {
    // Invalid optional device configuration must not disable local Codex model
    // reads. Selecting/using that device still reports the configuration error.
    const entries = await this.configured().catch(() => []);
    return new Map(
      await Promise.all(
        entries.map(async (entry) => {
          try {
            return [entry.id, (await this.capture(entry)).target] as const;
          } catch {
            return [entry.id, undefined] as const;
          }
        }),
      ),
    );
  }
  private async boundEntry(binding: ProjectEnvironment) {
    const entry = (await this.configured()).find((e) => e.id === binding.id);
    if (!entry || (await this.capture(entry)).target !== binding.target)
      throw new Error("Original project execution target is unavailable");
    return entry;
  }
  async og(binding: ProjectEnvironment) {
    return (await this.boundEntry(binding)).og;
  }
  async isWss(binding: ProjectEnvironment) {
    return "transport" in (await this.boundEntry(binding));
  }
  async projects(id = "local"): Promise<Project[]> {
    const environment = await this.binding(id);
    if (id === "local")
      return (await registeredProjects()).map((p) => ({ ...p, environment }));
    const value = await this.operation(environment, { operation: "projects" });
    const catalogue = z
      .object({
        projects: z.array(
          z.object({
            alias: z
              .string()
              .min(1)
              .max(200)
              .refine((value) => !value.includes(":")),
            name: z.string(),
            path: z
              .string()
              .refine(
                (value) => value.startsWith("/") && !value.includes("\0"),
              ),
            remote: z.string().optional(),
            archived: z.boolean().optional(),
          }),
        ),
      })
      .safeParse(value);
    if (!catalogue.success)
      throw new Error(
        `${environment.name}: project catalogue is invalid. Check og compatibility on the device.`,
      );
    return projectCatalogue(catalogue.data.projects).map((p) => ({
      ...p,
      environment,
    }));
  }
  async operation(
    binding: ProjectEnvironment,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    const entry = (await this.configured()).find((e) => e.id === binding.id);
    if (!entry) throw new Error("Remote execution environment is unavailable");
    const wss = "transport" in entry ? await this.wss(entry) : undefined;
    if ((wss?.target ?? (await this.capture(entry)).target) !== binding.target)
      throw new Error(
        `${binding.name}: execution target changed; retry from the original device configuration`,
      );
    const script = await readFile(
      new URL("./remote-project-read.py", import.meta.url),
      "utf8",
    );
    const data = Buffer.from(
      JSON.stringify({ ...payload, og: entry.og, execGroup: !!wss }),
    ).toString("base64");
    try {
      // A detached native session may retain its child after a broken socket.
      // Bound the remote lifetime even when terminate cannot reach the server.
      const boundedScript =
        "import signal,sys\nsignal.signal(signal.SIGALRM, lambda *_: sys.exit(1))\nsignal.alarm(15)\n" +
        script;
      const stdout =
        "transport" in entry
          ? await execProjectRead(
              wss!.url,
              wss!.token,
              boundedScript,
              data,
              signal,
            ).catch(() => {
              throw Object.assign(
                new Error("Remote project transport failed"),
                { code: "REMOTE_READ" },
              );
            })
          : (
              await this.command(
                "ssh",
                [
                  "-T",
                  "-o",
                  "BatchMode=yes",
                  "-o",
                  "StrictHostKeyChecking=yes",
                  "-o",
                  "ConnectTimeout=5",
                  entry.ssh,
                  `python3 -c ${quote(script)} ${quote(data)}`,
                ],
                {
                  signal,
                  timeout: 15000,
                  killSignal: "SIGKILL",
                  maxBuffer: 29 * 1024 * 1024,
                },
              )
            ).stdout;
      let value;
      try {
        value = JSON.parse(stdout);
      } catch {
        throw new Error(
          `${binding.name}: the project device returned invalid structured output. Check its tools and retry.`,
        );
      }
      if (value?.error)
        throw new Error(
          readErrors.has(value.error)
            ? value.error
            : `${binding.name}: project read failed. Check the device and retry.`,
        );
      return value;
    } catch (error) {
      if (error instanceof Error && "code" in error)
        throw new Error(
          `${binding.name}: could not read the project device. Check ${wss ? "WSS" : "SSH"}, python3 and og, then retry.`,
        );
      throw error;
    }
  }
  async branch(project: Project, signal: AbortSignal) {
    if (environmentId(project) === "local")
      throw new Error("Use local branch reader");
    return z
      .object({ branch: z.string().nullable() })
      .parse(
        await this.operation(
          project.environment!,
          { operation: "branch", path: project.path },
          signal,
        ),
      ).branch;
  }
}
