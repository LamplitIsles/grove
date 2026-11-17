import type { Delivery, Detail, Message } from "../src/contracts";

// Browser presentation only. Keep the ledger and native transcript unchanged.
export function memberDelivery(delivery?: Pick<Delivery, "source">) {
  return (
    !!delivery &&
    (delivery.source === "worker" ||
      delivery.source === "reviewer" ||
      delivery.source === "researcher")
  );
}

export function browserMessages(
  messages: Message[],
  deliveries: Delivery[] = [],
) {
  const byId = new Map(deliveries.map((d) => [d.id, d]));
  return messages.flatMap((message) => {
    const operation =
      message.clientId ?? (message.provisional ? message.id : undefined);
    const delivery = operation
      ? (byId.get(operation) ??
        (message.delivery?.id === operation ? message.delivery : undefined))
      : undefined;
    if (memberDelivery(delivery)) return [];
    // Unmatched metadata cannot establish provenance or leak a member status.
    return [
      memberDelivery(message.delivery)
        ? { ...message, delivery: undefined }
        : message,
    ];
  });
}

export function browserDetail(detail: Detail, recoveryCount?: number): Detail {
  if (detail.role !== "orc") return detail;
  return {
    ...detail,
    recoveryCount: recoveryCount ?? detail.recoveryCount,
    messages: browserMessages(detail.messages, detail.deliveries),
    deliveries: detail.deliveries.filter((d) => !memberDelivery(d)),
  };
}

export function browserRecoveries(deliveries: Delivery[]) {
  return deliveries.filter((d) => !memberDelivery(d));
}
