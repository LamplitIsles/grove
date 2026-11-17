import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ConfigFilesStatus } from "../src/contracts";
import { listConfigFiles } from "./config-files";
import { configFileSecret, configFilesFixture } from "./config-files-fixture";
import { memberPresetToml } from "./testing";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "grove-config-files-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, ...configFilesFixture(root) };
}
const sources = (status: ConfigFilesStatus) =>
  status.files.map((file) => file.source);

test("lists the resolved Grove, Pi and Codex locations without exposing file contents", async () => {
  const f = fixture();
  const status = await listConfigFiles(f);
  expect(status.issues).toEqual([]);
  expect(status.files).toEqual([
    {
      source: "grove",
      name: "Grove configuration",
      path: f.configPath,
      description: "Instance settings and project environments",
    },
    {
      source: "grove",
      name: "Task division",
      path: join(f.root, "prompts/role-division.md"),
      description:
        "Default task division captured by new Orcs; editing it affects only Orcs created afterwards",
    },
    {
      source: "grove",
      name: "Orc instructions",
      path: join(f.root, "prompts/orc.md"),
      description: "Responsibilities a new Orc captures when it starts",
    },
    {
      source: "grove",
      name: "Researcher instructions",
      path: join(f.root, "prompts/researcher.md"),
      description: "Instructions a new Researcher captures when it starts",
    },
    {
      source: "grove",
      name: "Standards reviewer instructions",
      path: join(f.root, "prompts/standards.md"),
      description: "Review prompt a new Standards Reviewer captures",
    },
    {
      source: "grove",
      name: "Spec reviewer instructions",
      path: join(f.root, "prompts/spec.md"),
      description: "Review prompt a new Spec Reviewer captures",
    },
    {
      source: "grove",
      name: "High-risk Spec reviewer instructions",
      path: join(f.root, "prompts/high-risk-spec.md"),
      description: "Review prompt a new High-risk Spec Reviewer captures",
    },
    {
      source: "grove",
      name: "Member preset codex-only",
      path: join(f.memberPresetsDirectory, "codex-only.toml"),
      description: "Backend, model and effort for new members",
    },
    {
      source: "pi",
      name: "Pi settings",
      path: join(f.piAgentDir, "settings.json"),
      description: "Pi settings used by Pi sessions",
    },
    {
      source: "pi",
      name: "Pi models",
      path: join(f.piAgentDir, "models.json"),
      description: "Additional provider and model definitions for Pi",
    },
    {
      source: "pi",
      name: "Pi MCP servers",
      path: join(f.piAgentDir, "mcp.json"),
      description: "MCP servers offered to Pi sessions",
    },
    {
      source: "pi",
      name: "Pi credentials",
      path: join(f.piAgentDir, "auth.json"),
      description: "Pi provider credentials; only this path is listed",
    },
    {
      source: "codex",
      name: "Codex configuration",
      path: join(f.codexHome, "config.toml"),
      description: "Codex settings, MCP servers and profiles",
    },
    {
      source: "codex",
      name: "Codex environments",
      path: join(f.codexHome, "environments.toml"),
      description: "Native execution environments used by project environments",
    },
    {
      source: "codex",
      name: "Codex credentials",
      path: join(f.codexHome, "auth.json"),
      description: "Codex account credentials; only this path is listed",
    },
  ]);
  // Only paths and purpose cross this boundary, never stored credentials.
  expect(JSON.stringify(status)).not.toContain(configFileSecret);
});

test("relative configured locations are reported as absolute paths on this host", async () => {
  const f = fixture();
  const relativeTo = (value: string) => relative(process.cwd(), value);
  // The fixture inputs really are relative, so the assertion below is not vacuous.
  expect(isAbsolute(relativeTo(f.configPath))).toBe(false);
  const status = await listConfigFiles({
    configPath: relativeTo(f.configPath),
    memberPresetsDirectory: relativeTo(f.memberPresetsDirectory),
    piAgentDir: relativeTo(f.piAgentDir),
    codexHome: relativeTo(f.codexHome),
  });
  expect(status.issues).toEqual([]);
  for (const file of status.files) expect(isAbsolute(file.path)).toBe(true);
  // The same locations as an absolute configuration, read and reported the same.
  const absolute = await listConfigFiles(f);
  expect(status.files).toEqual(absolute.files);
});

test("relative locations that cannot resolve still report absolute paths for every source", async () => {
  const f = fixture();
  const relativeTo = (value: string) => relative(process.cwd(), value);
  const missingConfig = join(f.root, "absent/config.toml");
  const status = await listConfigFiles({
    configPath: relativeTo(missingConfig),
    memberPresetsDirectory: relativeTo(join(f.root, "absent/member-presets")),
    piAgentDir: relativeTo(f.piAgentDir),
    codexHome: relativeTo(f.codexHome),
  });
  expect(status.issues).toEqual([
    "Could not resolve the Grove role instruction files",
  ]);
  for (const file of status.files) expect(isAbsolute(file.path)).toBe(true);
  expect(status.files[0]).toMatchObject({
    name: "Grove configuration",
    path: missingConfig,
  });
  expect(status.files.filter((file) => file.source === "pi")).toEqual([
    expect.objectContaining({
      name: "Pi settings",
      path: join(f.piAgentDir, "settings.json"),
    }),
    expect.objectContaining({
      name: "Pi models",
      path: join(f.piAgentDir, "models.json"),
    }),
    expect.objectContaining({
      name: "Pi MCP servers",
      path: join(f.piAgentDir, "mcp.json"),
    }),
    expect.objectContaining({
      name: "Pi credentials",
      path: join(f.piAgentDir, "auth.json"),
    }),
  ]);
  expect(status.files.filter((file) => file.source === "codex")).toEqual([
    expect.objectContaining({
      name: "Codex configuration",
      path: join(f.codexHome, "config.toml"),
    }),
    expect.objectContaining({
      name: "Codex environments",
      path: join(f.codexHome, "environments.toml"),
    }),
    expect.objectContaining({
      name: "Codex credentials",
      path: join(f.codexHome, "auth.json"),
    }),
  ]);
});

test("a source that cannot resolve its locations reports an issue and keeps the others", async () => {
  const f = fixture();
  writeFileSync(f.configPath, "orc = ");
  const status = await listConfigFiles(f);
  expect(status.issues).toEqual([
    "Could not resolve the Grove role instruction files",
  ]);
  expect(sources(status)).toEqual([
    "grove",
    "grove",
    "grove",
    "pi",
    "pi",
    "pi",
    "pi",
    "codex",
    "codex",
    "codex",
  ]);
  expect(status.files[0]).toMatchObject({
    name: "Grove configuration",
    path: f.configPath,
  });
  expect(status.files[1]).toMatchObject({
    name: "Task division",
    path: join(f.root, "prompts/role-division.md"),
  });
  expect(status.files[2]).toMatchObject({
    name: "Member preset codex-only",
    path: join(f.memberPresetsDirectory, "codex-only.toml"),
  });
});

test("member presets follow the directory without a restart and unconfigured presets are reported", async () => {
  const f = fixture();
  writeFileSync(
    join(f.memberPresetsDirectory, "added.toml"),
    memberPresetToml({ name: "Added" }, "added"),
  );
  expect(
    (await listConfigFiles(f)).files.filter(
      (file) =>
        file.source === "grove" && file.name.startsWith("Member preset"),
    ),
  ).toEqual([
    {
      source: "grove",
      name: "Member preset Added",
      path: join(f.memberPresetsDirectory, "added.toml"),
      description: "Backend, model and effort for new members",
    },
    {
      source: "grove",
      name: "Member preset codex-only",
      path: join(f.memberPresetsDirectory, "codex-only.toml"),
      description: "Backend, model and effort for new members",
    },
  ]);
  const unconfigured = await listConfigFiles({
    ...f,
    memberPresetsDirectory: undefined,
  });
  expect(unconfigured.issues).toEqual([
    "Member model presets are not configured for this instance",
  ]);
  expect(
    unconfigured.files.some((file) => file.name.startsWith("Member preset")),
  ).toBe(false);
  // A directory that does not exist yet simply has no presets to list.
  const absent = await listConfigFiles({
    ...f,
    memberPresetsDirectory: join(f.root, "absent"),
  });
  expect(absent.issues).toEqual([]);
  expect(
    absent.files.some((file) => file.name.startsWith("Member preset")),
  ).toBe(false);
  // An unlistable location is reported without hiding the role prompts.
  writeFileSync(join(f.root, "not-a-directory"), "");
  const unlistable = await listConfigFiles({
    ...f,
    memberPresetsDirectory: join(f.root, "not-a-directory"),
  });
  expect(unlistable.issues).toEqual(["Could not list the member preset files"]);
  expect(unlistable.files.filter((file) => file.source === "grove")).toEqual([
    expect.objectContaining({ name: "Grove configuration" }),
    expect.objectContaining({ name: "Task division" }),
    expect.objectContaining({ name: "Orc instructions" }),
    expect.objectContaining({ name: "Researcher instructions" }),
    expect.objectContaining({ name: "Standards reviewer instructions" }),
    expect.objectContaining({ name: "Spec reviewer instructions" }),
    expect.objectContaining({ name: "High-risk Spec reviewer instructions" }),
  ]);
});
