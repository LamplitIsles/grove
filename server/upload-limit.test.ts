import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { servePeer } from "./http";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { FakeRuntime, fixtureProjects } from "./testing";
import { IMAGE_BYTES, MESSAGE_IMAGE_BYTES } from "./images";

test("production listener enforces attachment image limits and body identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-upload-limit-"));
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
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
    });
    const headers = { Origin: origin, "X-Grove-Peer": service.identity.id };
    const query = async () =>
      `agent=${agent.id}&operation=${(await service.reserveSubmission(agent.id)).operationId}`;
    const begin = (q: string, sizes: number[]) =>
      fetch(`${origin}/api/attachments?${q}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "",
          mode: "direct",
          attachments: sizes.map((bytes) => ({
            kind: "image",
            name: "image.png",
            bytes,
          })),
        }),
      });
    const file = new File(
      [
        await sharp({
          create: {
            width: 1024,
            height: 1360,
            channels: 3,
            background: "white",
          },
        })
          .png({ compressionLevel: 0 })
          .toBuffer(),
      ],
      "large.png",
    );
    expect(file.size).toBeGreaterThan(1024 * 1024);
    expect(file.size * 5).toBeLessThanOrEqual(MESSAGE_IMAGE_BYTES);
    expect((await begin(await query(), [IMAGE_BYTES + 1])).status).toBe(400);
    expect(
      (
        await begin(await query(), [
          IMAGE_BYTES,
          IMAGE_BYTES,
          IMAGE_BYTES,
          IMAGE_BYTES,
          IMAGE_BYTES,
        ])
      ).status,
    ).toBe(400);
    const q = await query();
    expect((await begin(q, [file.size])).status).toBe(200);
    const put = (body: Blob) =>
      fetch(`${origin}/api/attachments/0?${q}`, {
        method: "PUT",
        headers,
        body,
      });
    expect((await put(file.slice(0, file.size - 1))).status).toBe(400);
    expect((await put(new Blob([file, new Uint8Array(1)]))).status).toBe(400);
    expect((await put(file)).status).toBe(200);
    const complete = await fetch(`${origin}/api/attachments/complete?${q}`, {
      method: "POST",
      headers,
    });
    expect(complete.status).toBe(200);
    expect((await complete.json()).images[0]).toMatchObject({
      width: 1024,
      height: 1360,
    });
    const batch = await query();
    expect((await begin(batch, Array(5).fill(file.size))).status).toBe(200);
    for (let index = 0; index < 5; index++) {
      const response = await fetch(
        `${origin}/api/attachments/${index}?${batch}`,
        { method: "PUT", headers, body: file },
      );
      expect(response.status).toBe(200);
    }
    const completedBatch = await fetch(
      `${origin}/api/attachments/complete?${batch}`,
      { method: "POST", headers },
    );
    expect(completedBatch.status).toBe(200);
    expect((await completedBatch.json()).images).toHaveLength(5);
    expect(
      (
        await fetch(`${origin}/api/images?${q}`, {
          method: "POST",
          headers,
          body: new FormData(),
        })
      ).status,
    ).toBe(405);
    expect(runtime.inputs).toHaveLength(0);
  } finally {
    await server.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
