import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Workspace, LIVE_BODY_LIMIT_BYTES } from "./workspace";
import { HostService } from "./hosts";
import { GroveAuth } from "./auth";
import { servePeer } from "./http";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixtureSync,
} from "./testing";
import { DeliveryRejected } from "./runtime";
import { authenticator } from "./synthetic-auth";
import { createHandler } from "./http";
import type { ProjectEnvironments } from "./project-environments";
import { parseFence, submissionOwner } from "./submission-admission";
import { encodedBytes, LIVE_BYTES } from "./conversation-reading";
import { EXTERNAL_HISTORY_MAX_READS } from "./external-mcp";

test("external MCP authenticates each SDK request and uses isolated workspace semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "external-mcp-"));
  const runtime = new FakeRuntime();
  const config = join(dir, "config.toml");
  writeFileSync(config, "not valid [[[\nFIXTURE_PRIVATE_SECRET");
  const remote = {
    id: "remote",
    name: "Remote fixture",
    target: "fixture-target",
  };
  const missing = {
    id: "missing",
    name: "Unavailable fixture",
    target: "missing-target",
  };
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async (environment) => {
      if (environment === "missing") throw new Error("fixture offline");
      return environment === "remote"
        ? [
            {
              ...fixtureProjects[0]!,
              path: "/remote/alpha",
              environment: remote,
            },
          ]
        : fixtureProjects;
    },
    environments: {
      list: async () => [
        { id: "local", name: "This machine", target: "local" },
        remote,
        missing,
      ],
      assert: async (environment: { id: string } | undefined) => {
        if (environment?.id === "missing") throw new Error("fixture offline");
      },
    } as unknown as ProjectEnvironments,
    memberPresets: memberPresetsFixtureSync(dir),
    liveBodyLimitBytes: 4 * 1024 * 1024,
    reviewerSnapshot: async () => ({ prompt: "test reviewer" }),
    researcherSnapshot: async () => ({ prompt: "test researcher" }),
    configFiles: {
      configPath: config,
      piAgentDir: join(dir, "pi"),
      codexHome: join(dir, "codex"),
    },
  });
  let origin = "";
  const service = new HostService(app, {
    directory: dir,
    origin: () => origin,
  });
  const options: Parameters<typeof servePeer>[1] = {
    service,
    origin: () => origin,
    hostname: "127.0.0.1",
    port: 0,
  };
  const listener = servePeer(app, options);
  origin = `http://127.0.0.1:${listener.port}`;
  const auth = new GroveAuth(app.store, dir, origin);
  options.auth = auth;
  const insert = app.store.sqlite.query(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, color) VALUES (?, ?, ?, 0, ?, ?, ?)",
  );
  for (const name of ["alice", "bob"])
    insert.run(
      name,
      name,
      `${name}@example.test`,
      "2026-01-01",
      "2026-01-01",
      "#123456",
    );
  for (const name of ["alice", "bob"])
    app.store.sqlite
      .query(
        "INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        name,
        `fixture-${name}`,
        name,
        "2099-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
  const session = spyOn(auth, "session").mockImplementation(async (headers) => {
    const name = headers.get("cookie");
    const user = name && auth.user(name);
    return user
      ? { user, sessionId: name!, expiresAt: Date.now() + 10000 }
      : null;
  });
  const active = spyOn(auth, "sessionActive").mockReturnValue(true);
  const browser = (
    method: string,
    user?: string,
    path = "/api/external-mcp/token",
  ) =>
    fetch(origin + path, {
      method,
      headers: { origin, ...(user ? { cookie: user } : {}) },
    });
  const clients: Client[] = [];
  const connect = async (token: string) => {
    const client = new Client({ name: "test-client", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/external-mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return JSON.parse(
      (result.content as { type: string; text: string }[])[0]!.text,
    );
  };
  const outcome = async (
    name: string,
    args: Record<string, unknown>,
    client: Client,
  ) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  try {
    expect((await browser("GET")).status).toBe(401);
    expect(await (await browser("GET", "alice")).json()).toEqual({
      active: false,
    });
    const alice = (
      (await (await browser("POST", "alice")).json()) as { token: string }
    ).token;
    const bob = (
      (await (await browser("POST", "bob")).json()) as { token: string }
    ).token;
    expect(alice).not.toBe(bob);
    expect(
      JSON.stringify(
        app.store.sqlite.query("SELECT * FROM external_mcp_tokens").all(),
      ),
    ).not.toContain(alice);
    expect(
      (
        await fetch(origin + "/external-mcp", {
          method: "POST",
          headers: { cookie: "alice" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(origin + "/external-mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${alice}`,
            origin: "https://evil.test",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(origin + "/api/external-mcp/token", {
          headers: { authorization: `Bearer ${alice}`, origin },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(origin + "/api/mcp/info", {
          headers: { authorization: `Bearer ${alice}` },
        })
      ).status,
    ).not.toBe(200);
    const client = await connect(alice);
    const other = await connect(bob);
    const unknownTool = await client.callTool({
      name: `missing-${alice}`,
      arguments: {},
    });
    expect(unknownTool.isError).toBe(true);
    expect(JSON.stringify(unknownTool)).not.toContain(alice);
    const configResult = await call(client, "get_config_files");
    expect(configResult).toEqual(await app.configFiles());
    expect(configResult.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(configResult)).not.toContain(
      "FIXTURE_PRIVATE_SECRET",
    );
    expect((await call(client, "list_projects")).projects[0].reference).toBe(
      "alpha",
    );
    expect(
      (await call(client, "list_projects", { environment: "remote" }))
        .projects[0],
    ).toMatchObject({ reference: "remote:alpha", path: "/remote/alpha" });
    expect(
      (
        await client.callTool({
          name: "list_projects",
          arguments: { environment: "missing" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "create_session",
          arguments: { project: "missing:alpha" },
        })
      ).isError,
    ).toBe(true);
    expect((await call(client, "list_skills")).skills.length).toBeGreaterThan(
      0,
    );
    const created = (await call(client, "create_session", { project: "alpha" }))
      .session;
    const sid = created.id as string;
    const raw = sid.slice(service.identity.id.length + 1);
    expect((await call(other, "list_sessions")).sessions[0].id).toBe(sid);
    const remoteSession = (
      await call(other, "create_session", { project: "remote:alpha" })
    ).session;
    expect(remoteSession.project).toMatchObject({
      reference: "remote:alpha",
      path: "/remote/alpha",
    });
    const models = runtime.models;
    runtime.models = async () => [];
    expect(
      await outcome("create_session", { project: "alpha" }, client),
    ).toMatchObject({ status: "failed" });
    runtime.models = models;
    const openSpy = spyOn(runtime, "open").mockImplementation(async () => {
      throw new Error("fixture native failure");
    });
    const unknownCreate = await outcome(
      "create_session",
      { project: "alpha" },
      client,
    );
    expect(unknownCreate).toMatchObject({ status: "unknown" });
    expect(JSON.stringify(unknownCreate)).not.toContain(
      "fixture native failure",
    );
    expect(openSpy).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
    const internalToken = runtime.agents.get(raw)!.token;
    expect(JSON.stringify(await call(client, "list_sessions"))).not.toContain(
      internalToken,
    );
    expect(
      (
        await fetch(origin + "/external-mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${internalToken}` },
        })
      ).status,
    ).toBe(401);
    expect(
      await call(client, "send_message", { session_id: sid, text: "hello" }),
    ).toEqual({ status: "accepted" });
    expect(runtime.inputs.filter((i) => i.text === "hello")).toHaveLength(1);
    const sentOperation = runtime.inputs.find(
      (i) => i.text === "hello",
    )!.clientId!;
    expect(
      parseFence(app.store.submissionFence(raw, sentOperation)!),
    ).toMatchObject({ state: "claimed", owner: submissionOwner("alice") });
    await call(client, "send_message", {
      session_id: sid,
      text: `echo ${internalToken}`,
    });
    const redacted = JSON.stringify(
      await call(client, "read_messages", { session_id: sid }),
    );
    expect(redacted).not.toContain(internalToken);
    expect(redacted).toContain("[redacted]");
    const similar = `grove_ext_${"A".repeat(42)}!`;
    await call(client, "send_message", {
      session_id: sid,
      text: `keys ${alice} ${bob} and ${similar}`,
    });
    const protectedMessages = JSON.stringify(
      await call(client, "read_messages", { session_id: sid }),
    );
    expect(protectedMessages).not.toContain(alice);
    expect(protectedMessages).not.toContain(bob);
    expect(protectedMessages).toContain(similar);
    expect(
      await call(client, "queue_message", { session_id: sid, text: "later" }),
    ).toEqual({ status: "queued" });
    expect(
      (await call(client, "list_deliveries", { session_id: sid })).followUps[0]
        .text,
    ).toBe("later");
    const turnId = app.detail(raw).turnId!;
    runtime.emit(raw, {
      type: "item",
      turnId,
      item: {
        id: "q",
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: `Which? ${alice}` }],
      },
    });
    expect(
      (await call(client, "list_questions", { session_id: sid })).questions[0]
        .id,
    ).toBe("q:0");
    const protectedQuestions = JSON.stringify(
      await call(client, "list_questions", { session_id: sid }),
    );
    expect(protectedQuestions).not.toContain(alice);
    expect(protectedQuestions).toContain("[redacted]");
    expect(
      await call(client, "answer_questions", {
        session_id: sid,
        answers: [{ questionId: "q:0", answer: "Yes" }],
      }),
    ).toEqual({ status: "accepted" });
    const inputCountAfterAnswer = runtime.inputs.length;
    const answered = await outcome(
      "answer_questions",
      { session_id: sid, answers: [{ questionId: "q:0", answer: "Again" }] },
      client,
    );
    expect(answered).toMatchObject({ status: "failed" });
    const missingQuestion = await outcome(
      "answer_questions",
      { session_id: sid, answers: [{ questionId: "missing:0", answer: "No" }] },
      client,
    );
    expect(missingQuestion).toMatchObject({ status: "failed" });
    expect(runtime.inputs.length).toBe(inputCountAfterAnswer);
    runtime.emit(raw, {
      type: "item",
      turnId,
      item: {
        id: "q-unknown",
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: "Which next?" }],
      },
    });
    runtime.sendOverride = async () => {
      throw new Error("fixture answer receipt lost");
    };
    const uncertainAnswer = await call(client, "answer_questions", {
      session_id: sid,
      answers: [{ questionId: "q-unknown:0", answer: "Maybe" }],
    });
    expect(uncertainAnswer).toEqual({ status: "unknown" });
    expect(
      runtime.inputs.filter((input) => input.text.includes("Answer: Maybe")),
    ).toHaveLength(1);
    runtime.sendOverride = undefined;
    const requests = [
      [
        "worker_start",
        { project: "alpha", title: "Worker", spec: "test", message: "work" },
      ],
      [
        "reviewer_start",
        {
          project: "alpha",
          title: "Reviewer",
          profile: "spec",
          spec: "test",
          fixedPoint: "base",
          reviewedHead: "head",
          message: "review",
        },
      ],
      [
        "researcher_start",
        {
          project: "alpha",
          title: "Researcher",
          question: "Why?",
          message: "research",
        },
      ],
    ] as const;
    for (const [tool, args] of requests)
      await app.tool(internalToken, tool, args);
    const listed = await call(other, "list_sessions");
    expect(
      listed.sessions.map((item: { role: string }) => item.role).sort(),
    ).toEqual(["orc", "orc", "researcher", "reviewer", "worker"]);
    const member = listed.sessions.find(
      (item: { role: string }) => item.role === "worker",
    );
    expect(member.ownerId).toBe(sid);
    expect(
      (
        await client.callTool({
          name: "send_message",
          arguments: { session_id: member.id, text: "no" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call(client, "read_messages", { session_id: member.id })).messages
        .length,
    ).toBeGreaterThan(0);
    const workerRaw = member.id.slice(service.identity.id.length + 1);
    await app.tool(runtime.agents.get(workerRaw)!.token, "worker_report", {
      message: "hidden confirmed report",
    });
    expect(
      JSON.stringify(await call(client, "read_messages", { session_id: sid })),
    ).not.toContain("hidden confirmed report");
    const threadForHidden = app.detail(raw).threadId!;
    const hidden = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.text.includes("hidden confirmed report"))!;
    hidden.text = "hidden ".repeat(200_000);
    expect(
      (
        await outcome(
          "read_message_body",
          { session_id: sid, body_ref: hidden.id },
          client,
        )
      ).error,
    ).toBe("Could not complete the requested read.");
    // An uncached member delivery remains readable from an older native page
    // when its accepted input has a later actionable outcome.
    const limits = app as unknown as {
      options: { liveBodyLimitBytes: number };
    };
    limits.options.liveBodyLimitBytes = 0;
    const memberText = "汉".repeat(90_000);
    await app.tool(runtime.agents.get(workerRaw)!.token, "worker_report", {
      message: memberText,
    });
    const memberInput = runtime.inputs.at(-1)!;
    const memberNative = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.clientId === memberInput.clientId)!;
    runtime.emit(raw, {
      type: "submission",
      operationId: memberInput.clientId!,
      turnId: app.detail(raw).turnId!,
      status: "unanswered",
      reason: "aborted",
    });
    await app.tool(runtime.agents.get(workerRaw)!.token, "worker_report", {
      message: "small member awaiting reconciliation",
    });
    const smallInput = runtime.inputs.at(-1)!;
    const smallNative = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.clientId === smallInput.clientId)!;
    const state = (
      app as unknown as {
        state: { agents: import("./runtime").RuntimeAgent[] };
      }
    ).state.agents.find((item) => item.id === raw)!;
    const smallDelivery = state.deliveries.find(
      (item) => item.id === smallInput.clientId,
    )!;
    smallDelivery.status = "uncertain";
    smallDelivery.error = "fixture pending receipt";
    await app.tool(runtime.agents.get(workerRaw)!.token, "worker_report", {
      message: "still uncertain without native evidence",
    });
    const unresolvedInput = runtime.inputs.at(-1)!;
    const unresolvedNative = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.clientId === unresolvedInput.clientId)!;
    const unresolvedDelivery = state.deliveries.find(
      (item) => item.id === unresolvedInput.clientId,
    )!;
    unresolvedDelivery.status = "uncertain";
    unresolvedDelivery.error = "fixture unknown";
    runtime.historyItems.set(
      threadForHidden,
      runtime.historyItems
        .get(threadForHidden)!
        .filter((item) => item.id !== unresolvedNative.id),
    );
    await app.tool(runtime.agents.get(workerRaw)!.token, "worker_report", {
      message: "确".repeat(90_000),
    });
    const hiddenLargeInput = runtime.inputs.at(-1)!;
    const hiddenLargeNative = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.clientId === hiddenLargeInput.clientId)!;
    // The native acceptance exists, but its live notification is delayed.
    // Workspace therefore retains its real provisional operation identity.
    const ownerHandle = (
      app as unknown as {
        handles: Map<string, import("./runtime").RuntimeHandle>;
      }
    ).handles.get(raw)!;
    const delayedNotification = spyOn(ownerHandle, "send").mockImplementation(
      async (text, turnId, images, clientId) => {
        const nativeTurn = turnId ?? "provisional-fixture-turn";
        runtime.inputs.push({ agentId: raw, text, turnId, images, clientId });
        runtime.historyItems.get(threadForHidden)!.push({
          id: `native-${clientId}`,
          clientId,
          turnId: nativeTurn,
          role: "user",
          text,
          at: Date.now(),
        });
        return nativeTurn;
      },
    );
    await app.tool(runtime.agents.get(workerRaw)!.token, "worker_report", {
      message: "暂".repeat(90_000),
    });
    delayedNotification.mockRestore();
    const bigProvisional = runtime.inputs.at(-1)!;
    const bigNative = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.clientId === bigProvisional.clientId)!;
    expect(bigNative.id).not.toBe(bigProvisional.clientId);
    expect(
      app
        .detail(raw)
        .messages.find((item) => item.id === bigProvisional.clientId),
    ).toMatchObject({ provisional: true, bodyRef: bigProvisional.clientId });
    await app.tool(runtime.agents.get(workerRaw)!.token, "worker_report", {
      message: "provisional member remains visible",
    });
    const provisionalInput = runtime.inputs.at(-1)!;
    const provisionalNative = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.clientId === provisionalInput.clientId)!;
    const provisionalLive = state.messages.find(
      (item) => item.id === provisionalNative.id,
    )!;
    provisionalLive.provisional = true;
    const provisionalDelivery = state.deliveries.find(
      (item) => item.id === provisionalInput.clientId,
    )!;
    provisionalDelivery.status = "uncertain";
    provisionalDelivery.error = "fixture pending";
    runtime.emit(raw, {
      type: "item",
      turnId: app.detail(raw).turnId!,
      item: {
        type: "agentMessage",
        id: "direct-question-check",
        text: "A direct question",
        delivery: "async",
        questions: [{ question: "Proceed?" }],
      },
    });
    const otherLarge = "N".repeat(1_100_000);
    runtime.emit(raw, {
      type: "item",
      turnId: app.detail(raw).turnId!,
      item: { type: "agentMessage", id: "second-uncached", text: otherLarge },
    });
    const latestProvisional = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      latestProvisional.messages.find(
        (item: { id: string }) => item.id === bigProvisional.clientId,
      ),
    ).toBeUndefined();
    expect(
      (
        await outcome(
          "read_message_body",
          { session_id: sid, body_ref: bigProvisional.clientId },
          client,
        )
      ).error,
    ).toBe("Could not complete the requested read.");
    // The page returned to the caller, unlike pages visited only for body
    // lookup, converges a strictly bound provisional member without an event.
    const originalBigId = bigNative.id;
    const bigDelivery = state.deliveries.find(
      (item) => item.id === bigProvisional.clientId,
    )!;
    const directQuestion = state.questions.find(
      (q) => q.itemId === "direct-question-check",
    )!;
    // An unrelated native item may have the same ID as the live operation.
    // It cannot confirm that operation or replace its uncertain row.
    const collisionOriginal = { ...bigNative };
    bigNative.id = bigProvisional.clientId!;
    bigNative.text = "unrelated native collision text";
    bigDelivery.status = "uncertain";
    bigDelivery.error = "fixture uncertain collision";
    for (const otherOperation of [
      hiddenLargeInput.clientId!,
      "ordinary-other-operation",
    ]) {
      bigNative.clientId = otherOperation;
      const collision = await call(client, "read_messages", {
        session_id: sid,
      });
      const row = collision.messages.find(
        (item: { id: string }) => item.id === bigProvisional.clientId,
      );
      expect(row).toMatchObject({
        provisional: true,
        clientId: bigProvisional.clientId,
        delivery: { status: "uncertain", hasError: true },
        bodyUnavailable: true,
      });
      expect(JSON.stringify(collision)).not.toContain(
        "unrelated native collision text",
      );
      expect(
        (
          await outcome(
            "read_message_body",
            { session_id: sid, body_ref: bigProvisional.clientId },
            client,
          )
        ).error,
      ).toBe("Could not complete the requested read.");
    }
    // A complete current live body and the actual bounded cache are safe to
    // read; neither is sourced from the unrelated native item.
    const liveCollision = state.messages.find(
      (item) => item.id === bigProvisional.clientId,
    )!;
    liveCollision.text = bigProvisional.text;
    delete liveCollision.bodyRef;
    expect(
      (
        await call(client, "read_message_body", {
          session_id: sid,
          body_ref: bigProvisional.clientId,
        })
      ).text,
    ).toBe(bigProvisional.text.slice(0, 65536));
    const saveWindow = () => {
      app.store.windows.add(state);
      (app as unknown as { save(): void }).save();
    };
    limits.options.liveBodyLimitBytes = 4 * 1024 * 1024;
    saveWindow();
    expect(
      state.messages.find((item) => item.id === bigProvisional.clientId),
    ).toMatchObject({ bodyRef: bigProvisional.clientId });
    expect(
      service.liveMessageBody(
        sid,
        bigProvisional.clientId!,
        bigProvisional.clientId,
      ),
    ).toBe(bigProvisional.text);
    const cachedCollision = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      cachedCollision.messages.find(
        (item: { id: string }) => item.id === bigProvisional.clientId,
      ),
    ).toMatchObject({ bodyRef: bigProvisional.clientId, provisional: true });
    expect(
      (
        await call(client, "read_message_body", {
          session_id: sid,
          body_ref: bigProvisional.clientId,
        })
      ).text,
    ).toBe(bigProvisional.text.slice(0, 65536));
    const originalWindow = state.messages.slice();
    state.messages.push({
      ...state.messages.find((item) => item.id === bigProvisional.clientId)!,
      clientId: "different-live-operation",
      provisional: false,
      text: "wrong live body",
    });
    expect(
      service.liveMessageBody(
        sid,
        bigProvisional.clientId!,
        bigProvisional.clientId,
      ),
    ).toBeUndefined();
    expect(
      (
        await outcome(
          "read_message_body",
          { session_id: sid, body_ref: bigProvisional.clientId },
          client,
        )
      ).error,
    ).toBe("Could not complete the requested read.");
    state.messages = originalWindow;
    // A stale cache entry with the same item ID but a different operation must
    // not become the live operation's body after the other row leaves.
    state.messages.push({
      ...state.messages.find((item) => item.id === bigProvisional.clientId)!,
      clientId: "different-live-operation",
      provisional: false,
      text: "wrong cached body".repeat(30_000),
      bodyRef: undefined,
    });
    saveWindow();
    state.messages = state.messages.filter(
      (item) => item.clientId !== "different-live-operation",
    );
    expect(service.liveMessageBody(sid, bigProvisional.clientId!)).toBe(
      "wrong cached body".repeat(30_000),
    );
    expect(
      service.liveMessageBody(
        sid,
        bigProvisional.clientId!,
        bigProvisional.clientId,
      ),
    ).toBeUndefined();
    expect(
      (
        await outcome(
          "read_message_body",
          { session_id: sid, body_ref: bigProvisional.clientId },
          client,
        )
      ).error,
    ).toBe("Could not complete the requested read.");
    const resetLive = state.messages.find(
      (item) => item.id === bigProvisional.clientId,
    )!;
    resetLive.text = bigProvisional.text;
    delete resetLive.bodyRef;
    limits.options.liveBodyLimitBytes = 0;
    saveWindow();
    expect(
      service.liveMessageBody(
        sid,
        bigProvisional.clientId!,
        bigProvisional.clientId,
      ),
    ).toBeUndefined();

    // Only the earlier native item bound to A may supply an uncached body;
    // the first-page same-ID item belongs to B and has different content.
    const savedCollisionHistory = runtime.historyItems.get(threadForHidden)!;
    const matchedText = "bound-native-正文".repeat(100_000);
    const matchedEarlier = { ...collisionOriginal, text: matchedText };
    runtime.historyItems.set(threadForHidden, [
      ...savedCollisionHistory.filter((item) => item !== bigNative),
      matchedEarlier,
      ...Array.from({ length: 35 }, (_, index) => ({
        id: `collision-filler-${index}`,
        role: "assistant" as const,
        text: "filler",
        at: Date.now() + index,
      })),
      bigNative,
    ]);
    const boundCollision = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      boundCollision.messages.find(
        (item: { id: string }) => item.id === bigProvisional.clientId,
      ),
    ).toMatchObject({ provisional: true, bodyRef: bigProvisional.clientId });
    const boundChunk = await call(client, "read_message_body", {
      session_id: sid,
      body_ref: bigProvisional.clientId,
    });
    expect(boundChunk.text).toBe(matchedText.slice(0, 65536));
    expect(boundChunk.text).not.toContain("unrelated native collision text");
    const collisionWindow = state.messages.slice();
    const collisionWatches = (
      app as unknown as { provisionalWatches: Set<unknown> }
    ).provisionalWatches;
    for (const tool of ["read_messages", "read_message_body"] as const) {
      state.messages = collisionWindow.slice();
      bigDelivery.status = "uncertain";
      bigDelivery.error = "fixture uncertain collision";
      const history = runtime.historyMessages.bind(runtime);
      let notified = false;
      const duringCollision = spyOn(
        runtime,
        "historyMessages",
      ).mockImplementation(async (threadId, position) => {
        const result = await history(threadId, position);
        if (position && !notified) {
          notified = true;
          runtime.emit(raw, {
            type: "item",
            turnId: matchedEarlier.turnId!,
            item: {
              type: "userMessage",
              id: matchedEarlier.id,
              clientId: matchedEarlier.clientId,
              text: matchedEarlier.text,
            },
          });
          for (let index = 0; index < 101; index++)
            runtime.emit(raw, {
              type: "item",
              turnId: matchedEarlier.turnId!,
              item: {
                type: "agentMessage",
                id: `collision-race-${tool}-${index}`,
                text: "window filler",
              },
            });
        }
        return result;
      });
      const result = await client.callTool({
        name: tool,
        arguments: {
          session_id: sid,
          ...(tool === "read_message_body"
            ? { body_ref: bigProvisional.clientId }
            : {}),
        },
      });
      expect(notified).toBe(true);
      expect(collisionWatches.size).toBe(0);
      if (tool === "read_message_body") expect(result.isError).toBe(true);
      else {
        expect(result.isError).not.toBe(true);
        const rows = JSON.parse(
          (result.content as { text: string }[])[0]!.text,
        ).messages;
        expect(
          rows.some(
            (item: { id: string }) => item.id === bigProvisional.clientId,
          ),
        ).toBe(false);
      }
      duringCollision.mockRestore();
    }
    state.messages = collisionWindow;
    runtime.historyItems.set(threadForHidden, savedCollisionHistory);
    Object.assign(bigNative, collisionOriginal);
    bigDelivery.status = "sent";
    bigDelivery.error = undefined;
    for (const sameId of [false, true]) {
      bigNative.id = sameId ? bigProvisional.clientId! : originalBigId;
      const confirmed = await call(client, "read_messages", {
        session_id: sid,
      });
      expect(
        confirmed.messages.some(
          (item: { id: string }) =>
            item.id === bigNative.id || item.id === bigProvisional.clientId,
        ),
      ).toBe(false);
      expect(
        (
          await outcome(
            "read_message_body",
            { session_id: sid, body_ref: bigProvisional.clientId },
            client,
          )
        ).error,
      ).toBe("Could not complete the requested read.");
      const cachedBody = spyOn(service, "liveMessageBody").mockImplementation(
        (_sessionId, messageId) =>
          messageId === bigProvisional.clientId
            ? bigProvisional.text
            : undefined,
      );
      expect(
        (
          await outcome(
            "read_message_body",
            { session_id: sid, body_ref: bigProvisional.clientId },
            client,
          )
        ).error,
      ).toBe("Could not complete the requested read.");
      cachedBody.mockRestore();

      bigDelivery.error = "fixture native outcome error";
      const failed = await call(client, "read_messages", { session_id: sid });
      expect(
        failed.messages.find(
          (item: { id: string }) => item.id === bigNative.id,
        ),
      ).toMatchObject({ delivery: { status: "sent", hasError: true } });
      expect(
        (
          await call(client, "read_message_body", {
            session_id: sid,
            body_ref: bigProvisional.clientId,
          })
        ).text,
      ).toBe(bigProvisional.text.slice(0, 65536));
      bigDelivery.error = undefined;

      const question = {
        ...directQuestion,
        id: `first-page-question-${sameId}`,
        itemId: bigNative.id,
      };
      state.questions.push(question);
      const questionPage = await call(client, "read_messages", {
        session_id: sid,
      });
      expect(
        questionPage.messages.find(
          (item: { id: string }) => item.id === bigNative.id,
        ),
      ).toMatchObject({ questionItemId: bigNative.id });
      expect(
        (
          await call(client, "read_message_body", {
            session_id: sid,
            body_ref: bigProvisional.clientId,
          })
        ).text,
      ).toBe(bigProvisional.text.slice(0, 65536));
      state.questions = state.questions.filter((q) => q.id !== question.id);

      const operation = bigNative.clientId;
      bigNative.clientId = "first-page-other-operation";
      const mismatch = await call(client, "read_messages", { session_id: sid });
      if (!sameId)
        expect(
          mismatch.messages.find(
            (item: { id: string }) => item.id === bigProvisional.clientId,
          ),
        ).toMatchObject({ provisional: true, bodyUnavailable: true });
      expect(
        (
          await outcome(
            "read_message_body",
            { session_id: sid, body_ref: bigProvisional.clientId },
            client,
          )
        ).error,
      ).toBe("Could not complete the requested read.");
      bigNative.clientId = operation;
    }
    bigNative.id = originalBigId;
    const historyWithBig = runtime.historyItems.get(threadForHidden)!;
    runtime.historyItems.set(
      threadForHidden,
      historyWithBig.filter((item) => item !== bigNative),
    );
    bigDelivery.status = "uncertain";
    bigDelivery.error = "fixture no native receipt";
    const unknownPage = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      unknownPage.messages.find(
        (item: { id: string }) => item.id === bigProvisional.clientId,
      ),
    ).toMatchObject({ provisional: true, delivery: { status: "uncertain" } });
    runtime.historyItems.set(threadForHidden, historyWithBig);
    bigDelivery.status = "sent";
    bigDelivery.error = undefined;
    runtime.historyItems.get(threadForHidden)!.push(
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `member-older-filler-${i}`,
        role: "assistant" as const,
        text: "filler",
        at: Date.now() + i,
      })),
    );
    const historyCount = spyOn(runtime, "historyMessages");
    const memberPage = await call(client, "read_messages", { session_id: sid });
    expect(historyCount.mock.calls.length).toBe(2);
    historyCount.mockRestore();
    expect(
      memberPage.messages.find(
        (item: { id: string }) => item.id === bigProvisional.clientId,
      ),
    ).toMatchObject({ provisional: true, bodyRef: bigProvisional.clientId });
    let provisionalText = "";
    let provisionalOffset: number | null = 0;
    do {
      const chunk = await call(client, "read_message_body", {
        session_id: sid,
        body_ref: bigProvisional.clientId,
        offset: provisionalOffset,
      });
      provisionalText += chunk.text;
      provisionalOffset = chunk.nextOffset;
    } while (provisionalOffset !== null);
    expect(provisionalText).toBe(bigProvisional.text);
    const nativeClientId = bigNative.clientId;
    bigNative.clientId = "fixture-wrong-operation";
    const mismatchProvisional = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      mismatchProvisional.messages.find(
        (item: { id: string }) => item.id === bigProvisional.clientId,
      ),
    ).toMatchObject({ bodyUnavailable: true });
    expect(
      (
        await outcome(
          "read_message_body",
          { session_id: sid, body_ref: bigProvisional.clientId },
          client,
        )
      ).error,
    ).toBe("Could not complete the requested read.");
    bigNative.clientId = nativeClientId;
    expect(
      memberPage.messages.some(
        (item: { id: string }) => item.id === hiddenLargeNative.id,
      ),
    ).toBe(false);
    expect(
      (
        await outcome(
          "read_message_body",
          { session_id: sid, body_ref: hiddenLargeNative.id },
          client,
        )
      ).error,
    ).toBe("Could not complete the requested read.");
    expect(
      (await service.agentHistory(sid, memberPage.nextCursor)).messages.some(
        (item) => item.id === hiddenLargeNative.id,
      ),
    ).toBe(true);
    const questionTemplate = state.questions.find(
      (q) => q.itemId === "direct-question-check",
    )!;
    expect(questionTemplate).toBeDefined();
    const boundQuestion = {
      ...questionTemplate,
      id: `${hiddenLargeNative.id}:fixture`,
      itemId: hiddenLargeNative.id,
    };
    state.questions.push(boundQuestion);
    const sameIdQuestion = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      sameIdQuestion.messages.find(
        (item: { id: string }) => item.id === hiddenLargeNative.id,
      ),
    ).toMatchObject({
      questionItemId: hiddenLargeNative.id,
      bodyRef: hiddenLargeNative.id,
    });
    expect(
      (
        await call(client, "read_message_body", {
          session_id: sid,
          body_ref: hiddenLargeNative.id,
        })
      ).text,
    ).toBe(hiddenLargeNative.text.slice(0, 65536));
    state.questions = state.questions.filter((q) => q.id !== boundQuestion.id);
    const nativeQuestion = {
      ...questionTemplate,
      id: `${bigNative.id}:fixture`,
      itemId: bigNative.id,
    };
    state.questions.push(nativeQuestion);
    expect(service.projectMessages(sid, [bigNative])[0]?.questionItemId).toBe(
      bigNative.id,
    );
    const differentIdQuestion = await call(client, "read_messages", {
      session_id: sid,
    });
    const provisionalWithOtherQuestion = differentIdQuestion.messages.find(
      (item: { id: string }) => item.id === bigProvisional.clientId,
    );
    expect(provisionalWithOtherQuestion).toMatchObject({
      provisional: true,
      bodyRef: bigProvisional.clientId,
    });
    expect(provisionalWithOtherQuestion.questionItemId).toBeUndefined();
    state.questions = state.questions.filter((q) => q.id !== nativeQuestion.id);
    // Hold an earlier native page in flight, deliver the item's real event,
    // then evict the resulting live row before the request can finish.
    const savedWindow = state.messages.slice();
    const savedHistory = runtime.historyItems.get(threadForHidden)!.slice();
    const originalNativeId = bigNative.id;
    const watches = (app as unknown as { provisionalWatches: Set<unknown> })
      .provisionalWatches;
    for (const sameId of [false, true]) {
      for (const tool of ["read_messages", "read_message_body"] as const) {
        state.messages = savedWindow.slice();
        runtime.historyItems.set(threadForHidden, savedHistory.slice());
        bigNative.id = sameId ? bigProvisional.clientId! : originalNativeId;
        const originalHistory = runtime.historyMessages.bind(runtime);
        let notified = false;
        const duringScan = spyOn(runtime, "historyMessages").mockImplementation(
          async (threadId, position) => {
            const result = await originalHistory(threadId, position);
            if (position && !notified) {
              notified = true;
              runtime.emit(raw, {
                type: "item",
                turnId: bigNative.turnId!,
                item: {
                  type: "userMessage",
                  id: bigNative.id,
                  clientId: bigNative.clientId,
                  text: bigNative.text,
                },
              });
              for (let i = 0; i < 101; i++)
                runtime.emit(raw, {
                  type: "item",
                  turnId: bigNative.turnId!,
                  item: {
                    type: "agentMessage",
                    id: `race-${sameId}-${tool}-${i}`,
                    text: "window filler",
                  },
                });
            }
            return result;
          },
        );
        const result = await client.callTool({
          name: tool,
          arguments: {
            session_id: sid,
            ...(tool === "read_message_body"
              ? { body_ref: bigProvisional.clientId }
              : {}),
          },
        });
        expect(notified).toBe(true);
        expect(
          state.messages.some(
            (item) => item.clientId === bigProvisional.clientId,
          ),
        ).toBe(false);
        expect(watches.size).toBe(0);
        if (tool === "read_message_body") expect(result.isError).toBe(true);
        else {
          expect(result.isError).not.toBe(true);
          const body = JSON.parse(
            (result.content as { text: string }[])[0]!.text,
          );
          expect(
            body.messages.some(
              (item: { id: string }) =>
                item.id === bigProvisional.clientId || item.id === bigNative.id,
            ),
          ).toBe(false);
        }
        duringScan.mockRestore();
      }
    }
    for (const otherNotification of [false, true]) {
      for (const tool of ["read_messages", "read_message_body"] as const) {
        state.messages = savedWindow.slice();
        bigNative.id = originalNativeId;
        runtime.historyItems.set(threadForHidden, savedHistory.slice());
        const originalHistory = runtime.historyMessages.bind(runtime);
        let ran = false;
        const duringScan = spyOn(runtime, "historyMessages").mockImplementation(
          async (threadId, position) => {
            const result = await originalHistory(threadId, position);
            if (position && !ran) {
              ran = true;
              if (otherNotification)
                runtime.emit(raw, {
                  type: "item",
                  turnId: "other-fixture-turn",
                  item: {
                    type: "userMessage",
                    id: "other-native-item",
                    clientId: "other-operation",
                    text: "unrelated",
                  },
                });
              for (let i = 0; i < 101; i++)
                runtime.emit(raw, {
                  type: "item",
                  turnId: bigNative.turnId!,
                  item: {
                    type: "agentMessage",
                    id: `control-${otherNotification}-${tool}-${i}`,
                    text: "window filler",
                  },
                });
            }
            return result;
          },
        );
        const result = await call(client, tool, {
          session_id: sid,
          ...(tool === "read_message_body"
            ? { body_ref: bigProvisional.clientId }
            : {}),
        });
        expect(ran).toBe(true);
        expect(
          state.messages.some(
            (item) => item.clientId === bigProvisional.clientId,
          ),
        ).toBe(false);
        if (tool === "read_message_body")
          expect(result.text).toBe(bigProvisional.text.slice(0, 65536));
        else
          expect(
            result.messages.find(
              (item: { id: string }) => item.id === bigProvisional.clientId,
            ),
          ).toMatchObject({
            provisional: true,
            bodyRef: bigProvisional.clientId,
          });
        expect(watches.size).toBe(0);
        duringScan.mockRestore();
      }
    }
    for (const sameQuestionIdentity of [true, false]) {
      for (const tool of ["read_messages", "read_message_body"] as const) {
        state.messages = savedWindow.slice();
        bigNative.id = originalNativeId;
        runtime.historyItems.set(threadForHidden, savedHistory.slice());
        const itemId = sameQuestionIdentity
          ? bigProvisional.clientId!
          : "unrelated-question-item";
        const question = { ...questionTemplate, id: `${itemId}:race`, itemId };
        state.questions.push(question);
        const originalHistory = runtime.historyMessages.bind(runtime);
        let notified = false;
        const duringScan = spyOn(runtime, "historyMessages").mockImplementation(
          async (threadId, position) => {
            const result = await originalHistory(threadId, position);
            if (position && !notified) {
              notified = true;
              runtime.emit(raw, {
                type: "item",
                turnId: bigNative.turnId!,
                item: {
                  type: "userMessage",
                  id: bigNative.id,
                  clientId: bigNative.clientId,
                  text: bigNative.text,
                },
              });
              for (let i = 0; i < 101; i++)
                runtime.emit(raw, {
                  type: "item",
                  turnId: bigNative.turnId!,
                  item: {
                    type: "agentMessage",
                    id: `question-race-${sameQuestionIdentity}-${tool}-${i}`,
                    text: "window filler",
                  },
                });
            }
            return result;
          },
        );
        const result = await client.callTool({
          name: tool,
          arguments: {
            session_id: sid,
            ...(tool === "read_message_body"
              ? { body_ref: bigProvisional.clientId }
              : {}),
          },
        });
        expect(notified).toBe(true);
        if (sameQuestionIdentity) {
          expect(result.isError).not.toBe(true);
          const body = JSON.parse(
            (result.content as { text: string }[])[0]!.text,
          );
          if (tool === "read_message_body")
            expect(body.text).toBe(bigProvisional.text.slice(0, 65536));
          else
            expect(
              body.messages.find(
                (item: { id: string }) => item.id === bigProvisional.clientId,
              ),
            ).toMatchObject({ questionItemId: itemId });
        } else if (tool === "read_message_body")
          expect(result.isError).toBe(true);
        else {
          expect(result.isError).not.toBe(true);
          const body = JSON.parse(
            (result.content as { text: string }[])[0]!.text,
          );
          expect(
            body.messages.some(
              (item: { id: string }) => item.id === bigProvisional.clientId,
            ),
          ).toBe(false);
        }
        expect(watches.size).toBe(0);
        state.questions = state.questions.filter((q) => q.id !== question.id);
        duringScan.mockRestore();
      }
    }
    for (const tool of ["read_messages", "read_message_body"] as const) {
      state.messages = savedWindow.slice();
      bigNative.id = originalNativeId;
      runtime.historyItems.set(threadForHidden, savedHistory.slice());
      const originalSnapshot = service.detailSnapshot.bind(service);
      let scheduled = false;
      const snapshot = spyOn(service, "detailSnapshot").mockImplementation(
        (id) => {
          const detail = originalSnapshot(id);
          if (!scheduled && id === sid) {
            scheduled = true;
            queueMicrotask(() => {
              runtime.emit(raw, {
                type: "item",
                turnId: bigNative.turnId!,
                item: {
                  type: "userMessage",
                  id: bigNative.id,
                  clientId: bigNative.clientId,
                  text: bigNative.text,
                },
              });
              for (let i = 0; i < 101; i++)
                runtime.emit(raw, {
                  type: "item",
                  turnId: bigNative.turnId!,
                  item: {
                    type: "agentMessage",
                    id: `snapshot-race-${tool}-${i}`,
                    text: "window filler",
                  },
                });
            });
          }
          return detail;
        },
      );
      const result = await client.callTool({
        name: tool,
        arguments: {
          session_id: sid,
          ...(tool === "read_message_body"
            ? { body_ref: bigProvisional.clientId }
            : {}),
        },
      });
      expect(scheduled).toBe(true);
      if (tool === "read_message_body") expect(result.isError).toBe(true);
      else {
        expect(result.isError).not.toBe(true);
        const body = JSON.parse(
          (result.content as { text: string }[])[0]!.text,
        );
        expect(
          body.messages.some(
            (item: { id: string }) => item.id === bigProvisional.clientId,
          ),
        ).toBe(false);
      }
      expect(watches.size).toBe(0);
      snapshot.mockRestore();
    }
    bigNative.id = originalNativeId;
    state.messages = savedWindow;
    runtime.historyItems.set(threadForHidden, savedHistory);
    const brokenProjection = spyOn(
      service,
      "projectMessages",
    ).mockImplementation(() => {
      throw new Error("fixture projection failure");
    });
    expect(
      (await outcome("read_messages", { session_id: sid }, client)).error,
    ).toBe("Could not complete the requested read.");
    expect(watches.size).toBe(0);
    brokenProjection.mockRestore();

    // Abort the actual external HTTP request while a native page is pending.
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const historyBeforeAbort = runtime.historyMessages.bind(runtime);
    const stalled = spyOn(runtime, "historyMessages").mockImplementation(
      async (threadId, position) => {
        if (position) {
          started.resolve();
          await resume.promise;
        }
        return historyBeforeAbort(threadId, position);
      },
    );
    const direct = createHandler(app, { service, auth, origin: () => origin });
    const pending = direct(
      new Request(origin + "/external-mcp", {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${alice}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7001,
          method: "tools/call",
          params: { name: "read_messages", arguments: { session_id: sid } },
        }),
      }),
    );
    await started.promise;
    expect(watches.size).toBe(1);
    controller.abort();
    expect(watches.size).toBe(0);
    resume.resolve();
    const abortedResponse = await pending;
    expect((await abortedResponse.json()).result.isError).toBe(true);
    expect(watches.size).toBe(0);
    stalled.mockRestore();
    // If the native item notification arrives during the scan, the original
    // provisional snapshot no longer qualifies as provisional.
    const beforeNotification = state.messages.slice();
    const historyBeforeNotification = runtime.historyMessages.bind(runtime);
    let notificationDelivered = false;
    const arrivingNative = spyOn(runtime, "historyMessages").mockImplementation(
      async (threadId, cursor) => {
        const result = await historyBeforeNotification(threadId, cursor);
        if (cursor && !notificationDelivered) {
          notificationDelivered = true;
          runtime.emit(raw, {
            type: "item",
            turnId: bigNative.turnId!,
            item: {
              type: "userMessage",
              id: bigNative.id,
              clientId: bigNative.clientId,
              text: bigNative.text,
            },
          });
        }
        return result;
      },
    );
    const afterNotification = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(notificationDelivered).toBe(true);
    expect(
      afterNotification.messages.some(
        (item: { id: string }) =>
          item.id === bigProvisional.clientId || item.id === bigNative.id,
      ),
    ).toBe(false);
    arrivingNative.mockRestore();
    state.messages = beforeNotification;
    expect(
      memberPage.messages.some(
        (item: { id: string }) => item.id === smallNative.id,
      ),
    ).toBe(false);
    expect(
      memberPage.messages.find(
        (item: { id: string }) => item.id === unresolvedNative.id,
      ),
    ).toMatchObject({ delivery: { status: "uncertain", hasError: true } });
    expect(
      memberPage.messages.find(
        (item: { id: string }) => item.id === provisionalNative.id,
      ),
    ).toMatchObject({ provisional: true, delivery: { status: "sent" } });
    expect(
      memberPage.messages.find(
        (item: { id: string }) => item.id === "direct-question-check",
      ),
    ).toMatchObject({ questionItemId: "direct-question-check" });
    // A successfully projected earlier page can confirm B even when a later
    // native read fails before A is found.
    smallDelivery.status = "uncertain";
    smallDelivery.error = "fixture pending receipt";
    const originalHistory = runtime.historyMessages.bind(runtime);
    let partialReads = 0;
    const partial = spyOn(runtime, "historyMessages").mockImplementation(
      async (threadId, position) => {
        partialReads++;
        if (partialReads === 1) return originalHistory(threadId, position);
        if (partialReads === 2)
          return { messages: [smallNative], nextCursor: "fault" };
        // The row may leave the live window after the original snapshot.
        state.messages = state.messages.filter(
          (item) => item.id !== smallNative.id,
        );
        throw new Error("fixture history disconnected");
      },
    );
    const partialPage = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(partialReads).toBe(3);
    expect(
      partialPage.messages.some(
        (item: { id: string }) => item.id === smallNative.id,
      ),
    ).toBe(false);
    expect(
      partialPage.messages.find(
        (item: { id: string }) => item.id === memberNative.id,
      ),
    ).toMatchObject({ bodyUnavailable: true });
    expect(
      partialPage.messages.find(
        (item: { id: string }) => item.id === unresolvedNative.id,
      ),
    ).toMatchObject({ delivery: { status: "uncertain", hasError: true } });
    partial.mockRestore();

    // Count real native reads, including the initial page. Multiple missing
    // member and non-member bodies share the same finite request budget.
    let budgetReads = 0;
    const exhausted = spyOn(runtime, "historyMessages").mockImplementation(
      async () => ({
        messages: [
          {
            id: `budget-${++budgetReads}`,
            role: "assistant" as const,
            text: "filler",
            at: budgetReads,
          },
        ],
        nextCursor: String(budgetReads),
      }),
    );
    const exhaustedPage = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(budgetReads).toBe(EXTERNAL_HISTORY_MAX_READS);
    expect(
      exhaustedPage.messages.find(
        (item: { id: string }) => item.id === memberNative.id,
      ),
    ).toMatchObject({ bodyUnavailable: true });
    expect(
      exhaustedPage.messages.find(
        (item: { id: string }) => item.id === "second-uncached",
      ),
    ).toMatchObject({ bodyUnavailable: true });
    exhausted.mockRestore();
    const largeNative = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.id === "second-uncached")!;
    let lastPageReads = 0;
    const lastPage = spyOn(runtime, "historyMessages").mockImplementation(
      async () => {
        lastPageReads++;
        return {
          messages:
            lastPageReads === EXTERNAL_HISTORY_MAX_READS
              ? [largeNative]
              : [
                  {
                    id: `edge-${lastPageReads}`,
                    role: "assistant" as const,
                    text: "filler",
                    at: lastPageReads,
                  },
                ],
          nextCursor: String(lastPageReads),
        };
      },
    );
    const lastPageResult = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(lastPageReads).toBe(EXTERNAL_HISTORY_MAX_READS);
    expect(
      lastPageResult.messages.find(
        (item: { id: string }) => item.id === largeNative.id,
      ),
    ).toMatchObject({ bodyRef: largeNative.id });
    lastPageReads = 0;
    const lastBody = await call(client, "read_message_body", {
      session_id: sid,
      body_ref: largeNative.id,
    });
    expect(lastPageReads).toBe(EXTERNAL_HISTORY_MAX_READS);
    expect(lastBody.text).toBe(otherLarge.slice(0, 65536));
    lastPage.mockRestore();
    let repeatedReads = 0;
    const repeated = spyOn(runtime, "historyMessages").mockImplementation(
      async () => ({
        messages: [
          {
            id: `repeat-${++repeatedReads}`,
            role: "assistant" as const,
            text: "filler",
            at: repeatedReads,
          },
        ],
        nextCursor: "repeat",
      }),
    );
    const repeatedPage = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(repeatedReads).toBe(2);
    expect(
      repeatedPage.messages.find(
        (item: { id: string }) => item.id === memberNative.id,
      ),
    ).toMatchObject({ bodyUnavailable: true });
    repeated.mockRestore();
    expect(
      memberPage.messages.find(
        (item: { id: string }) => item.id === memberNative.id,
      ),
    ).toMatchObject({ bodyRef: memberNative.id, delivery: { hasError: true } });
    const memberBody = await call(client, "read_message_body", {
      session_id: sid,
      body_ref: memberNative.id,
    });
    expect(memberBody.text).toBe(memberNative.text.slice(0, 65536));
    expect(memberBody.nextOffset).toBe(65536);
    let reconstructed = memberBody.text as string;
    let memberOffset = memberBody.nextOffset as number | null;
    while (memberOffset !== null) {
      const chunk = await call(client, "read_message_body", {
        session_id: sid,
        body_ref: memberNative.id,
        offset: memberOffset,
      });
      reconstructed += chunk.text;
      memberOffset = chunk.nextOffset;
    }
    expect(reconstructed).toBe(memberNative.text);
    expect(
      (await service.agentHistory(sid, memberPage.nextCursor)).messages.some(
        (item) => item.id === hidden.id,
      ),
    ).toBe(true);
    expect(
      (
        await outcome(
          "read_message_body",
          {
            session_id: sid,
            body_ref: hidden.id,
            page_cursor: memberPage.nextCursor,
          },
          client,
        )
      ).error,
    ).toBe("Could not complete the requested read.");
    const savedClientId = memberNative.clientId;
    memberNative.clientId = "different-operation";
    const mismatch = await call(client, "read_messages", { session_id: sid });
    expect(
      mismatch.messages.find(
        (item: { id: string }) => item.id === memberNative.id,
      ),
    ).toMatchObject({ bodyUnavailable: true });
    expect(
      (
        await outcome(
          "read_message_body",
          { session_id: sid, body_ref: memberNative.id },
          client,
        )
      ).error,
    ).toBe("Could not complete the requested read.");
    memberNative.clientId = savedClientId;
    limits.options.liveBodyLimitBytes = 4 * 1024 * 1024;

    // The stored live item fits, but adding its real delivery metadata tips
    // the detail projection over the live threshold. Native history is absent.
    await call(client, "send_message", {
      session_id: sid,
      text: "metadata seed",
    });
    const seed = runtime.inputs.at(-1)!;
    const seedNative = runtime.historyItems
      .get(threadForHidden)!
      .find((item) => item.clientId === seed.clientId)!;
    const metadataText = "M".repeat(
      LIVE_BYTES - 2048 - encodedBytes({ ...seedNative, text: "" }) - 20,
    );
    runtime.emit(raw, {
      type: "item",
      turnId: seedNative.turnId!,
      item: {
        type: "userMessage",
        id: seedNative.id,
        clientId: seed.clientId,
        text: metadataText,
      },
    });
    runtime.historyItems.set(
      threadForHidden,
      runtime.historyItems
        .get(threadForHidden)!
        .filter((item) => item.id !== seedNative.id),
    );
    expect(
      app.detail(raw).messages.find((item) => item.id === seedNative.id)
        ?.bodyRef,
    ).toBe(seedNative.id);
    expect(app.liveMessageBody(raw, seedNative.id)).toBe(metadataText);
    const metadataPage = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      metadataPage.messages.find(
        (item: { id: string }) => item.id === seedNative.id,
      ),
    ).toMatchObject({ bodyRef: seedNative.id });
    expect(
      (
        await call(client, "read_message_body", {
          session_id: sid,
          body_ref: seedNative.id,
        })
      ).text,
    ).toBe(metadataText.slice(0, 65536));
    runtime.sendOverride = async () => {
      throw new DeliveryRejected("definite rejection");
    };
    expect(
      await call(client, "send_message", { session_id: sid, text: "rejected" }),
    ).toEqual({ status: "failed" });
    runtime.sendOverride = async () => {
      throw new Error(`fixture lost receipt ${internalToken}`);
    };
    expect(
      await call(client, "send_message", {
        session_id: sid,
        text: "uncertain",
      }),
    ).toEqual({ status: "unknown" });
    expect(runtime.inputs.filter((i) => i.text === "uncertain")).toHaveLength(
      1,
    );
    expect(
      await call(client, "send_message", {
        session_id: sid,
        text: "D".repeat(1990) + bob,
      }),
    ).toEqual({ status: "unknown" });
    const deliveries = await call(client, "list_deliveries", {
      session_id: sid,
    });
    expect(
      deliveries.deliveries.some(
        (d: { text: string; status: string }) =>
          d.text === "uncertain" && d.status === "uncertain",
      ),
    ).toBe(true);
    expect(JSON.stringify(deliveries)).not.toContain(internalToken);
    expect(JSON.stringify(deliveries)).not.toContain(bob);
    const secretDelivery = deliveries.deliveries.find((d: { text: string }) =>
      d.text.startsWith("D".repeat(100)),
    );
    expect(secretDelivery.text).not.toContain("grove_ext_");
    expect(
      JSON.stringify(
        await call(client, "read_delivery", {
          session_id: sid,
          delivery_id: secretDelivery.id,
        }),
      ),
    ).not.toContain(bob);
    runtime.sendOverride = undefined;
    await Promise.all([
      call(client, "send_message", { session_id: sid, text: "same" }),
      call(other, "send_message", { session_id: sid, text: "same" }),
    ]);
    expect(runtime.inputs.filter((i) => i.text === "same")).toHaveLength(2);
    const thread = app.detail(raw).threadId!;
    const liveText = "L".repeat(300_000);
    const liveTurn = app.detail(raw).turnId!;
    runtime.emit(raw, {
      type: "item",
      turnId: liveTurn,
      item: { id: "live-only", type: "agentMessage", text: liveText },
    });
    runtime.historyItems.set(
      thread,
      runtime.historyItems.get(thread)!.filter((m) => m.id !== "live-only"),
    );
    const livePage = await call(client, "read_messages", { session_id: sid });
    expect(
      livePage.messages.find((m: { id: string }) => m.id === "live-only")
        .bodyRef,
    ).toBe("live-only");
    let liveBody = "";
    let offset: number | null = 0;
    do {
      const chunk = await call(client, "read_message_body", {
        session_id: sid,
        body_ref: "live-only",
        offset,
      });
      liveBody += chunk.text;
      offset = chunk.nextOffset;
    } while (offset !== null);
    expect(liveBody).toBe(liveText);
    runtime.historyItems.get(thread)!.push({
      id: "live-only",
      role: "assistant",
      text: liveText,
      at: Date.now(),
    });
    runtime.emit(raw, {
      type: "item",
      turnId: liveTurn,
      item: { id: "evict", type: "agentMessage", text: "Y".repeat(2_000_000) },
    });
    expect(app.liveMessageBody(raw, "live-only")).toBe(liveText);
    // The history page has the same item but its 1 MiB threshold does not clip it.
    const liveAfterHistory = await call(client, "read_message_body", {
      session_id: sid,
      body_ref: "live-only",
    });
    expect(liveAfterHistory.text).toBe(liveText.slice(0, 65536));
    const overflowText = "Z".repeat(2_200_000);
    runtime.emit(raw, {
      type: "item",
      turnId: liveTurn,
      item: {
        id: "too-large",
        type: "agentMessage",
        text: overflowText,
      },
    });
    runtime.historyItems.set(
      thread,
      runtime.historyItems.get(thread)!.filter((m) => m.id !== "too-large"),
    );
    const boundedLive = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      boundedLive.messages.find((m: { id: string }) => m.id === "too-large"),
    ).toMatchObject({ bodyUnavailable: true });
    expect(
      boundedLive.messages.find((m: { id: string }) => m.id === "too-large")
        .bodyRef,
    ).toBeUndefined();
    const beforeNativeFallback = runtime.historyItems.get(thread)!;
    runtime.historyItems.set(thread, [
      { id: "too-large", role: "assistant", text: overflowText, at: 1 },
      ...beforeNativeFallback,
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `native-filler-${i}`,
        role: "assistant" as const,
        text: "filler",
        at: i + 2,
      })),
    ]);
    const fallbackListing = await call(client, "read_messages", {
      session_id: sid,
    });
    expect(
      fallbackListing.messages.find((m: { id: string }) => m.id === "too-large")
        .bodyRef,
    ).toBe("too-large");
    expect(
      (
        await call(client, "read_message_body", {
          session_id: sid,
          body_ref: "too-large",
        })
      ).text,
    ).toBe(overflowText.slice(0, 65536));
    runtime.historyItems.set(thread, beforeNativeFallback);
    for (let i = 0; i < 101; i++)
      runtime.emit(raw, {
        type: "item",
        turnId: liveTurn,
        item: { id: `eviction-${i}`, type: "agentMessage", text: "small" },
      });
    runtime.historyItems.set(
      thread,
      runtime.historyItems
        .get(thread)!
        .filter((m) => !m.id.startsWith("eviction-")),
    );
    expect(app.detail(raw).messages.some((m) => m.id === "live-only")).toBe(
      false,
    );
    runtime.emit(raw, {
      type: "item",
      turnId: liveTurn,
      item: { id: "reclaimed", type: "agentMessage", text: liveText },
    });
    expect(app.liveMessageBody(raw, "reclaimed")).toBe(liveText);
    const historyOnlyBody = await call(client, "read_message_body", {
      session_id: sid,
      body_ref: "live-only",
    });
    expect(historyOnlyBody.text).toBe(liveText.slice(0, 65536));
    runtime.historyItems.set(
      thread,
      Array.from({ length: 65 }, (_, i) => ({
        id: `m${i}`,
        role: "assistant" as const,
        text: `message ${i}`,
        at: i,
      })),
    );
    const newest = await call(client, "read_messages", { session_id: sid });
    const older = await call(client, "read_messages", {
      session_id: sid,
      cursor: newest.nextCursor,
    });
    expect(newest.messages[0].id).toBe("m35");
    expect(older.messages.at(-1).id).toBe("m34");
    runtime.historyItems.set(thread, [
      {
        id: "large",
        role: "assistant",
        kind: "progress",
        text:
          "X".repeat(65_528) + alice + internalToken + "X".repeat(1_100_000),
        at: 1,
      },
    ]);
    const large = await call(client, "read_messages", { session_id: sid });
    expect(large.messages[0].bodyRef).toBe("large");
    const body = await call(client, "read_message_body", {
      session_id: sid,
      body_ref: "large",
    });
    expect(body.text.length).toBe(65536);
    expect(body.nextOffset).toBe(65536);
    const nextBody = await call(client, "read_message_body", {
      session_id: sid,
      body_ref: "large",
      offset: body.nextOffset,
    });
    expect(body.text + nextBody.text).not.toContain(internalToken);
    expect(body.text + nextBody.text).not.toContain(alice);
    expect(body.text + nextBody.text).toContain("[redacted]");
    let dropped = false;
    const lostClient = new Client({ name: "drop-test", version: "1" });
    await lostClient.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/external-mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${bob}` } },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (
            !dropped &&
            typeof init?.body === "string" &&
            init.body.includes("lost-response")
          ) {
            dropped = true;
            await response.text();
            throw new Error("fixture dropped response");
          }
          return response;
        },
      }),
    );
    clients.push(lostClient);
    await expect(
      lostClient.callTool({
        name: "send_message",
        arguments: { session_id: sid, text: "lost-response" },
      }),
    ).rejects.toThrow();
    expect(dropped).toBe(true);
    expect(
      runtime.inputs.filter((item) => item.text === "lost-response"),
    ).toHaveLength(1);
    const rotated = (
      (await (await browser("POST", "alice")).json()) as { token: string }
    ).token;
    expect(rotated).not.toBe(alice);
    await expect(client.listTools()).rejects.toThrow();
    runtime.historyItems.get(thread)!.push({
      id: "old-token",
      role: "assistant",
      text: `old ${alice}`,
      at: Date.now(),
    });
    const oldTokenMessages = JSON.stringify(
      await call(other, "read_messages", { session_id: sid }),
    );
    expect(oldTokenMessages).not.toContain(alice);
    expect(oldTokenMessages).toContain("old [redacted]");
    expect((await call(other, "list_sessions")).sessions.length).toBe(5);
    const enqueue = service.enqueueFollowUp.bind(service);
    const lostQueue = spyOn(service, "enqueueFollowUp").mockImplementation(
      async (...args) => {
        await enqueue(...args);
        throw new Error("fixture lost queue receipt");
      },
    );
    expect(
      await outcome(
        "queue_message",
        { session_id: sid, text: "unknown-queue" },
        other,
      ),
    ).toMatchObject({ status: "unknown" });
    expect(lostQueue).toHaveBeenCalledTimes(1);
    lostQueue.mockRestore();
    expect(
      (
        await call(other, "list_deliveries", { session_id: sid })
      ).followUps.filter(
        (item: { text: string }) => item.text === "unknown-queue",
      ),
    ).toHaveLength(1);
    // Fill the durable follow-up queue while the Orc is still working.
    for (let i = 2; i < 50; i++)
      await app.enqueueFollowUp(
        raw,
        `queued-${i}`,
        `fill-${i}`,
        undefined,
        "bob",
      );
    const beforeRejectedQueue = runtime.inputs.length;
    const rejectedQueue = await outcome(
      "queue_message",
      { session_id: sid, text: "queue-full" },
      other,
    );
    expect(rejectedQueue).toMatchObject({ status: "failed" });
    expect(runtime.inputs.length).toBe(beforeRejectedQueue);
    const replacement = await connect(rotated);
    expect((await browser("DELETE", "alice")).status).toBe(200);
    await expect(replacement.listTools()).rejects.toThrow();
    runtime.historyItems.get(thread)!.push({
      id: "revoked-token",
      role: "assistant",
      text: `revoked ${rotated}`,
      at: Date.now(),
    });
    const revokedMessages = JSON.stringify(
      await call(other, "read_messages", { session_id: sid }),
    );
    expect(revokedMessages).not.toContain(rotated);
    expect(revokedMessages).toContain("revoked [redacted]");
    expect((await browser("GET", "alice")).status).toBe(200);
    expect(await (await browser("GET", "alice")).json()).toEqual({
      active: false,
    });
    expect((await call(other, "list_sessions")).sessions.length).toBe(5);
    // Arm the storage fault only after the fake native runtime has accepted
    // and recorded the input. This is a fresh external single-call operation.
    const handle = (
      app as unknown as {
        handles: Map<string, import("./runtime").RuntimeHandle>;
      }
    ).handles.get(raw)!;
    const nativeSend = handle.send.bind(handle);
    const flush = spyOn(app.store, "flush");
    const send = spyOn(handle, "send").mockImplementation(async (...args) => {
      const result = await nativeSend(...args);
      flush.mockImplementation(() => {
        throw new Error("fixture storage failure after native admission");
      });
      return result;
    });
    const postNative = await outcome(
      "send_message",
      { session_id: sid, text: "accepted-before-save-failure" },
      other,
    );
    expect(postNative).toMatchObject({ status: "unknown" });
    expect(
      runtime.inputs.filter(
        (item) => item.text === "accepted-before-save-failure",
      ),
    ).toHaveLength(1);
    expect(
      runtime.historyItems
        .get(thread)!
        .filter((item) => item.text === "accepted-before-save-failure"),
    ).toHaveLength(1);
    expect(
      await outcome(
        "send_message",
        { session_id: sid, text: "storage-stopped" },
        other,
      ),
    ).toMatchObject({ status: "failed" });
    expect(
      runtime.inputs.filter((item) => item.text === "storage-stopped"),
    ).toHaveLength(0);
    send.mockRestore();
    flush.mockRestore();
    (app as unknown as { writeFailure: unknown }).writeFailure = undefined;
    app.store.sqlite.exec(
      "CREATE TRIGGER reject_external_fence BEFORE INSERT ON submission_fences BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    expect(
      await outcome(
        "send_message",
        { session_id: sid, text: "fence-failure" },
        other,
      ),
    ).toMatchObject({ status: "unknown" });
    expect(
      runtime.inputs.filter((item) => item.text === "fence-failure"),
    ).toHaveLength(0);
    expect(
      await outcome(
        "send_message",
        { session_id: sid, text: "already-broken" },
        other,
      ),
    ).toMatchObject({ status: "failed" });
    expect(
      await outcome(
        "queue_message",
        { session_id: sid, text: "already-broken" },
        other,
      ),
    ).toMatchObject({ status: "failed" });
    expect(
      runtime.inputs.filter((item) => item.text === "already-broken"),
    ).toHaveLength(0);
  } finally {
    for (const client of clients) await client.close();
    session.mockRestore();
    active.mockRestore();
    listener.stop(true);
    auth.close();
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("token management requires a real authenticated browser session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "external-mcp-browser-"));
  const origin = "http://localhost:3082";
  const app = new Workspace({
    directory: dir,
    runtime: new FakeRuntime(),
    projects: async () => fixtureProjects,
  });
  const service = new HostService(app, {
    directory: dir,
    origin: () => origin,
  });
  const auth = new GroveAuth(app.store, dir, origin);
  const handle = createHandler(app, { service, auth, origin: () => origin });
  const client = new Client({ name: "recovery-test", version: "1" });
  const cookie = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .find((s) => s.startsWith(name + "="))!
      .split(";")[0]!;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookies = "",
  ) =>
    handle(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          cookie: cookies,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  try {
    const pair = await request("/api/auth/pair", "POST", {
      code: auth.issue("bootstrap").code,
      nickname: "Alice",
    });
    const pairCookie = cookie(pair, "grove_pair");
    const options = await request(
      "/api/auth/passkey/generate-register-options",
      "GET",
      undefined,
      pairCookie,
    );
    const challenge = ((await options.clone().json()) as { challenge: string })
      .challenge;
    const registered = await request(
      "/api/auth/passkey/verify-registration",
      "POST",
      {
        createSession: true,
        response: authenticator(origin).register(challenge),
      },
      `${pairCookie}; ${cookie(options, "better-auth.better-auth-passkey")}`,
    );
    expect(registered.status).toBe(200);
    const session = cookie(registered, "better-auth.session_token");
    expect((await request("/api/external-mcp/token", "POST")).status).toBe(401);
    const generated = await request(
      "/api/external-mcp/token",
      "POST",
      undefined,
      session,
    );
    expect(generated.status).toBe(200);
    const token = ((await generated.json()) as { token: string }).token;
    expect(auth.externalTokenUser(token)?.name).toBe("Alice");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/external-mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) => handle(new Request(input, init)),
      }),
    );
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(
      await (
        await request("/api/external-mcp/token", "GET", undefined, session)
      ).json(),
    ).toEqual({ active: true });
    expect(
      (
        await handle(
          new Request(origin + "/api/external-mcp/token", {
            method: "DELETE",
            headers: { origin: "https://attacker.invalid", cookie: session },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/auth/sign-out", "POST", {}, session)).status,
    ).toBe(200);
    expect(
      (await request("/api/external-mcp/token", "DELETE", undefined, session))
        .status,
    ).toBe(401);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const recoveryPair = await request("/api/auth/pair", "POST", {
      code: auth.issue("recovery", auth.users()[0]!.id).code,
    });
    const recoveryCookie = cookie(recoveryPair, "grove_pair");
    const recoveryOptions = await request(
      "/api/auth/passkey/generate-register-options",
      "GET",
      undefined,
      recoveryCookie,
    );
    const recoveryChallenge = (
      (await recoveryOptions.clone().json()) as { challenge: string }
    ).challenge;
    const recovered = await request(
      "/api/auth/passkey/verify-registration",
      "POST",
      {
        createSession: true,
        response: authenticator(origin).register(recoveryChallenge),
      },
      `${recoveryCookie}; ${cookie(recoveryOptions, "better-auth.better-auth-passkey")}`,
    );
    expect(recovered.status).toBe(200);
    await expect(client.listTools()).rejects.toThrow();
    const recoveredSession = cookie(recovered, "better-auth.session_token");
    const started = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const realSession = auth.session.bind(auth);
    const delayed = spyOn(auth, "session").mockImplementation(
      async (headers) => {
        const result = await realSession(headers);
        if (headers.has("x-fixture-delay")) {
          started.resolve();
          await resume.promise;
        }
        return result;
      },
    );
    try {
      const pending = handle(
        new Request(origin + "/api/external-mcp/token", {
          method: "POST",
          headers: { origin, cookie: recoveredSession, "x-fixture-delay": "1" },
        }),
      );
      await started.promise;
      const again = await request("/api/auth/pair", "POST", {
        code: auth.issue("recovery", auth.users()[0]!.id).code,
      });
      const againCookie = cookie(again, "grove_pair");
      const againOptions = await request(
        "/api/auth/passkey/generate-register-options",
        "GET",
        undefined,
        againCookie,
      );
      const againChallenge = (
        (await againOptions.clone().json()) as { challenge: string }
      ).challenge;
      const againResult = await request(
        "/api/auth/passkey/verify-registration",
        "POST",
        {
          createSession: true,
          response: authenticator(origin).register(againChallenge),
        },
        `${againCookie}; ${cookie(againOptions, "better-auth.better-auth-passkey")}`,
      );
      expect(againResult.status).toBe(200);
      resume.resolve();
      expect((await pending).status).toBe(401);
      expect(
        app.store.sqlite.query("SELECT user_id FROM external_mcp_tokens").all(),
      ).toHaveLength(0);
    } finally {
      resume.resolve();
      delayed.mockRestore();
    }
  } finally {
    await client.close();
    auth.close();
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SDK reads preserve late Pi kind and the default live-body budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "external-mcp-pi-"));
  const runtime = new FakeRuntime();
  runtime.models = async () => [
    {
      backend: "pi",
      provider: "fixture",
      id: "fake",
      name: "Fake",
      efforts: ["off"],
      defaultEffort: "off",
      isDefault: true,
      fastTier: null,
    },
  ];
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, {
    directory: dir,
    origin: () => origin,
  });
  const options: Parameters<typeof servePeer>[1] = {
    service,
    origin: () => origin,
    hostname: "127.0.0.1",
    port: 0,
  };
  const listener = servePeer(app, options);
  origin = `http://127.0.0.1:${listener.port}`;
  const auth = new GroveAuth(app.store, dir, origin);
  options.auth = auth;
  app.store.sqlite
    .query(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, color) VALUES ('test', 'Test', 'test@example.test', 0, '2026-01-01', '2026-01-01', '#123456')",
    )
    .run();
  app.store.sqlite
    .query(
      "INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES ('test-session', 'fixture-session', 'test', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .run();
  const token = (
    auth.manageExternalToken(
      {
        user: auth.user("test")!,
        sessionId: "test-session",
        expiresAt: Date.now() + 10000,
      },
      "POST",
    ) as { token: string }
  ).token;
  const client = new Client({ name: "pi-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/external-mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const agent = await app.createOrc("alpha", {
      fast: false,
      orc: { backend: "pi", provider: "fixture", model: "fake", effort: "off" },
    });
    await app.send(agent.id, "start", "start");
    const sessionId = `${service.identity.id}:${agent.id}`;
    const turnId = app.detail(agent.id).turnId!;
    const thread = app.detail(agent.id).threadId!;
    const emit = (id: string, kind?: "progress") =>
      runtime.emit(agent.id, {
        type: "item",
        turnId,
        item: { id, type: "agentMessage", text: id, kind },
      });
    emit("during");
    emit("known");
    runtime.historyItems.set(thread, [
      { id: "first", role: "assistant", text: "first", at: 300 },
      { id: "during", role: "assistant", text: "during", at: 100 },
      {
        id: "known",
        role: "assistant",
        text: "known",
        kind: "result",
        at: 200,
      },
      { id: "unknown", role: "assistant", text: "unknown", at: 400 },
    ]);
    const gate = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>();
    const history = runtime.historyMessages.bind(runtime);
    runtime.historyMessages = async (id, cursor) => {
      const page = structuredClone(await history(id, cursor));
      started.resolve();
      await gate.promise;
      return page;
    };
    const pending = client.callTool({
      name: "read_messages",
      arguments: { session_id: sessionId },
    });
    await started.promise;
    emit("during", "progress");
    gate.resolve();
    const response = await pending;
    expect(response.isError).not.toBe(true);
    const page = JSON.parse((response.content as { text: string }[])[0]!.text);
    expect(
      page.messages
        .filter((m: { id: string }) =>
          ["first", "during", "known", "unknown"].includes(m.id),
        )
        .map((m: { id: string }) => m.id),
    ).toEqual(["first", "during", "known", "unknown"]);
    expect(
      page.messages.find((m: { id: string }) => m.id === "during").kind,
    ).toBe("progress");
    expect(
      page.messages.find((m: { id: string }) => m.id === "known").kind,
    ).toBe("result");
    expect(
      page.messages.find((m: { id: string }) => m.id === "unknown").kind,
    ).toBeUndefined();
    runtime.historyMessages = history;
    const privateState = app as unknown as { disposed: boolean };
    privateState.disposed = true;
    try {
      const count = runtime.inputs.length;
      for (const name of ["send_message", "queue_message"]) {
        const result = await client.callTool({
          name,
          arguments: { session_id: sessionId, text: "stopped" },
        });
        expect(result.isError).toBe(true);
        expect(
          JSON.parse((result.content as { text: string }[])[0]!.text).status,
        ).toBe("failed");
      }
      expect(runtime.inputs.length).toBe(count);
    } finally {
      privateState.disposed = false;
    }
    expect(LIVE_BODY_LIMIT_BYTES).toBe(128 * 1024 * 1024);
    const large = "P".repeat(2_200_000);
    runtime.emit(agent.id, {
      type: "item",
      turnId,
      item: { id: "default-large", type: "agentMessage", text: large },
    });
    runtime.historyItems.set(
      thread,
      runtime.historyItems.get(thread)!.filter((m) => m.id !== "default-large"),
    );
    const read = await client.callTool({
      name: "read_messages",
      arguments: { session_id: sessionId },
    });
    const listing = JSON.parse((read.content as { text: string }[])[0]!.text);
    expect(
      listing.messages.find((m: { id: string }) => m.id === "default-large")
        .bodyRef,
    ).toBe("default-large");
    const body = await client.callTool({
      name: "read_message_body",
      arguments: { session_id: sessionId, body_ref: "default-large" },
    });
    expect(JSON.parse((body.content as { text: string }[])[0]!.text).text).toBe(
      large.slice(0, 65536),
    );
  } finally {
    await client.close();
    listener.stop(true);
    auth.close();
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded live-body memory is shared and released with its session and workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "external-mcp-cache-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
    liveBodyLimitBytes: 650_000,
  });
  try {
    const one = await app.createOrc("alpha"),
      two = await app.createOrc("beta");
    await app.send(one.id, "start", "one");
    await app.send(two.id, "start", "two");
    const firstTurn = app.detail(one.id).turnId!,
      secondTurn = app.detail(two.id).turnId!;
    const body = "B".repeat(300_000);
    runtime.emit(one.id, {
      type: "item",
      turnId: firstTurn,
      item: { id: "first-large", type: "agentMessage", text: body },
    });
    runtime.emit(two.id, {
      type: "item",
      turnId: secondTurn,
      item: { id: "second-large", type: "agentMessage", text: body },
    });
    expect(app.liveMessageBody(one.id, "first-large")).toBe(body);
    expect(app.liveMessageBody(two.id, "second-large")).toBeUndefined();
    const snapshots = Array.from({ length: 101 }, (_, index) => {
      const id = `watch-${index}`;
      return {
        id,
        clientId: id,
        provisional: true,
        role: "user" as const,
        text: "",
        at: index,
        delivery: {
          id,
          text: "",
          source: "worker" as const,
          status: "sent" as const,
          questionIds: [],
          at: index,
        },
      };
    });
    const registry = (app as unknown as { provisionalWatches: Set<unknown> })
      .provisionalWatches;
    const controller = new AbortController();
    const aborted = app.watchProvisional(one.id, snapshots, controller.signal);
    expect(aborted.operations.size).toBe(100);
    expect(aborted.operations.has("watch-0")).toBe(false);
    expect(registry.size).toBe(1);
    controller.abort();
    expect(aborted.invalidated).toBe(true);
    expect(registry.size).toBe(0);
    aborted.stop();
    const closing = app.watchProvisional(
      one.id,
      snapshots,
      new AbortController().signal,
    );
    const disposing = app.watchProvisional(
      two.id,
      snapshots,
      new AbortController().signal,
    );
    expect(registry.size).toBe(2);
    runtime.emit(one.id, {
      type: "completed",
      turnId: firstTurn,
      status: "completed",
    });
    await app.closeTree(one.id);
    expect(closing.invalidated).toBe(true);
    expect(disposing.invalidated).toBe(false);
    expect(registry.size).toBe(1);
    runtime.emit(two.id, {
      type: "item",
      turnId: secondTurn,
      item: { id: "after-close", type: "agentMessage", text: body },
    });
    expect(app.liveMessageBody(two.id, "after-close")).toBe(body);
    app.dispose();
    expect(disposing.invalidated).toBe(true);
    expect(registry.size).toBe(0);
    expect(
      (app as unknown as { liveBodies: Map<string, unknown> }).liveBodies.size,
    ).toBe(0);
  } finally {
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
