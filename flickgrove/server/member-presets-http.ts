import { browserOrigin } from "./browser-origin";
import type { HostService } from "./hosts";
import type { SocketData } from "./chord-socket";
import { z } from "zod";

// Authenticated instance-shared member preset selection; never secret material.
export async function memberPresetsHttp(
  request: Request,
  service: HostService,
  origins: string[],
  authData?: Pick<SocketData, "auth" | "human" | "authHeaders">,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/member-presets") return;
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
  // The browser's observed instance identity must match before any read or write.
  if (request.headers.get("x-grove-peer") !== service.identity.id)
    return respond({ error: "Peer identity changed" }, 403);
  if (!authData?.auth || !authData.human)
    return respond({ error: "Authentication required" }, 401);
  const workspace = service.workspace;
  if (request.method === "GET") {
    try {
      return respond(await workspace.memberPresetsStatus());
    } catch {
      return respond({ error: "Could not read member presets" }, 500);
    }
  }
  if (request.method !== "PUT") return respond({ error: "Method denied" }, 405);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond({ error: "Check the values and try again" }, 400);
  }
  const value = z
    .object({ preset: z.string().trim().min(1) })
    .strict()
    .safeParse(body);
  if (!value.success)
    return respond({ error: "Check the values and try again" }, 400);
  try {
    return respond(await workspace.selectMemberPreset(value.data.preset));
  } catch (error) {
    return respond(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not save the member preset",
      },
      400,
    );
  }
}
