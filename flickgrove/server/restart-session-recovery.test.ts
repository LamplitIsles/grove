import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";

const until = async (f: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await f()) return;
    await Bun.sleep(20);
  }
  throw Error("fixture condition timed out");
};
test("restart then shared native disconnect preserves confirmed idle and unknown members", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grove-spec30-fixture-"));
  const control = join(dir, ".fake-app-server-control.json"),
    log = join(dir, ".fake-app-server-requests.jsonl"),
    pidlog = join(dir, "pids");
  const mk = () => {
    const runtime = new CodexRuntime({
      cwd: dir,
      origin: () => "http://127.0.0.1:9",
      codexPath: fileURLToPath(
        new URL("../tests/fake-codex.mjs", import.meta.url),
      ),
      env: {
        ...Object.fromEntries(
          Object.keys(process.env).map((k) => [k, undefined]),
        ),
        PATH: process.env.PATH,
        HOME: join(dir, "home"),
        CODEX_HOME: join(dir, "codex"),
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_CACHE_HOME: join(dir, "cache"),
        XDG_DATA_HOME: join(dir, "data"),
        TMPDIR: dir,
        FAKE_SERVER_ROOT: dir,
        FAKE_SERVER_PROCESS_LOG: pidlog,
      },
    });
    const app = new Workspace({
      directory: join(dir, "workspace"),
      runtime,
      projects: async () => [{ alias: "fixture", name: "fixture", path: dir }],
      branches: { read: async () => null },
      reviewerSnapshot: async () => ({
        model: "fixture-model",
        effort: "medium",
        prompt: "Fixture review",
      }),
    });
    return { runtime, app };
  };
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  let fixture = mk();
  try {
    await writeFile(control, "{}");
    const owner = await fixture.app.createOrc("fixture");
    const token = fixture.app.store.byId(owner.id)!.token;
    const target = {
      spec: "fixture",
      fixedPoint: "base",
      reviewedHead: "head",
    };
    const idle = (await fixture.app.tool(token, "worker_start", {
      project: "fixture",
      title: "idle",
      spec: "fixture",
      message: "initial idle",
    })) as { id: string };
    const startReviewer = async (title: string) =>
      (await fixture.app.tool(token, "reviewer_start", {
        project: "fixture",
        title,
        profile: "spec",
        ...target,
        message: `initial ${title}`,
      })) as { id: string };
    await until(() => fixture.app.detail(idle.id).state === "idle");
    const active = await startReviewer("active");
    await until(() => fixture.app.detail(active.id).state === "idle");
    const unknown = await startReviewer("unknown");
    await until(() => fixture.app.detail(unknown.id).state === "idle");
    const members = [idle, active, unknown];
    expect(members.map((m) => fixture.app.detail(m.id).role)).toEqual([
      "worker",
      "reviewer",
      "reviewer",
    ]);
    const identities = members.map((m) => {
      const detail = fixture.app.detail(m.id);
      return {
        id: detail.id,
        ownerId: detail.ownerId,
        threadId: detail.threadId,
      };
    });
    await writeFile(
      control,
      JSON.stringify({
        hold: true,
        projectInterrupted: true,
        trackThreadStatus: true,
      }),
    );
    await fixture.app.tool(token, "reviewer_send", {
      reviewerId: unknown.id,
      ...target,
      message: "accepted before restart",
    });
    expect(fixture.app.detail(unknown.id).state).toBe("working");
    const before = (await calls()).filter((r) =>
      ["turn/start", "turn/steer"].includes(r.method),
    ).length;
    await fixture.runtime.close();
    expect(fixture.app.detail(idle.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
    });
    fixture.app.dispose();
    fixture = mk();
    await Promise.all(
      [owner.id, idle.id, active.id, unknown.id].map((id) =>
        fixture.app.reconcileSettings(id),
      ),
    );
    expect(
      members.map((m) => {
        const detail = fixture.app.detail(m.id);
        return {
          id: detail.id,
          ownerId: detail.ownerId,
          threadId: detail.threadId,
        };
      }),
    ).toEqual(identities);
    expect(fixture.app.detail(idle.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
    });
    expect(fixture.app.detail(unknown.id)).toMatchObject({
      state: "error",
      workUnconfirmed: true,
    });
    await until(
      () => fixture.app.detail(unknown.id).currentExecution?.state === "idle",
    );
    expect(fixture.app.detail(unknown.id).currentExecution).toEqual({
      state: "idle",
      lastInterrupted: true,
    });
    expect(
      (await calls()).filter(
        (r) =>
          r.method === "thread/turns/list" &&
          r.params.threadId === fixture.app.detail(idle.id).threadId,
      ),
    ).toHaveLength(0);
    await fixture.app.tool(token, "reviewer_send", {
      reviewerId: active.id,
      ...target,
      message: "active after restart",
    });
    expect(fixture.app.detail(active.id).state).toBe("working");
    const currentCount = (await calls()).filter((r) =>
      ["turn/start", "turn/steer"].includes(r.method),
    ).length;
    expect(currentCount).toBe(before + 1);
    const pids = (await readFile(pidlog, "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    process.kill(pids.at(-1)!, "SIGTERM");
    await until(() =>
      [active, unknown].every((w) =>
        fixture.app.detail(w.id).error?.includes("App-server disconnected"),
      ),
    );
    const summaries = [idle, active, unknown].map((w) => {
      const d = fixture.app.detail(w.id);
      return {
        role: d.title,
        state: d.state,
        error: d.error,
        workUnconfirmed: d.workUnconfirmed,
        displayWorking: d.state === "working" || !!d.workUnconfirmed,
      };
    });
    console.log("SYMPTOM", JSON.stringify(summaries));
    expect(summaries[1].workUnconfirmed).toBe(true);
    expect(summaries[2].workUnconfirmed).toBe(true);
    expect(fixture.app.detail(unknown.id).currentExecution).toBeUndefined();
    expect(
      (await calls()).filter((r) =>
        ["turn/start", "turn/steer"].includes(r.method),
      ),
    ).toHaveLength(currentCount);
    expect(summaries[0]).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      displayWorking: false,
    });
    expect(summaries[0].error).toBeUndefined();
  } finally {
    await fixture.runtime.close();
    fixture.app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

test("idle startup waits for selection; a new input waits for recovery and failed recovery rejects without admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grove-spec30-lazy-"));
  const control = join(dir, ".fake-app-server-control.json");
  const log = join(dir, ".fake-app-server-requests.jsonl");
  const pidlog = join(dir, "pids");
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  const make = () => {
    const runtime = new CodexRuntime({
      cwd: dir,
      origin: () => "http://127.0.0.1:9",
      codexPath: fileURLToPath(
        new URL("../tests/fake-codex.mjs", import.meta.url),
      ),
      env: {
        ...Object.fromEntries(
          Object.keys(process.env).map((k) => [k, undefined]),
        ),
        PATH: process.env.PATH,
        HOME: join(dir, "home"),
        CODEX_HOME: join(dir, "codex"),
        TMPDIR: dir,
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_CACHE_HOME: join(dir, "cache"),
        XDG_DATA_HOME: join(dir, "data"),
        FAKE_SERVER_ROOT: dir,
        FAKE_SERVER_PROCESS_LOG: pidlog,
      },
    });
    return {
      runtime,
      app: new Workspace({
        directory: join(dir, "workspace"),
        runtime,
        projects: async () => [
          { alias: "fixture", name: "fixture", path: dir },
        ],
        branches: { read: async () => null },
      }),
    };
  };
  let f = make();
  try {
    await writeFile(control, "{}");
    const owner = await f.app.createOrc("fixture");
    await f.app.send(owner.id, "previous", "previous");
    await until(() => f.app.detail(owner.id).state === "idle");
    const thread = f.app.detail(owner.id).threadId;
    const before = (await calls()).filter(
      (r) => r.method === "thread/resume",
    ).length;
    await f.runtime.close();
    f.app.dispose();
    await writeFile(control, JSON.stringify({ holdResume: true }));
    f = make();
    await Bun.sleep(100);
    expect(
      (await calls()).filter((r) => r.method === "thread/resume"),
    ).toHaveLength(before);
    expect(f.app.detail(owner.id)).toMatchObject({
      state: "idle",
      workUnconfirmed: false,
      threadId: thread,
    });
    const selecting = f.app.reconcileSettings(owner.id);
    void selecting.catch(() => {});
    await until(
      () => f.app.detail(owner.id).connection?.state === "connecting",
    );
    const sending = f.app.send(owner.id, "new input", "new-operation");
    void sending.catch(() => {});
    await Bun.sleep(100);
    expect(
      (await calls()).filter(
        (r) => r.method === "turn/start" && r.params.threadId === thread,
      ),
    ).toHaveLength(1);
    await writeFile(control, "{}");
    await selecting;
    const result = await sending;
    expect(
      result.deliveries.find((d) => d.id === "new-operation")?.status,
    ).toBe("sent");
    await until(() => f.app.detail(owner.id).state === "idle");
    expect(f.app.detail(owner.id).threadId).toBe(thread);
    expect(
      (await calls())
        .filter(
          (r) => r.method === "turn/start" && r.params.threadId === thread,
        )
        .map((r) => r.params.input[0].text),
    ).toEqual(["previous", "new input"]);
    const pids = (await readFile(pidlog, "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    process.kill(pids.at(-1)!, "SIGTERM");
    await until(
      () =>
        f.app.detail(owner.id).state === "idle" &&
        (f.app as any).handles.size === 0,
    );
    await writeFile(control, JSON.stringify({ failResume: true }));
    await expect(f.app.reconcileSettings(owner.id)).rejects.toThrow();
    expect(f.app.detail(owner.id).connection?.state).toBe("failed");
    await f.app.send(owner.id, "retryable input", "retryable");
    expect(f.app.lookup(owner.id, "retryable")?.state).toBe("rejected");
    expect(
      (await calls()).filter(
        (r) => r.method === "turn/start" && r.params.threadId === thread,
      ),
    ).toHaveLength(2);
    await writeFile(control, "{}");
    await f.app.send(owner.id, "retryable input", "retryable", undefined, {
      after: "retryable",
      attempt: "retry-attempt",
    });
    expect(f.app.lookup(owner.id, "retryable")?.state).toBe("accepted");
    expect(
      (await calls())
        .filter(
          (r) => r.method === "turn/start" && r.params.threadId === thread,
        )
        .map((r) => r.params.input[0].text),
    ).toEqual(["previous", "new input", "retryable input"]);
  } finally {
    await f.runtime.close();
    f.app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

for (const ordering of ["event-first", "ack-first", "no-event"] as const) {
  test(`graceful shutdown records only observed terminal turns (${ordering})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-shutdown-wire-"));
    const control = join(dir, ".fake-app-server-control.json");
    const log = join(dir, ".fake-app-server-requests.jsonl");
    const calls = async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
    const make = () => {
      const runtime = new CodexRuntime({
        cwd: dir,
        origin: () => "http://127.0.0.1:9",
        codexPath: fileURLToPath(
          new URL("../tests/fake-codex.mjs", import.meta.url),
        ),
        env: {
          ...Object.fromEntries(
            Object.keys(process.env).map((k) => [k, undefined]),
          ),
          PATH: process.env.PATH,
          HOME: join(dir, "home"),
          CODEX_HOME: join(dir, "codex"),
          TMPDIR: dir,
          XDG_CONFIG_HOME: join(dir, "config"),
          XDG_CACHE_HOME: join(dir, "cache"),
          XDG_DATA_HOME: join(dir, "data"),
          FAKE_SERVER_ROOT: dir,
        },
      });
      const app = new Workspace({
        directory: join(dir, "workspace"),
        runtime,
        projects: async () => [
          { alias: "fixture", name: "fixture", path: dir },
        ],
        branches: { read: async () => null },
      });
      return { app, runtime };
    };
    let f = make();
    try {
      await writeFile(
        control,
        JSON.stringify({
          hold: true,
          interruptAckFirst: ordering === "ack-first",
          interruptNoEvent: ordering === "no-event",
        }),
      );
      const owner = await f.app.createOrc("fixture");
      const token = f.app.store.byId(owner.id)!.token;
      await f.app.send(owner.id, "owner work", "owner-work");
      const worker = (await f.app.tool(token, "worker_start", {
        project: "fixture",
        title: "worker",
        spec: "fixture",
        message: "member work",
      })) as { id: string };
      await f.app.enqueueFollowUp(owner.id, "queued A", "queued-A");
      const ids = [owner.id, worker.id];
      const before = ids.map((id) => ({
        id,
        threadId: f.app.detail(id).threadId!,
        turnId: f.app.detail(id).turnId!,
      }));
      const sendsBefore = (await calls()).filter((r) =>
        ["turn/start", "turn/steer"].includes(r.method),
      ).length;
      const started = Date.now();
      await f.app.prepareShutdown();
      expect(Date.now() - started).toBeLessThan(8000); // Both waits share the deadline.
      const interrupts = (await calls()).filter(
        (r) => r.method === "turn/interrupt",
      );
      expect(
        interrupts.map((r) => [r.params.threadId, r.params.turnId]).sort(),
      ).toEqual(before.map((a) => [a.threadId, a.turnId]).sort());
      for (const member of before) {
        const detail = f.app.detail(member.id);
        if (ordering === "no-event")
          expect(detail).toMatchObject({
            state: "working",
            workUnconfirmed: true,
            turnId: member.turnId,
          });
        else
          expect(detail).toMatchObject({
            state: "idle",
            workUnconfirmed: false,
            lastInterrupted: true,
          });
      }
      expect(f.app.lookupFollowUp(owner.id, "queued-A")?.status).toBe(
        "waiting",
      );
      if (ordering !== "no-event")
        expect(f.app.detail(owner.id).followUpPaused).toBe(true);
      await f.runtime.close();
      f.app.dispose();
      f = make();
      for (const member of before) {
        const detail = f.app.detail(member.id);
        expect(detail.threadId).toBe(member.threadId);
        if (ordering === "no-event")
          expect(detail).toMatchObject({
            state: "error",
            workUnconfirmed: true,
          });
        else
          expect(detail).toMatchObject({
            state: "idle",
            workUnconfirmed: false,
            lastInterrupted: true,
          });
      }
      expect(f.app.lookupFollowUp(owner.id, "queued-A")?.status).toBe(
        "waiting",
      );
      expect(f.app.detail(owner.id).followUpPaused).toBe(true);
      await Bun.sleep(100);
      expect(
        (await calls()).filter((r) =>
          ["turn/start", "turn/steer"].includes(r.method),
        ),
      ).toHaveLength(sendsBefore);
    } finally {
      await f.runtime.close();
      f.app.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
}
