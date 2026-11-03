import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  initializeReviewerConfig,
  reviewerSnapshot,
  researcherSnapshot,
  orcPrompt,
} from "./reviewer-config";
import { MixedRuntime } from "./mixed-runtime";
import { PiRuntime } from "./pi";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { ProjectEnvironments } from "./project-environments";
import { HostService } from "./hosts";
import { servePeer } from "./http";
import { WorkspaceStore } from "./workspace-store";
import { GroveAuth } from "./auth";
import { chmodSync, mkdirSync } from "node:fs";
import { instanceVersion } from "./instance-version";
import { instanceManager } from "./instance-manager";
import { InstanceControls } from "./instance-controls";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    listen: { type: "string", default: "127.0.0.1" },
    origin: { type: "string" },
    name: { type: "string" },
    port: { type: "string", default: "4318" },
    config: { type: "string" },
    state: { type: "string" },
    codex: { type: "string", default: "codex" },
    "pi-agent-dir": { type: "string" },
    auth: { type: "string" },
    user: { type: "string" },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Use a port between 1 and 65535");
const localOrigin = `http://127.0.0.1:${port}`;
const origin = values.origin ?? `http://localhost:${port}`;
if (
  !["http:", "https:"].includes(new URL(origin).protocol) ||
  new URL(origin).origin !== origin
)
  throw new Error("Use an HTTP(S) origin without a path");
const directory =
  values.state ?? join(homedir(), ".local", "share", "flickgrove");
const configPath =
  values.config ?? join(homedir(), ".config", "flickgrove", "config.toml");
if (values.auth) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  const auth = new GroveAuth(store, directory, origin);
  try {
    if (values.auth === "users") console.log(JSON.stringify(auth.users()));
    else if (values.auth === "bootstrap" || values.auth === "recovery")
      console.log(JSON.stringify(auth.issue(values.auth, values.user)));
    else
      throw new Error("Use --auth bootstrap, users, or recovery --user <id>");
  } finally {
    auth.close();
    store.close();
  }
  process.exit(0);
}
await initializeReviewerConfig(configPath);
const environments = new ProjectEnvironments(configPath);
const codexRuntime = new CodexRuntime({
  environments,
  projectForThread: (id) => app.projectForThread(id),
  cwd: process.cwd(),
  origin: () => localOrigin,
  codexPath: values.codex,
});
if (values["pi-agent-dir"])
  process.env.PI_CODING_AGENT_DIR = values["pi-agent-dir"];
const runtime: MixedRuntime = new MixedRuntime(
  codexRuntime,
  new PiRuntime({
    agentDir: getAgentDir(),
    tool: (token, name, args) => app.tool(token, name, args),
  }),
);
const app: Workspace = new Workspace({
  directory,
  runtime,
  projects: (id) => environments.projects(id),
  environments,
  orcPrompt: () => orcPrompt(configPath),
  researcherSnapshot: () => researcherSnapshot(configPath),
  reviewerSnapshot: (profile) => reviewerSnapshot(configPath, profile),
});
const auth = new GroveAuth(app.store, directory, origin);
const service = new HostService(app, {
  directory,
  name: values.name,
  origin: () => origin,
});
const httpOptions = {
  auth,
  instance: new InstanceControls(
    app,
    instanceVersion(
      fileURLToPath(new URL("..", import.meta.url)),
      fileURLToPath(new URL("../dist", import.meta.url)),
    ),
    instanceManager(),
  ),
  voice: { configPath },
  origin: () => origin,
  localOrigin: () => localOrigin,
  service,
  assets: fileURLToPath(new URL("../dist", import.meta.url)),
};
const server = servePeer(app, {
  ...httpOptions,
  hostname: values.listen!,
  port,
});
console.log(`FlickGrove is available at ${origin}`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await app.prepareShutdown();
  await runtime.close();
  service.dispose();
  auth.close();
  app.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
