// Test-owned remote exec-server. No host filesystem access or child execution.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.OWNED_EXECUTOR_LOG!;
const remote = process.env.OWNED_REMOTE_PATH!;
const sequences = new Map<string, number>();
const streams = new Map<string, string>();
const write = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const note = (s: string) => appendFileSync(log, s + "\n");
const info = {
  shell: { name: "sh", path: "/virtual/bin/sh" },
  cwd: `file://${remote}`,
  userHomeDir: "file:///virtual/home",
  platformOs: "linux",
  executorVersion: "0.163.0",
  capabilities: {},
};
function response(id: unknown, result: unknown) {
  write({ jsonrpc: "2.0", id, result });
}
function error(id: unknown, message: string) {
  write({ jsonrpc: "2.0", id, error: { code: -32601, message } });
}
function output(processId: string, mcp: unknown) {
  const chunk = Buffer.from(JSON.stringify(mcp) + "\n").toString("base64");
  const seq = (sequences.get(processId) ?? 0) + 1;
  sequences.set(processId, seq);
  write({
    jsonrpc: "2.0",
    method: "process/output",
    params: { processId, seq, stream: "stdout", chunk },
  });
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let request: any;
  try {
    request = JSON.parse(line);
  } catch {
    note("malformed input");
    process.exit(2);
  }
  const { id, method, params = {} } = request;
  if (!method) {
    note("unexpected response");
    continue;
  }
  note(method);
  if (id === undefined) continue;
  switch (method) {
    case "initialize":
      response(id, { sessionId: "owned-session", environmentInfo: info });
      break;
    case "environment/info":
      response(id, info);
      break;
    case "environment/status":
      response(id, { status: "ready" });
      break;
    case "fs/canonicalize":
      response(id, { path: params.path });
      break;
    case "fs/getMetadata": {
      const path = decodeURIComponent(String(params.path));
      if (path === `file://${remote}` || path === `file://${remote}/`)
        response(id, {
          isDirectory: true,
          isFile: false,
          isSymlink: false,
          size: 0,
          createdAtMs: 0,
          modifiedAtMs: 0,
        });
      else error(id, "fixture path does not exist");
      break;
    }
    case "fs/readDirectory":
      response(id, { entries: [] });
      break;
    case "fs/readFile":
      error(id, "fixture path does not exist");
      break;
    case "process/start": {
      if (params.argv?.[0] !== "/virtual/owned-og") {
        note("unexpected process request");
        error(id, "unexpected process");
        break;
      }
      note(
        `og-start cwd=${String(params.cwd).includes(remote) ? "remote" : "other"} token=${Object.hasOwn(params.env ?? {}, "FLICKGROVE_AGENT_TOKEN") ? "present" : "absent"}`,
      );
      streams.set(params.processId, "");
      sequences.set(params.processId, 0);
      response(id, { processId: params.processId });
      break;
    }
    case "process/write": {
      const pid = params.processId;
      if (!streams.has(pid)) {
        response(id, { status: "unknownProcess" });
        break;
      }
      let text =
        streams.get(pid)! + Buffer.from(params.chunk, "base64").toString();
      const lines = text.split("\n");
      streams.set(pid, lines.pop()!);
      response(id, { status: "accepted" });
      for (const part of lines) {
        if (!part) continue;
        const mcp = JSON.parse(part);
        note(`og:${mcp.method}`);
        if (mcp.id === undefined) continue;
        if (mcp.method === "initialize")
          output(pid, {
            jsonrpc: "2.0",
            id: mcp.id,
            result: {
              protocolVersion: mcp.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "owned-og", version: "1" },
            },
          });
        else if (mcp.method === "tools/list")
          output(pid, {
            jsonrpc: "2.0",
            id: mcp.id,
            result: {
              tools: [
                {
                  name: "project_get",
                  description: "Owned fixture",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          });
        else {
          note("unexpected og method");
          output(pid, {
            jsonrpc: "2.0",
            id: mcp.id,
            error: { code: -32601, message: "unexpected method" },
          });
        }
      }
      break;
    }
    case "process/read":
      response(id, {
        chunks: [],
        nextSeq: sequences.get(params.processId) ?? 0,
        exited: false,
        exitCode: null,
        closed: false,
        failure: null,
      });
      break;
    case "process/terminate":
      response(id, { running: false });
      break;
    default:
      note("UNSUPPORTED " + method);
      error(id, "unsupported fixture method");
  }
}
