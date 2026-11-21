import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { servePeer } from "./http";
import { FakeRuntime, fixtureProjects } from "./testing";
import { openGrove } from "../src/chord-client";
import { socketWithHeaders } from "./socket-testing";
import { DeliveryRejected } from "./runtime";
import { envelopeHash, parseFence } from "./submission-admission";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-discard-http-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, { directory, origin: () => origin });
  const server = servePeer(app, {
    service,
    origin: () => origin,
    hostname: "127.0.0.1",
    port: 0,
  });
  origin = `http://127.0.0.1:${server.port}`;
  const socket = socketWithHeaders(
    origin.replace("http:", "ws:") + "/api/socket",
    { Origin: origin },
  );
  const client = await openGrove(
    socket,
    () => {},
    () => {},
  );
  const agent = await service.createOrc("alpha", {
    fast: false,
    orc: { model: "sol", effort: "medium" },
  });
  const headers = { Origin: origin, "X-Grove-Peer": service.identity.id };
  const url = (operation: string) =>
    `${origin}/api/attachments?agent=${encodeURIComponent(agent.id)}&operation=${operation}`;
  const begin = (
    operation: string,
    text: string,
    mode: "direct" | "follow_up",
    sizes: number[],
  ) =>
    fetch(url(operation), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        mode,
        attachments: sizes.map((bytes, index) => ({
          kind: "file",
          name: `${index}.dat`,
          bytes,
        })),
      }),
    });
  const discard = (operation: string, custom = headers) =>
    fetch(url(operation), { method: "DELETE", headers: custom });
  const put = (operation: string, index: number, body: BodyInit) =>
    fetch(
      `${origin}/api/attachments/${index}?agent=${encodeURIComponent(agent.id)}&operation=${operation}`,
      { method: "PUT", headers, body },
    );
  const complete = async (operation: string) => {
    const response = await fetch(
      `${origin}/api/attachments/complete?agent=${encodeURIComponent(agent.id)}&operation=${operation}`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      images: import("../src/contracts").MessageImage[];
      files: import("../src/contracts").MessageFile[];
    };
    return { images: result.images, files: result.files };
  };
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
    () => server.stop(true),
    () => client.close(),
  );
  return {
    directory,
    runtime,
    app,
    service,
    agent,
    origin,
    headers,
    client,
    begin,
    discard,
    put,
    complete,
  };
}

test("exact attachment text survives HTTP preparation, Chord send, queue, and retry fences", async () => {
  const f = await fixture();
  const text = " \n exact caption \n ";
  const direct = await f.client.call<{ operationId: string }>(
    "reserveSubmission",
    { id: f.agent.id },
  );
  expect((await f.begin(direct.operationId, text, "direct", [3])).status).toBe(
    200,
  );
  expect((await f.put(direct.operationId, 0, "abc")).status).toBe(200);
  const refs = await f.complete(direct.operationId);
  const stage = readdirSync(join(f.directory, "attachments")).find(
    (name) =>
      JSON.parse(
        readFileSync(
          join(f.directory, "attachments", name, "manifest.json"),
          "utf8",
        ),
      ).operation === direct.operationId,
  )!;
  expect(
    JSON.parse(
      readFileSync(
        join(f.directory, "attachments", stage, "manifest.json"),
        "utf8",
      ),
    ).manifest.text,
  ).toBe(text);
  await f.client.call("send", {
    id: f.agent.id,
    operationId: direct.operationId,
    text,
    ...refs,
  });
  expect(f.runtime.inputs[0].text.startsWith(text)).toBe(true);
  const detail = await f.service.detail(f.agent.id);
  expect(
    detail.messages.find((m) => m.clientId === direct.operationId)?.text,
  ).toBe(text);
  expect(f.service.recovery(f.agent.id, direct.operationId).text).toBe(text);
  const queueText = "\n  queue body \n";
  expect(
    (await f.begin("exact-queue", queueText, "follow_up", [1])).status,
  ).toBe(200);
  expect((await f.put("exact-queue", 0, "q")).status).toBe(200);
  const queueRefs = await f.complete("exact-queue");
  await f.client.call("enqueueFollowUp", {
    id: f.agent.id,
    operationId: "exact-queue",
    text: queueText,
    ...queueRefs,
  });
  expect(f.service.lookupFollowUp(f.agent.id, "exact-queue")?.text).toBe(
    queueText,
  );
  expect(f.service.recovery(f.agent.id, "exact-queue").text).toBe(queueText);
  const rawId = f.agent.id.slice(f.service.identity.id.length + 1);
  const persisted = f.app.store.byId(rawId)!;
  expect(
    persisted.deliveries.find((d) => d.id === direct.operationId)?.text,
  ).toBe(text);
  expect(persisted.deliveries.find((d) => d.id === "exact-queue")?.text).toBe(
    queueText,
  );
  const rejected = await f.client.call<{ operationId: string }>(
    "reserveSubmission",
    { id: f.agent.id },
  );
  expect(
    (await f.begin(rejected.operationId, text, "direct", [1])).status,
  ).toBe(200);
  expect((await f.put(rejected.operationId, 0, "x")).status).toBe(200);
  const failedRefs = await f.complete(rejected.operationId);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("synthetic rejection");
  };
  await f.client.call("send", {
    id: f.agent.id,
    operationId: rejected.operationId,
    text,
    ...failedRefs,
  });
  f.runtime.sendOverride = undefined;
  const successor = await f.client.call<{
    state: string;
    operationId: string;
    claimToken: string;
  }>("reserveRetry", { id: f.agent.id, operationId: rejected.operationId });
  expect(successor.state).toBe("won");
  const predecessor = { source: "user", text, ...failedRefs };
  const { invoke } = await import("./chord-methods");
  await expect(
    invoke(f.service, "send", {
      id: f.agent.id,
      operationId: successor.operationId,
      text: text.trim(),
      predecessor,
      claimToken: successor.claimToken,
      ...failedRefs,
    }),
  ).rejects.toThrow("differs");
  await expect(
    invoke(f.service, "finalizeSubmission", {
      id: f.agent.id,
      operationId: successor.operationId,
      envelope: { ...predecessor, text: text.trim() },
      predecessor,
    }),
  ).rejects.toThrow("differs");
  await invoke(f.service, "send", {
    id: f.agent.id,
    operationId: successor.operationId,
    text,
    predecessor,
    claimToken: successor.claimToken,
    ...failedRefs,
  });
  expect(f.service.recovery(f.agent.id, successor.operationId).text).toBe(text);
});

test("old external whitespace fence allows exact Chord retry without allowing predecessor substitution", async () => {
  const f = await fixture();
  f.app.store.sqlite
    .query(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, color) VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .run("alice", "Alice", "alice@fixture.invalid", 1, 1, "#123456");
  const text = " \n external original \n ";
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("old external refusal");
  };
  await f.service.externalSend(f.agent.id, text, "old-external", "alice");
  const rawId = f.agent.id.slice(f.service.identity.id.length + 1);
  const old = parseFence(f.app.store.submissionFence(rawId, "old-external")!);
  expect(old.hash).toBe(envelopeHash({ source: "user", text: text.trim() }));
  f.runtime.sendOverride = undefined;
  const retry = await f.service.reserveRetry(
    f.agent.id,
    "old-external",
    "alice",
  );
  if (retry.state !== "won") throw new Error("retry lost");
  const { invoke } = await import("./chord-methods");
  await expect(
    invoke(
      f.service,
      "send",
      {
        id: f.agent.id,
        operationId: retry.operationId,
        text: text.trim(),
        predecessor: { source: "user", text: text.trim() },
        claimToken: retry.claimToken,
      },
      "alice",
    ),
  ).rejects.toThrow("differs");
  await invoke(
    f.service,
    "send",
    {
      id: f.agent.id,
      operationId: retry.operationId,
      text,
      predecessor: { source: "user", text },
      claimToken: retry.claimToken,
    },
    "alice",
  );
  expect(f.service.recovery(f.agent.id, retry.operationId).text).toBe(text);
});

test("two cancelled 200 MB preparations release quota for a complete 200 MB retry over HTTP", async () => {
  const f = await fixture();
  const first = await f.service.reserveSubmission(f.agent.id);
  const second = await f.service.reserveSubmission(f.agent.id);
  const retry = await f.service.reserveSubmission(f.agent.id);
  const sizes = [100_000_000, 100_000_000];
  expect(
    (await f.begin(first.operationId, "quota", "direct", sizes)).status,
  ).toBe(200);
  expect(
    (await f.begin(second.operationId, "quota", "direct", sizes)).status,
  ).toBe(200);
  expect(
    (await f.begin(retry.operationId, "quota", "direct", sizes)).status,
  ).toBe(400);
  for (const operation of [first.operationId, second.operationId]) {
    const deleted = await f.discard(operation);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ agent: f.agent.id, operation });
    expect((await f.discard(operation)).status).toBe(200);
    await expect(
      f.service.send(f.agent.id, "quota", operation),
    ).rejects.toThrow("discarded");
  }
  expect(
    (await f.begin(retry.operationId, "quota", "direct", sizes)).status,
  ).toBe(200);
  const script = `
    const http = require('node:http');
    const req = http.request(process.argv[1], {method:'PUT',headers:{Origin:process.argv[2],'X-Grove-Peer':process.argv[3],'Content-Length':'100000000'}}, res => { res.resume(); res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 2)); });
    req.on('error', () => process.exit(3));
    (async () => { const chunk = Buffer.alloc(1000000, 0x5a); for (let i=0;i<100;i++) if (!req.write(chunk)) await new Promise(resolve => req.once('drain',resolve)); req.end(); })();
  `;
  for (let index = 0; index < 2; index++) {
    const url = `${f.origin}/api/attachments/${index}?agent=${encodeURIComponent(f.agent.id)}&operation=${retry.operationId}`;
    const child = Bun.spawn(
      ["node", "-e", script, url, f.origin, f.service.identity.id],
      { stdout: "ignore", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }
  const refs = await f.complete(retry.operationId);
  expect(refs.files.map((file) => file.bytes)).toEqual(sizes);
  await f.client.call("send", {
    id: f.agent.id,
    operationId: retry.operationId,
    text: "quota",
    ...refs,
  });
  expect(f.runtime.inputs).toHaveLength(1);
  expect((await f.discard(retry.operationId)).status).toBe(400);
}, 30_000);

test("a DELETE during a real streaming PUT releases quota and removes late data", async () => {
  const f = await fixture();
  const operation = "streaming-queue";
  expect(
    (await f.begin(operation, "queue", "follow_up", [100_000_000, 100_000_000]))
      .status,
  ).toBe(200);
  const script = `
    const http = require('node:http');
    const req = http.request(process.argv[1], {method:'PUT',headers:{Origin:process.argv[2],'X-Grove-Peer':process.argv[3],'Content-Length':'4'}}, res => { res.resume(); res.on('end', () => process.exit(res.statusCode === 400 ? 0 : 2)); });
    req.on('error', () => process.exit(3));
    req.write('ab'); process.stdin.once('data', () => req.end('cd'));
  `;
  const url = `${f.origin}/api/attachments/0?agent=${encodeURIComponent(f.agent.id)}&operation=${operation}`;
  const child = Bun.spawn(
    ["node", "-e", script, url, f.origin, f.service.identity.id],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const folder = readdirSync(join(f.directory, "attachments"))[0];
    const stage = join(f.directory, "attachments", folder);
    let landed = 0;
    for (let n = 0; n < 200 && !landed; n++) {
      await Bun.sleep(5);
      try {
        landed = statSync(join(stage, "0.part")).size;
      } catch {}
    }
    expect(landed).toBe(2);
    expect((await f.discard(operation)).status).toBe(200);
    expect((await f.discard(operation)).status).toBe(200);
    const held = await f.service.reserveSubmission(f.agent.id);
    const next = await f.service.reserveSubmission(f.agent.id);
    const sizes = [100_000_000, 100_000_000];
    expect(
      (await f.begin(held.operationId, "hold", "direct", sizes)).status,
    ).toBe(200);
    expect(
      (await f.begin(next.operationId, "next", "direct", sizes)).status,
    ).toBe(400);
    await expect(
      f.service.enqueueFollowUp(f.agent.id, "queue", operation),
    ).rejects.toThrow("discarded");
    child.stdin.write("continue\n");
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(readdirSync(join(f.directory, "attachments"))).toHaveLength(1);
    expect(
      (await f.begin(next.operationId, "next", "direct", sizes)).status,
    ).toBe(200);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});

test("discard refuses bound queued, rejected and unknown operations", async () => {
  const f = await fixture();
  const prepare = async (operation: string, mode: "direct" | "follow_up") => {
    expect((await f.begin(operation, "data", mode, [1])).status).toBe(200);
    expect((await f.put(operation, 0, "x")).status).toBe(200);
    return f.complete(operation);
  };
  const queued = await prepare("bound-queue", "follow_up");
  await f.service.enqueueFollowUp(
    f.agent.id,
    "data",
    "bound-queue",
    queued.images,
    undefined,
    false,
    queued.files,
  );
  expect((await f.discard("bound-queue")).status).toBe(400);
  const rejected = await f.service.reserveSubmission(f.agent.id);
  const rejectedRefs = await prepare(rejected.operationId, "direct");
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("rejected");
  };
  await f.service.send(
    f.agent.id,
    "data",
    rejected.operationId,
    rejectedRefs.images,
    undefined,
    undefined,
    undefined,
    rejectedRefs.files,
  );
  expect((await f.discard(rejected.operationId)).status).toBe(400);
  const uncertain = await f.service.reserveSubmission(f.agent.id);
  const unknownRefs = await prepare(uncertain.operationId, "direct");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  await f.service.send(
    f.agent.id,
    "data",
    uncertain.operationId,
    unknownRefs.images,
    undefined,
    undefined,
    undefined,
    unknownRefs.files,
  );
  expect((await f.discard(uncertain.operationId)).status).toBe(400);
  expect(
    f.runtime.inputs.filter(
      (input) => input.clientId === uncertain.operationId,
    ),
  ).toHaveLength(1);
  expect(
    f.runtime.inputs.filter((input) => input.clientId === rejected.operationId),
  ).toHaveLength(1);
  expect(await f.service.lookup(f.agent.id, uncertain.operationId)).toBeNull();
});

test("discard during image completion removes prepared media and rejects completion", async () => {
  const f = await fixture();
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const { operationId } = await f.service.reserveSubmission(f.agent.id);
  const url = `${f.origin}/api/attachments?agent=${encodeURIComponent(f.agent.id)}&operation=${operationId}`;
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...f.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "image",
          mode: "direct",
          attachments: [{ kind: "image", name: "x.png", bytes: bytes.length }],
        }),
      })
    ).status,
  ).toBe(200);
  expect((await f.put(operationId, 0, bytes)).status).toBe(200);
  let ready!: () => void;
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const upload = f.app.images.upload.bind(f.app.images);
  f.app.images.upload = async (...args) => {
    const refs = await upload(...args);
    ready();
    await gate;
    return refs;
  };
  const complete = fetch(
    `${f.origin}/api/attachments/complete?agent=${encodeURIComponent(f.agent.id)}&operation=${operationId}`,
    { method: "POST", headers: f.headers },
  );
  await reached;
  try {
    expect((await f.discard(operationId)).status).toBe(200);
    await expect(
      f.service.send(f.agent.id, "image", operationId),
    ).rejects.toThrow("discarded");
  } finally {
    resume();
  }
  expect((await complete).status).toBe(400);
  expect(readdirSync(join(f.directory, "attachments"))).toHaveLength(0);
  expect(
    readdirSync(join(f.directory, "media")).filter(
      (name) => name !== "index.json",
    ),
  ).toHaveLength(0);
});

test("a concurrent discard cannot delete a stage while its message is admitted", async () => {
  const f = await fixture();
  const { operationId } = await f.service.reserveSubmission(f.agent.id);
  expect((await f.begin(operationId, "admit", "direct", [1])).status).toBe(200);
  expect((await f.put(operationId, 0, "x")).status).toBe(200);
  const refs = await f.complete(operationId);
  let ready!: () => void;
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const verify = f.app.attachments.verifyFiles.bind(f.app.attachments);
  f.app.attachments.verifyFiles = async (...args) => {
    ready();
    await gate;
    return verify(...args);
  };
  const send = f.service.send(
    f.agent.id,
    "admit",
    operationId,
    refs.images,
    undefined,
    undefined,
    undefined,
    refs.files,
  );
  await reached;
  const discard = f.discard(operationId);
  resume();
  await send;
  expect((await discard).status).toBe(400);
  expect(f.runtime.inputs).toHaveLength(1);
  const saved = await f.service.downloadAttachment(
    f.agent.id,
    refs.files[0].id,
  );
  expect(readFileSync(saved.path, "utf8")).toBe("x");
});

test("after restart discarded direct and queue references cannot be admitted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-discard-restart-"));
  let runtime = new FakeRuntime();
  let app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let service = new HostService(app, {
    directory,
    origin: () => "http://127.0.0.1:3333",
  });
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const direct = await service.reserveSubmission(agent.id);
    const prepare = async (operation: string, mode: "direct" | "follow_up") => {
      service.beginAttachments(agent.id, operation, {
        text: "saved",
        mode,
        attachments: [{ kind: "file", name: "x", bytes: 1 }],
      });
      await service.putAttachment(
        agent.id,
        operation,
        0,
        new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from("x"));
            c.close();
          },
        }),
      );
      return await service.completeAttachments(agent.id, operation);
    };
    const original = await prepare(direct.operationId, "direct");
    const queue = await prepare("restart-queue", "follow_up");
    await service.discardAttachments(agent.id, direct.operationId);
    await service.discardAttachments(agent.id, "restart-queue");
    app.dispose();
    runtime = new FakeRuntime();
    app = new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
    });
    service = new HostService(app, {
      directory,
      origin: () => "http://127.0.0.1:3333",
    });
    await expect(
      service.send(
        agent.id,
        "saved",
        direct.operationId,
        original.images,
        undefined,
        undefined,
        undefined,
        original.files,
      ),
    ).rejects.toThrow();
    await expect(
      service.enqueueFollowUp(
        agent.id,
        "saved",
        "restart-queue",
        queue.images,
        undefined,
        false,
        queue.files,
      ),
    ).rejects.toThrow();
    expect(runtime.inputs).toHaveLength(0);
    expect(await service.lookup(agent.id, direct.operationId)).toBeNull();
    expect(service.lookupFollowUp(agent.id, "restart-queue")).toBeNull();
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical legacy image fences retain their old hash while attachment text is exact", async () => {
  const { createHash } = await import("node:crypto");
  const image = {
    id: "a".repeat(64),
    name: "old.png",
    width: 1,
    height: 1,
    bytes: 1,
    mediaType: "image/png",
  };
  const legacyEncoding = [
    "grove-envelope-v1",
    [
      "user",
      "old caption",
      [
        [
          image.id,
          image.name,
          image.width,
          image.height,
          image.bytes,
          image.mediaType,
          null,
        ],
      ],
    ],
  ];
  const legacyHash = createHash("sha256")
    .update(JSON.stringify(legacyEncoding))
    .digest("hex");
  expect(
    envelopeHash({ source: "user", text: "old caption", images: [image] }),
  ).toBe(legacyHash);
  expect(
    envelopeHash({ source: "user", text: " old caption ", images: [image] }),
  ).not.toBe(legacyHash);
  expect(envelopeHash({ source: "user", text: " old caption " })).toBe(
    envelopeHash({ source: "user", text: "old caption" }),
  );
  expect(
    envelopeHash({
      source: "question",
      answers: [{ questionId: "q", answer: " answer " }],
    }),
  ).toBe(
    envelopeHash({
      source: "question",
      answers: [{ questionId: "q", answer: "answer" }],
    }),
  );
});
