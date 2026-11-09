import { test, expect, spyOn } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroveAuth } from "./auth";
import { WorkspaceStore } from "./workspace-store";
import { authenticator } from "./synthetic-auth";

const origin = "http://localhost:3082";
const cookie = (r: Response, name: string) => {
  const value = r.headers.getSetCookie().find((s) => s.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing cookie ${name}: ${r.status}`);
  return value.split(";")[0]!;
};
test("synthetic passkeys preserve other users, consume invitations and roll back failed recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-auth-test-"));
  const store = new WorkspaceStore(join(dir, "workspace.sqlite"));
  const auth = new GroveAuth(store, dir, origin);
  const call = (path: string, body?: unknown, cookies: string[] = []) =>
    auth.handle(
      new Request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          cookie: cookies.join("; "),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const pair = async (code: string, nickname?: string) => {
    const response = await call("/api/auth/pair", { code, nickname });
    expect(response.status).toBe(200);
    return cookie(response, "grove_pair");
  };
  const register = async (
    pairCookie: string,
    badOrigin = false,
    device = authenticator(origin),
    createSession: boolean | null = true,
  ) => {
    const options = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [pairCookie],
    );
    expect(options.status).toBe(200);
    const { challenge } = (await options.clone().json()) as {
      challenge: string;
    };
    return call(
      "/api/auth/passkey/verify-registration",
      {
        ...(createSession === null ? {} : { createSession }),
        response: device.register(
          challenge,
          badOrigin ? "https://attacker.example" : origin,
        ),
      },
      [pairCookie, cookie(options, "better-auth.better-auth-passkey")],
    );
  };
  try {
    const code = auth.issue("bootstrap").code;
    const device = authenticator(origin);
    const bootstrapCookie = await pair(code, "Alice");
    expect((await register(bootstrapCookie, false, device, false)).status).toBe(
      400,
    );
    expect((await register(bootstrapCookie, false, device, null)).status).toBe(
      400,
    );
    expect(auth.users()).toHaveLength(0);
    const first = await register(bootstrapCookie, false, device);
    expect(first.status).toBe(200);
    const alice = cookie(first, "better-auth.session_token");
    expect(
      (await call("/api/auth/pair", { code, nickname: "Alice" })).status,
    ).toBe(401);
    const loginOptions = await call(
      "/api/auth/passkey/generate-authenticate-options",
    );
    const loginChallenge = (
      (await loginOptions.clone().json()) as { challenge: string }
    ).challenge;
    const login = await call(
      "/api/auth/passkey/verify-authentication",
      { response: device.login(loginChallenge) },
      [cookie(loginOptions, "better-auth.better-auth-passkey")],
    );
    expect(login.status).toBe(200);
    const aliceLogin = cookie(login, "better-auth.session_token");
    const additional = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [alice],
    );
    expect(additional.status).toBe(200);
    const additionalChallenge = (
      (await additional.clone().json()) as { challenge: string }
    ).challenge;
    const added = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: false,
        response: authenticator(origin).register(additionalChallenge),
      },
      [alice, cookie(additional, "better-auth.better-auth-passkey")],
    );
    expect(added.status).toBe(200);
    const expiry = auth.issue("invite");
    store.sqlite
      .query("UPDATE authPairing SET expiresAt = ? WHERE kind = ?")
      .run(new Date(0).toISOString(), "invite");
    expect(
      (await call("/api/auth/pair", { code: expiry.code, nickname: "Expired" }))
        .status,
    ).toBe(401);
    const invitation = await call("/api/auth/invitations", {}, [alice]);
    expect(invitation.status).toBe(200);
    const inviteCode = ((await invitation.json()) as { code: string }).code;
    const bobPairCookie = await pair(inviteCode, "Bob");
    expect(
      (await register(bobPairCookie, false, authenticator(origin), false))
        .status,
    ).toBe(400);
    expect(auth.users()).toHaveLength(1);
    const second = await register(bobPairCookie);
    expect(second.status).toBe(200);
    const bob = cookie(second, "better-auth.session_token");
    const users = auth.users();
    expect(users.map((u) => u.name)).toEqual(["Alice", "Bob"]);
    expect(users[0]!.color).not.toBe(users[1]!.color);
    const wrongUserOptions = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [alice],
    );
    const wrongUserChallenge = (
      (await wrongUserOptions.clone().json()) as { challenge: string }
    ).challenge;
    const passkeysBefore = (
      store.sqlite.query("SELECT COUNT(*) AS n FROM passkey").get() as {
        n: number;
      }
    ).n;
    const wrongUser = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: false,
        response: authenticator(origin).register(wrongUserChallenge),
      },
      [bob, cookie(wrongUserOptions, "better-auth.better-auth-passkey")],
    );
    expect(wrongUser.status).not.toBe(200);
    expect(
      (
        store.sqlite.query("SELECT COUNT(*) AS n FROM passkey").get() as {
          n: number;
        }
      ).n,
    ).toBe(passkeysBefore);
    const recovery = auth.issue("recovery", users[0]!.id).code;
    const recoveryCookie = await pair(recovery);
    const revocations: string[] = [];
    const offRevoke = auth.onRevoke((userId) => revocations.push(userId));
    const activeOptions = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [alice, recoveryCookie],
    );
    const activeChallenge = (
      (await activeOptions.clone().json()) as { challenge: string }
    ).challenge;
    const activeAdded = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: false,
        response: authenticator(origin).register(activeChallenge),
      },
      [
        alice,
        recoveryCookie,
        cookie(activeOptions, "better-auth.better-auth-passkey"),
      ],
    );
    expect(activeAdded.status).toBe(200);
    expect(revocations).toEqual([]);
    expect(
      (await register(recoveryCookie, false, authenticator(origin), false))
        .status,
    ).toBe(400);
    expect(
      (await auth.session(new Headers({ cookie: alice })))?.user.name,
    ).toBe("Alice");
    expect((await register(recoveryCookie, true)).status).not.toBe(200);
    expect(
      (await auth.session(new Headers({ cookie: alice })))?.user.name,
    ).toBe("Alice");
    store.sqlite.exec(
      "CREATE TRIGGER fail_passkey BEFORE INSERT ON passkey BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    expect((await register(recoveryCookie)).status).not.toBe(200);
    expect(
      (await auth.session(new Headers({ cookie: alice })))?.user.name,
    ).toBe("Alice");
    store.sqlite.exec("DROP TRIGGER fail_passkey");
    const recovered = await register(recoveryCookie);
    expect(recovered.status).toBe(200);
    expect(revocations).toEqual([users[0]!.id]);
    offRevoke();
    expect(await auth.session(new Headers({ cookie: alice }))).toBeNull();
    expect(await auth.session(new Headers({ cookie: aliceLogin }))).toBeNull();
    expect((await auth.session(new Headers({ cookie: bob })))?.user.name).toBe(
      "Bob",
    );
    expect((await call("/api/auth/pair", { code: recovery })).status).toBe(401);
  } finally {
    auth.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP and WebSocket require a session and sign-out closes only its connection", async () => {
  const { Workspace } = await import("./workspace");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const { HostService } = await import("./hosts");
  const { servePeer } = await import("./http");
  const { socketWithHeaders } = await import("./socket-testing");
  const { openGrove } = await import("../src/chord-client");
  const { fakeVoiceProvider } = await import("../tests/voice-fixture");
  const dir = mkdtempSync(join(tmpdir(), "grove-auth-http-"));
  const app = new Workspace({
    directory: dir,
    runtime: new FakeRuntime(),
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
  const provider = fakeVoiceProvider();
  const configDir = join(dir, "voice-config");
  mkdirSync(configDir);
  const configPath = join(configDir, "config.toml");
  writeFileSync(configPath, "");
  writeFileSync(join(configDir, "voice-api-key"), "test-only-key", {
    mode: 0o600,
  });
  options.voice = { configPath, connect: provider.connect };
  const server = servePeer(app, options);
  origin = `http://localhost:${server.port}`;
  const auth = new GroveAuth(app.store, dir, origin);
  options.auth = auth;
  const call = (path: string, body?: unknown, cookies: string[] = []) =>
    fetch(origin.replace("localhost", "127.0.0.1") + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        host: `localhost:${server.port}`,
        origin,
        cookie: cookies.join("; "),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    for (const path of [
      "/api/identity",
      "/api/socket",
      "/api/file-preview",
      "/api/read/messages",
      "/api/images/a/original",
      "/api/voice/capability",
      "/api/voice/stream",
      "/api/voice/settings",
    ])
      expect((await call(path)).status).toBe(401);
    expect((await call("/preview/random/test.html")).status).toBe(410);
    expect((await call("/api/mcp/info")).status).toBe(401);
    const issue = auth.issue("bootstrap");
    const paired = await call("/api/auth/pair", {
      code: issue.code,
      nickname: "Alice",
    });
    const pairCookie = cookie(paired, "grove_pair");
    const opts = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [pairCookie],
    );
    const challenge = ((await opts.clone().json()) as { challenge: string })
      .challenge;
    const firstDevice = authenticator(origin);
    const result = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: true,
        response: firstDevice.register(challenge),
      },
      [pairCookie, cookie(opts, "better-auth.better-auth-passkey")],
    );
    expect(result.status).toBe(200);
    const session = cookie(result, "better-auth.session_token");
    expect((await call("/api/identity", undefined, [session])).status).toBe(
      200,
    );
    const otherOptions = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [session],
    );
    const otherChallenge = (
      (await otherOptions.clone().json()) as { challenge: string }
    ).challenge;
    const otherRegistration = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: false,
        response: authenticator(origin).register(otherChallenge),
      },
      [session, cookie(otherOptions, "better-auth.better-auth-passkey")],
    );
    expect(otherRegistration.status).toBe(200);
    expect(
      otherRegistration.headers
        .getSetCookie()
        .some((v) => v.startsWith("better-auth.session_token=")),
    ).toBe(false);
    const loginOptions = await call(
      "/api/auth/passkey/generate-authenticate-options",
    );
    const loginChallenge = (
      (await loginOptions.clone().json()) as { challenge: string }
    ).challenge;
    const secondLogin = await call(
      "/api/auth/passkey/verify-authentication",
      { response: firstDevice.login(loginChallenge) },
      [cookie(loginOptions, "better-auth.better-auth-passkey")],
    );
    expect(secondLogin.status).toBe(200);
    const otherSession = cookie(secondLogin, "better-auth.session_token");
    const invite = await call("/api/auth/invitations", {}, [session]);
    const inviteCode = ((await invite.json()) as { code: string }).code;
    const bobPair = await call("/api/auth/pair", {
      code: inviteCode,
      nickname: "Bob",
    });
    const bobPairCookie = cookie(bobPair, "grove_pair");
    const bobOptions = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [bobPairCookie],
    );
    const bobChallenge = (
      (await bobOptions.clone().json()) as { challenge: string }
    ).challenge;
    const bobRegistration = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: true,
        response: authenticator(origin).register(bobChallenge),
      },
      [bobPairCookie, cookie(bobOptions, "better-auth.better-auth-passkey")],
    );
    expect(bobRegistration.status).toBe(200);
    const bobSession = cookie(bobRegistration, "better-auth.session_token");
    const bobSocket = socketWithHeaders(
      `ws://127.0.0.1:${server.port}/api/socket`,
      { Host: `localhost:${server.port}`, Origin: origin, Cookie: bobSession },
    );
    const bobClient = await openGrove(
      bobSocket,
      () => {},
      () => {},
    );
    const socket = socketWithHeaders(
      `ws://127.0.0.1:${server.port}/api/socket`,
      { Host: `localhost:${server.port}`, Origin: origin, Cookie: session },
    );
    const aliceClient = await openGrove(
      socket,
      () => {},
      () => {},
    );
    const otherSocket = socketWithHeaders(
      `ws://127.0.0.1:${server.port}/api/socket`,
      {
        Host: `localhost:${server.port}`,
        Origin: origin,
        Cookie: otherSession,
      },
    );
    await new Promise<void>((resolve, reject) => {
      otherSocket.onopen = () => resolve();
      otherSocket.onerror = () => reject(new Error("Second WebSocket failed"));
    });
    const voiceSocket = socketWithHeaders(
      `ws://127.0.0.1:${server.port}/api/voice/stream`,
      {
        Host: `localhost:${server.port}`,
        Origin: origin,
        Cookie: session,
        "Sec-WebSocket-Protocol": `grove-voice.v1, grove-peer.${service.identity.id}`,
      },
    );
    for (let i = 0; i < 100 && !provider.active; i++) await Bun.sleep(5);
    expect(provider.active).toBe(1);
    expect(provider.stats.endpoints[0]).toBe(
      "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    );
    expect(provider.stats.authorization[0]).toBe("Bearer test-only-key");
    const setting = (
      method: string,
      cookieValue: string,
      body?: unknown,
      requestOrigin = origin,
    ) =>
      fetch(origin.replace("localhost", "127.0.0.1") + "/api/voice/settings", {
        method,
        headers: {
          host: `localhost:${server.port}`,
          origin: requestOrigin,
          cookie: cookieValue,
          "x-grove-peer": service.identity.id,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const initialSettings = await setting("GET", session);
    expect(initialSettings.headers.get("cache-control")).toBe("no-store");
    expect(await initialSettings.json()).toEqual({
      region: "beijing",
      configured: true,
    });
    unlinkSync(join(configDir, "voice-api-key"));
    expect(await (await setting("GET", session)).json()).toEqual({
      region: "beijing",
      configured: false,
    });
    expect((await setting("POST", session, { region: "beijing" })).status).toBe(
      400,
    );
    writeFileSync(join(configDir, "voice-api-key"), "test-only-key", {
      mode: 0o600,
    });
    expect(
      (await setting("POST", session, { region: "singapore" })).status,
    ).toBe(400);
    expect(
      (await setting("POST", session, { region: "other", apiKey: "bad" }))
        .status,
    ).toBe(400);
    expect(
      (
        await setting("POST", session, {
          region: "singapore",
          apiKey: "two keys",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await setting(
          "POST",
          session,
          { region: "singapore", apiKey: "replacement" },
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    let saved: Response;
    try {
      saved = await setting("POST", session, {
        region: "singapore",
        apiKey: "singapore-synthetic",
      });
      expect(
        JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]),
      ).not.toContain("singapore-synthetic");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).not.toContain("singapore-synthetic");
    expect(JSON.parse(savedText)).toEqual({
      region: "singapore",
      configured: true,
    });
    expect(statSync(join(configDir, "voice-api-key")).mode & 0o777).toBe(0o600);
    expect(await (await setting("GET", bobSession)).json()).toEqual({
      region: "singapore",
      configured: true,
    });
    expect(
      (await setting("POST", bobSession, { region: "singapore", apiKey: "" }))
        .status,
    ).toBe(200);
    const secondVoice = socketWithHeaders(
      `ws://127.0.0.1:${server.port}/api/voice/stream`,
      {
        Host: `localhost:${server.port}`,
        Origin: origin,
        Cookie: bobSession,
        "Sec-WebSocket-Protocol": `grove-voice.v1, grove-peer.${service.identity.id}`,
      },
    );
    for (let i = 0; i < 100 && provider.active < 2; i++) await Bun.sleep(5);
    expect(provider.active).toBe(2);
    expect(provider.stats.endpoints[1]).toBe(
      "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference",
    );
    expect(provider.stats.authorization[1]).toBe("Bearer singapore-synthetic");
    expect(voiceSocket.readyState).toBe(WebSocket.OPEN);
    voiceSocket.send(new Uint8Array([1, 2]));
    for (let i = 0; i < 100 && !provider.stats.frames; i++) await Bun.sleep(5);
    expect(provider.stats.frames).toBe(1);
    secondVoice.close();
    chmodSync(configDir, 0o500);
    let writeFailed: Response;
    try {
      writeFailed = await setting("POST", session, {
        region: "beijing",
        apiKey: "write-fails",
      });
    } finally {
      chmodSync(configDir, 0o700);
    }
    expect(((await writeFailed.json()) as { code: string }).code).toBe(
      "key_save_failed",
    );
    expect(readFileSync(join(configDir, "voice-api-key"), "utf8")).toBe(
      "singapore-synthetic",
    );
    expect(await (await setting("GET", session)).json()).toEqual({
      region: "singapore",
      configured: true,
    });
    app.store.sqlite.exec(
      "CREATE TRIGGER fail_voice_region BEFORE UPDATE ON voice_settings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    const failureLog = spyOn(console, "error").mockImplementation(() => {});
    let partial: Response;
    try {
      partial = await setting("POST", session, {
        region: "beijing",
        apiKey: "beijing-synthetic",
      });
      expect(JSON.stringify(failureLog.mock.calls)).not.toContain(
        "beijing-synthetic",
      );
    } finally {
      failureLog.mockRestore();
    }
    expect(partial.status).toBe(500);
    const partialText = await partial.text();
    expect(JSON.parse(partialText).code).toBe("key_saved_region_failed");
    expect(partialText).not.toContain("beijing-synthetic");
    expect(readFileSync(join(configDir, "voice-api-key"), "utf8")).toBe(
      "beijing-synthetic",
    );
    expect(await (await setting("GET", session)).json()).toEqual({
      region: "singapore",
      configured: true,
    });
    app.store.sqlite.exec("DROP TRIGGER fail_voice_region");
    const concurrent = await Promise.all([
      setting("POST", session, {
        region: "beijing",
        apiKey: "parallel-beijing",
      }),
      setting("POST", bobSession, {
        region: "singapore",
        apiKey: "parallel-singapore",
      }),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const concurrentStatus = (await (await setting("GET", session)).json()) as {
      region: string;
    };
    expect(readFileSync(join(configDir, "voice-api-key"), "utf8")).toBe(
      concurrentStatus.region === "beijing"
        ? "parallel-beijing"
        : "parallel-singapore",
    );
    expect(
      (
        await setting("POST", session, {
          region: "beijing",
          apiKey: "beijing-synthetic",
        })
      ).status,
    ).toBe(200);
    const thirdVoice = socketWithHeaders(
      `ws://127.0.0.1:${server.port}/api/voice/stream`,
      {
        Host: `localhost:${server.port}`,
        Origin: origin,
        Cookie: bobSession,
        "Sec-WebSocket-Protocol": `grove-voice.v1, grove-peer.${service.identity.id}`,
      },
    );
    for (let i = 0; i < 100 && provider.stats.authorization.length < 3; i++)
      await Bun.sleep(5);
    expect(provider.stats.endpoints[2]).toBe(
      "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    );
    expect(provider.stats.authorization[2]).toBe("Bearer beijing-synthetic");
    thirdVoice.close();
    const orc = await app.createOrc("alpha");
    const agentToken = app.store.byId(orc.id)!.token;
    const agentInfo = await fetch(
      origin.replace("localhost", "127.0.0.1") + "/api/mcp/info",
      {
        headers: {
          host: `localhost:${server.port}`,
          authorization: `Bearer ${agentToken}`,
        },
      },
    );
    expect(agentInfo.status).toBe(200);
    expect(
      (
        await fetch(
          origin.replace("localhost", "127.0.0.1") + "/api/voice/settings",
          {
            headers: {
              host: `localhost:${server.port}`,
              origin,
              authorization: `Bearer ${agentToken}`,
              "x-grove-peer": service.identity.id,
            },
          },
        )
      ).status,
    ).toBe(401);
    const id = `${service.identity.id}:${orc.id}`;
    const [{ operationId: aliceOp }, { operationId: bobOp }] =
      await Promise.all([
        aliceClient.call<{ operationId: string }>("reserveSubmission", { id }),
        bobClient.call<{ operationId: string }>("reserveSubmission", { id }),
      ]);
    const { operationId: originalOp } = await aliceClient.call<{
      operationId: string;
    }>("reserveSubmission", { id });
    const envelope = { source: "user", text: "private retry" };
    expect(
      await aliceClient.call("finalizeSubmission", {
        id,
        operationId: originalOp,
        envelope,
      }),
    ).toMatchObject({ state: "rejected" });
    const retry = await aliceClient.call<{
      state: "won";
      operationId: string;
      claimToken: string;
    }>("reserveRetry", { id, operationId: originalOp });
    expect(retry.state).toBe("won");
    expect(
      await bobClient.call("inspectRetry", {
        id,
        operationId: originalOp,
        envelope,
      }),
    ).toBeNull();
    await expect(
      bobClient.call("reserveRetry", { id, operationId: originalOp }),
    ).rejects.toThrow("another user");
    await expect(
      bobClient.call("send", {
        id,
        operationId: retry.operationId,
        text: envelope.text,
        predecessor: envelope,
        claimToken: retry.claimToken,
      }),
    ).rejects.toThrow("another user");
    expect(
      await aliceClient.call("inspectRetry", {
        id,
        operationId: originalOp,
        envelope,
      }),
    ).toMatchObject({
      operationId: originalOp,
      supersededBy: retry.operationId,
    });
    expect(
      await aliceClient.call("finalizeSubmission", {
        id,
        operationId: retry.operationId,
        envelope,
        predecessor: envelope,
      }),
    ).toMatchObject({ state: "rejected" });
    await expect(
      bobClient.call("finalizeSubmission", {
        id,
        operationId: aliceOp,
        envelope: { source: "user", text: "Alice speaks" },
      }),
    ).rejects.toThrow("another user");
    await expect(
      bobClient.call("send", {
        id,
        operationId: aliceOp,
        text: "Alice speaks",
      }),
    ).rejects.toThrow("another user");
    await Promise.all([
      aliceClient.call("send", {
        id,
        text: "Alice speaks",
        operationId: aliceOp,
      }),
      bobClient.call("send", { id, text: "Bob speaks", operationId: bobOp }),
    ]);
    expect(
      app.detail(orc.id).messages.find((m) => m.clientId === aliceOp)?.author
        ?.name,
    ).toBe("Alice");
    expect(
      app.detail(orc.id).messages.find((m) => m.clientId === bobOp)?.author
        ?.name,
    ).toBe("Bob");
    expect((await call("/api/auth/sign-out", {}, [session])).status).toBe(200);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    for (let i = 0; i < 100 && provider.active; i++) await Bun.sleep(5);
    expect(voiceSocket.readyState).toBe(WebSocket.CLOSED);
    expect(provider.active).toBe(0);
    expect(otherSocket.readyState).toBe(WebSocket.OPEN);
    otherSocket.close();
    bobClient.close();
    aliceClient.close();
    expect((await call("/api/identity", undefined, [session])).status).toBe(
      401,
    );
  } finally {
    void server.stop(true);
    provider.stop();
    auth.close();
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authenticated connections receive the registered user list after registration and reconnect", async () => {
  const { Workspace } = await import("./workspace");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const { HostService } = await import("./hosts");
  const { servePeer } = await import("./http");
  const { socketWithHeaders } = await import("./socket-testing");
  const { openGrove } = await import("../src/chord-client");
  const dir = mkdtempSync(join(tmpdir(), "grove-auth-users-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
  });
  let base = "";
  const service = new HostService(app, { directory: dir, origin: () => base });
  const options: Parameters<typeof servePeer>[1] = {
    service,
    origin: () => base,
    hostname: "127.0.0.1",
    port: 0,
  };
  const server = servePeer(app, options);
  base = `http://localhost:${server.port}`;
  const auth = new GroveAuth(app.store, dir, base);
  options.auth = auth;
  const call = (path: string, body?: unknown, cookies: string[] = []) =>
    fetch(base.replace("localhost", "127.0.0.1") + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        host: `localhost:${server.port}`,
        origin: base,
        cookie: cookies.join("; "),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const register = async (code: string, nickname: string) => {
    const paired = await call("/api/auth/pair", { code, nickname });
    expect(paired.status).toBe(200);
    const pairCookie = cookie(paired, "grove_pair");
    const opts = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [pairCookie],
    );
    expect(opts.status).toBe(200);
    const { challenge } = (await opts.clone().json()) as { challenge: string };
    const response = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: true,
        response: authenticator(base).register(challenge),
      },
      [pairCookie, cookie(opts, "better-auth.better-auth-passkey")],
    );
    expect(response.status).toBe(200);
    return cookie(response, "better-auth.session_token");
  };
  const clients: Array<Awaited<ReturnType<typeof openGrove>>> = [];
  const connect = async (session: string) => {
    let current: import("../src/chord-contract").View | undefined;
    const socket = socketWithHeaders(
      `ws://127.0.0.1:${server.port}/api/socket`,
      {
        Host: `localhost:${server.port}`,
        Origin: base,
        Cookie: session,
      },
    );
    const client = await openGrove(
      socket,
      (view) => {
        current = view;
      },
      () => {},
    );
    clients.push(client);
    return {
      get view() {
        return current;
      },
      get users() {
        return current?.users;
      },
      client,
    };
  };
  const waitFor = async (ready: () => boolean) => {
    for (let i = 0; i < 200 && !ready(); i++) await Bun.sleep(5);
    expect(ready()).toBe(true);
  };
  let stopped = false;
  try {
    expect((await call("/api/socket")).status).toBe(401);
    expect((await call("/api/auth/users")).status).toBe(404);
    expect(
      (await call("/api/auth/profile", { name: "Intruder", color: "#a855f7" }))
        .status,
    ).toBe(401);
    const alice = await register(auth.issue("bootstrap").code, "Alice");
    const first = await connect(alice);
    const secondDevice = await connect(alice);
    await waitFor(
      () => first.users?.length === 1 && secondDevice.users?.length === 1,
    );
    const firstUser = first.users![0]!;
    expect(firstUser.name).toBe("Alice");
    expect(Object.keys(firstUser).sort()).toEqual(["color", "id", "name"]);
    const invitation = await call("/api/auth/invitations", {}, [alice]);
    const code = ((await invitation.json()) as { code: string }).code;
    const bob = await register(code, "Bob");
    await waitFor(
      () => first.users?.length === 2 && secondDevice.users?.length === 2,
    );
    expect(first.users!.map((user) => user.name)).toEqual(["Alice", "Bob"]);
    expect(
      first.users!.every(
        (user) => Object.keys(user).sort().join(",") === "color,id,name",
      ),
    ).toBe(true);
    const bobConnection = await connect(bob);
    await waitFor(() => bobConnection.users?.length === 2);
    expect(bobConnection.users).toEqual(first.users);
    const status = await call("/api/auth/status", undefined, [alice]);
    const statusBody = (await status.json()) as { colors: string[] };
    expect(statusBody.colors.length).toBeGreaterThan(1);
    const selectedColor = statusBody.colors[1]!;
    const orc = await app.createOrc("alpha");
    const id = `${service.identity.id}:${orc.id}`;
    const { operationId: profileOp } = await first.client.call<{
      operationId: string;
    }>("reserveSubmission", { id });
    await Promise.all([
      first.client.call("select", { ids: [id] }),
      secondDevice.client.call("select", { ids: [id] }),
      bobConnection.client.call("select", { ids: [id] }),
    ]);
    await first.client.call("send", {
      id,
      text: "old message",
      operationId: profileOp,
    });
    await waitFor(
      () =>
        first.view?.details[id]?.messages.some(
          (m) => m.clientId === profileOp,
        ) === true,
    );
    for (const body of [
      { name: "  ", color: selectedColor },
      { name: "x".repeat(81), color: selectedColor },
      { name: "Alice", color: "#000000" },
      { name: "Alice", color: selectedColor, id: bobConnection.users![1]!.id },
    ])
      expect((await call("/api/auth/profile", body, [alice])).status).toBe(400);
    const foreign = await fetch(
      base.replace("localhost", "127.0.0.1") + "/api/auth/profile",
      {
        method: "POST",
        headers: {
          host: `localhost:${server.port}`,
          origin: "https://attacker.example",
          cookie: alice,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Intruder", color: selectedColor }),
      },
    );
    expect(foreign.status).toBe(403);
    expect(
      (await auth.session(new Headers({ cookie: alice })))?.user.name,
    ).toBe("Alice");
    const updated = await call(
      "/api/auth/profile",
      { name: "  Alicia  ", color: selectedColor },
      [alice],
    );
    expect(updated.status).toBe(200);
    expect(updated.headers.get("cache-control")).toBe("no-store");
    const { user } = (await updated.json()) as {
      user: { id: string; name: string; color: string };
    };
    expect(user).toEqual({
      ...firstUser,
      name: "Alicia",
      color: selectedColor,
    });
    await waitFor(() =>
      [first, secondDevice, bobConnection].every((c) => {
        const detail = c.view?.details[id];
        return (
          c.users?.find((u) => u.id === user.id)?.name === "Alicia" &&
          detail?.messages.find((m) => m.clientId === profileOp)?.author
            ?.name === "Alicia" &&
          c.view?.snapshot.agents
            .find((a) => a.id === id)
            ?.participants?.some(
              (p) =>
                p.user.id === user.id &&
                p.user.name === "Alicia" &&
                p.user.color === selectedColor,
            ) === true
        );
      }),
    );
    expect(
      first.view?.details[id]?.messages.find((m) => m.clientId === profileOp)
        ?.author,
    ).toEqual(user);
    expect(
      first.view?.details[id]?.deliveries.find((d) => d.id === profileOp)
        ?.author,
    ).toEqual(user);
    expect(
      (await service.agentHistory(id)).messages.find(
        (m) => m.clientId === profileOp,
      )?.author,
    ).toEqual(user);
    expect((await auth.session(new Headers({ cookie: bob })))?.user.name).toBe(
      "Bob",
    );
    bobConnection.client.close();
    expect((await call("/api/auth/sign-out", {}, [bob])).status).toBe(200);
    expect(
      (
        await call("/api/auth/profile", { name: "Bob", color: selectedColor }, [
          bob,
        ])
      ).status,
    ).toBe(401);
    expect(first.users?.length).toBe(2);
    first.client.close();
    const reconnected = await connect(alice);
    await waitFor(() => reconnected.users?.length === 2);
    expect(reconnected.users).toEqual(secondDevice.users);
    for (const client of clients) client.close();
    await server.stop(true);
    auth.close();
    app.dispose();
    stopped = true;
    const restarted = new Workspace({
      directory: dir,
      runtime,
      projects: async () => fixtureProjects,
    });
    const restartedAuth = new GroveAuth(restarted.store, dir, base);
    try {
      expect(
        (await restartedAuth.session(new Headers({ cookie: alice })))?.user,
      ).toEqual(user);
      expect(
        restarted.store.participants(orc.id).find((p) => p.user.id === user.id)
          ?.user,
      ).toEqual(user);
      await restarted.synchronizeDetail(orc.id);
      expect(
        restarted.detail(orc.id).messages.find((m) => m.clientId === profileOp)
          ?.author,
      ).toEqual(user);
    } finally {
      restartedAuth.close();
      restarted.dispose();
    }
  } finally {
    if (!stopped) {
      for (const client of clients) client.close();
      void server.stop(true);
      auth.close();
      app.dispose();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adding a passkey keeps this browser session revocable without affecting independently signed-in sessions", async () => {
  const { Workspace } = await import("./workspace");
  const { FakeRuntime } = await import("./testing");
  const { HostService } = await import("./hosts");
  const { servePeer } = await import("./http");
  const { socketWithHeaders } = await import("./socket-testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-extra-passkey-"));
  writeFileSync(join(dir, "preview.html"), "<h1>fixture</h1>");
  const app = new Workspace({
    directory: dir,
    runtime: new FakeRuntime(),
    projects: async () => [{ alias: "test", name: "Test", path: dir }],
    branches: { read: async () => null },
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
  const server = servePeer(app, options);
  origin = `http://localhost:${server.port}`;
  const auth = new GroveAuth(app.store, dir, origin);
  options.auth = auth;
  const call = (
    path: string,
    body?: unknown,
    cookies: string[] = [],
    extra: Record<string, string> = {},
  ) => {
    const url = new URL(path, origin);
    return fetch(
      `http://127.0.0.1:${server.port}${url.pathname}${url.search}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: `localhost:${server.port}`,
          origin,
          cookie: cookies.join("; "),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  };
  let socket: WebSocket | undefined, independentSocket: WebSocket | undefined;
  try {
    const device = authenticator(origin);
    const paired = await call("/api/auth/pair", {
      code: auth.issue("bootstrap").code,
      nickname: "Alice",
    });
    const pairCookie = cookie(paired, "grove_pair");
    const options = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [pairCookie],
    );
    const challenge = ((await options.clone().json()) as { challenge: string })
      .challenge;
    const registration = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: true,
        response: device.register(challenge),
      },
      [pairCookie, cookie(options, "better-auth.better-auth-passkey")],
    );
    expect(registration.status).toBe(200);
    const originalCookie = cookie(registration, "better-auth.session_token");
    const loginOpts = await call(
      "/api/auth/passkey/generate-authenticate-options",
    );
    const loginChallenge = (
      (await loginOpts.clone().json()) as { challenge: string }
    ).challenge;
    const login = await call(
      "/api/auth/passkey/verify-authentication",
      {
        response: device.login(loginChallenge),
      },
      [cookie(loginOpts, "better-auth.better-auth-passkey")],
    );
    expect(login.status).toBe(200);
    const independentCookie = cookie(login, "better-auth.session_token");
    const originalSession = await auth.session(
      new Headers({ cookie: originalCookie }),
    );
    const independentSession = await auth.session(
      new Headers({ cookie: independentCookie }),
    );
    expect(independentSession?.sessionId).not.toBe(originalSession?.sessionId);
    const orc = await app.createOrc("test");
    const makeGrant = async (session: string) => {
      const response = await call(
        "/api/file-preview",
        {
          agent: `${service.identity.id}:${orc.id}`,
          href: "preview.html",
        },
        [session],
        { "X-Grove-Peer": service.identity.id },
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { url: string }).url;
    };
    const grant = await makeGrant(originalCookie);
    const independentGrant = await makeGrant(independentCookie);
    socket = socketWithHeaders(`ws://127.0.0.1:${server.port}/api/socket`, {
      Host: `localhost:${server.port}`,
      Origin: origin,
      Cookie: originalCookie,
    });
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error("Socket failed"));
    });
    independentSocket = socketWithHeaders(
      `ws://127.0.0.1:${server.port}/api/socket`,
      {
        Host: `localhost:${server.port}`,
        Origin: origin,
        Cookie: independentCookie,
      },
    );
    await new Promise<void>((resolve, reject) => {
      independentSocket!.onopen = () => resolve();
      independentSocket!.onerror = () =>
        reject(new Error("Independent socket failed"));
    });
    const extraOpts = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [originalCookie],
    );
    const extraChallenge = (
      (await extraOpts.clone().json()) as { challenge: string }
    ).challenge;
    const extraDevice = authenticator(origin);
    const webauthnCookie = cookie(extraOpts, "better-auth.better-auth-passkey");
    const credential = extraDevice.register(extraChallenge);
    const passkeysBefore = (
      app.store.sqlite.query("SELECT COUNT(*) AS n FROM passkey").get() as {
        n: number;
      }
    ).n;
    const sessionsBefore = (
      app.store.sqlite.query('SELECT COUNT(*) AS n FROM "session"').get() as {
        n: number;
      }
    ).n;
    const rejected = await call(
      "/api/auth/passkey/verify-registration",
      {
        createSession: true,
        response: credential,
      },
      [originalCookie, webauthnCookie],
    );
    expect(rejected.status).toBe(400);
    expect(
      (
        app.store.sqlite.query("SELECT COUNT(*) AS n FROM passkey").get() as {
          n: number;
        }
      ).n,
    ).toBe(passkeysBefore);
    expect(
      (
        app.store.sqlite.query('SELECT COUNT(*) AS n FROM "session"').get() as {
          n: number;
        }
      ).n,
    ).toBe(sessionsBefore);
    expect(
      (
        await call(
          "/api/auth/passkey/verify-registration",
          { response: credential },
          [webauthnCookie],
        )
      ).status,
    ).toBe(401);
    const added = await call(
      "/api/auth/passkey/verify-registration",
      {
        response: credential,
      },
      [originalCookie, webauthnCookie],
    );
    expect(added.status).toBe(200);
    expect(
      added.headers
        .getSetCookie()
        .some((v) => v.startsWith("better-auth.session_token=")),
    ).toBe(false);
    expect(
      (
        app.store.sqlite.query("SELECT COUNT(*) AS n FROM passkey").get() as {
          n: number;
        }
      ).n,
    ).toBe(passkeysBefore + 1);
    expect(
      (
        app.store.sqlite.query('SELECT COUNT(*) AS n FROM "session"').get() as {
          n: number;
        }
      ).n,
    ).toBe(sessionsBefore);
    expect(
      (await auth.session(new Headers({ cookie: originalCookie })))?.sessionId,
    ).toBe(originalSession?.sessionId);
    const staleOpts = await call(
      "/api/auth/passkey/generate-register-options",
      undefined,
      [originalCookie],
    );
    const staleChallenge = (
      (await staleOpts.clone().json()) as { challenge: string }
    ).challenge;
    expect(
      (await call("/api/auth/sign-out", {}, [originalCookie])).status,
    ).toBe(200);
    expect(
      (
        await call(
          "/api/auth/passkey/verify-registration",
          {
            response: authenticator(origin).register(staleChallenge),
          },
          [
            originalCookie,
            cookie(staleOpts, "better-auth.better-auth-passkey"),
          ],
        )
      ).status,
    ).toBe(401);
    for (let i = 0; i < 50 && socket.readyState !== WebSocket.CLOSED; i++)
      await Bun.sleep(5);
    const grantStatus = (await call(grant, undefined, [], { origin: "null" }))
      .status;
    const otherGrantStatus = (
      await call(independentGrant, undefined, [], { origin: "null" })
    ).status;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(independentSocket.readyState).toBe(WebSocket.OPEN);
    expect(grantStatus).toBe(410);
    expect(otherGrantStatus).toBe(200);
    expect(
      (await call("/api/identity", undefined, [independentCookie])).status,
    ).toBe(200);
    const extraLoginOpts = await call(
      "/api/auth/passkey/generate-authenticate-options",
    );
    const extraLoginChallenge = (
      (await extraLoginOpts.clone().json()) as { challenge: string }
    ).challenge;
    const extraLogin = await call(
      "/api/auth/passkey/verify-authentication",
      { response: extraDevice.login(extraLoginChallenge) },
      [cookie(extraLoginOpts, "better-auth.better-auth-passkey")],
    );
    expect(extraLogin.status).toBe(200);
    expect(
      (
        await auth.session(
          new Headers({
            cookie: cookie(extraLogin, "better-auth.session_token"),
          }),
        )
      )?.user.id,
    ).toBe(originalSession?.user.id);
  } finally {
    socket?.close();
    independentSocket?.close();
    void server.stop(true);
    auth.close();
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
