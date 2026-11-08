import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentMemberPreset,
  defaultMemberPresetId,
  initializeMemberPresets,
  listMemberPresets,
  memberPresetsDirectory,
  memberPresetsStatus,
  readMemberPreset,
  selectMemberPreset,
  selectedMemberPresetId,
} from "./member-presets";
import { WorkspaceStore } from "./workspace-store";
import { memberPresetToml } from "./testing";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grove-presets-"));
  const directory = join(root, "config", "member-presets");
  const path = join(root, "workspace.sqlite");
  const store = new WorkspaceStore(path);
  cleanups.push(
    () => store.close(),
    () => rm(root, { recursive: true, force: true }),
  );
  return {
    root,
    directory,
    store,
    reopen() {
      store.close();
      const reopened = new WorkspaceStore(path);
      cleanups.push(() => reopened.close());
      return reopened;
    },
  };
}

test("shipped examples initialize only when missing and keep the documented combinations", async () => {
  const f = await fixture();
  expect(memberPresetsDirectory(join(f.root, "config", "config.toml"))).toBe(
    f.directory,
  );
  await initializeMemberPresets(f.directory);
  expect(await listMemberPresets(f.directory)).toEqual([
    { id: "codex-only", name: "Codex only" },
    { id: "di-only", name: "DI only" },
    { id: "ds-only", name: "DS only" },
  ]);
  const deepinfra = {
    backend: "pi" as const,
    provider: "deepinfra",
    model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  };
  expect(await readMemberPreset(f.directory, "di-only")).toEqual({
    id: "di-only",
    name: "DI only",
    worker: { ...deepinfra, effort: "high" },
    researcher: { ...deepinfra, effort: "high" },
    reviewers: {
      standards: { ...deepinfra, effort: "high" },
      spec: { ...deepinfra, effort: "high" },
      high_risk_spec: { ...deepinfra, effort: "xhigh" },
    },
  });
  const deepseek = {
    backend: "pi" as const,
    provider: "deepseek",
    model: "deepseek-flash",
    effort: "high",
  };
  expect(await readMemberPreset(f.directory, "ds-only")).toEqual({
    id: "ds-only",
    name: "DS only",
    worker: deepseek,
    researcher: deepseek,
    reviewers: {
      standards: deepseek,
      spec: deepseek,
      high_risk_spec: deepseek,
    },
  });
  const luna = {
    backend: "codex" as const,
    model: "gpt-6-luna",
    effort: "high",
  };
  const terra = {
    backend: "codex" as const,
    model: "gpt-6.1-terra",
    effort: "xhigh",
  };
  expect(await readMemberPreset(f.directory, "codex-only")).toEqual({
    id: "codex-only",
    name: "Codex only",
    worker: terra,
    researcher: luna,
    reviewers: { standards: luna, spec: luna, high_risk_spec: terra },
  });
  // A customized file is never overwritten; a deleted shipped file is restored.
  await writeFile(
    join(f.directory, "di-only.toml"),
    memberPresetToml({ name: "DI edited" }, "di-only"),
  );
  await unlink(join(f.directory, "ds-only.toml"));
  await initializeMemberPresets(f.directory);
  expect((await readMemberPreset(f.directory, "di-only")).name).toBe(
    "DI edited",
  );
  expect((await readMemberPreset(f.directory, "ds-only")).name).toBe("DS only");
  expect(await readFile(join(f.directory, "di-only.toml"), "utf8")).toContain(
    "DI edited",
  );
});

test("new and edited files are discovered without restart while one broken file stays visible", async () => {
  const f = await fixture();
  await initializeMemberPresets(f.directory);
  await writeFile(
    join(f.directory, "extra.toml"),
    memberPresetToml({ name: "Extra" }, "extra"),
  );
  await writeFile(join(f.directory, "broken.toml"), "name = ");
  await writeFile(
    join(f.directory, "duplicate.toml"),
    memberPresetToml({ name: "Extra" }, "duplicate"),
  );
  await writeFile(join(f.directory, "notes.txt"), "not a member preset");
  const listed = await listMemberPresets(f.directory);
  expect(listed.map((preset) => preset.id)).toEqual([
    "broken",
    "codex-only",
    "di-only",
    "ds-only",
    "duplicate",
    "extra",
  ]);
  expect(listed.find((preset) => preset.id === "broken")?.error).toContain(
    "is not valid TOML",
  );
  expect(listed.find((preset) => preset.id === "extra")?.error).toContain(
    "already used",
  );
  expect(listed.filter((preset) => !preset.error)).toHaveLength(4);
  // An edit is visible on the next read, without any reload step.
  await writeFile(
    join(f.directory, "extra.toml"),
    memberPresetToml({ name: "Extra edited" }, "extra"),
  );
  expect(
    (await listMemberPresets(f.directory)).find(
      (preset) => preset.id === "extra",
    ),
  ).toEqual({ id: "extra", name: "Extra edited" });
  expect((await readMemberPreset(f.directory, "extra")).name).toBe(
    "Extra edited",
  );
});

test("the selection defaults to codex-only, persists instance-wide and never falls back", async () => {
  const f = await fixture();
  await initializeMemberPresets(f.directory);
  expect(defaultMemberPresetId).toBe("codex-only");
  expect(selectedMemberPresetId(f.store)).toBe("codex-only");
  expect((await currentMemberPreset(f.directory, f.store)).id).toBe(
    "codex-only",
  );
  await selectMemberPreset(f.directory, f.store, "di-only");
  expect(await memberPresetsStatus(f.directory, f.store)).toEqual({
    presets: [
      { id: "codex-only", name: "Codex only" },
      { id: "di-only", name: "DI only" },
      { id: "ds-only", name: "DS only" },
    ],
    current: "di-only",
  });
  // Unknown and broken selections are refused before writing.
  await expect(
    selectMemberPreset(f.directory, f.store, "absent"),
  ).rejects.toThrow("was not found");
  await writeFile(join(f.directory, "broken.toml"), "name = ");
  await expect(
    selectMemberPreset(f.directory, f.store, "broken"),
  ).rejects.toThrow("is not valid TOML");
  expect(selectedMemberPresetId(f.store)).toBe("di-only");
  // A selected file that disappears is reported and refuses creation.
  await unlink(join(f.directory, "di-only.toml"));
  const status = await memberPresetsStatus(f.directory, f.store);
  expect(status.current).toBe("di-only");
  expect(status.currentError).toContain("is missing");
  expect(status.presets.some((preset) => preset.id === "codex-only")).toBe(
    true,
  );
  await expect(currentMemberPreset(f.directory, f.store)).rejects.toThrow(
    "is missing",
  );
  // A corrupted selected file is reported the same way; nothing falls back.
  await selectMemberPreset(f.directory, f.store, "codex-only");
  await writeFile(join(f.directory, "codex-only.toml"), "name = 7\n");
  expect(
    (await memberPresetsStatus(f.directory, f.store)).currentError,
  ).toContain("is invalid");
  await expect(currentMemberPreset(f.directory, f.store)).rejects.toThrow(
    "is invalid",
  );
  // An ambiguous name is reported and also refuses dispatch, not just the UI.
  await writeFile(
    join(f.directory, "codex-only.toml"),
    memberPresetToml({}, "codex-only"),
  );
  await writeFile(
    join(f.directory, "aaa-shared.toml"),
    memberPresetToml({ name: "codex-only" }, "aaa-shared"),
  );
  expect(
    (await memberPresetsStatus(f.directory, f.store)).currentError,
  ).toContain("already used");
  await expect(currentMemberPreset(f.directory, f.store)).rejects.toThrow(
    "already used",
  );
  // Every visitor and restart observes the same instance-shared selection.
  expect(selectedMemberPresetId(f.reopen())).toBe("codex-only");
});

test("entries require a Pi provider, reject a Codex provider, unknown profiles and unsafe IDs", async () => {
  const f = await fixture();
  await initializeMemberPresets(f.directory);
  const base = (await readMemberPreset(f.directory, "codex-only")).worker;
  const write = (name: string, text: string) =>
    writeFile(join(f.directory, `${name}.toml`), text);
  await write(
    "pi-without-provider",
    `name = "Pi"\n[worker]\nbackend = "pi"\nmodel = "m"\nreasoning_effort = "high"\n[researcher]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.standards]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.spec]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.high_risk_spec]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n`,
  );
  await expect(
    readMemberPreset(f.directory, "pi-without-provider"),
  ).rejects.toThrow("provider");
  await write(
    "codex-with-provider",
    `name = "Codex"\n[worker]\nbackend = "codex"\nprovider = "someone"\nmodel = "m"\nreasoning_effort = "high"\n[researcher]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.standards]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.spec]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.high_risk_spec]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n`,
  );
  await expect(
    readMemberPreset(f.directory, "codex-with-provider"),
  ).rejects.toThrow("do not take a provider");
  await write(
    "unknown-profile",
    `name = "Profiles"\n[worker]\nbackend = "codex"\nmodel = "${base.model}"\nreasoning_effort = "high"\n[researcher]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.standards]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.spec]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.high_risk_spec]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n[reviewers.legacy]\nbackend = "codex"\nmodel = "m"\nreasoning_effort = "high"\n`,
  );
  await expect(
    readMemberPreset(f.directory, "unknown-profile"),
  ).rejects.toThrow("legacy");
  for (const id of ["../escape", "nested/name", ".hidden", "a".repeat(65)])
    await expect(readMemberPreset(f.directory, id)).rejects.toThrow(
      "not a file name",
    );
});
