import { dirname, join, resolve } from "node:path";
import type {
  ConfigFileEntry,
  ConfigFilesStatus,
  ReviewerProfile,
} from "../src/contracts";
import { listMemberPresets } from "./member-presets";
import {
  readReviewerConfig,
  reviewerProfiles,
  roleDivisionFile,
} from "./reviewer-config";

/** Resolved locations for one running instance; never a directory scan. */
export interface ConfigFileLocations {
  configPath: string;
  memberPresetsDirectory?: string;
  piAgentDir: string;
  codexHome: string;
}

const profileNames: Record<ReviewerProfile, string> = {
  standards: "Standards",
  spec: "Spec",
  high_risk_spec: "High-risk Spec",
};

// Every known location is listed whether or not the file exists and its
// contents are never read for the response. A source that cannot resolve its
// own locations reports an issue and leaves the other sources listed.
export async function listConfigFiles(
  locations: ConfigFileLocations,
): Promise<ConfigFilesStatus> {
  // Every reported path is absolute on this host. A relative --config, member
  // preset directory, Pi agent directory or CODEX_HOME is opened against the
  // Grove process directory, so resolving it there matches the actual runtime
  // reads without touching the filesystem.
  const configPath = resolve(locations.configPath);
  const piAgentDir = resolve(locations.piAgentDir);
  const codexHome = resolve(locations.codexHome);
  const presetsDirectory = locations.memberPresetsDirectory
    ? resolve(locations.memberPresetsDirectory)
    : undefined;
  const files: ConfigFileEntry[] = [];
  const issues: string[] = [];
  const grove = (name: string, path: string, description: string) =>
    files.push({ source: "grove", name, path, description });
  grove(
    "Grove configuration",
    configPath,
    "Instance settings and project environments",
  );
  grove(
    "Task division",
    roleDivisionFile(configPath),
    "Default task division captured by new Orcs; editing it affects only Orcs created afterwards",
  );
  try {
    const config = await readReviewerConfig(configPath);
    const base = dirname(configPath);
    grove(
      "Orc instructions",
      resolve(base, config.orc.prompt_file),
      "Responsibilities a new Orc captures when it starts",
    );
    grove(
      "Researcher instructions",
      resolve(base, config.researcher.prompt_file),
      "Instructions a new Researcher captures when it starts",
    );
    for (const profile of reviewerProfiles)
      grove(
        `${profileNames[profile]} reviewer instructions`,
        resolve(base, config.reviewers[profile].prompt_file),
        `Review prompt a new ${profileNames[profile]} Reviewer captures`,
      );
  } catch {
    issues.push("Could not resolve the Grove role instruction files");
  }
  if (presetsDirectory) {
    try {
      const directory = presetsDirectory;
      for (const preset of await listMemberPresets(directory))
        grove(
          `Member preset ${preset.name}`,
          join(directory, `${preset.id}.toml`),
          "Backend, model and effort for new members",
        );
    } catch {
      issues.push("Could not list the member preset files");
    }
  } else {
    issues.push("Member model presets are not configured for this instance");
  }
  for (const [name, file, description] of [
    ["Pi settings", "settings.json", "Pi settings used by Pi sessions"],
    [
      "Pi models",
      "models.json",
      "Additional provider and model definitions for Pi",
    ],
    ["Pi MCP servers", "mcp.json", "MCP servers offered to Pi sessions"],
    [
      "Pi credentials",
      "auth.json",
      "Pi provider credentials; only this path is listed",
    ],
  ] as const)
    files.push({
      source: "pi",
      name,
      path: join(piAgentDir, file),
      description,
    });
  for (const [name, file, description] of [
    [
      "Codex configuration",
      "config.toml",
      "Codex settings, MCP servers and profiles",
    ],
    [
      "Codex environments",
      "environments.toml",
      "Native execution environments used by project environments",
    ],
    [
      "Codex credentials",
      "auth.json",
      "Codex account credentials; only this path is listed",
    ],
  ] as const)
    files.push({
      source: "codex",
      name,
      path: join(codexHome, file),
      description,
    });
  return { files, issues };
}
