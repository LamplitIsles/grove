import type { Delivery, Message } from "./contracts";

export type ConversationRow =
  | { type: "message"; id: string; message: Message }
  | { type: "group"; id: string; messages: Message[] };

// This is a reading projection: neither the native order nor the messages are
// changed. User inputs and uncertain/actionable records remain outside groups.
export function projectConversation(
  messages: Message[],
  deliveries: Delivery[] = [],
): ConversationRow[] {
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  const rows: ConversationRow[] = [];
  let segment: { message: Message; eligible: boolean }[] = [];
  for (const message of messages) {
    const delivery =
      byId.get(message.clientId ?? message.id) ?? message.delivery;
    const memberDelivery =
      delivery?.source === "worker" ||
      delivery?.source === "reviewer" ||
      delivery?.source === "researcher";
    if (
      memberDelivery &&
      delivery?.status === "sent" &&
      !delivery.error &&
      !message.provisional &&
      !message.questionItemId
    )
      continue;
    const eligible =
      !message.provisional &&
      !message.questionItemId &&
      delivery?.source !== "question" &&
      !memberDelivery &&
      !delivery?.error &&
      message.role === "assistant" &&
      message.kind === "progress";
    if (
      message.role === "assistant" &&
      message.kind === "result" &&
      !memberDelivery
    ) {
      const pending: Message[] = [];
      for (const entry of segment) {
        if (entry.eligible) pending.push(entry.message);
        else
          rows.push({
            type: "message",
            id: entry.message.id,
            message: entry.message,
          });
      }
      if (pending.length)
        rows.push({
          type: "group",
          id: `group:${message.id}`,
          messages: pending,
        });
      rows.push({ type: "message", id: message.id, message });
      segment = [];
    } else segment.push({ message, eligible });
  }
  for (const entry of segment)
    rows.push({
      type: "message",
      id: entry.message.id,
      message: entry.message,
    });
  return rows;
}
