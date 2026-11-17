import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("uncertain registry and publish outcomes never cause a blind replay", () => {
  const root = mkdtempSync(join(tmpdir(), "grove-publish-fixture-"));
  const sha = "a".repeat(40);
  const version = `0.1.0-snapshot.g${sha}`;
  const manifest = { name: "@lamplitisles/flickgrove", version };
  const write = (path, content, mode) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, mode ? { mode } : undefined);
  };
  try {
    write(".snapshot-artifacts/package/package.json", JSON.stringify(manifest));
    write("tar/package/package.json", JSON.stringify(manifest));
    write("tar/package/source.json", JSON.stringify({ commit: sha }));
    write(
      "tar/package/dist/version.json",
      JSON.stringify({ commit: sha, dirty: false }),
    );
    execFileSync("tar", [
      "-czf",
      join(root, "snapshot.tgz"),
      "-C",
      join(root, "tar"),
      "package",
    ]);
    const integrity = `sha512-${createHash("sha512")
      .update(readFileSync(join(root, "snapshot.tgz")))
      .digest("base64")}`;
    write(
      "bin/git",
      `#!/bin/sh\nif [ "$1" = rev-parse ]; then printf '%s\\n' '${sha}'; fi\nexit 0\n`,
      0o700,
    );
    write(
      "bin/npm",
      '#!/bin/sh\nprintf "called\\n" >> "$FIXTURE_CALLS"\nexit 1\n',
      0o700,
    );
    write(
      "preload.mjs",
      `globalThis.fetch = async () => {
      if (process.env.SCENARIO === 'unknown') throw new Error('synthetic network failure');
      if (process.env.SCENARIO === 'existing') return Response.json({ 'dist-tags': { latest: process.env.VERSION }, versions: { [process.env.VERSION]: { dist: { integrity: process.env.INTEGRITY } } } });
      return new Response('', { status: 404 });
    };`,
    );
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "snapshot-publish.mjs",
    );
    const run = (scenario) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          join(root, "preload.mjs"),
          script,
          "publish",
          join(root, "snapshot.tgz"),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: `${join(root, "bin")}:/usr/bin:/bin`,
            HOME: root,
            CI_COMMIT_SHA: sha,
            FORGEJO_PACKAGES_TOKEN: "fixture-token",
            FIXTURE_CALLS: join(root, "calls"),
            VERSION: version,
            INTEGRITY: integrity,
            SCENARIO: scenario,
          },
        },
      );
    assert.notEqual(run("unknown").status, 0);
    assert.equal(run("existing").status, 0);
    assert.notEqual(run("publish-failure").status, 0);
    assert.equal(readFileSync(join(root, "calls"), "utf8"), "called\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
