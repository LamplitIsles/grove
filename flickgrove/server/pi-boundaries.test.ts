import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { PiRuntime } from "./pi";
import { acquirePiWriter } from "./pi-storage";
import { Workspace } from "./workspace";
import { MixedRuntime } from "./mixed-runtime";
import { FakeRuntime } from "./testing";
import { threadIdentity } from "./backend";

async function isolated(name: string, run: () => Promise<void>) {
  if (process.env.GROVE_BOUNDARY_CHILD) return run();
  const home = await mkdtemp(join(tmpdir(), "grove-pi-boundary-"));
  try {
    const child = Bun.spawn(
      [process.execPath, "test", import.meta.path, "-t", name],
      {
        env: {
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
          GROVE_BOUNDARY_CHILD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    for (const line of out.split("\n"))
      if (line.startsWith("owned ")) console.log(line);
    expect({ code, output: code ? out + err : "" }).toEqual({
      code: 0,
      output: "",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
async function fixture(
  settings: object,
  codemode: boolean | "read" = false,
  resize?: { maxWidth: number; maxHeight: number; maxBytes: number },
  holdProvider = false,
) {
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  process.chdir(cwd);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  await writeFile(join(agentDir, "auth.json"), "{}");
  const bodies: {
    messages: { role: string; content: unknown }[];
    tools?: { function: { name: string } }[];
  }[] = [];
  const providerGate = Promise.withResolvers<void>();
  let providerAborted = false;
  const providerAborts: number[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as (typeof bodies)[number];
      if (
        body.messages.some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.startsWith("Return only a JSON object"),
        )
      ) {
        const chunk = (delta: object, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: "title", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          chunk(
            { role: "assistant", content: '{"title":"Fixture title"}' },
            null,
          ) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const requestIndex = bodies.length;
      bodies.push(body);
      if (holdProvider) {
        req.signal.addEventListener("abort", () => {
          providerAborted = true;
          providerAborts.push(requestIndex);
        });
        await providerGate.promise;
      }
      const plan = codemode && bodies.length === 1;
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(
          plan
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "owned-call",
                    type: "function",
                    function: {
                      name: codemode === "read" ? "read" : "codemode",
                      arguments: JSON.stringify(
                        codemode === "read"
                          ? { path: "owned-large.png" }
                          : {
                              code: 'text(await tools.bash({command:"printf owned > official-codemode-proof"}));',
                            },
                      ),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "Done" },
          null,
        ) +
          chunk({}, plan ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "owned-key",
          models: [
            {
              id: "vision",
              name: "Vision",
              reasoning: false,
              input: ["text", "image"],
              inputLimits: resize ? { images: { resize } } : undefined,
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  let app: Workspace;
  const runtime = new PiRuntime({
    agentDir,
    tool: (token, name, args) => app.tool(token, name, args),
  });
  const workspaceOptions = {
    directory: join(home, "workspace"),
    runtime,
    projects: async () => [{ alias: "owned", name: "Owned", path: cwd }],
  };
  app = new Workspace(workspaceOptions);
  const defaults = {
    backend: "pi" as const,
    provider: "fixture",
    model: "vision",
    effort: "off",
  };
  const create = () => app.createOrc("owned", { fast: false, orc: defaults });
  const idle = async (id: string) => {
    for (let i = 0; i < 1000; i++) {
      if (app.detail(id).state !== "working") return;
      await Bun.sleep(5);
    }
    throw Error("Fixture did not settle");
  };
  return {
    get app() {
      return app;
    },
    async restart() {
      app.dispose();
      await runtime.close();
      app = new Workspace(workspaceOptions);
    },
    runtime,
    bodies,
    releaseProvider: () => providerGate.resolve(),
    providerAborted: () => providerAborted,
    providerAborts: () => [...providerAborts],
    cwd,
    agentDir,
    create,
    idle,
    async close() {
      app.dispose();
      try {
        await runtime.close();
      } finally {
        upstream.stop(true);
      }
    },
  };
}

test("Pi blocked images reject before admission and preserve Grove attachments", () =>
  isolated("Pi blocked images", async () => {
    const f = await fixture({ images: { blockImages: true } });
    try {
      const root = await f.create();
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 4, background: "red" },
      })
        .png()
        .toBuffer();
      const observations = [];
      // A first submission and an already-used handle must enforce the same setting.
      for (const op of ["initial-image", "existing-image"]) {
        if (op === "existing-image") {
          await f.app.send(root.id, "Owned text", "text");
          await f.idle(root.id);
        }
        const refs = await f.app.images.upload(root.id, op, "caption", [
          new File([bytes], "owned.png", { type: "image/png" }),
        ]);
        const before = f.bodies.length;
        await f.app.send(root.id, "caption", op, refs);
        await f.idle(root.id);
        const delivery = f.app
          .detail(root.id)
          .deliveries.find((d) => d.id === op)!;
        observations.push({
          operation: op,
          status: delivery.status,
          addedRequests: f.bodies.length - before,
          payload: JSON.stringify(
            f.bodies
              .slice(before)
              .map((body) =>
                body.messages.filter((message) => message.role === "user"),
              ),
          ),
          images: delivery.images?.length,
        });
        expect(delivery.error).toContain("Image reading is disabled");
        expect(JSON.stringify(delivery.images)).toBe(JSON.stringify(refs));
        expect(
          await f.app.images.read(root.id, refs[0]!.id, false),
        ).toBeTruthy();
      }
      console.log("owned image observations", JSON.stringify(observations));
      expect(
        observations.map(({ status, addedRequests, images }) => ({
          status,
          addedRequests,
          images,
        })),
      ).toEqual([
        { status: "failed", addedRequests: 0, images: 1 },
        { status: "failed", addedRequests: 0, images: 1 },
      ]);
      expect(
        JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"))
          .images.blockImages,
      ).toBe(true);
    } finally {
      await f.close();
    }
  }));

test("Pi official codemode executes without MCP activating deferred tools", () =>
  isolated("Pi official codemode", async () => {
    const f = await fixture({}, true);
    try {
      const root = await f.create();
      await f.app.send(root.id, "Execute owned codemode", "code");
      await f.idle(root.id);
      console.log(
        "owned no-MCP declared tools",
        JSON.stringify(f.bodies[0]?.tools?.map((t) => t.function.name)),
      );
      expect(
        await readFile(join(f.cwd, "official-codemode-proof"), "utf8"),
      ).toBe("owned");
      expect(
        f.bodies[0]?.tools?.some((t) => t.function.name === "codemode"),
      ).toBe(true);
      expect(
        f.bodies[0]?.tools?.some((t) => t.function.name === "tool_search"),
      ).toBe(true);
    } finally {
      await f.close();
    }
  }));

test("Pi native acceptance survives a failed Grove confirmation transaction without replay", () =>
  isolated("Pi native acceptance", async () => {
    const f = await fixture({});
    const db = new Database(
      join(process.env.HOME!, "workspace/workspace.sqlite"),
    );
    try {
      const root = await f.create();
      db.exec(
        "CREATE TRIGGER fail_pi_confirmation BEFORE UPDATE ON deliveries WHEN new.status='sent' BEGIN SELECT RAISE(ABORT,'owned Pi confirmation failure'); END",
      );
      await expect(
        f.app.send(root.id, "Accepted across databases", "cross-database"),
      ).rejects.toThrow("owned Pi confirmation failure");
      expect(() => f.app.lookup(root.id, "cross-database")).toThrow();
      expect(() => f.app.detail(root.id)).toThrow();
      expect(
        db
          .query("SELECT status FROM deliveries WHERE operation_id=?")
          .get("cross-database"),
      ).toEqual({ status: "sending" });
      db.exec("DROP TRIGGER fail_pi_confirmation");
      await f.restart();
      for (let i = 0; i < 1000; i++) {
        if (f.app.lookup(root.id, "cross-database")?.state === "accepted")
          break;
        await Bun.sleep(5);
      }
      expect(f.app.lookup(root.id, "cross-database")?.state).toBe("accepted");
      await f.idle(root.id);
      const history = await f.runtime.historyMessages(
        f.app.detail(root.id).threadId!,
      );
      expect(
        history.messages.filter((m) => m.clientId === "cross-database"),
      ).toHaveLength(1);
      expect(f.app.detail(root.id).state).toBe("idle");
    } finally {
      db.close();
      await f.close();
    }
  }));

test("Pi checkpoint failure cannot confirm business Close", () =>
  isolated("Pi checkpoint failure", async () => {
    const f = await fixture({});
    let fault: ReturnType<typeof spyOn> | undefined;
    try {
      const root = await f.create();
      await f.app.send(root.id, "settle owned work", "checkpoint-work");
      await f.idle(root.id);
      const query = Database.prototype.query;
      fault = spyOn(Database.prototype, "query").mockImplementation(function (
        this: Database,
        sql: string,
      ) {
        if (sql === "PRAGMA journal_mode=DELETE")
          throw new Error("owned checkpoint failure");
        return query.call(this, sql);
      } as typeof query);
      await expect(f.app.closeTree(root.id)).rejects.toThrow(
        "Native thread release failed",
      );
      expect(f.app.detail(root.id).closed).toBe(false);
      const release = acquirePiWriter(
        join(f.agentDir, "grove-durable", `${root.threadId}.sqlite`),
      );
      await release();
    } finally {
      fault?.mockRestore();
      // A failed native release remains failed; disposal still closes the fake upstream.
      await f
        .close()
        .catch((error) =>
          expect(String(error)).toContain("Pi resources could not be released"),
        );
    }
  }));

for (const mode of ["read", "submit"] as const)
  test(`Pi official image preparation ${mode} obeys model dimensions`, () =>
    isolated(`Pi official image preparation ${mode}`, async () => {
      const f = await fixture(
        {},
        mode === "read" ? "read" : false,
        mode === "submit"
          ? { maxWidth: 640, maxHeight: 480, maxBytes: 1024 * 1024 }
          : undefined,
      );
      try {
        const bytes = await sharp({
          create: { width: 3000, height: 2000, channels: 4, background: "red" },
        })
          .png()
          .toBuffer();
        expect(bytes.length).toBeLessThan(1024 * 1024);
        await writeFile(join(f.cwd, "owned-large.png"), bytes);
        const root = await f.create();
        const refs =
          mode === "submit"
            ? await f.app.images.upload(
                root.id,
                "image-prep",
                "Original image",
                [new File([bytes], "owned-large.png", { type: "image/png" })],
              )
            : undefined;
        await f.app.send(root.id, "Original image", "image-prep", refs);
        await f.idle(root.id);
        const images = f.bodies
          .flatMap((body) =>
            body.messages.flatMap((message) =>
              Array.isArray(message.content) ? message.content : [],
            ),
          )
          .filter((part: any) => part.type === "image_url") as {
          image_url: { url: string };
        }[];
        const sizes = await Promise.all(
          images.map(async (image) => {
            const data = Buffer.from(
              image.image_url.url.split(",")[1]!,
              "base64",
            );
            const meta = await sharp(data).metadata();
            return {
              width: meta.width,
              height: meta.height,
              bytes: data.length,
            };
          }),
        );
        console.log(
          "owned image preparation",
          JSON.stringify({
            mode,
            originalBytes: bytes.length,
            sizes,
            toolResults: f.bodies.flatMap((body) =>
              body.messages
                .filter((m) => m.role === "tool")
                .map((m) => String(m.content).slice(0, 500)),
            ),
          }),
        );
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) {
          expect(size.width).toBeLessThanOrEqual(
            mode === "submit" ? 640 : 2000,
          );
          expect(size.height).toBeLessThanOrEqual(
            mode === "submit" ? 480 : 2000,
          );
        }
        if (refs) {
          expect(
            (
              await sharp(
                f.app.images.read(root.id, refs[0]!.id, false)!.bytes,
              ).metadata()
            ).width,
          ).toBe(3000);
          const modelPath = join(f.agentDir, "models.json");
          const config = JSON.parse(await readFile(modelPath, "utf8"));
          config.providers.fixture.models[0].inputLimits.images.resize.maxBytes = 1;
          await writeFile(modelPath, JSON.stringify(config));
          const tiny = await sharp({
            create: { width: 2, height: 2, channels: 4, background: "red" },
          })
            .png()
            .toBuffer();
          const rejected = await f.app.images.upload(
            root.id,
            "cannot-prepare",
            "Reject the whole input",
            [
              new File([tiny], "first.png", { type: "image/png" }),
              new File([tiny], "second.png", { type: "image/png" }),
            ],
          );
          const before = f.bodies.length;
          await f.app.send(
            root.id,
            "Reject the whole input",
            "cannot-prepare",
            rejected,
          );
          const delivery = f.app
            .detail(root.id)
            .deliveries.find((d) => d.id === "cannot-prepare")!;
          expect(delivery).toMatchObject({
            status: "failed",
            images: rejected,
            error: "Image could not be prepared for the selected Pi model",
          });
          expect(f.bodies.length).toBe(before);
          for (const image of rejected)
            expect(f.app.images.read(root.id, image.id, false)).toBeTruthy();
        }
      } finally {
        await f.close();
      }
    }));

test("cold Pi resumes accepted native work on explicit history restore without replaying unknown input", () =>
  isolated("cold Pi resumes accepted native work", async () => {
    const f = await fixture({}, false, undefined, true);
    const runtime = new MixedRuntime(new FakeRuntime(), f.runtime);
    const options = {
      directory: join(process.env.HOME!, "mixed-workspace"),
      runtime,
      projects: async () => [{ alias: "owned", name: "Owned", path: f.cwd }],
      orcPrompt: undefined as undefined | (() => Promise<string>),
    };
    let app = new Workspace(options);
    try {
      const root = await app.createOrc("owned", {
        fast: false,
        orc: {
          backend: "pi",
          provider: "fixture",
          model: "vision",
          effort: "off",
        },
      });
      await app.send(root.id, "accepted prior work", "accepted-prior");
      for (let i = 0; i < 500 && !f.bodies.length; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(1);
      expect(app.lookup(root.id, "accepted-prior")?.state).toBe("accepted");
      const acceptedReceipt = app.lookup(root.id, "accepted-prior");
      await app.enqueueFollowUp(root.id, "waiting for Continue", "waiting-id");
      const state = app as unknown as {
        state: { agents: import("./runtime").RuntimeAgent[] };
      };
      const rootState = state.state.agents.find((a) => a.id === root.id)!;
      rootState.deliveries.push({
        id: "unknown-submission",
        source: "user",
        status: "uncertain",
        text: "Unknown input must not be resent",
        questionIds: [],
        at: 1,
      });
      rootState.questions.push({
        id: "saved-q",
        itemId: "saved-q",
        index: 0,
        title: "Decision",
        text: "Continue?",
        options: [],
        state: "unanswered",
        at: 1,
      });
      app.store.flush();
      app.dispose();
      await runtime.close();
      const db = new Database(join(options.directory, "workspace.sqlite"));
      db.query(
        "UPDATE sessions SET state='error', recovery=json_set(recovery,'$.turnEnded',json('false'),'$.followUpPaused',json('true')) WHERE id=?",
      ).run(root.id);
      db.close();
      // Prefeature prompt defers startup so the real native file is cold.
      options.orcPrompt = async () => "fixture";
      app = new Workspace(options);
      const nativeSends: string[] = [];
      let failNotification = false;
      const activationSnapshots: {
        closed: boolean;
        state: string;
        paused: boolean | undefined;
      }[] = [];
      const openNative = f.runtime.open.bind(f.runtime);
      const opened = spyOn(f.runtime, "open").mockImplementation(
        async (...args) => {
          const [agent, notify] = args;
          const handle = await openNative(agent, (event) => {
            if (failNotification && event.type === "working")
              throw new Error("fixture notification failure");
            notify(event);
          });
          const send = handle.send.bind(handle);
          handle.send = async (...input) => {
            nativeSends.push(input[3] ?? "missing-id");
            return send(...input);
          };
          const activate = handle.activate;
          if (activate)
            handle.activate = () => {
              activationSnapshots.push({
                closed: app.store.byId(root.id)!.closed,
                state: app.detail(root.id).state,
                paused: app.detail(root.id).followUpPaused,
              });
              expect(() => acquirePiWriter(nativePath)).toThrow(
                "already has a writer",
              );
              activate();
            };
          return handle;
        },
      );
      expect(app.detail(root.id).workUnconfirmed).toBe(true);
      const nativePath = join(
        f.agentDir,
        "grove-durable",
        `${threadIdentity(root.threadId!).id}.sqlite`,
      );
      const lock = acquirePiWriter(nativePath);
      try {
        await expect(app.closeTree(root.id, undefined, true)).rejects.toThrow(
          "already has a writer",
        );
        expect(app.store.byId(root.id)).toMatchObject({ closed: false });
      } finally {
        await lock();
      }
      const failingStore = new Database(
        join(options.directory, "workspace.sqlite"),
      );
      failingStore.exec(
        "CREATE TRIGGER fail_confirmed_close BEFORE UPDATE ON sessions WHEN new.closed=1 BEGIN SELECT RAISE(ABORT,'fixture close failure'); END",
      );
      await expect(app.closeTree(root.id, undefined, true)).rejects.toThrow(
        "fixture close failure",
      );
      const failed = failingStore
        .query("SELECT closed,recovery FROM sessions WHERE id=?")
        .get(root.id) as { closed: number; recovery: string };
      expect(failed.closed).toBe(0);
      expect(JSON.parse(failed.recovery).turnEnded).toBe(false);
      failingStore.exec("DROP TRIGGER fail_confirmed_close");
      failingStore.close();
      app.dispose();
      await runtime.close();
      app = new Workspace(options);
      await Bun.sleep(20);
      expect(opened).not.toHaveBeenCalled();
      const flush = app.store.flush.bind(app.store);
      let checkedLease = false;
      const flushSpy = spyOn(app.store, "flush").mockImplementation(() => {
        const current = (
          app as unknown as {
            state: { agents: import("./runtime").RuntimeAgent[] };
          }
        ).state.agents.find((a) => a.id === root.id);
        if (current?.closed) {
          expect(() => acquirePiWriter(nativePath)).toThrow(
            "already has a writer",
          );
          checkedLease = true;
        }
        return flush();
      });
      await app.closeTree(root.id, undefined, true);
      flushSpy.mockRestore();
      expect(checkedLease).toBe(true);
      expect(app.store.byId(root.id)).toMatchObject({
        closed: true,
        turnEnded: false,
        followUpPaused: true,
      });
      expect(opened).not.toHaveBeenCalled();
      expect(f.bodies).toHaveLength(1);
      options.orcPrompt = undefined;
      app.store.sqlite.exec(
        "CREATE TRIGGER fail_reopen BEFORE UPDATE ON sessions WHEN old.closed=1 AND new.closed=0 BEGIN SELECT RAISE(ABORT,'fixture reopen failure'); END",
      );
      await expect(
        app.resumeHistory("owned", root.threadId!, false),
      ).rejects.toThrow("fixture reopen failure");
      expect(activationSnapshots).toEqual([]);
      expect(nativeSends).toEqual([]);
      expect(f.bodies).toHaveLength(1);
      const rollback = new Database(
        join(options.directory, "workspace.sqlite"),
      );
      expect(
        rollback.query("SELECT closed FROM sessions WHERE id=?").get(root.id),
      ).toEqual({ closed: 1 });
      rollback.exec("DROP TRIGGER fail_reopen");
      rollback.close();
      const afterFailure = acquirePiWriter(nativePath);
      await afterFailure();
      app.dispose();
      await runtime.close();
      app = new Workspace(options);
      failNotification = true;
      await expect(
        app.resumeHistory("owned", root.threadId!, false),
      ).rejects.toThrow("fixture notification failure");
      expect(app.store.byId(root.id)).toMatchObject({
        closed: true,
        turnEnded: false,
      });
      expect(app.lookup(root.id, "unknown-submission")).toBeNull();
      expect(activationSnapshots).toEqual([]);
      expect(f.bodies).toHaveLength(1);
      const afterNotificationFailure = acquirePiWriter(nativePath);
      await afterNotificationFailure();
      failNotification = false;
      await app.resumeHistory("owned", root.threadId!, false);
      for (let i = 0; i < 500 && f.bodies.length < 2; i++) await Bun.sleep(5);
      expect(opened).toHaveBeenCalledTimes(3);
      expect(f.bodies).toHaveLength(2);
      expect(app.detail(root.id).state).toBe("working");
      expect(activationSnapshots).toEqual([
        { closed: false, state: "working", paused: true },
      ]);
      await expect(app.closeTree(root.id, undefined, true)).rejects.toThrow(
        "current work",
      );
      expect(app.lookup(root.id, "accepted-prior")).toEqual(acceptedReceipt);
      expect(app.lookup(root.id, "unknown-submission")).toBeNull();
      expect(
        app
          .detail(root.id)
          .deliveries.find((d) => d.id === "unknown-submission")?.status,
      ).toBe("uncertain");
      expect(app.lookupFollowUp(root.id, "waiting-id")?.status).toBe("waiting");
      expect(app.detail(root.id).followUpPaused).toBe(true);
      expect(nativeSends).toEqual([]);
      expect(nativeSends).toEqual([]);
      const history = await f.runtime.historyMessages(
        threadIdentity(root.threadId!).id,
      );
      expect(
        history.messages.filter((m) => m.clientId === "accepted-prior"),
      ).toHaveLength(1);
      expect(
        history.messages.filter((m) => m.clientId === "unknown-submission"),
      ).toHaveLength(0);
      expect(app.detail(root.id).questions[0]?.state).toBe("unanswered");
      app.dispose();
      await runtime.close();
      app = new Workspace(options);
      for (let i = 0; i < 500 && f.bodies.length < 3; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(3);
      expect(app.lookup(root.id, "unknown-submission")).toBeNull();
      expect(app.lookupFollowUp(root.id, "waiting-id")?.status).toBe("waiting");
      expect(app.detail(root.id).followUpPaused).toBe(true);
      opened.mockRestore();
    } finally {
      f.releaseProvider();
      app.dispose();
      await runtime.close();
      await f.close();
    }
  }));

test("Pi history reopen fences close and new sends until native activation", () =>
  isolated("Pi history reopen fences close", async () => {
    const f = await fixture({});
    const runtime = new MixedRuntime(new FakeRuntime(), f.runtime);
    const options = {
      directory: join(process.env.HOME!, "fence-workspace"),
      runtime,
      projects: async () => [{ alias: "owned", name: "Owned", path: f.cwd }],
    };
    const app = new Workspace(options);
    const gate = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    let closeDuringActivation: Promise<unknown> | undefined;
    try {
      const root = await app.createOrc("owned", {
        fast: false,
        orc: {
          backend: "pi",
          provider: "fixture",
          model: "vision",
          effort: "off",
        },
      });
      await app.closeTree(root.id, undefined, true);
      const openNative = f.runtime.open.bind(f.runtime);
      const opened = spyOn(f.runtime, "open").mockImplementation(
        async (...args) => {
          const handle = await openNative(...args);
          const activate = handle.activate!;
          handle.activate = () => {
            closeDuringActivation = app
              .closeTree(root.id, undefined, true)
              .catch((error) => error);
            expect(f.bodies).toHaveLength(0);
            activate();
          };
          ready.resolve();
          await gate.promise;
          return handle;
        },
      );
      const restoring = app.resumeHistory("owned", root.threadId!, false);
      await ready.promise;
      expect(app.store.byId(root.id)?.closed).toBe(true);
      await expect(app.closeTree(root.id, undefined, true)).rejects.toThrow(
        "Session not found",
      );
      const sending = app.send(root.id, "explicit new input", "explicit-send");
      await Bun.sleep(20);
      expect(f.bodies).toHaveLength(0);
      gate.resolve();
      await restoring;
      expect(await closeDuringActivation).toBeInstanceOf(Error);
      expect(((await closeDuringActivation) as Error).message).toContain(
        "in-flight operation",
      );
      await sending;
      for (let i = 0; i < 500 && !f.bodies.length; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(1);
      expect(app.lookup(root.id, "explicit-send")?.state).toBe("accepted");
      expect(app.store.byId(root.id)?.closed).toBe(false);
      opened.mockRestore();
    } finally {
      gate.resolve();
      app.dispose();
      await runtime.close();
      await f.close();
    }
  }));

test("Pi activation failure after starting remains unknown without abort or replay", () =>
  isolated("Pi activation failure after starting", async () => {
    const f = await fixture({}, false, undefined, true);
    const runtime = new MixedRuntime(new FakeRuntime(), f.runtime);
    const options = {
      directory: join(process.env.HOME!, "activation-workspace"),
      runtime,
      projects: async () => [{ alias: "owned", name: "Owned", path: f.cwd }],
      orcPrompt: undefined as undefined | (() => Promise<string>),
    };
    let app = new Workspace(options);
    try {
      const root = await app.createOrc("owned", {
        fast: false,
        orc: {
          backend: "pi",
          provider: "fixture",
          model: "vision",
          effort: "off",
        },
      });
      await app.send(root.id, "accepted native input", "accepted-native");
      for (let i = 0; i < 500 && !f.bodies.length; i++) await Bun.sleep(5);
      const receipt = app.lookup(root.id, "accepted-native");
      const agent = (
        app as unknown as {
          state: { agents: import("./runtime").RuntimeAgent[] };
        }
      ).state.agents.find((a) => a.id === root.id)!;
      agent.deliveries.push({
        id: "uncertain",
        source: "user",
        status: "uncertain",
        text: "unknown",
        questionIds: [],
        at: 1,
      });
      app.store.flush();
      app.dispose();
      await runtime.close();
      const db = new Database(join(options.directory, "workspace.sqlite"));
      db.query(
        "UPDATE sessions SET state='error', recovery=json_set(json_remove(recovery,'$.turnId'),'$.turnEnded',json('false')) WHERE id=?",
      ).run(root.id);
      db.close();
      options.orcPrompt = async () => "fixture";
      app = new Workspace(options);
      await app.closeTree(root.id, undefined, true);
      options.orcPrompt = undefined;
      const openNative = f.runtime.open.bind(f.runtime);
      let activationCount = 0;
      const opened = spyOn(f.runtime, "open").mockImplementation(
        async (...args) => {
          const handle = await openNative(...args);
          const activate = handle.activate!;
          handle.activate = () => {
            activationCount++;
            activate();
            throw new Error("fixture activation outcome lost");
          };
          return handle;
        },
      );
      await expect(
        app.resumeHistory("owned", root.threadId!, false),
      ).rejects.toThrow("fixture activation outcome lost");
      for (let i = 0; i < 500 && f.bodies.length < 2; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(2);
      expect(activationCount).toBe(1);
      expect(f.providerAborts()).not.toContain(1);
      expect(app.store.byId(root.id)).toMatchObject({
        closed: false,
        turnEnded: false,
      });
      expect(app.lookup(root.id, "accepted-native")).toEqual(receipt);
      expect(app.lookup(root.id, "uncertain")).toBeNull();
      const history = await f.runtime.historyMessages(
        threadIdentity(root.threadId!).id,
      );
      expect(
        history.messages.filter((m) => m.clientId === "accepted-native"),
      ).toHaveLength(1);
      expect(
        history.messages.filter((m) => m.clientId === "uncertain"),
      ).toHaveLength(0);
      opened.mockRestore();
    } finally {
      f.releaseProvider();
      app.dispose();
      await runtime.close();
      await f.close();
    }
  }));

test("hot Pi unknown cannot release while preserving a live invocation", () =>
  isolated("hot Pi unknown", async () => {
    const f = await fixture({}, false, undefined, true);
    try {
      const root = await f.create();
      await f.app.send(root.id, "Owned held provider", "held-operation");
      for (let i = 0; i < 500 && !f.bodies.length; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(1);
      // Simulate loss of Grove's current-turn projection while the owned
      // native provider invocation is demonstrably still running.
      const state = f.app as unknown as {
        state: { agents: import("./runtime").RuntimeAgent[] };
      };
      const agent = state.state.agents.find((a) => a.id === root.id)!;
      agent.state = "error";
      agent.turnId = undefined;
      agent.turnEnded = false;
      await expect(f.app.closeTree(root.id, undefined, true)).rejects.toThrow(
        "Pi has live native work",
      );
      expect(f.providerAborted()).toBe(false);
      expect(f.app.snapshot().agents.map((a) => a.id)).toContain(root.id);
      expect(f.app.lookup(root.id, "held-operation")?.state).toBe("accepted");
      const nativeFile = join(
        f.agentDir,
        "grove-durable",
        `${root.threadId}.sqlite`,
      );
      expect(() => acquirePiWriter(nativeFile)).toThrow("already has a writer");
      f.releaseProvider();
      await Bun.sleep(50);
    } finally {
      f.releaseProvider();
      await f.close();
    }
  }));

test("Pi waiting follow-up remains paused until Continue after restore", () =>
  isolated("Pi waiting follow-up", async () => {
    const f = await fixture({}, false, undefined, true);
    const runtime = new MixedRuntime(new FakeRuntime(), f.runtime);
    const options = {
      directory: join(process.env.HOME!, "queue-workspace"),
      runtime,
      projects: async () => [{ alias: "owned", name: "Owned", path: f.cwd }],
    };
    let app = new Workspace(options);
    try {
      const root = await app.createOrc("owned", {
        fast: false,
        orc: {
          backend: "pi",
          provider: "fixture",
          model: "vision",
          effort: "off",
        },
      });
      await app.send(root.id, "first", "first");
      for (let i = 0; i < 500 && !f.bodies.length; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(1);
      await app.enqueueFollowUp(root.id, "waiting", "waiting-operation");
      const state = app as unknown as {
        state: { agents: import("./runtime").RuntimeAgent[] };
      };
      const storedAgent = state.state.agents.find((a) => a.id === root.id)!;
      storedAgent.followUpPaused = true;
      storedAgent.questions.push({
        id: "retained-q",
        itemId: "retained-q",
        index: 0,
        title: "Decision",
        text: "Continue?",
        options: [],
        state: "unanswered",
        at: 1,
      });
      f.releaseProvider();
      for (let i = 0; i < 1000 && app.detail(root.id).state === "working"; i++)
        await Bun.sleep(5);
      expect(app.detail(root.id).state).toBe("idle");
      expect(app.lookupFollowUp(root.id, "waiting-operation")?.status).toBe(
        "waiting",
      );
      await app.closeTree(root.id, undefined, true);
      await app.resumeHistory("owned", root.threadId!, false);
      await app.synchronizeDetail(root.id);
      await Bun.sleep(30);
      expect(f.bodies).toHaveLength(1);
      expect(app.detail(root.id).followUpPaused).toBe(true);
      app.dispose();
      await runtime.close();
      app = new Workspace(options);
      await Bun.sleep(50);
      expect(f.bodies).toHaveLength(1);
      expect(app.lookupFollowUp(root.id, "waiting-operation")?.status).toBe(
        "waiting",
      );
      await app.send(root.id, "new independent input", "new-input");
      for (let i = 0; i < 1000 && app.detail(root.id).state === "working"; i++)
        await Bun.sleep(5);
      expect(f.bodies).toHaveLength(2);
      expect(app.lookupFollowUp(root.id, "waiting-operation")?.status).toBe(
        "waiting",
      );
      await app.answerBatch(
        root.id,
        [{ questionId: "retained-q", answer: "Yes" }],
        "new-answer",
      );
      for (let i = 0; i < 1000 && app.detail(root.id).state === "working"; i++)
        await Bun.sleep(5);
      expect(f.bodies).toHaveLength(3);
      expect(app.lookupFollowUp(root.id, "waiting-operation")?.status).toBe(
        "waiting",
      );
      await app.resumeFollowUps(root.id);
      for (let i = 0; i < 1000 && f.bodies.length < 4; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(4);
    } finally {
      f.releaseProvider();
      app.dispose();
      await runtime.close();
      await f.close();
    }
  }));

test("paused Pi follow-ups do not suppress unrelated accepted native recovery", () =>
  isolated("paused Pi follow-ups do not suppress", async () => {
    const f = await fixture({}, false, undefined, true);
    try {
      const root = await f.create();
      await f.app.send(
        root.id,
        "independent accepted work",
        "original-native-work",
      );
      for (let i = 0; i < 500 && !f.bodies.length; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(1);
      expect(f.app.lookup(root.id, "original-native-work")?.state).toBe(
        "accepted",
      );
      await f.app.enqueueFollowUp(root.id, "queued for later", "waiting-later");
      const state = f.app as unknown as {
        state: { agents: import("./runtime").RuntimeAgent[] };
      };
      const agent = state.state.agents.find((a) => a.id === root.id)!;
      // Model loss of the live projection while an independently accepted Pi
      // generation and a Grove waiting queue both remain durable.
      agent.state = "error";
      agent.turnId = undefined;
      agent.turnEnded = false;
      agent.followUpPaused = true;
      f.app.store.flush();
      const open = spyOn(f.runtime, "open");
      await f.restart();
      for (let i = 0; i < 200 && open.mock.calls.length === 0; i++)
        await Bun.sleep(5);
      expect(open).toHaveBeenCalled();
      expect(f.app.lookupFollowUp(root.id, "waiting-later")?.status).toBe(
        "waiting",
      );
      open.mockRestore();
    } finally {
      f.releaseProvider();
      await f.close();
    }
  }));

test("empty Pi close and restore permits a new message without recovery", () =>
  isolated("empty Pi close and restore", async () => {
    const f = await fixture({});
    const runtime = new MixedRuntime(new FakeRuntime(), f.runtime);
    const options = {
      directory: join(process.env.HOME!, "empty-workspace"),
      runtime,
      projects: async () => [{ alias: "owned", name: "Owned", path: f.cwd }],
    };
    const app = new Workspace(options);
    try {
      const root = await app.createOrc("owned", {
        fast: false,
        orc: {
          backend: "pi",
          provider: "fixture",
          model: "vision",
          effort: "off",
        },
      });
      await app.closeTree(root.id, undefined, true);
      await app.resumeHistory("owned", root.threadId!, false);
      expect(f.bodies).toHaveLength(0);
      await app.send(root.id, "new message", "new-message");
      for (let i = 0; i < 1000 && !f.bodies.length; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(1);
      expect(app.lookup(root.id, "new-message")?.state).toBe("accepted");
    } finally {
      app.dispose();
      await runtime.close();
      await f.close();
    }
  }));

test("Pi restore respects a competing writer and resumes its accepted work", () =>
  isolated("Pi restore respects a competing writer", async () => {
    const f = await fixture({}, false, undefined, true);
    const runtime = new MixedRuntime(new FakeRuntime(), f.runtime);
    const options = {
      directory: join(process.env.HOME!, "race-workspace"),
      runtime,
      projects: async () => [{ alias: "owned", name: "Owned", path: f.cwd }],
    };
    const app = new Workspace(options);
    try {
      const root = await app.createOrc("owned", {
        fast: false,
        orc: {
          backend: "pi",
          provider: "fixture",
          model: "vision",
          effort: "off",
        },
      });
      await app.closeTree(root.id, undefined, true);
      const saved = app.store.byId(root.id)!;
      // A separate owner legitimately acquires the released native writer and
      // submits work after the close snapshot but before Grove restores it.
      const native = await f.runtime.open(
        {
          ...saved,
          closed: false,
          threadId: threadIdentity(root.threadId!).id,
        },
        () => {},
      );
      await native.send("new native work", undefined, [], "external-native");
      for (let i = 0; i < 500 && !f.bodies.length; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(1);
      await expect(
        app.resumeHistory("owned", root.threadId!, false),
      ).rejects.toThrow("already has a writer");
      expect(app.store.byId(root.id)).toMatchObject({ closed: true });
      expect(f.bodies).toHaveLength(1);
      await f.runtime.close();
      await app.resumeHistory("owned", root.threadId!, false);
      for (let i = 0; i < 500 && f.bodies.length < 2; i++) await Bun.sleep(5);
      expect(f.bodies).toHaveLength(2);
      expect(app.store.byId(root.id)).toMatchObject({ closed: false });
      const history = await f.runtime.historyMessages(
        threadIdentity(root.threadId!).id,
      );
      expect(
        history.messages.filter((m) => m.clientId === "external-native"),
      ).toHaveLength(1);
    } finally {
      f.releaseProvider();
      app.dispose();
      await runtime.close();
      await f.close();
    }
  }));

test("hot Pi historical unknown can close when native inspection finds no live work", () =>
  isolated("hot Pi historical unknown can close", async () => {
    const f = await fixture({});
    try {
      const root = await f.create();
      const state = f.app as unknown as {
        state: { agents: import("./runtime").RuntimeAgent[] };
      };
      const agent = state.state.agents.find((a) => a.id === root.id)!;
      agent.state = "error";
      agent.turnEnded = false;
      agent.turnId = undefined;
      await f.app.closeTree(root.id, undefined, true);
      expect(f.app.store.byId(root.id)).toMatchObject({
        closed: true,
        state: "error",
        turnEnded: false,
      });
      expect(f.bodies).toHaveLength(0);
    } finally {
      await f.close();
    }
  }));
