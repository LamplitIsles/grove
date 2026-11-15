import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  parseProjectReference,
  projectReference,
} from "../src/project-identity";
import { isHiddenMemberDelivery } from "../src/conversation-projection";
import type { Agent, Delivery, Message } from "../src/contracts";
import type { Human } from "./auth";
import type { HostService } from "./hosts";
import { RequestRefused } from "./runtime";
import { FollowUpRejected } from "./workspace";
import type { HistoryReadBudget } from "./conversation-reading";

export const EXTERNAL_HISTORY_MAX_READS = 1024;

const id = z.string().min(1).max(500);
const text = z
  .string()
  .min(1)
  .max(100_000)
  .refine((value) => !!value.trim());
const cursor = z.string().max(4000).optional();
class TargetUnavailable extends Error {}
class ProjectUnavailable extends Error {}
function pageById<T extends { id: string }>(
  items: T[],
  next?: string,
  limit = 50,
) {
  const after = next ? Buffer.from(next, "base64url").toString("utf8") : "";
  const sorted = items.slice().sort((a, b) => a.id.localeCompare(b.id));
  const remaining = sorted.filter(
    (item) => !after || item.id.localeCompare(after) > 0,
  );
  const page = remaining.slice(0, limit);
  return {
    items: page,
    nextCursor:
      remaining.length > limit
        ? Buffer.from(page.at(-1)!.id).toString("base64url")
        : null,
  };
}
const publicSession = (a: Agent) => ({
  id: a.id,
  role: a.role,
  ownerId: a.ownerId,
  title: a.title,
  state: a.state,
  workUnconfirmed: a.workUnconfirmed,
  connection: a.connection?.state,
  project: {
    reference: projectReference(a.project),
    alias: a.project.alias,
    name: a.project.name,
    path: a.project.path,
    owner: a.project.owner,
    environment: a.project.environment ?? {
      id: "local",
      name: "This machine",
      target: "local",
    },
  },
});
const publicDelivery = (d: Delivery) => ({
  id: d.id,
  mode: d.mode,
  source: d.source,
  status: d.status,
  at: d.at,
  text: d.text,
  author: d.author,
  hasError: !!d.error,
  memberId:
    d.reportingWorkerId ?? d.reportingReviewerId ?? d.reportingResearcherId,
});
const publicMessage = (m: Message) => ({
  id: m.id,
  clientId: m.clientId,
  role: m.role,
  kind: m.kind,
  text: m.text,
  at: m.at,
  author: m.author,
  provisional: m.provisional,
  bodyRef: m.bodyRef,
  questionItemId: m.questionItemId,
  delivery: m.delivery && publicDelivery(m.delivery),
});
const payload = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const failure = (message: string, status?: "failed" | "unknown") => ({
  isError: true,
  ...payload({ error: message, ...(status ? { status } : {}) }),
});

async function builtinSkills() {
  const root = fileURLToPath(new URL("../skills/", import.meta.url));
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const body = await readFile(join(root, name, "SKILL.md"), "utf8");
      const header = /^---\s*\n([\s\S]*?)\n---/.exec(body)?.[1] ?? "";
      const description = /^description:\s*(.*)$/m.exec(header)?.[1] ?? "";
      return { name, description };
    }),
  );
}

// A fresh stateless transport per HTTP request avoids retaining bearer authority
// in a transport session. Each request authenticates before reaching this code.
export async function externalMcp(
  request: Request,
  service: HostService,
  user: Human,
) {
  const server = new McpServer({
    name: "flickgrove-external",
    version: "1.0.0",
  });
  const open = (sessionId: string) => {
    const agent = service.snapshot().agents.find((a) => a.id === sessionId);
    if (!agent) throw new TargetUnavailable();
    return agent;
  };
  const orc = (sessionId: string) => {
    let agent: Agent;
    try {
      agent = open(sessionId);
    } catch (error) {
      if (error instanceof TargetUnavailable) throw error;
      throw new RequestRefused("Session state is unavailable");
    }
    if (agent.role !== "orc") throw new TargetUnavailable();
    return agent;
  };
  // Share one bounded traversal for live bodies, binding Orc member matches
  // to the native identity and the original ledger operation.
  const findBodies = async (
    sessionId: string,
    initial: Awaited<ReturnType<HostService["agentHistory"]>>,
    candidates: Message[],
    budget: HistoryReadBudget,
    guardMembers: boolean,
  ) => {
    const found = new Map<string, Message>();
    const byIdentity = new Map(
      candidates.map((message) => [message.id, message]),
    );
    let page = initial;
    const seen = new Set<string>();
    for (;;) {
      for (const native of page.messages) {
        const possible = [
          byIdentity.get(native.id),
          native.clientId ? byIdentity.get(native.clientId) : undefined,
        ];
        for (const live of possible) {
          if (!live || found.has(live.id)) continue;
          const member =
            guardMembers &&
            live.delivery &&
            ["worker", "reviewer", "researcher"].includes(live.delivery.source);
          const operation = live.delivery?.id;
          const nativeMember =
            guardMembers &&
            native.delivery &&
            ["worker", "reviewer", "researcher"].includes(
              native.delivery.source,
            );
          const matches = member
            ? !!operation &&
              live.clientId === operation &&
              native.clientId === operation &&
              native.delivery?.id === operation &&
              (native.id === live.id ||
                (live.provisional && live.id === operation))
            : native.id === live.id && !nativeMember;
          if (matches) found.set(live.id, native);
        }
      }
      const cursor = page.nextCursor;
      if (
        found.size === candidates.length ||
        !cursor ||
        seen.has(cursor) ||
        budget.remaining <= 0
      )
        break;
      seen.add(cursor);
      try {
        page = await service.agentHistory(sessionId, cursor, budget);
      } catch {
        break;
      }
    }
    return found;
  };
  // Only a native row in the page returned to the reader converges a live
  // provisional row. Pages visited solely to find a body do not do so.
  const boundNative = (live: Message, native: Message) => {
    const operation = live.delivery?.id;
    return (
      !!live.provisional &&
      !native.provisional &&
      !!operation &&
      ["worker", "reviewer", "researcher"].includes(live.delivery!.source) &&
      live.clientId === operation &&
      native.clientId === operation &&
      native.delivery?.id === operation &&
      (native.id === live.id || live.id === operation)
    );
  };
  const register = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    fn: (args: any) => Promise<unknown>,
    mayWrite = false,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: shape },
      async (args) => {
        try {
          const result = payload(await fn(args));
          result.content[0]!.text = service.workspace.redactExternalSecrets(
            result.content[0]!.text,
          );
          return result;
        } catch (error) {
          if (mayWrite && error instanceof FollowUpRejected)
            return failure(
              "The follow-up queue is full or the Orc is stopping; no message was queued.",
              "failed",
            );
          if (mayWrite && error instanceof RequestRefused)
            return failure(
              "The action was not admitted. Check the session state and input.",
              "failed",
            );
          return failure(
            error instanceof TargetUnavailable
              ? "Choose an open session of the appropriate role."
              : error instanceof ProjectUnavailable
                ? "Registered project or execution environment unavailable."
                : mayWrite
                  ? "Outcome unknown. Inspect the session before taking further action."
                  : "Could not complete the requested read.",
            mayWrite &&
              !(error instanceof TargetUnavailable) &&
              !(error instanceof ProjectUnavailable)
              ? "unknown"
              : mayWrite
                ? "failed"
                : undefined,
          );
        }
      },
    );
  };
  register(
    "list_sessions",
    "List open sessions and their qualified identities.",
    { cursor },
    async ({ cursor }) => {
      const page = pageById(service.snapshot().agents, cursor);
      return {
        sessions: page.items.map(publicSession),
        nextCursor: page.nextCursor,
      };
    },
  );
  register(
    "close_session",
    "Close one Orc tree; this call accepts pending and unknown outcomes, including work that may still run. Known working or stopping sessions cannot close. A lost response is unknown; inspect status before any further action.",
    { session_id: id },
    async ({ session_id }) => {
      orc(session_id);
      await service.closeTree(session_id, undefined, true);
      return { status: "closed" };
    },
    true,
  );
  register(
    "close_session_status",
    "Read the durable closed, open, or unknown state on the original Peer; closed does not attribute closure to a particular request.",
    { session_id: id },
    async ({ session_id }) => {
      try {
        return service.closeStatus(session_id);
      } catch {
        return { status: "unknown" };
      }
    },
  );
  register(
    "list_projects",
    "List execution environments and a page of registered projects in the selected environment (default local).",
    { environment: id.optional(), cursor },
    async ({ environment = "local", cursor }) => {
      const environments = await service.environments();
      if (!environments.some((entry) => entry.id === environment))
        throw new Error("Environment unavailable");
      const projects = (await service.projects(environment)).map((p) => ({
        id: projectReference(p),
        reference: projectReference(p),
        alias: p.alias,
        name: p.name,
        path: p.path,
        owner: p.owner,
        environment: p.environment,
      }));
      const page = pageById(projects, cursor, 50);
      return {
        environments: environments.map((e) => ({
          id: e.id,
          name: e.name,
          target: e.target,
        })),
        projects: page.items.map(({ id: _id, ...project }) => project),
        nextCursor: page.nextCursor,
      };
    },
  );
  register("list_skills", "List Grove built-in skills.", {}, async () => ({
    skills: await builtinSkills(),
  }));
  register(
    "get_config_files",
    "List configuration file locations and resolution issues; paths do not imply existence.",
    {},
    async () => service.workspace.configFiles(),
  );
  register(
    "read_messages",
    "Read a chronological page; use nextCursor to read earlier messages.",
    { session_id: id, cursor },
    async ({ session_id, cursor }) => {
      const agent = open(session_id);
      const budget = { remaining: EXTERNAL_HISTORY_MAX_READS };
      const before =
        agent.backend === "pi"
          ? (await service.detail(session_id)).messages
          : [];
      const page = await service.agentHistory(session_id, cursor, budget);
      const messages = page.messages.map((message) => ({ ...message }));
      const unavailable = new Set<string>();
      const candidates: Message[] = [];
      const recent =
        !cursor || agent.backend === "pi"
          ? service.detailSnapshot(session_id).messages
          : [];
      if (agent.backend === "pi") {
        const beforeKinds = new Map(before.map((m) => [m.id, m.kind]));
        const byId = new Map(recent.map((m) => [m.id, m]));
        for (const message of messages) {
          const current = byId.get(message.id);
          if (
            message.role !== "assistant" ||
            current?.role !== "assistant" ||
            message.questionItemId ||
            current.questionItemId ||
            message.delivery?.source === "question" ||
            current.delivery?.source === "question" ||
            !(
              current.text === message.text ||
              current.bodyRef === message.id ||
              message.bodyRef === message.id
            )
          )
            continue;
          if (!message.kind && current.kind) message.kind = current.kind;
          else if (
            current.kind === "progress" &&
            beforeKinds.get(message.id) !== "progress"
          )
            message.kind = "progress";
        }
      }
      if (!cursor) {
        const identities = new Set(
          messages.flatMap((m) => [m.id, ...(m.clientId ? [m.clientId] : [])]),
        );
        for (const m of recent) {
          const operation = m.delivery?.id;
          if (
            agent.role === "orc" &&
            (m.provisional || m.questionItemId) &&
            operation &&
            m.clientId === operation &&
            m.delivery &&
            ["worker", "reviewer", "researcher"].includes(m.delivery.source)
          ) {
            const nativeIndex = messages.findIndex(
              (native) =>
                native.clientId === operation &&
                native.delivery?.id === operation &&
                (native.id === m.id || (m.provisional && m.id === operation)),
            );
            if (nativeIndex >= 0) {
              if (boundNative(m, messages[nativeIndex]!)) continue;
              // Keep the native position but return the bound live row and its
              // provisional/Question eligibility.
              messages[nativeIndex] = m;
              if (
                m.bodyRef &&
                service.liveMessageBody(session_id, m.id) === undefined
              )
                candidates.push(m);
              continue;
            }
            if (m.provisional && m.id === operation) {
              const collision = messages.findIndex(
                (native) => native.id === m.id && !boundNative(m, native),
              );
              if (collision >= 0) {
                // Like the joined timeline, keep the live operation at this
                // ID; the unrelated native row is not evidence for it.
                messages[collision] = m;
                if (
                  m.bodyRef &&
                  service.liveMessageBody(session_id, m.id, operation) ===
                    undefined
                )
                  candidates.push(m);
                continue;
              }
            }
          }
          if (
            !identities.has(m.id) &&
            (!m.clientId || !identities.has(m.clientId))
          ) {
            // Keep the native page's order intact while placing live-only
            // records by their known timestamps.
            const index =
              m.at > 0
                ? messages.findIndex((item) => item.at > 0 && item.at > m.at)
                : -1;
            if (index < 0) messages.push(m);
            else messages.splice(index, 0, m);
            if (
              m.bodyRef &&
              service.liveMessageBody(session_id, m.id) === undefined
            ) {
              candidates.push(m);
            }
          }
        }
      }
      const watch = service.watchProvisional(
        session_id,
        recent,
        request.signal,
      );
      try {
        const found = await findBodies(
          session_id,
          page,
          candidates,
          budget,
          agent.role === "orc",
        );
        for (const candidate of candidates)
          if (!found.has(candidate.id)) unavailable.add(candidate.id);
        // History projection may have confirmed any ledger entry, even if a
        // later page failed. Refresh all rows, including those outside the live window.
        if (watch.invalidated || request.signal.aborted)
          throw new Error("Request unavailable");
        const refreshed = service.projectMessages(
          session_id,
          messages,
          watch.observed,
        );
        return {
          messages: refreshed
            .filter(
              (m, index) =>
                (agent.role !== "orc" ||
                  !(
                    messages[index]?.delivery &&
                    ["worker", "reviewer", "researcher"].includes(
                      messages[index]!.delivery!.source,
                    ) &&
                    (messages[index]!.clientId !==
                      messages[index]!.delivery!.id ||
                      m.delivery?.id !== messages[index]!.delivery!.id)
                  )) &&
                (agent.role !== "orc" || !isHiddenMemberDelivery(m)),
            )
            .map((m) =>
              unavailable.has(m.id)
                ? {
                    ...publicMessage(m),
                    bodyRef: undefined,
                    bodyUnavailable: true,
                  }
                : publicMessage(m),
            ),
          nextCursor: page.nextCursor,
        };
      } finally {
        watch.stop();
      }
    },
  );
  register(
    "read_message_body",
    "Read an oversized message body by its bodyRef.",
    {
      session_id: id,
      body_ref: id,
      page_cursor: cursor,
      offset: z.number().int().min(0).optional(),
    },
    async ({ session_id, body_ref, page_cursor, offset = 0 }) => {
      const agent = open(session_id);
      let nativeBody: Message | undefined;
      let operationBody: Message | undefined;
      const budget: HistoryReadBudget = {
        remaining: EXTERNAL_HISTORY_MAX_READS,
        onPage: (native) => {
          const exact = native.messages.find((m) => m.id === body_ref);
          const provisional = native.messages.find(
            (m) => m.clientId === body_ref,
          );
          if (!operationBody && provisional) operationBody = provisional;
          if (exact || (!nativeBody && provisional))
            nativeBody = exact ?? provisional;
        },
      };
      const page = await service.agentHistory(session_id, page_cursor, budget);
      const live = page_cursor
        ? undefined
        : service
            .detailSnapshot(session_id)
            .messages.find((m) => m.id === body_ref && m.bodyRef === body_ref);
      const sameId = page.messages.find((m) => m.id === body_ref);
      const collision =
        agent.role === "orc" &&
        !!live?.provisional &&
        live.id === live.clientId &&
        live.delivery?.id === live.id &&
        ["worker", "reviewer", "researcher"].includes(live.delivery.source) &&
        !!sameId &&
        !boundNative(live, sameId);
      const historical = collision ? undefined : sameId;
      const message = live ?? historical;
      const matchedNative =
        agent.role === "orc" && live
          ? page.messages.find((native) => boundNative(live, native))
          : undefined;
      const watch = service.watchProvisional(
        session_id,
        live ? [live] : [],
        request.signal,
      );
      try {
        if (
          !message ||
          (agent.role === "orc" && isHiddenMemberDelivery(message))
        )
          throw new Error("Message unavailable");
        let fallback: Message | undefined;
        if (
          agent.role === "orc" &&
          live &&
          historical?.delivery &&
          ["worker", "reviewer", "researcher"].includes(
            historical.delivery.source,
          ) &&
          (live.clientId !== historical.delivery.id ||
            live.delivery?.id !== historical.delivery.id)
        )
          throw new Error("Message unavailable");
        if (
          agent.role === "orc" &&
          live?.delivery &&
          ["worker", "reviewer", "researcher"].includes(live.delivery.source) &&
          historical &&
          (historical.clientId !== live.delivery.id ||
            historical.delivery?.id !== live.delivery.id)
        )
          throw new Error("Message unavailable");
        const cached = service.liveMessageBody(
          session_id,
          body_ref,
          collision ? live?.clientId : undefined,
        );
        if (!historical && cached === undefined && live) {
          fallback = (
            await findBodies(
              session_id,
              page,
              [live],
              budget,
              agent.role === "orc",
            )
          ).get(live.id);
          if (watch.invalidated || request.signal.aborted)
            throw new Error("Request unavailable");
          const current = service.projectMessages(
            session_id,
            [live],
            watch.observed,
          )[0];
          if (
            !fallback ||
            !current ||
            (agent.role === "orc" &&
              ((live.delivery &&
                ["worker", "reviewer", "researcher"].includes(
                  live.delivery.source,
                ) &&
                (current.clientId !== live.delivery.id ||
                  current.delivery?.id !== live.delivery.id)) ||
                isHiddenMemberDelivery(current)))
          )
            throw new Error("Message unavailable");
        }
        if (watch.invalidated || request.signal.aborted)
          throw new Error("Request unavailable");
        if (agent.role === "orc") {
          if (
            matchedNative &&
            isHiddenMemberDelivery(
              service.projectMessages(session_id, [matchedNative])[0]!,
            )
          )
            throw new Error("Message unavailable");
          const checked = service.projectMessages(
            session_id,
            [message],
            watch.observed,
          );
          if (isHiddenMemberDelivery(checked[0]!))
            throw new Error("Message unavailable");
          if (
            message.delivery &&
            ["worker", "reviewer", "researcher"].includes(
              message.delivery.source,
            ) &&
            (message.clientId !== message.delivery.id ||
              checked[0]?.delivery?.id !== message.delivery.id)
          )
            throw new Error("Message unavailable");
        }
        const nativeId = fallback?.id ?? historical?.id ?? body_ref;
        const native = (collision ? operationBody : nativeBody) as
          | Message
          | undefined;
        const captured =
          native &&
          native.id === nativeId &&
          (!(fallback ?? historical)?.clientId ||
            native.clientId === (fallback ?? historical)?.clientId)
            ? native.text
            : undefined;
        const body = service.workspace.redactExternalSecrets(
          cached ??
            (fallback && !fallback.bodyRef ? fallback.text : undefined) ??
            (historical && !historical.bodyRef
              ? historical.text
              : (captured ??
                (() => {
                  throw new Error("Message body unavailable");
                })())),
        );
        if (offset > body.length) throw new Error("Invalid body offset");
        const end = Math.min(offset + 65536, body.length);
        return {
          text: body.slice(offset, end),
          nextOffset: end < body.length ? end : null,
        };
      } finally {
        watch.stop();
      }
    },
  );
  register(
    "list_questions",
    "List pending questions for an open Orc.",
    { session_id: id, cursor },
    async ({ session_id, cursor }) => {
      orc(session_id);
      const page = pageById(
        service
          .questionHistory(session_id, { pending: true })
          .filter((q) => q.state === "unanswered"),
        cursor,
        10,
      );
      return {
        nextCursor: page.nextCursor,
        questions: page.items.map((q) => ({
          id: q.id,
          itemId: q.itemId,
          title: q.title,
          text: q.text,
          options: q.options,
          state: q.state,
          at: q.at,
          answerOperation: q.answerOperation,
        })),
      };
    },
  );
  register(
    "list_deliveries",
    "Inspect pending follow-ups and unconfirmed deliveries; cursor pages older direct deliveries.",
    { session_id: id, cursor },
    async ({ session_id, cursor }) => {
      orc(session_id);
      const page = service.recoveryPage(session_id, cursor);
      const detail = await service.detail(session_id);
      return {
        deliveries: page.deliveries.map((d) => {
          const full = service.recovery(session_id, d.id);
          const text = service.workspace.redactExternalSecrets(full.text);
          return {
            ...publicDelivery(full),
            text: text.slice(0, 2000),
            truncated: text.length > 2000,
          };
        }),
        nextCursor: page.nextCursor,
        followUps: cursor
          ? []
          : (detail.followUps ?? []).map((d) => {
              const full = service.recovery(session_id, d.id);
              const text = service.workspace.redactExternalSecrets(full.text);
              return {
                ...publicDelivery(full),
                text: text.slice(0, 2000),
                truncated: text.length > 2000,
              };
            }),
      };
    },
  );
  register(
    "read_delivery",
    "Read a pending or unconfirmed delivery in full.",
    { session_id: id, delivery_id: id },
    async ({ session_id, delivery_id }) => {
      orc(session_id);
      const d = service.recovery(session_id, delivery_id);
      if (d.status === "sent" || d.status === "cancelled")
        throw new Error("Delivery unavailable");
      return { delivery: publicDelivery(d) };
    },
  );
  register(
    "send_message",
    "Send once; accepted means native admission, not completion. Unknown outcomes require inspection.",
    { session_id: id, text },
    async ({ session_id, text }) => {
      orc(session_id);
      const operation = `grove-v1-${crypto.randomUUID()}`;
      await service.externalSend(session_id, text, operation, user.id);
      const delivery = service.recovery(session_id, operation);
      return {
        status:
          delivery.status === "sent"
            ? "accepted"
            : delivery.status === "failed"
              ? "failed"
              : "unknown",
      };
    },
    true,
  );
  register(
    "queue_message",
    "Queue one follow-up durably; queued does not mean delivered.",
    { session_id: id, text },
    async ({ session_id, text }) => {
      orc(session_id);
      await service.enqueueFollowUp(
        session_id,
        text,
        `grove-v1-${crypto.randomUUID()}`,
        undefined,
        user.id,
        true,
      );
      return { status: "queued" };
    },
    true,
  );
  register(
    "answer_questions",
    "Answer pending questions once; accepted means native admission.",
    {
      session_id: id,
      answers: z
        .array(z.object({ questionId: id, answer: text }).strict())
        .min(1)
        .max(100),
    },
    async ({ session_id, answers }) => {
      orc(session_id);
      const operation = `grove-v1-${crypto.randomUUID()}`;
      await service.externalAnswer(session_id, answers, operation, user.id);
      const delivery = service.recovery(session_id, operation);
      return {
        status:
          delivery.status === "sent"
            ? "accepted"
            : delivery.status === "failed"
              ? "failed"
              : "unknown",
      };
    },
    true,
  );
  register(
    "create_session",
    "Create an Orc in the selected registered project using server defaults.",
    { project: id },
    async ({ project }) => {
      const reference = parseProjectReference(project);
      let exists = false;
      try {
        exists = (await service.projects(reference.environment)).some(
          (p) => p.alias === reference.alias,
        );
      } catch {
        throw new ProjectUnavailable();
      }
      if (!exists) throw new ProjectUnavailable();
      return {
        session: publicSession(
          await service.createOrc(project, undefined, true),
        ),
      };
    },
    true,
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  if (
    !response.body ||
    !response.headers.get("content-type")?.startsWith("application/json")
  )
    return response;
  // SDK validation and unknown-tool errors can echo caller-controlled values
  // before a tool callback runs, so protect the complete JSON-RPC response.
  const body = service.workspace.redactExternalSecrets(await response.text());
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
