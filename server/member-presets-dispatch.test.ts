import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixture,
  writeMemberPreset,
} from "./testing";
import type { Detail } from "../src/contracts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "grove-preset-dispatch-"));
  const runtime = new FakeRuntime();
  const memberPresets = await memberPresetsFixture(directory, {
    worker: { model: "luna", effort: "low" },
    researcher: { model: "luna", effort: "low" },
    standards: { model: "luna", effort: "low" },
    spec: { model: "sol", effort: "high" },
    high_risk_spec: { model: "sol", effort: "high" },
  });
  await writeMemberPreset(memberPresets.directory, "other", {
    worker: { model: "sol", effort: "high" },
    researcher: { model: "sol", effort: "high" },
    standards: { model: "sol", effort: "high" },
    spec: { model: "sol", effort: "high" },
    high_risk_spec: { model: "sol", effort: "high" },
  });
  const app = new Workspace({
    directory: join(directory, "state"),
    runtime,
    projects: async () => fixtureProjects,
    reviewerSnapshot: async () => ({ prompt: "Axis scope" }),
    researcherSnapshot: async () => ({ prompt: "Research scope" }),
    memberPresets,
  });
  cleanups.push(
    () => app.dispose(),
    () => rm(directory, { recursive: true, force: true }),
  );
  const orc = await app.createOrc("alpha", {
    fast: false,
    orc: { model: "sol", effort: "medium" },
  });
  const token = runtime.agents.get(orc.id)!.token;
  const start = {
    worker: () =>
      app.tool(token, "worker_start", {
        project: "alpha",
        title: "Worker",
        spec: "#5537",
        message: "Work",
      }) as Promise<Detail>,
    reviewer: (profile: "standards" | "spec" | "high_risk_spec") =>
      app.tool(token, "reviewer_start", {
        project: "alpha",
        title: profile,
        profile,
        spec: "#5537",
        fixedPoint: "base",
        reviewedHead: "head",
        message: "Review",
      }) as Promise<Detail>,
    researcher: () =>
      app.tool(token, "researcher_start", {
        project: "alpha",
        title: "Research",
        question: "Which model applies?",
        message: "Find evidence",
      }) as Promise<Detail>,
  };
  return { directory, app, runtime, memberPresets, orc, token, start };
}

test("Worker, each Reviewer axis and Researcher resolve the current preset while Orc settings stay independent", async () => {
  const f = await fixture();
  const worker = await f.start.worker();
  expect(f.app.detail(worker.id)).toMatchObject({
    role: "worker",
    model: "luna",
    effort: "low",
    backend: "codex",
    serviceTier: "default",
  });
  const standards = await f.start.reviewer("standards");
  const spec = await f.start.reviewer("spec");
  const highRisk = await f.start.reviewer("high_risk_spec");
  const researcher = await f.start.researcher();
  expect(f.app.detail(standards.id)).toMatchObject({
    model: "luna",
    effort: "low",
    reviewTarget: { profile: "standards" },
  });
  expect(f.app.detail(spec.id)).toMatchObject({
    model: "sol",
    effort: "high",
    reviewTarget: { profile: "spec" },
  });
  expect(f.app.detail(highRisk.id)).toMatchObject({
    model: "sol",
    effort: "high",
    reviewTarget: { profile: "high_risk_spec" },
  });
  expect(f.app.detail(researcher.id)).toMatchObject({
    model: "luna",
    effort: "low",
    researchQuestion: "Which model applies?",
  });
  // The Orc keeps its own settings and is the only adjustable session.
  expect(f.app.detail(f.orc.id)).toMatchObject({
    model: "sol",
    effort: "medium",
  });
  await expect(
    f.app.updateSettings(worker.id, { model: "sol", effort: "high" }),
  ).rejects.toThrow("Only Orc");
  await expect(
    f.app.updateSettings(standards.id, { model: "sol", effort: "high" }),
  ).rejects.toThrow("Only Orc");
  // Switching the instance preset applies to later members of the same Orc.
  await f.app.selectMemberPreset("other");
  const later = await f.start.worker();
  expect(f.app.detail(later.id)).toMatchObject({
    model: "sol",
    effort: "high",
  });
  // Existing members keep their captured model and the Orc is unchanged.
  expect(f.app.detail(worker.id)).toMatchObject({
    model: "luna",
    effort: "low",
  });
  expect(f.app.detail(f.orc.id)).toMatchObject({
    model: "sol",
    effort: "medium",
  });
});

test("a missing, invalid or unavailable current preset refuses creation without falling back", async () => {
  const f = await fixture();
  const before = f.app.snapshot().agents.length;
  await writeFile(
    join(f.memberPresets.directory, "codex-only.toml"),
    'name = "Broken"\n',
  );
  await expect(f.start.worker()).rejects.toThrow("is invalid");
  expect(f.app.snapshot().agents.length).toBe(before);
  // A valid file with an unavailable model is refused with an actionable error.
  await writeMemberPreset(f.memberPresets.directory, "unknown-model", {
    worker: { model: "not-a-model", effort: "medium" },
  });
  await f.app.selectMemberPreset("unknown-model");
  await expect(f.start.worker()).rejects.toThrow(
    "unavailable worker model or reasoning effort",
  );
  expect(f.app.snapshot().agents.length).toBe(before);
  expect((await f.app.memberPresetsStatus()).current).toBe("unknown-model");
  // A selected file that disappears refuses creation; nothing is substituted.
  await unlink(join(f.memberPresets.directory, "unknown-model.toml"));
  await expect(f.start.worker()).rejects.toThrow("is missing");
  expect((await f.app.memberPresetsStatus()).currentError).toContain(
    "is missing",
  );
  expect(f.app.snapshot().agents.length).toBe(before);
  // Reviewer and Researcher share the same refusal.
  await writeFile(
    join(f.memberPresets.directory, "unknown-model.toml"),
    'name = "Unknown"\n',
  );
  await expect(f.start.reviewer("standards")).rejects.toThrow("is invalid");
  await expect(f.start.researcher()).rejects.toThrow("is invalid");
  expect(f.app.snapshot().agents.length).toBe(before);
});

test("tree Fast still follows each preset model's capability for future members", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-preset-fast-"));
  const runtime = new FakeRuntime();
  const memberPresets = await memberPresetsFixture(directory, {
    worker: { model: "sol", effort: "medium" },
  });
  await writeMemberPreset(memberPresets.directory, "slow", {
    worker: { model: "luna", effort: "low" },
  });
  const app = new Workspace({
    directory: join(directory, "state"),
    runtime,
    projects: async () => fixtureProjects,
    memberPresets,
  });
  cleanups.push(
    () => app.dispose(),
    () => rm(directory, { recursive: true, force: true }),
  );
  const orc = await app.createOrc("alpha", {
    fast: true,
    orc: { model: "sol", effort: "medium" },
  });
  const token = runtime.agents.get(orc.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Fast worker",
    spec: "#5537",
    message: "Work",
  })) as Detail;
  expect(app.detail(worker.id).serviceTier).toBe("priority");
  await app.selectMemberPreset("slow");
  const slow = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Slow worker",
    spec: "#5537",
    message: "Work",
  })) as Detail;
  expect(app.detail(slow.id)).toMatchObject({
    model: "luna",
    effort: "low",
    serviceTier: "default",
  });
});

test("a duplicate preset name blocks dispatch of the selected preset instead of falling back", async () => {
  const f = await fixture();
  const before = f.app.snapshot().agents.length;
  // This file sorts first and takes the selected preset's name.
  await writeMemberPreset(f.memberPresets.directory, "aaa-shared", {
    name: "codex-only",
  });
  const status = await f.app.memberPresetsStatus();
  expect(status.current).toBe("codex-only");
  expect(status.currentError).toContain("already used");
  for (const start of [
    () => f.start.worker(),
    () => f.start.reviewer("standards"),
    () => f.start.researcher(),
  ])
    await expect(start()).rejects.toThrow("already used");
  expect(f.app.snapshot().agents.length).toBe(before);
  expect(f.runtime.agents.size).toBe(before);
  // A uniquely named preset still dispatches every role, without falling back.
  await f.app.selectMemberPreset("aaa-shared");
  const worker = await f.start.worker();
  expect(f.app.detail(worker.id)).toMatchObject({
    role: "worker",
    model: "sol",
    effort: "medium",
  });
  const reviewer = await f.start.reviewer("spec");
  expect(f.app.detail(reviewer.id)).toMatchObject({
    role: "reviewer",
    model: "sol",
    effort: "high",
  });
  const researcher = await f.start.researcher();
  expect(f.app.detail(researcher.id)).toMatchObject({
    role: "researcher",
    model: "sol",
    effort: "high",
  });
  // The Orc keeps its own model and the blocked selections never appeared.
  expect(f.app.detail(f.orc.id)).toMatchObject({
    model: "sol",
    effort: "medium",
  });
});
