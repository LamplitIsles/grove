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
import { validVoiceKey } from "./voice-config";

const filename = (configPath: string) =>
  join(dirname(configPath), "context7-api-key");
export const validContext7Key = validVoiceKey;

// Read on every call so rotation takes effect for already-running sessions.
export function readContext7Key(configPath?: string): string | undefined {
  if (!configPath) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(filename(configPath), "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 || stat.mode & 0o077)
      throw new Error("Invalid key file");
    const bytes = Buffer.alloc(1025);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    const key = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, size))
      .trim();
    if (size > 1024 || !validContext7Key(key))
      throw new Error("Invalid key file");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Could not read Context7 settings");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeContext7Key(configPath: string, key: string): void {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.context7-key-${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temp, "wx", 0o600);
    created = true;
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, key, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(temp, filename(configPath));
    created = false;
  } finally {
    if (created)
      try {
        unlinkSync(temp);
      } catch {
        /* preserve original error */
      }
  }
}
export function deleteContext7Key(configPath: string): void {
  try {
    unlinkSync(filename(configPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
