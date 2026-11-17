import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type {
  Backend,
  MemberPresetsStatus,
  ReviewerProfile,
} from "../src/contracts";
import { memberPresetSettings } from "./schema";
import type { WorkspaceStore } from "./workspace-store";
import { reviewerProfiles } from "./reviewer-config";

/** Used until this instance saves a selection; a broken file is still an error. */
export const defaultMemberPresetId = "codex-only";
const shippedPresetIds = ["codex-only", "di-only", "ds-only"];
const templates = fileURLToPath(
  new URL("../templates/member-presets/", import.meta.url),
);

export interface MemberModelChoice {
  backend: Backend;
  provider?: string;
  model: string;
  effort: string;
}
export interface MemberPreset {
  id: string;
  name: string;
  worker: MemberModelChoice;
  researcher: MemberModelChoice;
  reviewers: Record<ReviewerProfile, MemberModelChoice>;
}

export function memberPresetsDirectory(configPath: string) {
  return join(dirname(configPath), "member-presets");
}

const choiceSchema = z
  .object({
    backend: z.enum(["codex", "pi"]),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1),
    reasoning_effort: z.string().trim().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.backend === "pi" && !value.provider)
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Pi entries need a provider",
      });
    if (value.backend === "codex" && value.provider)
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Codex entries do not take a provider",
      });
  });
const presetSchema = z
  .object({
    name: z.string().trim().min(1),
    worker: choiceSchema,
    researcher: choiceSchema,
    reviewers: z
      .object({
        standards: choiceSchema,
        spec: choiceSchema,
        high_risk_spec: choiceSchema,
      })
      .strict(),
  })
  .strict();

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function issues(error: z.ZodError) {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length ? issue.path.join(".") : "file"}: ${issue.message}`,
    )
    .join("; ");
}
function choice(value: z.infer<typeof choiceSchema>): MemberModelChoice {
  return {
    backend: value.backend,
    ...(value.provider ? { provider: value.provider } : {}),
    model: value.model,
    effort: value.reasoning_effort,
  };
}

// Exclusive creation preserves customization and retries partial initialization.
export async function initializeMemberPresets(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const id of shippedPresetIds) {
    try {
      await writeFile(
        join(directory, `${id}.toml`),
        await readFile(resolve(templates, `${id}.toml`)),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function presetFile(directory: string, id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id) || id.includes(".."))
    throw new Error(
      `Member preset ${id} is not a file name in the member presets directory`,
    );
  return join(directory, `${id}.toml`);
}

export async function readMemberPreset(
  directory: string,
  id: string,
): Promise<MemberPreset> {
  const path = presetFile(directory, id);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `Member preset ${id} is missing. Add ${path} or select another preset in Settings.`,
      );
    throw new Error(`Cannot read member preset ${path}: ${message(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`Member preset ${id} is not valid TOML: ${message(error)}`);
  }
  const value = presetSchema.safeParse(parsed);
  if (!value.success)
    throw new Error(`Member preset ${id} is invalid: ${issues(value.error)}`);
  return {
    id,
    name: value.data.name,
    worker: choice(value.data.worker),
    researcher: choice(value.data.researcher),
    reviewers: Object.fromEntries(
      reviewerProfiles.map((profile) => [
        profile,
        choice(value.data.reviewers[profile]),
      ]),
    ) as Record<ReviewerProfile, MemberModelChoice>,
  };
}

interface PresetEntry {
  id: string;
  name: string;
  preset?: MemberPreset;
  error?: string;
}

// One validity rule for listing, selection and dispatch: one unreadable or
// ambiguously named file never hides the others, and never dispatches members.
async function presetEntries(directory: string): Promise<PresetEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read member presets: ${message(error)}`);
  }
  const ids = entries
    .filter((name) => name.endsWith(".toml") && !name.startsWith("."))
    .map((name) => name.slice(0, -".toml".length))
    .sort();
  const presets: PresetEntry[] = [];
  const names = new Set<string>();
  for (const id of ids) {
    try {
      const preset = await readMemberPreset(directory, id);
      if (names.has(preset.name)) {
        presets.push({
          id,
          name: preset.name,
          error: `Member preset name ${preset.name} is already used by another file. Rename one of them.`,
        });
        continue;
      }
      names.add(preset.name);
      presets.push({ id, name: preset.name, preset });
    } catch (error) {
      presets.push({ id, name: id, error: message(error) });
    }
  }
  return presets;
}

export async function listMemberPresets(
  directory: string,
): Promise<MemberPresetsStatus["presets"]> {
  return (await presetEntries(directory)).map(({ id, name, error }) => ({
    id,
    name,
    ...(error ? { error } : {}),
  }));
}

export function selectedMemberPresetId(store: WorkspaceStore) {
  return (
    store.db
      .select()
      .from(memberPresetSettings)
      .where(eq(memberPresetSettings.id, 1))
      .get()?.presetId ?? defaultMemberPresetId
  );
}

export function saveMemberPresetId(store: WorkspaceStore, presetId: string) {
  store.db
    .insert(memberPresetSettings)
    .values({ id: 1, presetId })
    .onConflictDoUpdate({ target: memberPresetSettings.id, set: { presetId } })
    .run();
}

export async function memberPresetsStatus(
  directory: string | undefined,
  store: WorkspaceStore,
): Promise<MemberPresetsStatus> {
  const current = selectedMemberPresetId(store);
  if (!directory)
    return {
      presets: [],
      current,
      currentError:
        "Member model presets are not configured for this instance.",
    };
  const presets = await listMemberPresets(directory);
  const entry = presets.find((preset) => preset.id === current);
  if (!entry)
    return {
      presets,
      current,
      currentError: `Member preset ${current} is missing. Add ${join(directory, `${current}.toml`)} or select another preset.`,
    };
  return entry.error
    ? { presets, current, currentError: entry.error }
    : { presets, current };
}

// Validate the selected file before writing; the completed write is authoritative.
export async function selectMemberPreset(
  directory: string | undefined,
  store: WorkspaceStore,
  id: string,
): Promise<MemberPresetsStatus> {
  if (!directory)
    throw new Error(
      "Member model presets are not configured for this instance.",
    );
  const entry = (await listMemberPresets(directory)).find(
    (preset) => preset.id === id,
  );
  if (!entry)
    throw new Error(
      `Member preset ${id} was not found. Refresh the list and try again.`,
    );
  if (entry.error) throw new Error(entry.error);
  saveMemberPresetId(store, id);
  return memberPresetsStatus(directory, store);
}

// New members resolve the current preset with the same validity rule the UI
// reports; a broken or ambiguous selection never dispatches and never falls back.
export async function currentMemberPreset(
  directory: string | undefined,
  store: WorkspaceStore,
): Promise<MemberPreset> {
  if (!directory)
    throw new Error(
      "Member model presets are not configured for this instance.",
    );
  const id = selectedMemberPresetId(store);
  const entry = (await presetEntries(directory)).find(
    (preset) => preset.id === id,
  );
  if (!entry)
    throw new Error(
      `Member preset ${id} is missing. Add ${join(directory, `${id}.toml`)} or select another preset.`,
    );
  if (entry.error || !entry.preset)
    throw new Error(entry.error ?? `Member preset ${id} is unreadable.`);
  return entry.preset;
}
