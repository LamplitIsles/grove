import type { HostService } from "./hosts";
import { authorizeRead } from "./peer-http";
import { browserMessages, browserRecoveries } from "./browser-presentation";
export async function readingHttp(
  request: Request,
  service: HostService,
  origins: string[],
) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/read/")) return;
  const auth = authorizeRead(request, service, origins);
  if (auth instanceof Response) return auth;
  const { respond } = auth;
  if (request.method !== "GET") return respond({ error: "Method denied" }, 405);
  const p = url.searchParams;
  try {
    if (request.signal.aborted)
      return respond({ error: "Read cancelled" }, 408);
    const agent = p.get("agent") ?? "";
    const thread = p.get("thread") ?? "";
    const project = p.get("project") ?? "";
    const cursor = p.get("cursor") ?? undefined;
    switch (url.pathname) {
      case "/api/read/outline":
        return respond(service.userMessageOutline(agent));
      case "/api/read/window": {
        const page = await service.agentMessageWindow(agent, {
          operation: p.get("operation") ?? undefined,
          cursor,
          direction: p.get("direction") ?? undefined,
        });
        return respond({ ...page, messages: browserMessages(page.messages) });
      }
      case "/api/read/messages": {
        const page = agent
          ? await service.agentHistory(agent, cursor)
          : await service.historyMessages(project, thread, cursor);
        const role = agent
          ? (await service.detail(agent)).role
          : (await service.historySession(project, thread)).role;
        return respond(
          role === "orc"
            ? { ...page, messages: browserMessages(page.messages) }
            : page,
        );
      }
      case "/api/read/body": {
        const { role, message } = await service.browserBodyMessage(
          agent || undefined,
          project,
          thread,
          p.get("item") ?? "",
        );
        if (role === "orc" && !browserMessages([message]).length)
          return respond({ error: "Message body unavailable" }, 404);
        return respond({ text: message.text });
      }
      case "/api/read/deliveries": {
        return respond(service.browserRecoveryPage(agent, cursor));
      }
      case "/api/read/recovery": {
        const delivery = service.recovery(agent, p.get("operation") ?? "");
        if (
          (await service.detail(agent)).role === "orc" &&
          !browserRecoveries([delivery]).length
        )
          return respond({ error: "Delivery unavailable" }, 404);
        return respond(delivery);
      }
      case "/api/read/questions":
        return respond(
          agent
            ? service.questionHistory(agent, {
                item: p.get("item") ?? undefined,
                operation: p.get("operation") ?? undefined,
                pending: p.get("pending") === "true",
              })
            : await service.historyQuestions(project, thread, {
                item: p.get("item") ?? undefined,
                operation: p.get("operation") ?? undefined,
              }),
        );
      default:
        return respond({ error: "Reading action not found" }, 404);
    }
  } catch (error) {
    return respond(
      { error: error instanceof Error ? error.message : "Reading failed" },
      400,
    );
  }
}
