import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { HostService } from "./hosts";
import { invoke } from "./chord-methods";
import { followUpInspectionSchema } from "../src/chord-contract";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function fixture(backend: "codex" | "pi" = "codex") {
  const directory = mkdtempSync(join(tmpdir(), "grove-inspect-test-"));
  const runtime = new FakeRuntime();
  if (backend === "pi")
    runtime.models = async () => [
      {
        id: "sol",
        name: "Sol",
        backend: "pi",
        provider: "fixture",
        efforts: ["medium"],
        defaultEffort: "medium",
        isDefault: true,
        fastTier: null,
      },
    ];
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  cleanups.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
  );
  const agent = await app.createOrc("alpha");
  await app.send(agent.id, "start", "start");
  const turnId = app.detail(agent.id).turnId!;
  await app.enqueueFollowUp(agent.id, "inspect me", "unknown");
  await app.enqueueFollowUp(agent.id, "later", "later");
  runtime.sendOverride = async (_id, _text, _turn, startOnly) => {
    if (startOnly) throw new Error("lost reply");
    return "ordinary";
  };
  runtime.emit(agent.id, { type: "completed", turnId, status: "completed" });
  for (
    let i = 0;
    i < 400 && app.lookupFollowUp(agent.id, "unknown")?.status !== "uncertain";
    i++
  )
    await Bun.sleep(5);
  expect(app.lookupFollowUp(agent.id, "unknown")?.status).toBe("uncertain");
  return { app, runtime, agent, directory };
}

test("unknown and read failure remain unknown; accepted receipt and terminal proof enable explicit continuation", async () => {
  const { app, runtime, agent, directory } = await fixture();
  const service = new HostService(app, {
    directory,
    origin: () => "http://fixture",
  });
  const id = `${service.identity.id}:${agent.id}`;
  runtime.inspectOverride = async () => ({ accepted: false, settled: false });
  const missing = followUpInspectionSchema.parse(
    await invoke(service, "inspectFollowUp", { id, operationId: "unknown" }),
  );
  expect(missing).toMatchObject({
    admission: "unknown",
    canContinue: false,
    reason: "admission_unknown",
    delivery: { status: "uncertain" },
  });
  runtime.inspectOverride = async () => {
    throw new Error("fixture unavailable");
  };
  expect(await app.inspectFollowUp(agent.id, "unknown")).toMatchObject({
    admission: "unknown",
    canContinue: false,
    reason: "unavailable",
  });
  await expect(app.resumeFollowUps(agent.id)).rejects.toThrow();
  runtime.inspectOverride = async () => ({
    accepted: true,
    turnId: "native-turn",
    settled: false,
  });
  expect(await app.inspectFollowUp(agent.id, "unknown")).toMatchObject({
    admission: "accepted",
    canContinue: false,
    reason: "turn_unconfirmed",
    delivery: { status: "sent" },
  });
  await expect(app.resumeFollowUps(agent.id)).rejects.toThrow();
  runtime.inspectOverride = async () => ({
    accepted: true,
    turnId: "native-turn",
    settled: true,
  });
  const ready = await app.inspectFollowUp(agent.id, "unknown");
  expect(ready).toMatchObject({
    admission: "accepted",
    canContinue: true,
    reason: "ready",
  });
  expect(app.detail(agent.id).followUpPaused).toBe(true);
  expect(
    runtime.inputs.filter((input) => input.clientId === "unknown"),
  ).toHaveLength(1);
  runtime.sendOverride = undefined;
  await app.resumeFollowUps(agent.id);
  for (
    let i = 0;
    i < 400 && app.lookupFollowUp(agent.id, "later")?.status !== "sent";
    i++
  )
    await Bun.sleep(5);
  expect(app.lookupFollowUp(agent.id, "later")?.status).toBe("sent");
  expect(
    runtime.inputs.filter((input) => input.clientId === "unknown"),
  ).toHaveLength(1);
});

test("native events during inspection invalidate the observation and never release the queue", async () => {
  const { app, runtime, agent } = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  runtime.inspectOverride = async () => {
    entered();
    await gate;
    return { accepted: true, turnId: "native-turn", settled: true };
  };
  const inspecting = app.inspectFollowUp(agent.id, "unknown");
  await started;
  runtime.emit(agent.id, { type: "working", turnId: "new-turn" });
  release();
  expect(await inspecting).toMatchObject({
    admission: "unknown",
    canContinue: false,
    reason: "changed",
  });
  expect(app.lookupFollowUp(agent.id, "unknown")?.status).toBe("uncertain");
  await expect(app.resumeFollowUps(agent.id)).rejects.toThrow();
});

test("proof of acceptance never overrides a different currently observed turn", async () => {
  const { app, runtime, agent } = await fixture();
  runtime.emit(agent.id, { type: "working", turnId: "new-turn" });
  runtime.inspectOverride = async () => ({
    accepted: true,
    turnId: "old-turn",
    settled: true,
  });
  expect(await app.inspectFollowUp(agent.id, "unknown")).toMatchObject({
    admission: "accepted",
    canContinue: false,
    reason: "session_busy",
  });
  expect(app.detail(agent.id).turnId).toBe("new-turn");
  await expect(app.resumeFollowUps(agent.id)).rejects.toThrow();
});

test("disconnected Pi inspection is passive; only explicit continuation reconnects", async () => {
  const { app, runtime, agent } = await fixture("pi");
  runtime.emit(agent.id, { type: "disconnected", error: "connection lost" });
  let opens = 0;
  const originalOpen = runtime.open.bind(runtime);
  runtime.open = async (...args) => {
    opens++;
    return originalOpen(...args);
  };
  runtime.inspectOverride = async () => ({
    accepted: true,
    turnId: "native-turn",
    settled: true,
  });
  expect(await app.inspectFollowUp(agent.id, "unknown")).toMatchObject({
    admission: "accepted",
    canContinue: true,
    reason: "ready",
  });
  expect(opens).toBe(0);
  expect(
    runtime.inputs.filter((input) => input.clientId === "unknown"),
  ).toHaveLength(1);
  runtime.sendOverride = undefined;
  await app.resumeFollowUps(agent.id);
  for (
    let i = 0;
    i < 400 && app.lookupFollowUp(agent.id, "later")?.status !== "sent";
    i++
  )
    await Bun.sleep(5);
  expect(opens).toBe(1);
  expect(app.lookupFollowUp(agent.id, "later")?.status).toBe("sent");
  expect(
    runtime.inputs.filter((input) => input.clientId === "unknown"),
  ).toHaveLength(1);
});

test("a confirmed operation does not bypass another unresolved delivery", async () => {
  const { app, runtime, agent } = await fixture();
  runtime.sendOverride = async () => {
    throw new Error("another lost reply");
  };
  await app.send(agent.id, "another uncertain input", "other-unknown");
  runtime.inspectOverride = async () => ({
    accepted: true,
    turnId: "native-turn",
    settled: true,
  });
  expect(await app.inspectFollowUp(agent.id, "unknown")).toMatchObject({
    admission: "accepted",
    canContinue: false,
    reason: "other_unresolved",
  });
  await expect(app.resumeFollowUps(agent.id)).rejects.toThrow();
  runtime.emit(agent.id, {
    type: "item",
    turnId: "other-turn",
    item: {
      type: "userMessage",
      id: "other-native",
      clientId: "other-unknown",
      text: "another uncertain input",
    },
  });
  expect(app.lookup(agent.id, "other-unknown")?.state).toBe("accepted");
  await expect(app.resumeFollowUps(agent.id)).rejects.toThrow("verified idle");
  expect(app.lookupFollowUp(agent.id, "later")?.status).toBe("waiting");
});

test("a late native acceptance remains inspectable until its terminal boundary is proven", async () => {
  const { app, runtime, agent } = await fixture();
  runtime.emit(agent.id, {
    type: "item",
    turnId: "native-turn",
    item: {
      type: "userMessage",
      id: "native-input",
      clientId: "unknown",
      text: "inspect me",
    },
  });
  expect(app.lookupFollowUp(agent.id, "unknown")?.status).toBe("sent");
  expect(
    app.detail(agent.id).followUps?.find((item) => item.id === "unknown")
      ?.status,
  ).toBe("sent");
  runtime.inspectOverride = async () => ({
    accepted: true,
    turnId: "native-turn",
    settled: true,
  });
  expect(await app.inspectFollowUp(agent.id, "unknown")).toMatchObject({
    canContinue: true,
    reason: "ready",
  });
  expect(
    app.detail(agent.id).followUps?.some((item) => item.id === "unknown"),
  ).toBe(false);
});

test("late accepted follow-up keeps newly queued work paused until explicit continuation", async () => {
  const { app, runtime, agent } = await fixture();
  await app.cancelFollowUp(agent.id, "later");
  runtime.emit(agent.id, { type: "working", turnId: "native-turn" });
  runtime.emit(agent.id, {
    type: "item",
    turnId: "native-turn",
    item: {
      type: "userMessage",
      id: "native-input",
      clientId: "unknown",
      text: "inspect me",
    },
  });
  expect(app.detail(agent.id)).toMatchObject({
    state: "working",
    turnId: "native-turn",
    followUpPaused: true,
    followUpCount: 0,
  });
  expect(app.detail(agent.id).followUps?.map((d) => d.id)).toEqual(["unknown"]);
  await app.enqueueFollowUp(agent.id, "first new", "new-1");
  await app.enqueueFollowUp(agent.id, "second new", "new-2");
  expect(app.detail(agent.id)).toMatchObject({
    followUpPaused: true,
    followUpCount: 2,
  });
  expect(app.detail(agent.id).followUps?.map((d) => d.id)).toEqual([
    "unknown",
    "new-1",
    "new-2",
  ]);
  runtime.sendOverride = undefined;
  runtime.emit(agent.id, {
    type: "completed",
    turnId: "native-turn",
    status: "completed",
    verified: true,
  });
  await Bun.sleep(30);
  expect(runtime.inputs.map((input) => input.clientId)).toEqual([
    "start",
    "unknown",
  ]);
  expect(app.detail(agent.id).followUpPaused).toBe(true);
  expect(app.lookupFollowUp(agent.id, "new-1")?.status).toBe("waiting");
  runtime.inspectOverride = async () => ({
    accepted: true,
    turnId: "native-turn",
    settled: true,
  });
  expect(await app.inspectFollowUp(agent.id, "unknown")).toMatchObject({
    admission: "accepted",
    canContinue: true,
  });
  expect(app.lookupFollowUp(agent.id, "new-1")?.status).toBe("waiting");
  await app.resumeFollowUps(agent.id);
  for (
    let i = 0;
    i < 400 && app.lookupFollowUp(agent.id, "new-1")?.status !== "sent";
    i++
  )
    await Bun.sleep(5);
  expect(app.lookupFollowUp(agent.id, "new-1")?.status).toBe("sent");
  expect(app.lookupFollowUp(agent.id, "new-2")?.status).toBe("waiting");
  runtime.emit(agent.id, {
    type: "completed",
    turnId: app.detail(agent.id).turnId!,
    status: "completed",
    verified: true,
  });
  for (
    let i = 0;
    i < 400 && app.lookupFollowUp(agent.id, "new-2")?.status !== "sent";
    i++
  )
    await Bun.sleep(5);
  expect(app.lookupFollowUp(agent.id, "new-2")?.status).toBe("sent");
  expect(runtime.inputs.map((input) => input.clientId)).toEqual([
    "start",
    "unknown",
    "new-1",
    "new-2",
  ]);
});

test("accepted follow-up is not counted as pending but cannot close or continue before its terminal proof", async () => {
  const { app, runtime, agent } = await fixture();
  await app.cancelFollowUp(agent.id, "later");
  runtime.emit(agent.id, { type: "working", turnId: "native-turn" });
  runtime.emit(agent.id, {
    type: "item",
    turnId: "native-turn",
    item: {
      type: "userMessage",
      id: "native-input",
      clientId: "unknown",
      text: "inspect me",
    },
  });
  runtime.emit(agent.id, {
    type: "completed",
    turnId: "native-turn",
    status: "completed",
    verified: false,
  });
  expect(app.detail(agent.id)).toMatchObject({
    state: "idle",
    followUpCount: 0,
    followUpPaused: true,
  });
  expect(app.detail(agent.id).followUps?.map((d) => d.status)).toEqual([
    "sent",
  ]);
  await expect(app.resumeFollowUps(agent.id)).rejects.toThrow("verified idle");
  await expect(app.closeTree(agent.id)).rejects.toThrow();
  runtime.inspectOverride = async () => ({
    accepted: true,
    turnId: "native-turn",
    settled: true,
  });
  expect(await app.inspectFollowUp(agent.id, "unknown")).toMatchObject({
    canContinue: true,
  });
  expect(app.detail(agent.id).followUps).toEqual([]);
  await app.closeTree(agent.id);
  expect(
    runtime.inputs.filter((input) => input.clientId === "unknown"),
  ).toHaveLength(1);
});
