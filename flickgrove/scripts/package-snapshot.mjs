import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { snapshotManifest } from "./snapshot-publish.mjs";

const [target, assets, sha] = process.argv.slice(2);
if (!target || !assets || !/^[a-f0-9]{40}$/.test(sha ?? ""))
  throw new Error(
    "Usage: package-snapshot <new directory> <built assets> <full SHA>",
  );
const root = resolve(import.meta.dirname, "../..");
const app = join(root, "flickgrove");
const output = resolve(target);
const version = JSON.parse(
  await readFile(join(assets, "version.json"), "utf8"),
);
if (version?.commit !== sha || version.dirty !== false)
  throw new Error("Assets do not identify the clean requested source revision");
await mkdir(output); // Refuse to overwrite an existing artifact.
for (const dir of [
  "server",
  "src",
  "drizzle",
  "skills",
  "templates",
  "licenses",
]) {
  await cp(join(app, dir), join(output, dir), {
    recursive: true,
    filter: (path) =>
      !path.includes("/paraglide") && !/\.test\.[^.]+$/.test(path),
  });
}
await cp(assets, join(output, "dist"), { recursive: true });
const original = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
const {
  private: _,
  devDependencies: _devDependencies,
  scripts: _scripts,
  ...manifest
} = original;
for (const name of [
  "@fontsource/ibm-plex-mono",
  "@humanspeak/svelte-markdown",
  "@tanstack/highlight",
  "@tanstack/svelte-virtual",
  "fuzzysort",
  "katex",
  "mermaid",
  "svelte",
])
  delete manifest.dependencies[name]; // Already included in the browser build.
manifest.name = "@lamplitisles/flickgrove";
manifest.files = [
  "server",
  "src",
  "drizzle",
  "skills",
  "templates",
  "licenses",
  "dist",
  "source.json",
];
await writeFile(
  join(output, "package.json"),
  `${JSON.stringify(snapshotManifest(manifest, sha), null, 2)}\n`,
);
await writeFile(
  join(output, "source.json"),
  `${JSON.stringify({ commit: sha })}\n`,
);
await cp(join(root, "LICENSE"), join(output, "LICENSE"));
execFileSync(
  "npm",
  ["pack", "--ignore-scripts", "--pack-destination", resolve(output, "..")],
  { cwd: output, stdio: "inherit" },
);
