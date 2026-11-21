import { authorizeRead } from "./peer-http";
import type { HostService } from "./hosts";
export async function imageHttp(
  request: Request,
  service: HostService,
  origins: string[],
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/images")) return;
  const auth = authorizeRead(request, service, origins);
  if (auth instanceof Response) return auth;
  const { headers, respond } = auth;
  try {
    const agent = url.searchParams.get("agent") ?? "";
    const match = /^\/api\/images\/([a-f0-9]{64})\/(preview|original)$/.exec(
      url.pathname,
    );
    if (match && request.method === "GET") {
      const image = service.media(agent, match[1], match[2] === "preview");
      if (!image) return respond({ error: "Image missing or unreadable" }, 404);
      headers.set("Content-Type", image.mediaType);
      return new Response(image.bytes, { headers });
    }
    return respond({ error: "Image action not found" }, 404);
  } catch (error) {
    return respond(
      {
        error:
          error instanceof Error ? error.message : "Could not prepare image",
      },
      400,
    );
  }
}
