import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Project } from "../src/contracts";

// The same owner syntax as remoteOwner; the bounded input also keeps HTTP and
// stored records manageable. Hashes avoid filesystem filename length limits.
export function organizationKey(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^[a-z0-9][a-z0-9_.-]*$/i.test(value)
  )
    return;
  return value.toLowerCase();
}

export class OrganizationReviewStore {
  private readonly directory: string;
  constructor(instanceDirectory: string) {
    this.directory = join(instanceDirectory, "organization-review");
  }
  private key(owner: string) {
    if (organizationKey(owner) !== owner)
      throw new Error("Invalid organization");
    return join(
      this.directory,
      `${createHash("sha256").update(owner).digest("hex")}.json`,
    );
  }
  private checkDirectory(create: boolean) {
    if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      const stat = lstatSync(this.directory);
      if (
        !stat.isDirectory() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.mode & 0o077
      )
        throw new Error("Invalid organization review directory");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create)
        return false;
      throw error;
    }
  }
  async readEnabled(owner: string): Promise<boolean> {
    const path = this.key(owner);
    if (!this.checkDirectory(false)) return false;
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.mode & 0o077 ||
        stat.size > 8192
      )
        throw new Error("Invalid organization review setting file");
      const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        (value as Record<string, unknown>).organization !== owner ||
        typeof (value as Record<string, unknown>).enabled !== "boolean"
      )
        throw new Error("Invalid organization review setting");
      return (value as { enabled: boolean }).enabled;
    } finally {
      closeSync(fd);
    }
  }
  async write(owner: string, enabled: boolean): Promise<void> {
    const path = this.key(owner);
    if (typeof enabled !== "boolean") throw new Error("Invalid setting");
    this.checkDirectory(true);
    const temporary = join(this.directory, `.tmp-${crypto.randomUUID()}`);
    let created = false;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      created = true;
      try {
        writeFileSync(fd, JSON.stringify({ organization: owner, enabled }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      created = false;
      const dir = openSync(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (created)
        try {
          unlinkSync(temporary);
        } catch {
          /* preserve write error */
        }
    }
  }
}

export async function organizationReviewSettings(
  store: Pick<OrganizationReviewStore, "readEnabled">,
  environments: () => Promise<Array<{ id: string; name: string }>>,
  projects: (id: string) => Promise<Project[]>,
) {
  const entries = await environments();
  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const catalogue = await projects(entry.id);
      return catalogue.flatMap((project) => {
        if (project.owner == null) return [];
        const owner = organizationKey(project.owner);
        if (!owner) throw new Error("Invalid project organization");
        return [owner];
      });
    }),
  );
  if (!results.some((result) => result.status === "fulfilled"))
    throw new Error("No project catalogues available");
  const unavailableEnvironments = entries
    .filter((_, i) => results[i]?.status === "rejected")
    .map(({ id, name }) => ({ id, name }));
  const owners = [
    ...new Set(
      results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const organizations = await Promise.all(
    owners.map(async (organization) => ({
      organization,
      enabled: await store.readEnabled(organization),
    })),
  );
  return { organizations, unavailableEnvironments };
}
