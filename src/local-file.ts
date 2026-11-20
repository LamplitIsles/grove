export type LocalFile = {
  path: string;
  fragment: string;
  kind: "image" | "document";
  source?: true;
  line?: number;
};
export const sourceExtensions = [
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "py",
  "pyi",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "hxx",
  "cs",
  "swift",
  "rb",
  "php",
  "lua",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "css",
  "scss",
  "sass",
  "less",
  "svelte",
  "vue",
];
export function isSourceFile(path: string) {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1].toLowerCase();
  return !!extension && sourceExtensions.includes(extension);
}
// Link decoding happens once here; filesystem/resource paths are never URLs to proxy.
export function localFile(href: string): LocalFile | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  let value = href;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.host && url.host !== "localhost") return null;
      value = url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  }
  const fragment = value.includes("#") ? value.slice(value.indexOf("#")) : "";
  try {
    const encodedPath = value.split(/[?#]/)[0];
    const suffix = /:(\d+)$/.exec(encodedPath);
    const path = decodeURIComponent(
      suffix ? encodedPath.slice(0, suffix.index) : encodedPath,
    );
    if (!path || /[\0\\]/.test(path)) return null;
    const source = isSourceFile(path);
    const scheme = /^[a-z][a-z\d+.-]*:/i.exec(encodedPath);
    if (scheme && !(source && suffix && scheme[0].length - 1 === suffix.index))
      return null;
    if (suffix && !source) return null;
    const line = suffix ? Number(suffix[1]) : undefined;
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1))
      return null;
    const extension = /\.([a-z]+)$/i.exec(path)?.[1].toLowerCase();
    const kind =
      extension && ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)
        ? "image"
        : extension && ["html", "htm", "md", "markdown"].includes(extension)
          ? "document"
          : source
            ? "document"
            : null;
    if (!kind) return null;
    return source
      ? {
          path,
          fragment: "",
          kind,
          source: true,
          ...(line === undefined ? {} : { line }),
        }
      : { path, fragment, kind };
  } catch {
    return null;
  }
}
