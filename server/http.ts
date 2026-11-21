import type { GroveAuth } from "./auth";
import { browserOrigin } from "./browser-origin";
import { readingHttp } from "./reading-http";
import { filePreview } from "./file-preview";
import { voiceHttp } from "./voice-http";
import { webSettingsHttp } from "./web-settings-http";
import {
  organizationReviewHttp,
  type OrganizationReviewOptions,
} from "./organization-review-http";
import { memberPresetsHttp } from "./member-presets-http";
import { configFilesHttp } from "./config-files-http";
import type { VoiceOptions } from "./voice";
import { imageHttp } from "./image-http";
import { attachmentHttp } from "./attachment-http";
import { MESSAGE_IMAGE_BYTES } from "./images";
import { FILE_BYTES } from "./attachments";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { Server } from "bun";
import type { Workspace } from "./workspace";
import { qualify, type HostService } from "./hosts";
import { groveWebsocket, type SocketData } from "./chord-socket";
import { externalMcp } from "./external-mcp";
export const REQUEST_BODY_BYTES = MESSAGE_IMAGE_BYTES + 700_000;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function limitBody(request: Request): Promise<Request | Response> {
  const path = new URL(request.url).pathname;
  const rawAttachment =
    request.method === "PUT" &&
    /^\/api\/attachments\/(0|[1-9][0-9]*)$/.test(path);
  if (rawAttachment || !request.body) return request;
  if (Number(request.headers.get("content-length")) > REQUEST_BODY_BYTES) {
    // Drain without buffering so a keep-alive client can receive the 413
    // without leaving unread request bytes on the connection. Bun still caps
    // the total body at FILE_BYTES for every route.
    try {
      const reader = request.body.getReader();
      while (!(await reader.read()).done) {
        /* discard */
      }
    } catch {
      /* A disconnected client has no response to receive. */
    }
    return Response.json(
      { error: "Request body too large" },
      {
        status: 413,
        headers: { "Cache-Control": "no-store", Connection: "close" },
      },
    );
  }
  let bytes = 0;
  const limited = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > REQUEST_BODY_BYTES)
          throw new Error("Request body too large");
        controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request, { body: limited, duplex: "half" } as RequestInit);
}
type Options = {
  instance?: import("./instance-controls").InstanceControls;
  voice?: VoiceOptions;
  origin: () => string;
  localOrigin?: () => string;
  assets?: string;
  service: HostService;
  auth?: GroveAuth;
  organizationReview?: OrganizationReviewOptions;
};
export function createUpgrade(workspace: Workspace, options: Options) {
  return (
    request: Request,
    server: Pick<Server<SocketData>, "upgrade">,
    human?: import("./auth").HumanSession | null,
  ): Response | true | undefined => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/socket") return;
    const origin = options.origin();
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((p) => p.trim());
    const origins = [origin, options.localOrigin?.()].filter(
      (value): value is string => !!value,
    );
    const local =
      request.headers.has("origin") && !!browserOrigin(request, origins);
    if (
      request.method !== "GET" ||
      !origins.some((value) => url.host === new URL(value).host)
    )
      return json(
        { error: "Open FlickGrove from its configured address" },
        403,
      );
    if (!local)
      return json(
        { error: "Open FlickGrove from its configured address" },
        403,
      );
    if (options.auth && !human)
      return json({ error: "Authentication required" }, 401);
    if (
      server.upgrade(request, {
        ...(protocols.includes("grove.v1")
          ? { headers: { "Sec-WebSocket-Protocol": "grove.v1" } }
          : {}),
        data: {
          app: options.service,
          service: options.service,
          auth: options.auth,
          human,
          authHeaders: request.headers,
        },
      })
    )
      return true;
    return json({ error: "WebSocket upgrade required" }, 400);
  };
}
export function createHandler(workspace: Workspace, options: Options) {
  const preview = filePreview(options.service, Date.now, () => options.auth);
  return async (request: Request): Promise<Response> => {
    const bounded = await limitBody(request);
    if (bounded instanceof Response) return bounded;
    request = bounded;
    const url = new URL(request.url);
    if (url.pathname === "/external-mcp") {
      const origins = [options.origin(), options.localOrigin?.()].filter(
        (value): value is string => !!value,
      );
      if (
        !origins.some((value) => url.host === new URL(value).host) ||
        (request.headers.has("origin") && !browserOrigin(request, origins))
      )
        return json({ error: "Wrong origin" }, 403);
      const token = /^Bearer (.+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      const user = token && options.auth?.externalTokenUser(token);
      if (!user) return json({ error: "Bearer authorization required" }, 401);
      return externalMcp(request, options.service, user);
    }
    const mcp = url.pathname.startsWith("/api/mcp/");
    const origin = mcp
      ? (options.localOrigin?.() ?? options.origin())
      : options.origin();
    const origins = mcp
      ? [origin]
      : [origin, options.localOrigin?.()].filter(
          (value): value is string => !!value,
        );
    let human: import("./auth").HumanSession | null | undefined;
    if (options.auth && !mcp) {
      if (url.pathname.startsWith("/api/auth/")) {
        if (!browserOrigin(request, origins))
          return json({ error: "Wrong origin" }, 403);
        return options.auth.handle(request, (user) =>
          workspace.updateHuman(user),
        );
      }
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname === "/member-presets" ||
        url.pathname === "/config-files"
      ) {
        human = await options.auth.session(request.headers);
        if (!human && url.pathname.startsWith("/api/")) {
          const response = json({ error: "Authentication required" }, 401);
          if (
            request.method === "PUT" &&
            url.pathname.startsWith("/api/attachments/")
          )
            response.headers.set("Connection", "close");
          return response;
        }
      }
    }
    // The preview handler validates each bearer grant against its issuing session.
    const file = await preview(request, origins, human);
    const voice = await voiceHttp(
      request,
      options.service,
      origins,
      options.voice,
      undefined,
      options.auth && human
        ? { auth: options.auth, human, authHeaders: request.headers }
        : undefined,
    );
    if (voice && voice !== true) return voice;
    const webSettings = await webSettingsHttp(
      request,
      options.service,
      origins,
      options.voice?.configPath,
      !!options.auth && !!human,
    );
    if (webSettings) return webSettings;
    const organizationReview = await organizationReviewHttp(
      request,
      options.service,
      origins,
      options.organizationReview,
      !!options.auth && !!human,
    );
    if (organizationReview) return organizationReview;
    if (file) return file;
    const reading = await readingHttp(request, options.service, origins);
    if (reading) return reading;
    const media = await imageHttp(request, options.service, origins);
    if (media) return media;
    const attachment = await attachmentHttp(
      request,
      options.service,
      origins,
      human,
    );
    if (attachment) return attachment;
    if (
      !origins.some((value) => url.host === new URL(value).host) ||
      (request.headers.get("origin") &&
        !origins.includes(request.headers.get("origin")!))
    )
      return json(
        { error: "Open FlickGrove from its configured address" },
        403,
      );
    try {
      if (url.pathname === "/api/external-mcp/token") {
        if (!options.auth || !human)
          return json({ error: "Authentication required" }, 401);
        if (!browserOrigin(request, origins))
          return json({ error: "Wrong origin" }, 403);
        if (
          request.method === "GET" ||
          request.method === "POST" ||
          request.method === "DELETE"
        ) {
          const result = options.auth.manageExternalToken(
            human,
            request.method,
          );
          return result
            ? json(result)
            : json({ error: "Authentication required" }, 401);
        }
        return json({ error: "Method denied" }, 405);
      }
      const presets = await memberPresetsHttp(
        request,
        options.service,
        origins,
        options.auth && human
          ? { auth: options.auth, human, authHeaders: request.headers }
          : undefined,
      );
      if (presets) return presets;
      const configFiles = await configFilesHttp(
        request,
        options.service,
        origins,
        options.auth && human
          ? { auth: options.auth, human, authHeaders: request.headers }
          : undefined,
      );
      if (configFiles) return configFiles;
      if (
        url.pathname === "/api/instance" ||
        url.pathname.startsWith("/api/instance/")
      ) {
        if (!options.auth || !human)
          return json({ error: "Authentication required" }, 401);
        if (!browserOrigin(request, origins))
          return json({ error: "Wrong origin" }, 403);
        if (!options.instance)
          return json({ error: "Instance controls unavailable" }, 503);
        if (request.method === "GET" && url.pathname === "/api/instance") {
          const status = await options.instance.status();
          return json({
            ...status,
            sessions: status.sessions.map((session) => ({
              ...session,
              id: qualify(options.service.identity.id, session.id),
            })),
          });
        }
        if (
          request.method === "POST" &&
          (url.pathname === "/api/instance/mcp/reload" ||
            url.pathname === "/api/instance/restart")
        ) {
          const body = await request.text();
          const confirmation = body
            ? z
                .object({
                  confirmBusy: z.literal(true),
                  instanceId: z.string().min(1),
                })
                .strict()
                .parse(JSON.parse(body))
            : undefined;
          return json(
            url.pathname.endsWith("/reload")
              ? await options.instance.reload(confirmation)
              : await options.instance.restart(confirmation),
          );
        }
        return json({ error: "Action not found" }, 404);
      }
      if (mcp) {
        const token = /^Bearer (.+)$/.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        if (!token) return json({ error: "Agent authorization required" }, 401);
        if (request.method === "GET" && url.pathname === "/api/mcp/info")
          return json(workspace.identity(token));
        if (request.method === "POST" && url.pathname === "/api/mcp/call") {
          const body = z
            .object({ name: z.string().min(1), arguments: z.unknown() })
            .parse(await request.json());
          return json(await workspace.tool(token, body.name, body.arguments));
        }
        return json({ error: "Tool action not found" }, 404);
      }
      if (request.method === "GET" && url.pathname === "/api/identity")
        return json(options.service.identity);
      if (url.pathname.startsWith("/api/"))
        return json({ error: "Action not found" }, 404);
      if (request.method !== "GET" || !options.assets)
        return json({ error: "Build the FlickGrove web app first" }, 404);
      const root = resolve(options.assets);
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (path !== root && !path.startsWith(root + sep))
        return json({ error: "Not found" }, 404);
      let file = Bun.file(path);
      if (!(await file.exists()) || url.pathname === "/")
        file = Bun.file(resolve(root, "index.html"));
      if (!(await file.exists()))
        return json(
          { error: "Run bun run build before starting FlickGrove" },
          503,
        );
      return new Response(file, {
        headers: {
          "Cache-Control": url.pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    } catch (error) {
      return json(
        {
          error:
            error instanceof z.ZodError
              ? "Check the values and try again"
              : error instanceof Error
                ? error.message
                : "Could not complete this action",
        },
        400,
      );
    }
  };
}

// Keep the actual HTTP listener configuration shared with isolated socket tests.
export function servePeer(
  workspace: Workspace,
  options: Options & { hostname: string; port: number },
) {
  const handler = createHandler(workspace, options);
  const upgrade = createUpgrade(workspace, options);
  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    idleTimeout: 0,
    maxRequestBodySize: FILE_BYTES,
    websocket: groveWebsocket,
    async fetch(request, server) {
      // Bun has one listener-wide limit; preserve the smaller limit before
      // voice handling too, which can consume a settings body here.
      const bounded = await limitBody(request);
      if (bounded instanceof Response) return bounded;
      request = bounded;
      const human =
        options.auth && new URL(request.url).pathname.startsWith("/api/voice/")
          ? await options.auth.session(request.headers)
          : undefined;
      if (
        options.auth &&
        new URL(request.url).pathname.startsWith("/api/voice/") &&
        !human
      )
        return json({ error: "Authentication required" }, 401);
      const voice = await voiceHttp(
        request,
        options.service,
        [options.origin(), options.localOrigin?.()].filter(
          (v): v is string => !!v,
        ),
        options.voice,
        server,
        options.auth
          ? { auth: options.auth, human: human!, authHeaders: request.headers }
          : undefined,
      );
      if (voice) return voice === true ? undefined : voice;
      const socketHuman =
        options.auth && new URL(request.url).pathname === "/api/socket"
          ? await options.auth.session(request.headers)
          : undefined;
      const result = upgrade(request, server, socketHuman);
      return result === true ? undefined : (result ?? handler(request));
    },
  });
}
