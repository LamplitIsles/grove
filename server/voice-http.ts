import { browserOrigin } from "./browser-origin";
import type { Server } from "bun";
import type { HostService } from "./hosts";
import type { SocketData } from "./chord-socket";
import type { VoiceOptions } from "./voice";
import {
  readVoiceKey,
  saveVoiceRegion,
  validVoiceKey,
  voiceRegion,
  voiceSettingsStatus,
  writeVoiceKey,
} from "./voice-config";
import type { VoiceRegion } from "./voice";

export async function voiceHttp(
  request: Request,
  service: HostService,
  origins: string[],
  options: VoiceOptions = {},
  server?: Pick<Server<SocketData>, "upgrade">,
  authData?: Pick<SocketData, "auth" | "human" | "authHeaders">,
): Promise<Response | true | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/voice/")) return;
  const stream = url.pathname === "/api/voice/stream";
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((p) => p.trim());
  const origin = browserOrigin(request, origins);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Grove-Peer": service.identity.id,
    Vary: "Origin",
  });
  const respond = (value: unknown, status = 200) =>
    Response.json(value, { status, headers });
  if (!origins.some((o) => new URL(o).host === url.host))
    return respond({ error: "Wrong Peer address" }, 403);
  if (!origin || !origins.includes(origin))
    return respond(
      { error: "Open FlickGrove from its configured address" },
      403,
    );
  const peerId = stream
    ? protocols.find((p) => p.startsWith("grove-peer."))?.slice(11)
    : request.headers.get("x-grove-peer");
  if (peerId !== service.identity.id)
    return respond({ error: "Peer identity changed" }, 403);
  const store = service.workspace.store;
  if (url.pathname === "/api/voice/settings") {
    if (!authData?.auth || !authData.human)
      return respond({ error: "Authentication required" }, 401);
    if (request.method === "GET") {
      try {
        return respond(voiceSettingsStatus(store, options.configPath));
      } catch {
        return respond({ error: "Could not read voice settings" }, 500);
      }
    }
    if (request.method !== "POST")
      return respond({ error: "Method denied" }, 405);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond({ error: "Check the values and try again" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return respond({ error: "Check the values and try again" }, 400);
    const values = body as Record<string, unknown>;
    if (
      (values.region !== "beijing" && values.region !== "singapore") ||
      (values.apiKey !== undefined && typeof values.apiKey !== "string") ||
      Object.keys(values).some((key) => key !== "region" && key !== "apiKey")
    )
      return respond({ error: "Check the values and try again" }, 400);
    const region = values.region as VoiceRegion;
    const key = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    if (key && !validVoiceKey(key))
      return respond({ error: "Invalid API key", code: "invalid_key" }, 400);
    let currentRegion: VoiceRegion;
    try {
      currentRegion = voiceRegion(store);
    } catch {
      return respond({ error: "Could not read voice settings" }, 500);
    }
    if (!key && (region !== currentRegion || !readVoiceKey(options.configPath)))
      return respond(
        {
          error: "An API key is required for this region",
          code: "key_required",
        },
        400,
      );
    if (key) {
      try {
        if (!options.configPath) throw new Error("Missing configuration path");
        writeVoiceKey(options.configPath, key);
      } catch {
        return respond(
          { error: "Could not save API key", code: "key_save_failed" },
          500,
        );
      }
    }
    try {
      saveVoiceRegion(store, region);
    } catch {
      return key
        ? respond(
            {
              error:
                "API key saved; region was not saved. Select the correct region and retry.",
              code: "key_saved_region_failed",
            },
            500,
          )
        : respond(
            { error: "Could not save region", code: "region_save_failed" },
            500,
          );
    }
    try {
      return respond(voiceSettingsStatus(store, options.configPath));
    } catch {
      return respond(
        {
          error: "Settings saved; could not read status",
          code: "settings_saved_status_failed",
        },
        500,
      );
    }
  }
  if (request.method !== "GET") return respond({ error: "Method denied" }, 405);
  if (url.pathname !== "/api/voice/capability" && !stream)
    return respond({ error: "Voice action not found" }, 404);
  let region: VoiceRegion;
  try {
    region = voiceRegion(store);
  } catch {
    return respond({ error: "Voice unavailable" }, 503);
  }
  const key = readVoiceKey(options.configPath);
  if (!stream)
    return respond(
      key
        ? { available: true }
        : { available: false, reason: "config_unavailable" },
    );
  if (!key) return respond({ error: "Voice unavailable" }, 503);
  if (!protocols.includes("grove-voice.v1") || !server)
    return respond({ error: "Voice WebSocket required" }, 400);
  if (
    server.upgrade(request, {
      headers: { "Sec-WebSocket-Protocol": "grove-voice.v1" },
      data: {
        app: service,
        service,
        voice: { key, region, peerId: service.identity.id, options },
        ...authData,
      },
    })
  )
    return true;
  return respond({ error: "WebSocket upgrade required" }, 400);
}
