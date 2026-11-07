import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { authUsers } from "./schema";
import { HostService } from "./hosts";
import { detailSchema, snapshotSchema } from "../src/chord-contract";

test("authors and independent participant times survive messages, agent activity, and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-human-test-"));
  const runtime = new FakeRuntime();
  const make = () =>
    new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
      branches: { read: async () => null },
    });
  let app = make();
  try {
    for (const [id, name, color] of [
      ["a", "Alice", "pink"],
      ["b", "Bob", "green"],
    ])
      app.store.db
        .insert(authUsers)
        .values({
          id,
          name,
          color,
          email: `${id}@test.invalid`,
          emailVerified: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();
    const orc = await app.createOrc("alpha");
    await app.send(orc.id, "hello", "a1", undefined, "a");
    await app.send(orc.id, "world", "b1", undefined, "b");
    const detail = detailSchema.parse(app.detail(orc.id));
    expect(detail.messages.find((m) => m.clientId === "a1")?.author?.name).toBe(
      "Alice",
    );
    expect(detail.messages.find((m) => m.clientId === "b1")?.author?.name).toBe(
      "Bob",
    );
    const before = app.store.participants(orc.id);
    expect(before.map((v) => v.user.name).sort()).toEqual(["Alice", "Bob"]);
    runtime.emit(orc.id, {
      type: "item",
      turnId: app.detail(orc.id).turnId!,
      item: { type: "agentMessage", id: "agent", text: "reply" },
    });
    expect(app.store.participants(orc.id)).toEqual(before);
    runtime.emit(orc.id, {
      type: "item",
      turnId: app.detail(orc.id).turnId!,
      item: { type: "userMessage", id: "external", text: "external" },
    });
    expect(
      app.detail(orc.id).messages.find((m) => m.id === "external")?.author,
    ).toBeUndefined();
    const queuedOrc = await app.createOrc("beta");
    await app.send(queuedOrc.id, "first", "queued-first", undefined, "a");
    const firstTurn = app.detail(queuedOrc.id).turnId!;
    await app.enqueueFollowUp(
      queuedOrc.id,
      "later",
      "queued-bob",
      undefined,
      "b",
    );
    expect(
      app.store.participants(queuedOrc.id).map((v) => v.user.name),
    ).toEqual(["Alice"]);
    runtime.emit(queuedOrc.id, {
      type: "completed",
      turnId: firstTurn,
      status: "completed",
      verified: true,
    });
    for (
      let i = 0;
      i < 50 &&
      app.lookupFollowUp(queuedOrc.id, "queued-bob")?.status !== "sent";
      i++
    )
      await Bun.sleep(5);
    expect(app.lookupFollowUp(queuedOrc.id, "queued-bob")?.status).toBe("sent");
    expect(
      app.detail(queuedOrc.id).messages.find((m) => m.clientId === "queued-bob")
        ?.author?.name,
    ).toBe("Bob");
    expect(
      app.store
        .participants(queuedOrc.id)
        .map((v) => v.user.name)
        .sort(),
    ).toEqual(["Alice", "Bob"]);
    const service = new HostService(app, {
      directory,
      origin: () => "http://localhost:3082",
    });
    expect(
      snapshotSchema
        .parse(service.snapshot())
        .agents.find((a) => a.id.endsWith(orc.id))?.participants,
    ).toHaveLength(2);
    service.dispose();
    app.dispose();
    app = make();
    expect(app.store.participants(orc.id)).toEqual(before);
    await app.synchronizeDetail(orc.id);
    expect(
      app.detail(orc.id).messages.find((m) => m.clientId === "a1")?.author
        ?.name,
    ).toBe("Alice");
  } finally {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
