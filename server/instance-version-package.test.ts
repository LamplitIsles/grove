import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceVersion } from "./instance-version";

test("packaged version requires matching valid source and asset identities", () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-package-version-"));
  const assets = join(dir, "dist");
  const commit = "a".repeat(40);
  try {
    mkdirSync(assets);
    writeFileSync(join(dir, "source.json"), JSON.stringify({ commit }));
    writeFileSync(
      join(assets, "version.json"),
      JSON.stringify({ commit, dirty: false }),
    );
    expect(instanceVersion(dir, assets)).toBe("aaaaaaa");
    writeFileSync(
      join(assets, "version.json"),
      JSON.stringify({ commit: "b".repeat(40), dirty: false }),
    );
    expect(instanceVersion(dir, assets)).toBeNull();
    writeFileSync(
      join(dir, "source.json"),
      JSON.stringify({ commit: "not-a-sha" }),
    );
    expect(instanceVersion(dir, assets)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
