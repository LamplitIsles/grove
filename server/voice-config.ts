import {
  closeSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { voiceSettings } from "./schema";
import type { WorkspaceStore } from "./workspace-store";
import type { VoiceRegion } from "./voice";

export function validVoiceKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    Buffer.byteLength(value) <= 1024 &&
    !/\s|[\x00-\x1f\x7f]/u.test(value)
  );
}

export function voiceRegion(store: WorkspaceStore): VoiceRegion {
  const region = store.db
    .select()
    .from(voiceSettings)
    .where(eq(voiceSettings.id, 1))
    .get()?.region;
  if (region === undefined) return "beijing";
  if (region === "beijing" || region === "singapore") return region;
  throw new Error("Invalid saved voice region");
}

// Each snapshot is read synchronously so it cannot interleave with a save.
export function readVoiceKey(
  configPath: string | undefined,
): string | undefined {
  if (!configPath) return;
  let fd: number | undefined;
  try {
    fd = openSync(join(dirname(configPath), "voice-api-key"), "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 || stat.mode & 0o077) return;
    const buffer = Buffer.alloc(1025);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 1024) return;
    const key = new TextDecoder("utf-8", { fatal: true })
      .decode(buffer.subarray(0, size))
      .trim();
    return validVoiceKey(key) ? key : undefined;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function voiceSettingsStatus(
  store: WorkspaceStore,
  configPath?: string,
) {
  return {
    region: voiceRegion(store),
    configured: !!readVoiceKey(configPath),
  };
}

export function writeVoiceKey(configPath: string, key: string) {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.voice-key-${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, key, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(directory, "voice-api-key"));
    created = false;
  } finally {
    if (created)
      try {
        unlinkSync(temporary);
      } catch {
        /* preserve original error */
      }
  }
}

export function saveVoiceRegion(store: WorkspaceStore, region: VoiceRegion) {
  store.db
    .insert(voiceSettings)
    .values({ id: 1, region })
    .onConflictDoUpdate({ target: voiceSettings.id, set: { region } })
    .run();
}
