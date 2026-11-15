import { expect, test } from "bun:test";
import type { Delivery, Detail, Message } from "../src/contracts";
import {
  browserDetail,
  browserMessages,
  browserRecoveries,
} from "./browser-presentation";

test("browser hides all member report states without guessing identity", () => {
  const deliveries: Delivery[] = [];
  const messages: Message[] = [];
  for (const source of ["worker", "reviewer", "researcher"] as const) {
    for (const status of [
      "queued",
      "sending",
      "sent",
      "failed",
      "uncertain",
    ] as const) {
      const id = `${source}-${status}`;
      const delivery: Delivery = {
        id,
        source,
        status,
        text: "",
        at: 1,
        questionIds: [],
      };
      deliveries.push(delivery);
      messages.push({
        id,
        clientId: id,
        role: "user",
        text: id,
        at: 1,
        provisional: true,
        delivery,
      });
    }
    const delivery: Delivery = {
      id: `${source}-sent-error`,
      source,
      status: "sent",
      error: "late error",
      text: "",
      at: 1,
      questionIds: [],
    };
    deliveries.push(delivery);
    messages.push({
      id: delivery.id,
      clientId: delivery.id,
      role: "user",
      text: delivery.id,
      at: 1,
      delivery,
    });
  }
  const unknown: Message = {
    id: "unknown",
    role: "user",
    text: "Worker reports: identical text",
    at: 1,
  };
  const question: Message = {
    id: "question",
    role: "assistant",
    text: "A question",
    at: 1,
    questionItemId: "question",
    delivery: deliveries[0],
  };
  const collision: Message = {
    id: "worker-sent",
    role: "user",
    text: "Unknown native item",
    at: 1,
  };
  const forwarded = [0, 6, 12].map((i): Message => ({
    id: `forwarded-${i}`,
    clientId: deliveries[i].id,
    questionItemId: `forwarded-${i}`,
    role: "user",
    text: "Member question",
    at: 1,
    delivery: deliveries[i],
  }));
  messages.push(unknown, question, collision, ...forwarded);
  const visible = browserMessages(messages, deliveries);
  expect(visible.map((m) => m.id)).toEqual([
    "unknown",
    "question",
    "worker-sent",
  ]);
  expect(visible.find((m) => m.id === "question")?.delivery).toBeUndefined();
  expect(browserRecoveries(deliveries)).toEqual([]);
  const member = { role: "worker", messages, deliveries } as Detail;
  expect(browserDetail(member)).toBe(member);
  expect(messages).toHaveLength(24);
  expect(deliveries).toHaveLength(18);
});
