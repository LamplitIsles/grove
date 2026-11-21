import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { AttachmentStore } from "./attachments";
import { ImageStore } from "./images";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture(referenced = () => false) {
  const dir = mkdtempSync(join(tmpdir(), "grove-attachments-"));
  directories.push(dir);
  const images = new ImageStore(join(dir, "images"));
  const store = new AttachmentStore(
    join(dir, "attachments"),
    images,
    referenced,
  );
  return { dir, store };
}
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

test("stages a frozen mixed operation with independently limited raw bodies", async () => {
  const { dir, store } = fixture();
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const manifest = {
    text: "original\ntext",
    mode: "direct",
    attachments: [
      { kind: "file", name: "empty.txt", bytes: 0 },
      { kind: "image", name: "photo.png", bytes: png.length },
      { kind: "file", name: "notes.txt", bytes: 3 },
    ],
  } as const;
  store.begin("a", "op", "alice", manifest);
  expect(() => store.begin("a", "op", "bob", manifest)).toThrow("another user");
  expect(() =>
    store.begin("a", "op", "alice", { ...manifest, text: "changed" }),
  ).toThrow("different content");
  await expect(store.put("a", "op", "bob", 0, null)).rejects.toThrow(
    "another user",
  );
  await expect(store.complete("a", "op", "alice")).rejects.toThrow(
    "every attachment",
  );
  await store.put("a", "op", "alice", 0, null);
  await store.put("a", "op", "alice", 1, stream(png));
  await expect(
    store.put("a", "op", "alice", 2, stream(Buffer.from("xy"))),
  ).rejects.toThrow("truncated");
  await expect(
    store.put("a", "op", "alice", 2, stream(Buffer.from("long"))),
  ).rejects.toThrow("exceeds");
  await store.put("a", "op", "alice", 2, stream(Buffer.from("xyz")));
  const refs = await store.complete("a", "op", "alice");
  expect(refs.images).toHaveLength(1);
  expect(refs.files.map(({ name, bytes }) => ({ name, bytes }))).toEqual([
    { name: "empty.txt", bytes: 0 },
    { name: "notes.txt", bytes: 3 },
  ]);
  expect(await store.complete("a", "op", "alice")).toEqual(refs);
  const operation = readdirSync(join(dir, "attachments"))[0];
  expect(
    readFileSync(join(dir, "attachments", operation, "2.data"), "utf8"),
  ).toBe("xyz");
  expect(
    statSync(join(dir, "attachments", operation, "2.data")).mode & 0o777,
  ).toBe(0o400);
  await expect(
    store.put("a", "op", "alice", 2, stream(Buffer.from("xyz"))),
  ).rejects.toThrow("already uploaded");
});

test("writes incoming chunks to disk before stream completion", async () => {
  const { dir, store } = fixture();
  store.begin("a", "op", "alice", {
    text: "",
    mode: "direct",
    attachments: [{ kind: "file", name: "data", bytes: 6 }],
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const upload = store.put("a", "op", "alice", 0, body);
  controller.enqueue(Buffer.from("abc"));
  const operation = readdirSync(join(dir, "attachments"))[0];
  const path = join(dir, "attachments", operation, "0.part");
  let size = 0;
  for (let i = 0; i < 100 && size !== 3; i++) {
    await Bun.sleep(5);
    try {
      size = statSync(path).size;
    } catch {}
  }
  expect(size).toBe(3);
  controller.enqueue(Buffer.from("def"));
  controller.close();
  await upload;
  expect(
    readFileSync(join(dir, "attachments", operation, "0.data"), "utf8"),
  ).toBe("abcdef");
});

test("an interrupted upload removes its partial file and can be retried", async () => {
  const { dir, store } = fixture();
  store.begin("a", "abort", "alice", {
    text: "",
    mode: "direct",
    attachments: [{ kind: "file", name: "x", bytes: 4 }],
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const pending = store.put("a", "abort", "alice", 0, body);
  controller.enqueue(Buffer.from("ab"));
  controller.error(new Error("interrupted"));
  await expect(pending).rejects.toThrow("interrupted");
  const operation = readdirSync(join(dir, "attachments"))[0];
  expect(
    readdirSync(join(dir, "attachments", operation)).filter((name) =>
      name.endsWith(".part"),
    ),
  ).toHaveLength(0);
  await store.put("a", "abort", "alice", 0, stream(Buffer.from("abcd")));
  expect((await store.complete("a", "abort", "alice")).files[0].bytes).toBe(4);
});

test("enforces independent limits and retains only referenced expired stages", async () => {
  let retain = false;
  const { dir, store } = fixture(() => retain);
  const item = (kind: "file" | "image", bytes: number) => ({
    kind,
    name: "x",
    bytes,
  });
  const begin = (attachments: ReturnType<typeof item>[]) =>
    store.begin("a", "op", "alice", {
      text: "",
      mode: "follow_up",
      attachments,
    });
  expect(() =>
    begin(Array.from({ length: 7 }, () => item("file", 0))),
  ).toThrow();
  expect(() => begin([item("file", 100_000_001)])).toThrow();
  expect(() =>
    begin([
      item("file", 100_000_000),
      item("file", 100_000_000),
      item("file", 1),
    ]),
  ).toThrow();
  expect(() => begin([item("image", 0)])).toThrow();
  expect(() =>
    begin([{ kind: "file", name: "../secret", bytes: 0 }]),
  ).toThrow();
  expect(() =>
    begin([{ kind: "file", name: "bad\u0000name", bytes: 0 }]),
  ).toThrow();
  expect(() =>
    begin([{ kind: "file", name: "bad\ud800name", bytes: 0 }]),
  ).toThrow();
  expect(() =>
    store.begin("a", "full-mixed", "alice", {
      text: "",
      mode: "direct",
      attachments: [
        ...[5_242_880, 5_242_880, 5_242_880, 5_242_879, 1].map((bytes) =>
          item("image", bytes),
        ),
        ...[100_000_000, 100_000_000, 0, 0, 0, 0].map((bytes) =>
          item("file", bytes),
        ),
      ],
    }),
  ).not.toThrow();
  begin([item("file", 0)]);
  await store.put("a", "op", "alice", 0, null);
  await store.complete("a", "op", "alice");
  retain = true;
  store.cleanup(Date.now() + 86_400_001);
  expect(readdirSync(join(dir, "attachments"))).toHaveLength(2);
  retain = false;
  store.cleanup(Date.now() + 86_400_001);
  expect(readdirSync(join(dir, "attachments"))).toHaveLength(0);
});

test("real HTTP prepares files, admission binds them, and same-origin download preserves bytes", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { servePeer } = await import("./http");
  const { invoke } = await import("./chord-methods");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-http-"));
  directories.push(dir);
  const runtime = new FakeRuntime();
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
  const server = servePeer(app, {
    hostname: "127.0.0.1",
    port: 0,
    service,
    origin: () => origin,
  });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const other = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const { operationId } = await service.reserveSubmission(agent.id);
    const params = `agent=${encodeURIComponent(agent.id)}&operation=${operationId}`;
    const headers = { Origin: origin, "X-Grove-Peer": service.identity.id };
    const manifest = {
      text: "  exact\n",
      mode: "direct",
      attachments: [{ kind: "file", name: "测试.txt", bytes: 3 }],
    };
    const begin = await fetch(`${origin}/api/attachments?${params}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    expect(begin.status).toBe(200);
    const uploaded = await fetch(`${origin}/api/attachments/0?${params}`, {
      method: "PUT",
      headers,
      body: "abc",
    });
    expect(await uploaded.json()).toMatchObject({ index: 0 });
    const complete = await fetch(
      `${origin}/api/attachments/complete?${params}`,
      { method: "POST", headers },
    );
    expect(complete.status).toBe(200);
    const resultBody = (await complete.json()) as {
      images: import("../src/contracts").MessageImage[];
      files: import("../src/contracts").MessageFile[];
    };
    const refs = { images: resultBody.images, files: resultBody.files };
    await expect(
      invoke(service, "send", {
        id: agent.id,
        operationId,
        text: manifest.text,
      }),
    ).rejects.toThrow("Attachments do not belong");
    const download = `${origin}/api/attachments/${refs.files[0].id}/download?agent=${encodeURIComponent(agent.id)}`;
    expect(
      (await fetch(download, { headers: { "sec-fetch-site": "same-origin" } }))
        .status,
    ).toBe(404);
    await expect(
      invoke(service, "send", {
        id: other.id,
        operationId,
        text: manifest.text,
        ...refs,
      }),
    ).rejects.toThrow();
    await expect(
      invoke(service, "send", {
        id: agent.id,
        operationId,
        text: "changed",
        ...refs,
      }),
    ).rejects.toThrow();
    await invoke(service, "send", {
      id: agent.id,
      operationId,
      text: manifest.text,
      ...refs,
    });
    expect(runtime.inputs).toHaveLength(1);
    expect(runtime.inputs[0].text).toContain("Attached files (local paths)");
    const path = JSON.parse(
      runtime.inputs[0].text.split("Attached files (local paths):\n")[1],
    )[0].path;
    expect(readFileSync(path, "utf8")).toBe("abc");
    const detail = await service.detail(agent.id);
    expect(detail.messages[0].text).toBe(manifest.text);
    expect(detail.messages[0].files).toEqual(refs.files);
    expect(service.userMessageOutline(agent.id)[0].files).toBe(1);
    expect((await fetch(download)).status).toBe(403);
    const result = await fetch(download, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toContain("attachment;");
    expect(await result.text()).toBe("abc");
    expect(
      (
        await fetch(
          `${origin}/api/attachments/${refs.files[0].id}/download?agent=${encodeURIComponent(other.id)}`,
          { headers: { "sec-fetch-site": "same-origin" } },
        )
      ).status,
    ).toBe(404);
  } finally {
    await server.stop(true);
    app.dispose();
  }
});

test("real HEVC image is decoded upright into model-compatible image and preview", async () => {
  const { dir, store } = fixture();
  const bytes = await Bun.file(
    new URL("./fixtures/attachment-orientation-6.heic", import.meta.url),
  ).arrayBuffer();
  store.begin("a", "heic", "alice", {
    text: "",
    mode: "direct",
    attachments: [
      { kind: "image", name: "photo.heic", bytes: bytes.byteLength },
    ],
  });
  await store.put("a", "heic", "alice", 0, stream(new Uint8Array(bytes)));
  const refs = await store.complete("a", "heic", "alice");
  expect(refs.images).toHaveLength(1);
  expect(refs.images[0]).toMatchObject({ width: 1200, height: 800 });
  expect(refs.images[0].bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
  expect(["image/png", "image/webp"]).toContain(refs.images[0].mediaType);
  const original = await sharp(
    join(dir, "images", refs.images[0].id),
  ).metadata();
  const preview = await sharp(
    join(dir, "images", refs.images[0].id + ".preview"),
  ).metadata();
  expect([original.width, original.height]).toEqual([1200, 800]);
  expect([preview.width, preview.height]).toEqual([480, 320]);
  const pixel = await sharp(join(dir, "images", refs.images[0].id))
    .extract({ left: 230, top: 160, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[1]).toBeGreaterThan(160);
  expect(pixel[2]).toBeLessThan(80);
});

test("truncated HEVC never publishes an attachment set", async () => {
  const { store } = fixture();
  const complete = await Bun.file(
    new URL("./fixtures/attachment-orientation-6.heic", import.meta.url),
  ).arrayBuffer();
  const bytes = new Uint8Array(complete).slice(0, 4096);
  store.begin("a", "broken", "alice", {
    text: "",
    mode: "direct",
    attachments: [{ kind: "image", name: "broken.heic", bytes: bytes.length }],
  });
  await store.put("a", "broken", "alice", 0, stream(bytes));
  await expect(store.complete("a", "broken", "alice")).rejects.toThrow();
  expect(store.authorize("a", "broken", "alice").images).toBeUndefined();
});

test("HEVC with EXIF-only orientation is rotated exactly once", async () => {
  const { decodeHeif } = await import("./heif");
  const bytes = Buffer.from(
    await Bun.file(
      new URL("./fixtures/attachment-orientation-6.heic", import.meta.url),
    ).arrayBuffer(),
  );
  // Retain the fixture's EXIF orientation while disabling its container rotation.
  const property = bytes.indexOf(Buffer.from("irot"));
  expect(property).toBeGreaterThan(0);
  bytes.write("free", property);
  const output = await decodeHeif(bytes, 5 * 1024 * 1024);
  const meta = await sharp(output).metadata();
  expect([meta.width, meta.height]).toEqual([1200, 800]);
  const pixel = await sharp(output)
    .extract({ left: 230, top: 160, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[1]).toBeGreaterThan(160);
  expect(pixel[2]).toBeLessThan(80);
});

test("rejected direct submission retries its original durable file refs without upload", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { DeliveryRejected } = await import("./runtime");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-retry-"));
  directories.push(dir);
  const runtime = new FakeRuntime();
  let app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
  });
  app.store.sqlite
    .query(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, color) VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .run("alice", "Alice", "alice@example.test", 1, 1, "#abcdef");
  let service = new HostService(app, {
    directory: dir,
    origin: () => "http://127.0.0.1:3333",
  });
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const { operationId } = await service.reserveSubmission(agent.id, "alice");
    service.beginAttachments(
      agent.id,
      operationId,
      {
        text: "original",
        mode: "direct",
        attachments: [{ kind: "file", name: "data.txt", bytes: 3 }],
      },
      "alice",
    );
    await service.putAttachment(
      agent.id,
      operationId,
      0,
      stream(Buffer.from("abc")),
      "alice",
    );
    const refs = await service.completeAttachments(
      agent.id,
      operationId,
      "alice",
    );
    const envelope = { source: "user" as const, text: "original", ...refs };
    runtime.sendOverride = async () => {
      throw new DeliveryRejected("synthetic refusal");
    };
    await service.send(
      agent.id,
      envelope.text,
      operationId,
      refs.images,
      "alice",
      undefined,
      undefined,
      refs.files,
    );
    expect((await service.detail(agent.id)).deliveries[0].status).toBe(
      "failed",
    );
    await expect(
      service.reserveRetry(agent.id, operationId, "bob"),
    ).rejects.toThrow();
    const retry = await service.reserveRetry(agent.id, operationId, "alice");
    if (retry.state !== "won") throw new Error("retry not won");
    runtime.sendOverride = undefined;
    await expect(
      service.send(
        agent.id,
        envelope.text,
        retry.operationId,
        refs.images,
        "alice",
        envelope,
        retry.claimToken,
        [{ ...refs.files[0], name: "different" }],
      ),
    ).rejects.toThrow();
    await service.send(
      agent.id,
      envelope.text,
      retry.operationId,
      refs.images,
      "alice",
      envelope,
      retry.claimToken,
      refs.files,
    );
    expect(runtime.inputs).toHaveLength(2);
    expect(
      (await service.detail(agent.id)).deliveries.find(
        (d) => d.id === retry.operationId,
      )?.status,
    ).toBe("sent");
    app.dispose();
    app = new Workspace({
      directory: dir,
      runtime: new FakeRuntime(),
      projects: async () => fixtureProjects,
    });
    service = new HostService(app, {
      directory: dir,
      origin: () => "http://127.0.0.1:3333",
    });
    const file = await service.downloadAttachment(agent.id, refs.files[0].id);
    expect(readFileSync(file.path, "utf8")).toBe("abc");
    chmodSync(file.path, 0o600);
    writeFileSync(file.path, "bad");
    await expect(
      service.downloadAttachment(agent.id, refs.files[0].id),
    ).rejects.toThrow("content changed");
  } finally {
    app.dispose();
  }
});

test("queue admission validates owner, frozen refs and cancellation without invoking native", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-queue-"));
  directories.push(dir);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
  });
  app.store.sqlite
    .query(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, color) VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .run("alice", "Alice", "alice@example.test", 1, 1, "#abcdef");
  const service = new HostService(app, {
    directory: dir,
    origin: () => "http://127.0.0.1:3333",
  });
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const op = "queue-op";
    const active = await service.reserveSubmission(agent.id, "alice");
    await service.send(
      agent.id,
      "active",
      active.operationId,
      undefined,
      "alice",
    );
    service.beginAttachments(
      agent.id,
      op,
      {
        text: "queue",
        mode: "follow_up",
        attachments: [{ kind: "file", name: "empty", bytes: 0 }],
      },
      "alice",
    );
    await service.putAttachment(agent.id, op, 0, null, "alice");
    const refs = await service.completeAttachments(agent.id, op, "alice");
    await expect(
      service.enqueueFollowUp(
        agent.id,
        "queue",
        op,
        refs.images,
        "bob",
        false,
        refs.files,
      ),
    ).rejects.toThrow();
    await expect(
      service.enqueueFollowUp(
        agent.id,
        "changed",
        op,
        refs.images,
        "alice",
        false,
        refs.files,
      ),
    ).rejects.toThrow();
    await service.enqueueFollowUp(
      agent.id,
      "queue",
      op,
      refs.images,
      "alice",
      false,
      refs.files,
    );
    expect(runtime.inputs).toHaveLength(1);
    expect(service.lookupFollowUp(agent.id, op)?.files).toEqual(refs.files);
    await service.cancelFollowUp(agent.id, op);
    await expect(
      service.completeAttachments(agent.id, op, "alice"),
    ).rejects.toThrow();
    expect(runtime.inputs).toHaveLength(1);
  } finally {
    app.dispose();
  }
});

test("production listener streams a 100 MB body to disk before request end", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { servePeer } = await import("./http");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-large-"));
  directories.push(dir);
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
  const server = servePeer(app, {
    hostname: "127.0.0.1",
    port: 0,
    service,
    origin: () => origin,
  });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const { operationId } = await service.reserveSubmission(agent.id);
    const params = `agent=${encodeURIComponent(agent.id)}&operation=${operationId}`;
    const headers = { Origin: origin, "X-Grove-Peer": service.identity.id };
    expect(
      (
        await fetch(`${origin}/api/attachments?${params}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "",
            mode: "direct",
            attachments: [
              { kind: "file", name: "large.bin", bytes: 100_000_000 },
            ],
          }),
        })
      ).status,
    ).toBe(200);
    const script = `
      const http = require('node:http');
      const req = http.request(process.argv[1], {method:'PUT',headers:{Origin:process.argv[2],'X-Grove-Peer':process.argv[3],'Content-Length':'100000000'}}, res => { res.resume(); res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 2)); });
      req.on('error', e => { console.error(e); process.exit(1); });
      const chunk = Buffer.alloc(1000000, 0x5a);
      req.write(chunk);
      process.stdin.once('data', async () => {
        for (let i=1;i<100;i++) if (!req.write(chunk)) await new Promise(resolve => req.once('drain',resolve));
        req.end();
      });
    `;
    const client = Bun.spawn(
      [
        "node",
        "-e",
        script,
        `${origin}/api/attachments/0?${params}`,
        origin,
        service.identity.id,
      ],
      { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
    );
    const timeout = setTimeout(() => client.kill(), 10_000);
    try {
      const stage = readdirSync(join(dir, "attachments"))[0];
      const path = join(dir, "attachments", stage, "0.part");
      let landed = 0;
      for (let i = 0; i < 200 && landed === 0; i++) {
        await Bun.sleep(5);
        try {
          landed = statSync(path).size;
        } catch {}
      }
      expect(landed).toBeGreaterThan(0);
      client.stdin.write("continue\n");
      client.stdin.end();
      expect(await client.exited).toBe(0);
      expect(statSync(join(dir, "attachments", stage, "0.data")).size).toBe(
        100_000_000,
      );
      const refs = await service.completeAttachments(agent.id, operationId);
      await service.send(
        agent.id,
        "",
        operationId,
        refs.images,
        undefined,
        undefined,
        undefined,
        refs.files,
      );
      const response = await fetch(
        `${origin}/api/attachments/${refs.files[0].id}/download?agent=${encodeURIComponent(agent.id)}`,
        { headers: { "sec-fetch-site": "same-origin" } },
      );
      expect(response.status).toBe(200);
      const { createHash } = await import("node:crypto");
      const actual = createHash("sha256"),
        expected = createHash("sha256");
      const expectedChunk = Buffer.alloc(1_000_000, 0x5a);
      for (let i = 0; i < 100; i++) expected.update(expectedChunk);
      let total = 0;
      for await (const chunk of response.body!) {
        total += chunk.byteLength;
        actual.update(chunk);
      }
      expect(total).toBe(100_000_000);
      expect(actual.digest("hex")).toBe(expected.digest("hex"));
    } finally {
      clearTimeout(timeout);
      client.kill();
    }
  } finally {
    await server.stop(true);
    app.dispose();
  }
}, 30_000);

test("finalized rejection retains exact staged refs past cleanup for successor retry", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-finalize-"));
  directories.push(dir);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
  });
  const service = new HostService(app, {
    directory: dir,
    origin: () => "http://127.0.0.1:3333",
  });
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const { operationId } = await service.reserveSubmission(agent.id);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const manifest = {
      text: "",
      mode: "direct",
      attachments: [
        { kind: "image", name: "a.png", bytes: png.length },
        { kind: "file", name: "empty", bytes: 0 },
      ],
    };
    service.beginAttachments(agent.id, operationId, manifest);
    await service.putAttachment(agent.id, operationId, 0, stream(png));
    await service.putAttachment(agent.id, operationId, 1, null);
    const refs = await service.completeAttachments(agent.id, operationId);
    expect(() => service.media(agent.id, refs.images[0].id, true)).toThrow(
      "unavailable",
    );
    await expect(
      service.send(agent.id, "", operationId, undefined),
    ).rejects.toThrow();
    const envelope = { source: "user" as const, text: "", ...refs };
    expect(
      await service.finalizeSubmission(agent.id, operationId, envelope),
    ).toMatchObject({ state: "rejected" });
    app.attachments.cleanup(Date.now() + 86_400_001);
    app.images.cleanup(Date.now() + 86_400_001);
    const retry = await service.reserveRetry(agent.id, operationId);
    if (retry.state !== "won") throw new Error("retry not won");
    await service.send(
      agent.id,
      "",
      retry.operationId,
      refs.images,
      undefined,
      envelope,
      retry.claimToken,
      refs.files,
    );
    expect(runtime.inputs).toHaveLength(1);
    expect(service.media(agent.id, refs.images[0].id, true)).toBeTruthy();
  } finally {
    app.dispose();
  }
});

test("unknown queued attachment admission is inspected across restart without resending", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-unknown-"));
  directories.push(dir);
  const runtime = new FakeRuntime();
  const options = {
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
  };
  let app = new Workspace(options);
  let service = new HostService(app, {
    directory: dir,
    origin: () => "http://127.0.0.1:3333",
  });
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const raw = agent.id.slice(service.identity.id.length + 1);
    const first = await service.reserveSubmission(agent.id);
    await service.send(agent.id, "active", first.operationId);
    const turn = app.detail(raw).turnId!;
    const op = "queued-attachment";
    service.beginAttachments(agent.id, op, {
      text: "follow",
      mode: "follow_up",
      attachments: [{ kind: "file", name: "x.txt", bytes: 3 }],
    });
    await service.putAttachment(agent.id, op, 0, stream(Buffer.from("xyz")));
    const refs = await service.completeAttachments(agent.id, op);
    await service.enqueueFollowUp(
      agent.id,
      "follow",
      op,
      refs.images,
      undefined,
      false,
      refs.files,
    );
    runtime.sendOverride = async () => {
      throw new Error("unknown admission");
    };
    runtime.emit(raw, { type: "completed", turnId: turn, status: "completed" });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 400; i++) {
        if (check()) return;
        await Bun.sleep(5);
      }
      throw new Error("timed out");
    };
    await until(() => app.lookupFollowUp(raw, op)?.status === "uncertain");
    expect(
      runtime.inputs.filter((input) => input.clientId === op),
    ).toHaveLength(1);
    app.dispose();
    runtime.sendOverride = undefined;
    runtime.inspectOverride = async (_id, id) => {
      expect(id).toBe(op);
      return {
        accepted: true,
        settled: true,
        completed: true,
        turnId: "native-follow",
      };
    };
    app = new Workspace(options);
    service = new HostService(app, {
      directory: dir,
      origin: () => "http://127.0.0.1:3333",
    });
    await until(() => app.lookupFollowUp(raw, op)?.status === "sent");
    expect(
      runtime.inputs.filter((input) => input.clientId === op),
    ).toHaveLength(1);
    const message = (await service.detail(agent.id)).messages.find(
      (m) => m.clientId === op,
    );
    expect(message?.text).toBe("follow");
    expect(message?.files).toEqual(refs.files);
  } finally {
    app.dispose();
  }
});

test("environment changes refuse a prepared local file before native admission", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { FakeRuntime } = await import("./testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-environment-"));
  directories.push(dir);
  const runtime = new FakeRuntime();
  const project: import("../src/contracts").Project = {
    alias: "alpha",
    name: "Alpha",
    path: "/fixture",
    environment: undefined,
  };
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => [project],
  });
  const service = new HostService(app, {
    directory: dir,
    origin: () => "http://127.0.0.1:3333",
  });
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const { operationId } = await service.reserveSubmission(agent.id);
    service.beginAttachments(agent.id, operationId, {
      text: "x",
      mode: "direct",
      attachments: [{ kind: "file", name: "x", bytes: 1 }],
    });
    await service.putAttachment(
      agent.id,
      operationId,
      0,
      stream(Buffer.from("x")),
    );
    const refs = await service.completeAttachments(agent.id, operationId);
    project.environment = { id: "remote", name: "Remote", target: "fixture" };
    await expect(
      service.send(
        agent.id,
        "x",
        operationId,
        refs.images,
        undefined,
        undefined,
        undefined,
        refs.files,
      ),
    ).rejects.toThrow("local sessions");
    expect(runtime.inputs).toHaveLength(0);
  } finally {
    app.dispose();
  }
});

test("failed workspace commit cannot publish prepared images or files", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-failed-save-"));
  directories.push(dir);
  const options = {
    directory: dir,
    runtime: new FakeRuntime(),
    projects: async () => fixtureProjects,
  };
  let app = new Workspace(options),
    service = new HostService(app, {
      directory: dir,
      origin: () => "http://127.0.0.1:3333",
    });
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const { operationId } = await service.reserveSubmission(agent.id);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    service.beginAttachments(agent.id, operationId, {
      text: "file",
      mode: "direct",
      attachments: [
        { kind: "image", name: "x.png", bytes: png.length },
        { kind: "file", name: "x", bytes: 1 },
      ],
    });
    await service.putAttachment(agent.id, operationId, 0, stream(png));
    await service.putAttachment(
      agent.id,
      operationId,
      1,
      stream(Buffer.from("x")),
    );
    const refs = await service.completeAttachments(agent.id, operationId);
    app.store.sqlite.exec(
      "CREATE TRIGGER attachment_fail BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
    );
    await expect(
      service.send(
        agent.id,
        "file",
        operationId,
        refs.images,
        undefined,
        undefined,
        undefined,
        refs.files,
      ),
    ).rejects.toThrow("fixture write failure");
    expect(options.runtime.inputs).toHaveLength(0);
    app.dispose();
    app = new Workspace(options);
    service = new HostService(app, {
      directory: dir,
      origin: () => "http://127.0.0.1:3333",
    });
    expect(() => service.media(agent.id, refs.images[0].id, true)).toThrow(
      "unavailable",
    );
    await expect(
      service.downloadAttachment(agent.id, refs.files[0].id),
    ).rejects.toThrow("unavailable");
  } finally {
    app.dispose();
  }
});

test("cleanup errors preserve the transfer error and release upload and reader locks", async () => {
  const { dir, store } = fixture();
  store.begin("a", "cleanup-error", "alice", {
    text: "",
    mode: "direct",
    attachments: [{ kind: "file", name: "x", bytes: 4 }],
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const pending = store.put("a", "cleanup-error", "alice", 0, body);
  controller.enqueue(Buffer.from("ab"));
  const operation = readdirSync(join(dir, "attachments"))[0];
  const path = join(dir, "attachments", operation, "0.part");
  let exists = false;
  for (let i = 0; i < 100 && !exists; i++) {
    await Bun.sleep(5);
    try {
      exists = statSync(path).size === 2;
    } catch {}
  }
  expect(exists).toBe(true);
  unlinkSync(path);
  mkdirSync(path);
  writeFileSync(join(path, "prevent-removal"), "fixture");
  controller.error(new Error("primary transfer failure"));
  await expect(pending).rejects.toThrow("primary transfer failure");
  expect(body.locked).toBe(false);
  rmSync(path, { recursive: true });
  await store.put(
    "a",
    "cleanup-error",
    "alice",
    0,
    stream(Buffer.from("abcd")),
  );
  expect(
    (await store.complete("a", "cleanup-error", "alice")).files[0].bytes,
  ).toBe(4);
});

test("a missing or damaged file does not hide other committed attachments", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { servePeer } = await import("./http");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "grove-attachment-partial-"));
  directories.push(dir);
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
  const server = servePeer(app, {
    hostname: "127.0.0.1",
    port: 0,
    service,
    origin: () => origin,
  });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const { operationId } = await service.reserveSubmission(agent.id);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const healthy = Buffer.from("healthy original");
    const broken = Buffer.from("broken original");
    const query = `agent=${encodeURIComponent(agent.id)}&operation=${operationId}`;
    const headers = { Origin: origin, "X-Grove-Peer": service.identity.id };
    const begin = await fetch(`${origin}/api/attachments?${query}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "mixed",
        mode: "direct",
        attachments: [
          { kind: "image", name: "image.png", bytes: png.length },
          { kind: "file", name: "healthy.txt", bytes: healthy.length },
          { kind: "file", name: "broken.txt", bytes: broken.length },
        ],
      }),
    });
    expect(begin.status).toBe(200);
    for (const [index, bytes] of [png, healthy, broken].entries()) {
      const response = await fetch(
        `${origin}/api/attachments/${index}?${query}`,
        { method: "PUT", headers, body: bytes },
      );
      const result = await response.text();
      expect({
        index,
        status: response.status,
        result: response.status === 200 ? "ok" : result,
      }).toEqual({ index, status: 200, result: "ok" });
    }
    const completed = await fetch(
      `${origin}/api/attachments/complete?${query}`,
      { method: "POST", headers },
    );
    expect(completed.status).toBe(200);
    const refs = (await completed.json()) as {
      images: import("../src/contracts").MessageImage[];
      files: import("../src/contracts").MessageFile[];
    };
    await service.send(
      agent.id,
      "mixed",
      operationId,
      refs.images,
      undefined,
      undefined,
      undefined,
      refs.files,
    );
    const stage = readdirSync(join(dir, "attachments"))[0];
    const badPath = join(dir, "attachments", stage, "2.data");
    const download = (index: number) =>
      `${origin}/api/attachments/${refs.files[index].id}/download?agent=${encodeURIComponent(agent.id)}`;
    const image = (kind: string) =>
      `${origin}/api/images/${refs.images[0].id}/${kind}?agent=${encodeURIComponent(agent.id)}`;
    const original = await fetch(image("original"), { headers });
    const preview = await fetch(image("preview"), { headers });
    expect(original.status).toBe(200);
    expect(preview.status).toBe(200);
    const originalBytes = Buffer.from(await original.arrayBuffer());
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    for (const state of ["missing", "wrong-size", "wrong-content"]) {
      if (state === "missing") unlinkSync(badPath);
      else {
        if (state === "wrong-content") chmodSync(badPath, 0o600);
        writeFileSync(
          badPath,
          state === "wrong-size" ? "x" : "z".repeat(broken.length),
        );
      }
      expect(
        (
          await fetch(download(1), {
            headers: { "sec-fetch-site": "same-origin" },
          })
        ).status,
      ).toBe(404);
      const good = await fetch(download(0), {
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(good.status).toBe(200);
      expect(
        createHash("sha256")
          .update(Buffer.from(await good.arrayBuffer()))
          .digest("hex"),
      ).toBe(createHash("sha256").update(healthy).digest("hex"));
      const originalAgain = await fetch(image("original"), { headers });
      const previewAgain = await fetch(image("preview"), { headers });
      expect(originalAgain.status).toBe(200);
      expect(previewAgain.status).toBe(200);
      expect(Buffer.from(await originalAgain.arrayBuffer())).toEqual(
        originalBytes,
      );
      expect(Buffer.from(await previewAgain.arrayBuffer())).toEqual(
        previewBytes,
      );
    }
  } finally {
    await server.stop(true);
    app.dispose();
  }
});

test("missing staged files cannot reach native, queue admission, finalization or retry", async () => {
  const { Workspace } = await import("./workspace");
  const { HostService } = await import("./hosts");
  const { DeliveryRejected } = await import("./runtime");
  const { FakeRuntime, fixtureProjects } = await import("./testing");
  const dir = mkdtempSync(
    join(tmpdir(), "grove-attachment-admission-missing-"),
  );
  directories.push(dir);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: dir,
    runtime,
    projects: async () => fixtureProjects,
  });
  const service = new HostService(app, {
    directory: dir,
    origin: () => "http://127.0.0.1:3333",
  });
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const prepare = async (operation: string, mode: "direct" | "follow_up") => {
      service.beginAttachments(agent.id, operation, {
        text: "data",
        mode,
        attachments: [{ kind: "file", name: "x", bytes: 4 }],
      });
      await service.putAttachment(
        agent.id,
        operation,
        0,
        stream(Buffer.from("data")),
      );
      const refs = await service.completeAttachments(agent.id, operation);
      const base = join(dir, "attachments");
      const entry = readdirSync(base).find(
        (name) =>
          JSON.parse(readFileSync(join(base, name, "manifest.json"), "utf8"))
            .operation === operation,
      );
      if (!entry) throw new Error("missing fixture stage");
      return { refs, path: join(base, entry, "0.data") };
    };
    const direct = await service.reserveSubmission(agent.id);
    const directStage = await prepare(direct.operationId, "direct");
    unlinkSync(directStage.path);
    await service.send(
      agent.id,
      "data",
      direct.operationId,
      directStage.refs.images,
      undefined,
      undefined,
      undefined,
      directStage.refs.files,
    );
    expect(runtime.inputs).toHaveLength(0);
    expect(
      (await service.detail(agent.id)).deliveries.find(
        (d) => d.id === direct.operationId,
      )?.status,
    ).toBe("failed");

    const finalized = await service.reserveSubmission(agent.id);
    const finalStage = await prepare(finalized.operationId, "direct");
    unlinkSync(finalStage.path);
    await expect(
      service.finalizeSubmission(agent.id, finalized.operationId, {
        source: "user",
        text: "data",
        ...finalStage.refs,
      }),
    ).rejects.toThrow("missing");

    const queueStage = await prepare("missing-queue", "follow_up");
    unlinkSync(queueStage.path);
    await expect(
      service.enqueueFollowUp(
        agent.id,
        "data",
        "missing-queue",
        queueStage.refs.images,
        undefined,
        false,
        queueStage.refs.files,
      ),
    ).rejects.toThrow("missing");

    const original = await service.reserveSubmission(agent.id);
    const retryStage = await prepare(original.operationId, "direct");
    runtime.sendOverride = async () => {
      throw new DeliveryRejected("synthetic rejection");
    };
    await service.send(
      agent.id,
      "data",
      original.operationId,
      retryStage.refs.images,
      undefined,
      undefined,
      undefined,
      retryStage.refs.files,
    );
    expect(runtime.inputs).toHaveLength(1);
    const retry = await service.reserveRetry(agent.id, original.operationId);
    if (retry.state !== "won") throw new Error("retry not won");
    unlinkSync(retryStage.path);
    runtime.sendOverride = undefined;
    await service.send(
      agent.id,
      "data",
      retry.operationId,
      retryStage.refs.images,
      undefined,
      { source: "user", text: "data", ...retryStage.refs },
      retry.claimToken,
      retryStage.refs.files,
    );
    expect(runtime.inputs).toHaveLength(1);
    expect(
      (await service.detail(agent.id)).deliveries.find(
        (d) => d.id === retry.operationId,
      )?.status,
    ).toBe("failed");
  } finally {
    app.dispose();
  }
});
