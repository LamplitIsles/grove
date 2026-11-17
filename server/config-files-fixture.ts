import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memberPresetToml } from "./testing";

/** A value that must never appear in a configuration catalog response. */
export const configFileSecret = "sk-fixture-8f3c2a-never-list-me";

/** Test-owned Grove, Pi and Codex configuration locations. */
export function configFilesFixture(root: string) {
  const configPath = join(root, "config.toml");
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(
    configPath,
    [
      "[orc]",
      'prompt_file = "prompts/orc.md"',
      "",
      "[researcher]",
      'prompt_file = "prompts/researcher.md"',
      "",
      "[reviewers.standards]",
      'prompt_file = "prompts/standards.md"',
      "",
      "[reviewers.spec]",
      'prompt_file = "prompts/spec.md"',
      "",
      "[reviewers.high_risk_spec]",
      'prompt_file = "prompts/high-risk-spec.md"',
      "",
    ].join("\n"),
  );
  const memberPresetsDirectory = join(root, "member-presets");
  mkdirSync(memberPresetsDirectory, { recursive: true });
  writeFileSync(
    join(memberPresetsDirectory, "codex-only.toml"),
    memberPresetToml({}, "codex-only"),
  );
  const piAgentDir = join(root, "pi-agent");
  mkdirSync(piAgentDir, { recursive: true });
  writeFileSync(
    join(piAgentDir, "auth.json"),
    JSON.stringify({ openai: { key: configFileSecret } }),
  );
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: configFileSecret }),
  );
  return { configPath, memberPresetsDirectory, piAgentDir, codexHome };
}
