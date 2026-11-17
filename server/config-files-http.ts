import { browserOrigin } from "./browser-origin";
import type { HostService } from "./hosts";
import type { SocketData } from "./chord-socket";

// Authenticated listing of known configuration locations; never file contents.
export async function configFilesHttp(
  request: Request,
  service: HostService,
  origins: string[],
  authData?: Pick<SocketData, "auth" | "human" | "authHeaders">,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/config-files") return;
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Grove-Peer": service.identity.id,
    Vary: "Origin",
  });
  const respond = (value: unknown, status = 200) =>
    Response.json(value, { status, headers });
  if (!origins.some((o) => new URL(o).host === url.host))
    return respond({ error: "Wrong Peer address" }, 403);
  const origin = browserOrigin(request, origins);
  if (!origin || !origins.includes(origin))
    return respond(
      { error: "Open FlickGrove from its configured address" },
      403,
    );
  // The browser's observed instance identity must match before any read.
  if (request.headers.get("x-grove-peer") !== service.identity.id)
    return respond({ error: "Peer identity changed" }, 403);
  if (!authData?.auth || !authData.human)
    return respond({ error: "Authentication required" }, 401);
  if (request.method !== "GET") return respond({ error: "Method denied" }, 405);
  try {
    return respond(await service.workspace.configFiles());
  } catch {
    return respond({ error: "Could not list the configuration files" }, 500);
  }
}
