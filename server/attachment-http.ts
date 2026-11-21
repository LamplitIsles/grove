import type { HostService } from "./hosts";
import { authorizeRead } from "./peer-http";
import { browserOrigin } from "./browser-origin";

function closeInput(request: Request, headers: Headers) {
  headers.set("Connection", "close");
  try {
    void request.body?.cancel().catch(() => {});
  } catch {
    /* The reader may already own the body. */
  }
}

export async function attachmentHttp(
  request: Request,
  service: HostService,
  origins: string[],
  human?: import("./auth").HumanSession | null,
) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/attachments")) return;
  const download = /^\/api\/attachments\/([a-f0-9]{64})\/download$/.exec(
    url.pathname,
  );
  if (download && request.method === "GET") {
    if (
      request.headers.get("sec-fetch-site") !== "same-origin" ||
      !browserOrigin(request, origins)
    )
      return Response.json(
        { error: "Open FlickGrove from its configured address" },
        { status: 403 },
      );
    try {
      const { file, path } = await service.downloadAttachment(
        url.searchParams.get("agent") ?? "",
        download[1],
      );
      const fallback =
        file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 150) ||
        "attachment";
      const encoded = encodeURIComponent(file.name).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return new Response(Bun.file(path), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
          "Content-Length": String(file.bytes),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return Response.json(
        { error: "Attachment unavailable" },
        { status: 404 },
      );
    }
  }
  const auth = authorizeRead(request, service, origins, [
    "POST",
    "PUT",
    "DELETE",
  ]);
  if (auth instanceof Response) {
    if (request.method === "PUT") closeInput(request, auth.headers);
    return auth;
  }
  const { respond, headers } = auth;
  const agent = url.searchParams.get("agent") ?? "";
  const operation = url.searchParams.get("operation") ?? "";
  try {
    if (request.method === "DELETE" && url.pathname === "/api/attachments") {
      await service.discardAttachments(agent, operation, human?.user.id);
      return respond({ agent, operation });
    }
    if (request.method === "POST" && url.pathname === "/api/attachments") {
      if (
        !request.headers.get("content-type")?.startsWith("application/json")
      ) {
        closeInput(request, headers);
        return respond({ error: "Use an attachment manifest" }, 415);
      }
      if (Number(request.headers.get("content-length")) > 700_000) {
        closeInput(request, headers);
        return respond({ error: "Attachment manifest too large" }, 413);
      }
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 700_000) {
              await reader.cancel();
              headers.set("Connection", "close");
              return respond({ error: "Attachment manifest too large" }, 413);
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const body = new TextDecoder().decode(Buffer.concat(chunks));
      service.beginAttachments(
        agent,
        operation,
        JSON.parse(body),
        human?.user.id,
      );
      return respond({ agent, operation });
    }
    const put = /^\/api\/attachments\/(0|[1-9][0-9]*)$/.exec(url.pathname);
    if (request.method === "PUT" && put) {
      await service.putAttachment(
        agent,
        operation,
        Number(put[1]),
        request.body,
        human?.user.id,
      );
      return respond({ agent, operation, index: Number(put[1]) });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/attachments/complete"
    ) {
      const result = await service.completeAttachments(
        agent,
        operation,
        human?.user.id,
      );
      return respond({ agent, operation, ...result });
    }
    if (request.method === "PUT") closeInput(request, headers);
    return respond({ error: "Attachment action not found" }, 404);
  } catch (error) {
    if (request.method === "PUT") closeInput(request, headers);
    return respond(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not prepare attachment",
      },
      400,
    );
  }
}
