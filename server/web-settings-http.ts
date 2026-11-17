import { browserOrigin } from "./browser-origin";
import type { HostService } from "./hosts";
import {
  deleteContext7Key,
  readContext7Key,
  validContext7Key,
  writeContext7Key,
} from "./web-config";

export async function webSettingsHttp(
  request: Request,
  service: HostService,
  origins: string[],
  configPath: string | undefined,
  authenticated: boolean,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/web/settings") return;
  const headers = {
    "Cache-Control": "no-store",
    "X-Grove-Peer": service.identity.id,
    Vary: "Origin",
  };
  const respond = (body: unknown, status = 200) =>
    Response.json(body, { status, headers });
  if (!origins.some((origin) => new URL(origin).host === url.host))
    return respond({ error: "Wrong Peer address" }, 403);
  const origin = browserOrigin(request, origins);
  if (!origin || !origins.includes(origin))
    return respond(
      { error: "Open FlickGrove from its configured address" },
      403,
    );
  if (request.headers.get("x-grove-peer") !== service.identity.id)
    return respond({ error: "Peer identity changed" }, 403);
  if (!authenticated) return respond({ error: "Authentication required" }, 401);
  if (request.method === "GET") {
    try {
      if (!configPath) throw new Error();
      return respond({ context7Configured: !!readContext7Key(configPath) });
    } catch {
      return respond({ error: "Could not read web settings" }, 500);
    }
  }
  if (request.method === "PUT") {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return respond({ error: "Check the values and try again" }, 400);
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof (value as Record<string, unknown>).context7ApiKey !== "string"
    )
      return respond({ error: "Check the values and try again" }, 400);
    const key = (
      (value as Record<string, unknown>).context7ApiKey as string
    ).trim();
    if (!validContext7Key(key))
      return respond({ error: "Invalid API key", code: "invalid_key" }, 400);
    try {
      if (!configPath) throw new Error();
      writeContext7Key(configPath, key);
      return respond({ context7Configured: true });
    } catch {
      return respond(
        { error: "Could not save API key", code: "key_save_failed" },
        500,
      );
    }
  }
  if (request.method === "DELETE") {
    try {
      if (!configPath) throw new Error();
      deleteContext7Key(configPath);
      return respond({ context7Configured: false });
    } catch {
      return respond(
        { error: "Could not delete API key", code: "key_delete_failed" },
        500,
      );
    }
  }
  return respond({ error: "Method denied" }, 405);
}
