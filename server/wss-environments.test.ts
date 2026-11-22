import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectEnvironments } from "./project-environments";

test("WSS configuration binds the destination without binding the bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-wss-config-"));
  try {
    const codex = join(root, "codex"),
      config = join(root, "grove.toml");
    await mkdir(codex);
    await writeFile(
      config,
      '[[project_environments]]\nid="owned"\nname="Owned"\ntransport="wss"\nog="/owned/og"\n',
    );
    const native = join(codex, "environments.toml");
    const write = (url: string, token: string) =>
      writeFile(
        native,
        `[[environments]]\nid="owned"\nurl=${JSON.stringify(url)}\nauth_bearer_token=${JSON.stringify(token)}\n`,
        { mode: 0o600 },
      );
    await write("wss://first.example/exec", "first-token");
    const environments = new ProjectEnvironments(config, codex);
    const binding = await environments.binding("owned");
    expect(JSON.stringify(binding)).not.toContain("first-token");
    await write("wss://first.example/exec", "rotated-token");
    expect((await environments.binding("owned")).target).toBe(binding.target);
    await write("wss://second.example/exec", "rotated-token");
    await expect(environments.assert(binding)).rejects.toThrow(
      /target changed/,
    );
    await write("wss://first.example/exec?secret=bad", "rotated-token");
    await expect(environments.binding("owned")).rejects.toThrow(
      /configure a matching WSS/,
    );
    await write("ws://first.example/exec", "rotated-token");
    await expect(environments.binding("owned")).rejects.toThrow(
      /configure a matching WSS/,
    );
    await write("wss://first.example/exec", "rotated-token");
    await chmod(native, 0o644);
    await expect(environments.binding("owned")).rejects.toThrow(/owner-only/);
    await chmod(native, 0o600);
    await writeFile(
      config,
      '[[project_environments]]\nid="owned"\nname="Owned"\ntransport="wss"\nog="/owned/og"\n[[project_environments]]\nid="other"\nname="Other"\ntransport="wss"\nog="/other/og"\n',
    );
    await writeFile(
      native,
      '[[environments]]\nid="owned"\nurl="wss://first.example/exec"\nauth_bearer_token="first-token"\n[[environments]]\nid="other"\nurl="wss://second.example/exec"\nauth_bearer_token="other-token"\n',
    );
    const first = await environments.binding("owned");
    const second = await environments.binding("other");
    expect(first.target).not.toBe(second.target);
    expect(await environments.og(first)).toBe("/owned/og");
    expect(await environments.og(second)).toBe("/other/og");
    expect(JSON.stringify([first, second])).not.toMatch(
      /first-token|other-token/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WSS worktree lookup dispatches the fixed operation to the captured target", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-wss-worktree-"));
  const original = globalThis.WebSocket;
  try {
    const codex = join(root, "codex"),
      config = join(root, "grove.toml");
    await mkdir(codex);
    await writeFile(
      config,
      '[[project_environments]]\nid="owned"\nname="Owned"\ntransport="wss"\nog="/owned/og"\n',
    );
    await writeFile(
      join(codex, "environments.toml"),
      '[[environments]]\nid="owned"\nurl="wss://owned.invalid/exec"\nauth_bearer_token="owned-token"\n',
      { mode: 0o600 },
    );
    const requests: unknown[] = [];
    class Socket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      onclose?: () => void;
      constructor(url: string, options: { headers: Record<string, string> }) {
        expect(url).toBe("wss://owned.invalid/exec");
        expect(options.headers.Authorization).toBe("Bearer owned-token");
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        const message = JSON.parse(data);
        const send = (value: unknown) =>
          queueMicrotask(() =>
            this.onmessage?.({ data: JSON.stringify(value) }),
          );
        if (message.method === "initialize")
          send({ id: 1, result: { sessionId: "owned" } });
        if (message.method === "process/start") {
          const payload = JSON.parse(
            Buffer.from(message.params.argv[3], "base64").toString(),
          );
          requests.push(payload);
          send({ id: 2, result: { processId: "read" } });
          const output =
            payload.path === "/linked"
              ? { project: "test", worktree: "/linked" }
              : { error: "Invalid project read" };
          send({
            method: "process/output",
            params: {
              processId: "read",
              seq: 1,
              stream: "stdout",
              chunk: Buffer.from(JSON.stringify(output)).toString("base64"),
            },
          });
          send({
            method: "process/exited",
            params: { processId: "read", seq: 2, exitCode: 0 },
          });
          send({
            method: "process/closed",
            params: { processId: "read", seq: 3 },
          });
        }
      }
      close() {
        this.readyState = 3;
      }
    }
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    const environments = new ProjectEnvironments(config, codex);
    const binding = await environments.binding("owned");
    expect(
      await environments.resolveWorktree(binding, "/linked", true),
    ).toEqual({ project: "test", worktree: "/linked" });
    expect(requests).toEqual([
      {
        operation: "resolve-worktree",
        path: "/linked",
        exact: true,
        og: "/owned/og",
        execGroup: true,
      },
    ]);
    await expect(
      environments.resolveWorktree(binding, "/missing", true),
    ).rejects.toThrow("Cannot verify worktree");
    await writeFile(
      config,
      '[[project_environments]]\nid="owned"\nname="Owned"\ntransport="wss"\nog="/different/og"\n',
    );
    await expect(
      environments.resolveWorktree(binding, "/linked", true),
    ).rejects.toThrow("Cannot verify worktree");
    expect(requests).toHaveLength(2);
  } finally {
    globalThis.WebSocket = original;
    await rm(root, { recursive: true, force: true });
  }
});
