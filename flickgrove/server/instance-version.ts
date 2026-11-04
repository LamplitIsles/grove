import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type SourceVersion = { commit: string; dirty: boolean };

/** Capture once, before building assets or serving requests. */
export function sourceVersion(directory: string): SourceVersion | null {
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
    ])
      delete env[key];
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        timeout: 3000,
        env,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const commit = git("rev-parse", "--verify", "HEAD");
    if (!/^[0-9a-f]{40}$/.test(commit)) return null;
    const dirty = !!git("status", "--porcelain", "--untracked-files=no");
    return { commit, dirty };
  } catch {
    return null;
  }
}

export function matchingVersion(
  source: SourceVersion | null,
  asset: unknown,
): string | null {
  if (!source || source.dirty || !asset || typeof asset !== "object")
    return null;
  const value = asset as Partial<SourceVersion>;
  return value.dirty === false && value.commit === source.commit
    ? source.commit.slice(0, 7)
    : null;
}

export function instanceVersion(
  directory: string,
  assets: string,
): string | null {
  try {
    const asset: unknown = JSON.parse(
      readFileSync(resolve(assets, "version.json"), "utf8"),
    );
    const packaged = resolve(directory, "source.json");
    if (existsSync(packaged)) {
      const source: unknown = JSON.parse(readFileSync(packaged, "utf8"));
      if (!source || typeof source !== "object") return null;
      const commit = (source as { commit?: unknown }).commit;
      if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
        return null;
      return matchingVersion({ commit, dirty: false }, asset);
    }
    return matchingVersion(sourceVersion(directory), asset);
  } catch {
    return null;
  }
}
