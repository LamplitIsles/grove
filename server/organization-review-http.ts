import { browserOrigin } from "./browser-origin";
import type { HostService } from "./hosts";
import {
  organizationKey,
  organizationReviewSettings,
  type OrganizationReviewStore,
} from "./organization-review";
import type { Project } from "../src/contracts";

export type OrganizationReviewOptions = {
  store: OrganizationReviewStore;
  environments: () => Promise<Array<{ id: string; name: string }>>;
  projects: (id: string) => Promise<Project[]>;
};

export async function organizationReviewHttp(
  request: Request,
  service: HostService,
  origins: string[],
  options: OrganizationReviewOptions | undefined,
  authenticated: boolean,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/organization-review-settings") return;
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
      if (!options) throw new Error("Settings unavailable");
      return respond(
        await organizationReviewSettings(
          options.store,
          options.environments,
          options.projects,
        ),
      );
    } catch {
      return respond(
        { error: "Could not load organization review settings" },
        500,
      );
    }
  }
  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond({ error: "Check the values and try again" }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      typeof (body as Record<string, unknown>).enabled !== "boolean"
    )
      return respond({ error: "Check the values and try again" }, 400);
    const organization = organizationKey(
      (body as Record<string, unknown>).organization,
    );
    if (!organization)
      return respond({ error: "Check the values and try again" }, 400);
    const enabled = (body as { enabled: boolean }).enabled;
    try {
      if (!options) throw new Error("Settings unavailable");
      await options.store.write(organization, enabled);
      return respond({ organization, enabled });
    } catch {
      return respond(
        {
          error: "Could not confirm organization review setting",
          code: "setting_save_unconfirmed",
        },
        500,
      );
    }
  }
  return respond({ error: "Method denied" }, 405);
}
