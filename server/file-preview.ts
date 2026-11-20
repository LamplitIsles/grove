import { browserOrigin } from "./browser-origin";
import { previewMarkdown } from "./preview-markdown";
import { previewSource } from "./preview-source";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep, posix } from "node:path";
import { environmentId } from "../src/project-identity";
import type { Project } from "../src/contracts";
import { z } from "zod";
import { isSourceFile, localFile, sourceExtensions } from "../src/local-file";
import type { HostService } from "./hosts";
import type { GroveAuth, HumanSession } from "./auth";

export const PREVIEW_BYTES = 20 * 1024 * 1024;
export const PREVIEW_TTL = 15 * 60 * 1000;
const SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_LINES = 50_000;
const types: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
const within = (root: string, path: string) =>
  path.startsWith(root.endsWith(sep) ? root : root + sep);
function clean(path: string) {
  if (/[\0\\]/.test(path) || path.split("/").includes(".."))
    throw new Error("File is outside the preview directory");
}
function previewType(path: string, source: boolean, extension = extname) {
  const type = source
    ? isSourceFile(path)
      ? "text/plain; charset=utf-8"
      : undefined
    : types[extension(path).toLowerCase()];
  if (!type) throw new Error("File type is not supported");
  return type;
}
function sourceText(bytes: Buffer) {
  if (bytes.length > SOURCE_BYTES) throw new Error("File exceeds 2 MiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Source file must be UTF-8 text");
  }
  if (text.split(/\r\n?|\n/).length > SOURCE_LINES)
    throw new Error("File exceeds 50,000 lines");
  return text;
}
async function read(
  root: string,
  target: string,
  source = false,
  expected?: string,
) {
  if ((await realpath(root)) !== root)
    throw new Error("Preview directory changed");
  const canonical = await realpath(target);
  if (expected && canonical !== expected)
    throw new Error("Preview file changed");
  if (!within(root, canonical))
    throw new Error("File is outside the preview directory");
  const type = previewType(canonical, source);
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Only regular files can be previewed");
    const limit = source ? SOURCE_BYTES : PREVIEW_BYTES;
    if (stat.size > limit)
      throw new Error(source ? "File exceeds 2 MiB" : "File exceeds 20 MiB");
    // Read at most budget + 1 even if the file grows after stat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > limit || size > stat.size)
      throw new Error("File changed while reading; retry");
    if (
      (await realpath(target)) !== canonical ||
      (await realpath(root)) !== root
    )
      throw new Error("Preview directory changed");
    return { bytes: bytes.subarray(0, size), type, canonical };
  } finally {
    await handle.close();
  }
}
export function filePreview(
  service: HostService,
  now = Date.now,
  authProvider?: () => GroveAuth | undefined,
) {
  const grants = new Map<
    string,
    {
      root: string;
      expires: number;
      project?: Project;
      sessionId?: string;
      source?: { target: string; line?: number };
    }
  >();
  const remote = async (
    project: Project,
    request: Record<string, unknown>,
    source = false,
  ) => {
    const value = z
      .object({
        canonical: z.string(),
        root: z.string().optional(),
        bytes: z.string().max(Math.ceil(((PREVIEW_BYTES + 1) * 4) / 3) + 4),
      })
      .parse(
        await service.remoteProjectRead(project, {
          ...request,
          extensions: source
            ? sourceExtensions.map((ext) => `.${ext}`)
            : Object.keys(types),
          ...(source ? { maxBytes: SOURCE_BYTES } : {}),
        }),
      );
    const type = previewType(value.canonical, source, posix.extname);
    const bytes = Buffer.from(value.bytes, "base64");
    if (bytes.length > (source ? SOURCE_BYTES : PREVIEW_BYTES))
      throw new Error(source ? "File exceeds 2 MiB" : "File exceeds 20 MiB");
    return { ...value, bytes, type };
  };
  return async (
    request: Request,
    origins: string[],
    human?: HumanSession | null,
  ): Promise<Response | undefined> => {
    const auth = authProvider?.();
    const url = new URL(request.url);
    const resource = url.pathname.startsWith("/preview/");
    if (!resource && url.pathname !== "/api/file-preview") return;
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Grove-Peer": service.identity.id,
    });
    const fail = (error: string, status = 400) =>
      Response.json({ error }, { status, headers });
    if (!origins.some((o) => new URL(o).host === url.host))
      return fail("Wrong Peer address", 403);
    for (const [id, grant] of grants)
      if (grant.expires <= now()) grants.delete(id);
    try {
      if (resource) {
        const match = /^\/preview\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
        const grant = match && grants.get(match[1]);
        const active = () =>
          !!grant &&
          grant.expires > now() &&
          (!auth || (!!grant.sessionId && auth.sessionActive(grant.sessionId)));
        if (!grant || !active()) {
          if (match) grants.delete(match[1]);
          return fail(
            "Preview expired or unavailable. Retry from the conversation.",
            410,
          );
        }
        if (request.method !== "GET" && request.method !== "HEAD")
          return fail("Read only", 405);
        const path = decodeURIComponent(match![2]);
        clean(path);
        if (path.startsWith("/"))
          return fail("File is outside the preview directory", 403);
        const target = posix.resolve(grant.root, path);
        if (grant.source && target !== grant.source.target)
          return fail("File is outside the preview grant", 403);
        const file = grant.project
          ? await remote(
              grant.project,
              {
                operation: "preview-read",
                root: grant.root,
                target,
                ...(grant.source ? { expected: grant.source.target } : {}),
              },
              !!grant.source,
            )
          : await read(
              grant.root,
              resolve(grant.root, path),
              !!grant.source,
              grant.source?.target,
            );
        if (grant.source && file.canonical !== grant.source.target)
          throw new Error("Preview file changed");
        // The read can cross an async local or remote boundary; a revoked session
        // must not receive bytes that finished loading after revocation.
        if (!active()) {
          grants.delete(match![1]);
          return fail(
            "Preview expired or unavailable. Retry from the conversation.",
            410,
          );
        }
        headers.set("Content-Type", file.type);
        headers.set("Access-Control-Allow-Origin", "*");
        const markdown = file.type.startsWith("text/markdown");
        const bytes = grant.source
          ? previewSource(
              sourceText(file.bytes),
              basename(grant.source.target),
              grant.source.line,
            )
          : markdown
            ? previewMarkdown(
                file.bytes.toString("utf8"),
                grant.root,
                resolve(grant.root, path),
                `/preview/${match![1]}/`,
              )
            : file.bytes;
        if (markdown || grant.source)
          headers.set("Content-Type", "text/html; charset=utf-8");
        if (grant.source)
          headers.set(
            "Content-Security-Policy",
            "sandbox; default-src 'none'; style-src 'unsafe-inline'",
          );
        else if (markdown || file.type.startsWith("text/html"))
          headers.set("Content-Security-Policy", "sandbox allow-scripts");
        return new Response(request.method === "HEAD" ? null : bytes, {
          headers,
        });
      }
      if (auth && !human) return fail("Authentication required", 401);
      const origin = browserOrigin(request, origins);
      if (!origin)
        return fail("Open FlickGrove from its configured address", 403);
      if (request.headers.get("x-grove-peer") !== service.identity.id)
        return fail("Peer identity changed", 403);
      if (request.method !== "POST") return fail("Method denied", 405);
      if (Number(request.headers.get("content-length")) > 8192)
        return fail("Link too long", 413);
      const reader = request.body?.getReader();
      if (!reader) return fail("Choose a file link");
      let text = "";
      let size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 8192) {
            headers.set("Connection", "close");
            await reader.cancel();
            return fail("Link too long", 413);
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const body = JSON.parse(text);
      if (typeof body.agent !== "string" || typeof body.href !== "string")
        return fail("Choose a file link");
      const link = localFile(body.href);
      if (!link) return fail("File type is not supported");
      clean(link.path);
      const project = service.previewProject(body.agent);
      if (environmentId(project) !== "local") {
        // No remote path reaches host realpath/stat. The grant captures both
        // target identity and the canonical root returned by that device.
        const requested = posix.resolve(project.path, link.path);
        const file = await remote(
          project,
          {
            operation: "preview-grant",
            target: requested,
            allowed: [project.path],
          },
          !!link.source,
        );
        if (
          !file.root ||
          (link.source
            ? !isSourceFile(file.canonical)
            : !localFile(file.canonical) || isSourceFile(file.canonical))
        )
          throw new Error("File type is not supported");
        if (link.source) sourceText(file.bytes);
        if (auth && (!human || !auth.sessionActive(human.sessionId)))
          return fail("Authentication required", 401);
        const id =
          crypto.randomUUID().replaceAll("-", "") +
          crypto.randomUUID().replaceAll("-", "");
        if (grants.size >= 256) grants.delete(grants.keys().next().value!);
        grants.set(id, {
          root: file.root,
          project: structuredClone(project),
          expires: now() + PREVIEW_TTL,
          sessionId: human?.sessionId,
          ...(link.source
            ? { source: { target: file.canonical, line: link.line } }
            : {}),
        });
        return Response.json(
          {
            url: `${origin}/preview/${id}/${encodeURIComponent(posix.basename(file.canonical))}${link.source ? (link.line ? `#L${link.line}` : "") : link.fragment}`,
            kind: link.source ? "document" : localFile(file.canonical)!.kind,
          },
          { headers },
        );
      }
      const session = resolve(service.previewDirectory(body.agent));
      const requested = resolve(session, link.path);
      const target = await realpath(requested);
      // The catalogue belongs to this execution Peer. Failure cannot grant
      // cross-project access, but does not revoke the session's own directory.
      const projects = await service.projects().catch(() => []);
      let allowed = false;
      for (const path of [session, ...projects.map((p) => p.path)]) {
        const root = resolve(path);
        const canonical = await realpath(root).catch(() => undefined);
        if (canonical && within(canonical, target)) {
          allowed = true;
          break;
        }
      }
      if (!allowed)
        return fail(
          "File is outside the session and registered project directories",
          403,
        );
      if (
        link.source
          ? !isSourceFile(target)
          : !localFile(target) || isSourceFile(target)
      )
        return fail("File type is not supported");
      const root = dirname(target);
      const file = await read(
        root,
        target,
        !!link.source,
        link.source ? target : undefined,
      );
      if (link.source) sourceText(file.bytes);
      if (auth && (!human || !auth.sessionActive(human.sessionId)))
        return fail("Authentication required", 401);
      const id =
        crypto.randomUUID().replaceAll("-", "") +
        crypto.randomUUID().replaceAll("-", "");
      if (grants.size >= 256) grants.delete(grants.keys().next().value!);
      grants.set(id, {
        root,
        expires: now() + PREVIEW_TTL,
        sessionId: human?.sessionId,
        ...(link.source ? { source: { target, line: link.line } } : {}),
      });
      return Response.json(
        {
          url: `${origin}/preview/${id}/${encodeURIComponent(basename(target))}${link.source ? (link.line ? `#L${link.line}` : "") : link.fragment}`,
          kind: link.source ? "document" : localFile(target)!.kind,
        },
        { headers },
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return fail(
        code === "ENOENT"
          ? "File missing. Check the link and retry."
          : code === "EACCES"
            ? "File is not readable."
            : code
              ? "File is not readable. Check the link and retry."
              : error instanceof Error
                ? error.message
                : "Could not open file",
      );
    }
  };
}
