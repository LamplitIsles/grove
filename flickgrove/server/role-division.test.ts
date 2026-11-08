import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { initializeReviewerConfig, roleDivision } from "./reviewer-config";
import { FakeRuntime, fixtureProjects, memberPresetsFixture } from "./testing";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "grove-role-division-"));
  const configPath = join(directory, "config.toml");
  await initializeReviewerConfig(configPath);
  const file = join(directory, "prompts/role-division.md");
  await writeFile(file, "Division A");
  const memberPresets = await memberPresetsFixture(directory);
  const open = (division: boolean) => {
    const runtime = new FakeRuntime();
    const app = new Workspace({
      directory: join(directory, "state"),
      runtime,
      projects: async () => fixtureProjects,
      memberPresets,
      ...(division ? { roleDivision: () => roleDivision(configPath) } : {}),
    });
    cleanups.push(() => app.dispose());
    return { app, runtime };
  };
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const capture = async (app: Workspace, id: string) =>
    app.store.byId(id)?.roleDivisionSnapshot;
  const worker = async (app: Workspace, orcId: string) => {
    const token = app.store.byId(orcId)!.token;
    return (await app.tool(token, "worker_start", {
      project: "alpha",
      title: "Worker",
      spec: "#5554",
      message: "Work",
    })) as { id: string };
  };
  return { directory, configPath, file, open, capture, worker };
}

test("a new Orc captures the division file, its new Worker inherits it, and both survive a restart after edits", async () => {
  const f = await fixture();
  let { app } = f.open(true);
  const orc = await app.createOrc("alpha");
  expect(await f.capture(app, orc.id)).toBe("Division A");
  await writeFile(f.file, "Division B");
  const firstWorker = await f.worker(app, orc.id);
  // The Worker captures its owner's text, never the current file.
  expect(await f.capture(app, firstWorker.id)).toBe("Division A");
  app.dispose();

  // A restart reads only each session's captured text.
  await writeFile(f.file, "Division C");
  ({ app } = f.open(true));
  expect(await f.capture(app, orc.id)).toBe("Division A");
  expect(await f.capture(app, firstWorker.id)).toBe("Division A");
  // Later members of the same Orc keep that captured text.
  const secondWorker = await f.worker(app, orc.id);
  expect(await f.capture(app, secondWorker.id)).toBe("Division A");
  // Only an Orc created after the edit reads the new file.
  const nextOrc = await app.createOrc("alpha");
  expect(await f.capture(app, nextOrc.id)).toBe("Division C");
  const nextWorker = await f.worker(app, nextOrc.id);
  expect(await f.capture(app, nextWorker.id)).toBe("Division C");
});

test("a prefeature Orc and its new Worker keep the legacy division without reading the file", async () => {
  const f = await fixture();
  let { app } = f.open(false);
  const legacy = await app.createOrc("alpha");
  expect(await f.capture(app, legacy.id)).toBeUndefined();
  app.dispose();

  // A later instance has the file, but the existing session never adopts it.
  await writeFile(f.file, "Division D");
  ({ app } = f.open(true));
  await app.updateSettings(legacy.id, { model: "sol", effort: "medium" });
  expect(await f.capture(app, legacy.id)).toBeUndefined();
  // A Worker started by the prefeature Orc stays legacy too.
  const legacyWorker = await f.worker(app, legacy.id);
  expect(await f.capture(app, legacyWorker.id)).toBeUndefined();
  // The same instance's newly created Orc does capture the file.
  const current = await app.createOrc("alpha");
  expect(await f.capture(app, current.id)).toBe("Division D");
  expect(await f.capture(app, (await f.worker(app, current.id)).id)).toBe(
    "Division D",
  );
});

test("an unreadable or empty division file fails Orc creation without applying other rules", async () => {
  const f = await fixture();
  const { app } = f.open(true);
  await unlink(f.file);
  await expect(app.createOrc("alpha")).rejects.toThrow(
    `Cannot read Task division prompt ${f.file}`,
  );
  expect(app.snapshot().agents).toHaveLength(0);
  await writeFile(f.file, "  \n");
  await expect(app.createOrc("alpha")).rejects.toThrow(
    `Task division prompt is empty: ${f.file}`,
  );
  expect(app.snapshot().agents).toHaveLength(0);
  // The explicit error never silently applies other rules; restoring the file
  // creates the captured default again.
  await writeFile(f.file, "Division E");
  expect(await f.capture(app, (await app.createOrc("alpha")).id)).toBe(
    "Division E",
  );
});

test("a broken division file blocks only the Orc that would capture it", async () => {
  const f = await fixture();
  let { app } = f.open(true);
  const existing = await app.createOrc("alpha");
  app.dispose();

  // Startup initialization never reads the user's file and still succeeds.
  await writeFile(f.file, "");
  await expect(initializeReviewerConfig(f.configPath)).resolves.toBeUndefined();
  expect(await readFile(f.file, "utf8")).toBe("");
  ({ app } = f.open(true));
  // Existing sessions keep their captured text and keep working.
  await app.updateSettings(existing.id, { model: "sol", effort: "medium" });
  expect(await f.capture(app, existing.id)).toBe("Division A");
  // Only a new Orc fails, explicitly.
  await expect(app.createOrc("alpha")).rejects.toThrow(
    `Task division prompt is empty: ${f.file}`,
  );
  // An unreadable file is reported the same way, never as a startup failure.
  await rm(f.file);
  await mkdir(f.file);
  await expect(initializeReviewerConfig(f.configPath)).resolves.toBeUndefined();
  await expect(app.createOrc("alpha")).rejects.toThrow(
    `Cannot read Task division prompt ${f.file}`,
  );
  expect(app.snapshot().agents.map((a) => a.id)).toEqual([existing.id]);
});

test("initialization creates only a missing division file and never overwrites customization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-role-division-init-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.toml");
  await initializeReviewerConfig(configPath);
  const file = join(directory, "prompts/role-division.md");
  const shipped = await readFile(file, "utf8");
  expect(shipped.trim()).not.toBe("");
  await writeFile(file, "User division");
  await initializeReviewerConfig(configPath);
  expect(await readFile(file, "utf8")).toBe("User division");
  // An instance initialized before this feature gains the missing file only.
  await unlink(file);
  await initializeReviewerConfig(configPath);
  expect(await readFile(file, "utf8")).toBe(shipped);
});
