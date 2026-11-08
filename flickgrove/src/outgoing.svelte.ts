import { readingCache } from "./api";
import { saveImages, operationKey } from "./image-drafts";
import { z } from "zod";
import type { Detail, Answer } from "./contracts";
import {
  imageSchema,
  answerSchema,
  submissionEnvelopeSchema,
  lookupSchema,
  type Receipt,
} from "./chord-contract";
const prefix = `flickgrove/${location.origin}/outgoing/`;
const dismissalPrefix = `flickgrove/${location.origin}/dismissed-pending/`;
const dismissalKey = (agentId: string, id: string) =>
  `${dismissalPrefix}${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`;
const dismissals = $state({ revision: 0 });
const dismissal = z.object({ questionIds: z.array(z.string()) });
function readDismissal(agentId: string, id: string) {
  try {
    const parsed = dismissal.safeParse(
      JSON.parse(localStorage.getItem(dismissalKey(agentId, id)) ?? "null"),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
export function dismissedAnswerOperations(agentId: string) {
  void dismissals.revision;
  const scope = `${dismissalPrefix}${encodeURIComponent(agentId)}/`;
  return Object.keys(localStorage).flatMap((key) => {
    if (!key.startsWith(scope)) return [];
    try {
      const id = decodeURIComponent(key.slice(scope.length));
      const saved = readDismissal(agentId, id);
      return saved?.questionIds.length && dismissalKey(agentId, id) === key
        ? [{ id, questionIds: saved.questionIds }]
        : [];
    } catch {
      return [];
    }
  });
}
export function hasDismissedAnswer(agentId: string, questionIds: string[]) {
  return dismissedAnswerOperations(agentId).some((operation) =>
    operation.questionIds.some((id) => questionIds.includes(id)),
  );
}
export function isDismissedPending(
  agentId: string,
  id: string,
  status: import("./contracts").Delivery["status"],
) {
  void dismissals.revision;
  return (
    submissionResult({ status }) === "pending" &&
    !receiptAlreadyAccepted(agentId, id) &&
    !!readDismissal(agentId, id)
  );
}
const confirmed = new Set<string>();
const key = (o: Outgoing) =>
  `${prefix}${encodeURIComponent(o.agentId)}/${encodeURIComponent(o.id)}`;
const entry = z.object({
  attemptId: z.string().optional(),
  admissionVersion: z.literal(1).optional(),
  retryOf: z.string().optional(),
  predecessor: submissionEnvelopeSchema.optional(),
  agentId: z.string(),
  id: z.string(),
  text: z.string(),
  at: z.number(),
  status: z.enum(["sending", "sent", "failed", "uncertain"]),
  error: z.string().optional(),
  images: z.array(imageSchema).optional(),
  localImageIds: z.array(z.string()).optional(),
  answers: z.array(answerSchema).optional(),
});
// The operation journal keeps its existing encoding; presentation has three results.
export type SubmissionResult = "pending" | "accepted" | "rejected";
export function submissionResult(
  delivery: Pick<import("./contracts").Delivery, "status">,
): SubmissionResult {
  const { status } = delivery;
  return status === "sent"
    ? "accepted"
    : status === "failed"
      ? "rejected"
      : "pending";
}
const journalStatus = (status: SubmissionResult) =>
  status === "accepted"
    ? ("sent" as const)
    : status === "rejected"
      ? ("failed" as const)
      : ("sending" as const);
export type Outgoing = Omit<z.infer<typeof entry>, "status"> & {
  status: SubmissionResult;
};
const saved: Outgoing[] = [];
for (const storageKey of Object.keys(localStorage)) {
  if (!storageKey.startsWith(prefix)) continue;
  try {
    const o = entry.parse(JSON.parse(localStorage.getItem(storageKey)!));
    saved.push({
      ...o,
      status: receiptAlreadyAccepted(o.agentId, o.id)
        ? "accepted"
        : submissionResult(o),
      error: receiptAlreadyAccepted(o.agentId, o.id) ? undefined : o.error,
    });
  } catch {
    /* malformed device-owned cache supplies no facts */
  }
}
export const outgoing = $state<{ entries: Outgoing[] }>({ entries: saved });
// Read-only relationships are rechecked with the owning Peer after a reload.
const retryLinks = $state<Record<string, string>>({});
export function observeRetryLink(
  agentId: string,
  operationId: string,
  successor: string,
) {
  retryLinks[`${agentId}/${operationId}`] = successor;
}
function persist(o: Outgoing, required = false) {
  // Each operation owns its record; an unrelated tab cannot erase its journal.
  if (receiptAlreadyAccepted(o.agentId, o.id)) {
    o.status = "accepted";
    o.error = undefined;
  }
  const raw = localStorage.getItem(key(o));
  try {
    const previous = entry.safeParse(JSON.parse(raw ?? "null"));
    if (previous.success && previous.data.status === "sent") {
      o.status = "accepted";
      o.error = undefined;
    }
  } catch {
    /* A malformed record supplies no receipt. */
  }
  if (o.status === "accepted") {
    localStorage.removeItem(key(o));
    if (o.localImageIds?.length || o.images?.length)
      void saveImages(operationKey(o.agentId, o.id), []).catch(() => {});
    return;
  }
  try {
    readingCache.writeDevice(
      key(o),
      JSON.stringify({ ...o, status: journalStatus(o.status) }),
    );
  } catch (error) {
    // A new submission must be durable before sending. An existing journal or
    // owner-confirmed receipt can still converge in memory when storage is full.
    if (!raw || required) throw error;
  }
}
export function addOutgoing(
  agentId: string,
  text: string,
  id: string,
  answers?: Answer[],
  images?: import("./contracts").MessageImage[],
  localImageIds?: string[],
  retry?: { of: string; predecessor: z.infer<typeof submissionEnvelopeSchema> },
) {
  const previous = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === id,
  );
  if (previous) {
    if (
      previous.text !== text ||
      JSON.stringify(previous.answers) !== JSON.stringify(answers) ||
      JSON.stringify(previous.images ?? []) !== JSON.stringify(images ?? []) ||
      JSON.stringify(previous.localImageIds ?? []) !==
        JSON.stringify(localImageIds ?? []) ||
      previous.retryOf !== retry?.of ||
      JSON.stringify(previous.predecessor) !==
        JSON.stringify(retry?.predecessor)
    )
      throw new Error("Operation ID is bound to different content");
    if (previous.status === "accepted" || receiptAlreadyAccepted(agentId, id))
      return;
    previous.status = "pending";
    previous.error = undefined;
    persist(previous);
    return;
  }
  const o: Outgoing = {
    agentId,
    text,
    id,
    at: Date.now(),
    status: "pending",
    admissionVersion: 1,
    ...(retry
      ? { retryOf: retry.of, predecessor: structuredClone(retry.predecessor) }
      : {}),
    images: images ? structuredClone(images) : undefined,
    localImageIds: localImageIds ? [...localImageIds] : undefined,
    ...(answers ? { answers: structuredClone(answers) } : {}),
  };
  persist(o);
  outgoing.entries.push(o);
}
export function observeRetry(
  agentId: string,
  text: string,
  id: string,
  answers: Answer[] | undefined,
  retry: { of: string; predecessor: z.infer<typeof submissionEnvelopeSchema> },
) {
  const local = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === id,
  );
  if (local) return;
  const raw = localStorage.getItem(
    `${prefix}${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`,
  );
  if (raw) {
    const saved = entry.parse(JSON.parse(raw));
    if (
      saved.agentId !== agentId ||
      saved.id !== id ||
      saved.retryOf !== retry.of ||
      JSON.stringify(saved.predecessor) !== JSON.stringify(retry.predecessor)
    )
      throw new Error("Retry identity changed");
    if (saved.status !== "sent")
      outgoing.entries.push({ ...saved, status: submissionResult(saved) });
    return;
  }
  addOutgoing(agentId, text, id, answers, undefined, undefined, retry);
}
export function receiptAlreadyAccepted(agentId: string, id: string) {
  const key = `flickgrove/${location.origin}/accepted/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`;
  return confirmed.has(key) || !!localStorage.getItem(key);
}
function rememberAccepted(agentId: string, id: string) {
  const key = `flickgrove/${location.origin}/accepted/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`;
  confirmed.add(key);
  try {
    readingCache.writeDevice(key, "true");
  } catch {
    /* The owner receipt is still authoritative in this page. */
  }
}
export function observeOutgoing(detail: Detail) {
  for (const delivery of detail.deliveries)
    if (
      delivery.status === "sent" ||
      detail.messages.some(
        (m) =>
          m.role === "user" &&
          (m.id === delivery.id || m.clientId === delivery.id),
      )
    )
      rememberAccepted(detail.id, delivery.id);
  outgoing.entries = outgoing.entries.filter((o) => {
    if (o.agentId !== detail.id) return true;
    if (
      detail.messages.some(
        (m) => m.role === "user" && (m.id === o.id || m.clientId === o.id),
      )
    ) {
      rememberAccepted(o.agentId, o.id);
      localStorage.removeItem(key(o));
      if (o.localImageIds?.length || o.images?.length)
        void saveImages(operationKey(o.agentId, o.id), []).catch(() => {});
      return false;
    }
    const d = detail.deliveries.find((d) => d.id === o.id);
    if (
      d &&
      o.status !== "accepted" &&
      (d.status === "sent" || (d.attemptId ?? o.id) === (o.attemptId ?? o.id))
    ) {
      o.status = submissionResult(d);
      if (o.status === "accepted") rememberAccepted(o.agentId, o.id);
      o.error = d.error;
      persist(o);
    }
    return o.status !== "accepted";
  });
}
export function acceptReceipt(agentId: string, raw: Receipt | null) {
  const receipt = lookupSchema.parse(raw);
  if (!receipt) return;
  if (receipt.state === "accepted")
    rememberAccepted(agentId, receipt.operationId);
  if (
    receipt.state !== "accepted" &&
    receiptAlreadyAccepted(agentId, receipt.operationId)
  )
    return;
  if (
    receipt.state === "rejected" &&
    readDismissal(agentId, receipt.operationId)
  ) {
    localStorage.removeItem(dismissalKey(agentId, receipt.operationId));
    dismissals.revision++;
  }
  const o = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === receipt.operationId,
  );
  if (
    !o ||
    o.status === "accepted" ||
    (receipt.state !== "accepted" &&
      (receipt.attemptId ?? o.id) !== (o.attemptId ?? o.id))
  )
    return;
  o.status = receipt.state === "accepted" ? "accepted" : "rejected";
  o.error = receipt.error ?? undefined;
  persist(o);
  if (o.status === "accepted")
    outgoing.entries = outgoing.entries.filter((entry) => entry !== o);
}
export function unknownOutgoing(agentId: string, id: string, error: string) {
  const o = outgoing.entries.find((o) => o.agentId === agentId && o.id === id);
  if (o && o.status === "pending" && !receiptAlreadyAccepted(agentId, id)) {
    o.status = "pending";
    o.error = error;
    persist(o);
  }
}
export function withOutgoing(detail: Detail): Detail {
  const local = outgoing.entries.filter(
    (o) =>
      o.status !== "accepted" &&
      o.agentId === detail.id &&
      !isDismissedPending(detail.id, o.id, journalStatus(o.status)) &&
      !detail.messages.some((m) => m.id === o.id || m.clientId === o.id),
  );
  const unobserved = detail.deliveries.filter(
    (d) =>
      d.status !== "sent" &&
      !isDismissedPending(detail.id, d.id, d.status) &&
      !receiptAlreadyAccepted(detail.id, d.id) &&
      !detail.messages.some((m) => m.id === d.id || m.clientId === d.id) &&
      !local.some((o) => o.id === d.id),
  );
  return {
    ...detail,
    questions: detail.questions.map((q) => {
      const confirmed = local.find(
        (o) =>
          o.status === "accepted" &&
          o.answers?.some((a) => a.questionId === q.id),
      );
      const accepted =
        confirmed ??
        detail.deliveries.find(
          (d) =>
            receiptAlreadyAccepted(detail.id, d.id) &&
            d.answers?.some((a) => a.questionId === q.id),
        );
      const answer = accepted?.answers?.find((a) => a.questionId === q.id);
      return answer
        ? { ...q, state: "answered" as const, answer: answer.answer }
        : q;
    }),
    messages: [
      ...detail.messages,
      ...local.map((o) => ({
        id: o.id,
        clientId: o.id,
        provisional: true,
        text: o.text,
        images: o.images,
        localImageIds: o.localImageIds,
        role: "user" as const,
        at: o.at,
      })),
      ...unobserved.map((d) => ({
        id: d.id,
        clientId: d.id,
        provisional: true,
        text: d.text,
        bodyRef: d.recoveryRef ? d.id : undefined,
        delivery: d,
        images: d.images,
        role: "user" as const,
        at: d.at,
      })),
    ],
    deliveries: [
      ...detail.deliveries
        .filter(
          (d) =>
            !local.some((o) => o.id === d.id) &&
            !isDismissedPending(detail.id, d.id, d.status),
        )
        .map((d) =>
          receiptAlreadyAccepted(detail.id, d.id)
            ? {
                ...d,
                status: "sent" as const,
                error: d.status === "sent" ? d.error : undefined,
              }
            : d,
        ),
      ...local.map((o) => ({
        id: o.id,
        supersededBy:
          detail.deliveries.find((d) => d.id === o.id)?.supersededBy ??
          retryLinks[`${detail.id}/${o.id}`],
        attemptId: o.attemptId,
        text: o.text,
        images: o.images,
        status: journalStatus(o.status),
        source: o.answers ? ("question" as const) : ("user" as const),
        questionIds: o.answers?.map((a) => a.questionId) ?? [],
        ...(o.answers ? { answers: o.answers } : {}),
        error: o.error,
        at: o.at,
      })),
    ],
  };
}

window.addEventListener("storage", (event) => {
  if (event.key?.startsWith(dismissalPrefix)) {
    dismissals.revision++;
    return;
  }
  if (!event.key?.startsWith(prefix)) return;
  if (!event.newValue && event.oldValue) {
    const previous = entry.safeParse(JSON.parse(event.oldValue));
    if (
      previous.success &&
      (previous.data.status === "failed" ||
        (!previous.data.admissionVersion &&
          ["sending", "uncertain"].includes(previous.data.status)))
    )
      outgoing.entries = outgoing.entries.filter(
        (o) =>
          key(o) !== event.key ||
          (previous.data.status === "failed"
            ? o.status !== "rejected"
            : o.status !== "pending") ||
          receiptAlreadyAccepted(o.agentId, o.id),
      );
  }
  if (event.newValue) {
    try {
      const parsed = entry.parse(JSON.parse(event.newValue));
      const local = outgoing.entries.find(
        (o) => o.id === parsed.id && o.agentId === parsed.agentId,
      );
      if (parsed.status === "sent") {
        if (local) Object.assign(local, { ...parsed, status: "accepted" });
        rememberAccepted(parsed.agentId, parsed.id);
      }
    } catch {}
  }
});

export function setOutgoingImages(
  agentId: string,
  id: string,
  images: import("./contracts").MessageImage[],
) {
  const o = outgoing.entries.find((o) => o.agentId === agentId && o.id === id);
  if (o) {
    if (o.images && JSON.stringify(o.images) !== JSON.stringify(images))
      throw new Error("Operation ID is bound to different images");
    const previous = o.images;
    o.images = structuredClone(images);
    try {
      persist(o, true);
    } catch (error) {
      o.images = previous;
      throw error;
    }
  }
}

export function deleteRejectedOutgoing(agentId: string, id: string) {
  if (receiptAlreadyAccepted(agentId, id))
    throw new Error("Accepted submissions cannot be deleted");
  const local = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === id,
  );
  if (local && (local.status !== "rejected" || local.answers))
    throw new Error("Only a rejected user submission can be deleted");
  const storageKey = `${prefix}${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`;
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    const stored = entry.parse(JSON.parse(raw));
    if (
      stored.agentId !== agentId ||
      stored.id !== id ||
      stored.status !== "failed" ||
      stored.answers
    )
      throw new Error("Only a rejected user submission can be deleted");
  }
  localStorage.removeItem(storageKey);
  outgoing.entries = outgoing.entries.filter(
    (o) => o.agentId !== agentId || o.id !== id,
  );
}

// An old device journal may have no corresponding server record. Removing it
// is a local presentation choice, not evidence of cancellation or rejection.
export function forgetLegacyPending(agentId: string, id: string) {
  const local = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === id,
  );
  if (
    !local ||
    local.status !== "pending" ||
    local.admissionVersion ||
    receiptAlreadyAccepted(agentId, id)
  )
    throw new Error("This submission is no longer awaiting confirmation");
  const storageKey = key(local);
  const raw = localStorage.getItem(storageKey);
  if (!raw) throw new Error("The saved submission is no longer available");
  const stored = entry.parse(JSON.parse(raw));
  if (
    stored.agentId !== agentId ||
    stored.id !== id ||
    stored.admissionVersion ||
    !["sending", "uncertain"].includes(stored.status)
  )
    throw new Error("This submission is no longer awaiting confirmation");
  readingCache.writeDevice(
    dismissalKey(agentId, id),
    JSON.stringify({
      questionIds: stored.answers?.map((answer) => answer.questionId) ?? [],
    }),
  );
  dismissals.revision++;
  localStorage.removeItem(storageKey);
  outgoing.entries = outgoing.entries.filter(
    (o) => o.agentId !== agentId || o.id !== id,
  );
}

// Hide an unknown answer locally without discarding its reconciliation journal.
export function dismissPendingAnswer(
  agentId: string,
  delivery: import("./contracts").Delivery,
) {
  if (
    delivery.source !== "question" ||
    submissionResult(delivery) !== "pending" ||
    !delivery.questionIds.length ||
    receiptAlreadyAccepted(agentId, delivery.id)
  )
    throw new Error("This submission is no longer awaiting confirmation");
  const local = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === delivery.id,
  );
  if (local && !local.admissionVersion) {
    forgetLegacyPending(agentId, delivery.id);
    return;
  }
  readingCache.writeDevice(
    dismissalKey(agentId, delivery.id),
    JSON.stringify({ questionIds: delivery.questionIds }),
  );
  dismissals.revision++;
}

// Only call after the owning Peer confirms this explicitly abandoned session closed.
export function clearClosedPending(agentId: string) {
  const scope = `${prefix}${encodeURIComponent(agentId)}/`;
  for (const storageKey of Object.keys(localStorage)) {
    if (!storageKey.startsWith(scope)) continue;
    const raw = localStorage.getItem(storageKey);
    let parsed;
    try {
      parsed = raw ? entry.safeParse(JSON.parse(raw)) : null;
    } catch {
      continue;
    }
    if (
      !parsed?.success ||
      parsed.data.agentId !== agentId ||
      !["sending", "uncertain"].includes(parsed.data.status)
    )
      continue;
    localStorage.removeItem(storageKey);
    void saveImages(operationKey(agentId, parsed.data.id), []).catch(() => {});
  }
  outgoing.entries = outgoing.entries.filter(
    (o) => o.agentId !== agentId || o.status !== "pending",
  );
}

// A device-owned close intent contains identities only, never another submission ledger.
const closePrefix = `flickgrove/${location.origin}/abandon-close/`;
const closeIntent = z.object({
  agentId: z.string().min(1),
  unknownOperationIds: z.array(z.string().min(1)).min(1),
});
const savedCloses: z.infer<typeof closeIntent>[] = [];
for (const storageKey of Object.keys(localStorage)) {
  if (!storageKey.startsWith(closePrefix)) continue;
  try {
    const intent = closeIntent.parse(
      JSON.parse(localStorage.getItem(storageKey)!),
    );
    if (storageKey === closePrefix + encodeURIComponent(intent.agentId))
      savedCloses.push(intent);
  } catch {
    /* Invalid device data cannot authorize a close or cleanup. */
  }
}
export const closeRecovery = $state({ entries: savedCloses });
export function rememberCloseRecovery(
  agentId: string,
  unknownOperationIds: string[],
) {
  const intent = closeIntent.parse({ agentId, unknownOperationIds });
  // Failure must prevent the close mutation: recovery has to survive a reload first.
  readingCache.writeDevice(
    closePrefix + encodeURIComponent(agentId),
    JSON.stringify(intent),
  );
  closeRecovery.entries = [
    ...closeRecovery.entries.filter((i) => i.agentId !== agentId),
    intent,
  ];
}
export function forgetCloseRecovery(agentId: string) {
  localStorage.removeItem(closePrefix + encodeURIComponent(agentId));
  closeRecovery.entries = closeRecovery.entries.filter(
    (i) => i.agentId !== agentId,
  );
}
