import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registryDecision,
  snapshotManifest,
  snapshotVersion,
} from "./snapshot-publish.mjs";

const old = "a".repeat(40),
  current = "b".repeat(40);
const version = snapshotVersion("0.1.0", current);
const previous = snapshotVersion("0.1.0", old);
const ancestor = (a, b) => (a === old && b === current) || a === b;
const metadata = (latest, versions) => ({ "dist-tags": { latest }, versions });

test("snapshot identity is tied to the complete commit", () => {
  assert.equal(version, `0.1.0-snapshot.g${current}`);
  assert.throws(() => snapshotVersion("0.1.0", "abc"));
  assert.throws(() =>
    snapshotManifest({ name: "other", version: "0.1.0" }, current),
  );
  assert.equal(
    snapshotManifest(
      { name: "@lamplitisles/flickgrove", version: "0.1.0" },
      current,
    ).version,
    version,
  );
});

test("registry decisions require matching integrity and monotonic ancestry", () => {
  assert.equal(
    registryDecision(null, version, "integrity", current, ancestor),
    "publish",
  );
  assert.equal(
    registryDecision(
      metadata(previous, { [previous]: {} }),
      version,
      "integrity",
      current,
      ancestor,
    ),
    "publish",
  );
  assert.equal(
    registryDecision(
      metadata(version, { [version]: { dist: { integrity: "integrity" } } }),
      version,
      "integrity",
      current,
      ancestor,
    ),
    "skip",
  );
  assert.throws(() =>
    registryDecision(
      metadata(version, { [version]: { dist: { integrity: "different" } } }),
      version,
      "integrity",
      current,
      ancestor,
    ),
  );
  assert.throws(() =>
    registryDecision(
      metadata(previous, {
        [previous]: {},
        [version]: { dist: { integrity: "integrity" } },
      }),
      version,
      "integrity",
      current,
      ancestor,
    ),
  );
  assert.throws(() =>
    registryDecision(
      metadata(snapshotVersion("0.1.0", "c".repeat(40)), {}),
      version,
      "integrity",
      current,
      ancestor,
    ),
  );
  assert.throws(() =>
    registryDecision(
      { versions: { [previous]: {} } },
      version,
      "integrity",
      current,
      ancestor,
    ),
  );
});
