import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  ROOT_CONVERSATION_ID,
  LiveDoc,
  InboxDoc,
} from "@earendil-works/pi-durable";
import { PiMetadata, PiOperation } from "./pi-documents";
import { readPiStorage } from "./pi-storage";
import type { NativeFollowUpInspection, RuntimeAgent } from "./runtime";

// One readonly SQLite snapshot binds the receipt, operation envelope, task and
// live documents to the same native database revision.
export async function inspectPiFollowUp(
  path: string,
  threadId: string,
  agent: RuntimeAgent,
  operationId: string,
): Promise<NativeFollowUpInspection> {
  const storage = await readPiStorage(path);
  const session = createSession(storage);
  const ctx = BACKGROUND_CONTEXT;
  try {
    const metadata = await session.snapshot(PiMetadata, ctx);
    if (
      !metadata ||
      metadata.id !== threadId ||
      metadata.agentId !== agent.id ||
      metadata.role !== agent.role ||
      metadata.ownerId !== (agent.ownerId ?? "") ||
      resolve(metadata.cwd) !== resolve(agent.project.path)
    )
      throw new Error("Original Pi session identity unavailable");
    const receipt = await storage.submissionByRequest(
      ROOT_CONVERSATION_ID,
      operationId,
      ctx,
    );
    const envelope = await session.snapshot(PiOperation, operationId, ctx);
    if (
      !receipt ||
      receipt.conversationId !== ROOT_CONVERSATION_ID ||
      receipt.requestId !== operationId ||
      receipt.type !== "input" ||
      !envelope?.fingerprint
    )
      return { accepted: false, settled: false };
    let input: import("@earendil-works/pi-durable").EntryRecord | undefined;
    if (receipt.entry !== undefined) {
      input = (await storage.entry(ROOT_CONVERSATION_ID, receipt.entry, ctx))
        ?.entry;
      const data = input?.data as
        | { operation?: string; fingerprint?: string }
        | undefined;
      if (
        !input ||
        input.conversationId !== ROOT_CONVERSATION_ID ||
        input.kind !== "grove.input" ||
        data?.operation !== operationId ||
        data.fingerprint !== envelope.fingerprint
      )
        return { accepted: false, settled: false };
    }
    const accepted = { accepted: true, settled: false };
    try {
      // A queued or placed receipt proves admission, not an ended run.
      if (receipt.status !== "done" && receipt.status !== "unanswered")
        return accepted;
      const answer =
        receipt.status === "done"
          ? (await storage.entry(ROOT_CONVERSATION_ID, receipt.answer, ctx))
              ?.entry
          : undefined;
      if (
        receipt.status === "done" &&
        (!answer ||
          answer.kind !== "pi.assistant" ||
          answer.conversationId !== ROOT_CONVERSATION_ID)
      )
        return accepted;
      const taskId =
        answer?.byTaskId ??
        (receipt.status === "unanswered" ? input?.byTaskId : undefined);
      if (!taskId) return accepted;
      const task = await storage.task(taskId, ctx);
      if (
        !task ||
        task.id !== taskId ||
        task.conversationId !== ROOT_CONVERSATION_ID ||
        task.kind !== "pi.generation" ||
        task.owner !== undefined ||
        task.background ||
        task.state.status !== "terminal"
      )
        return accepted;
      if (answer) {
        if (task.state.outcome.status !== "completed") return accepted;
        const result = task.state.outcome.result;
        if (
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          result.entryId !== answer.id
        )
          return accepted;
      }
      const latest = await storage.scanTasks(
        {
          conversationId: ROOT_CONVERSATION_ID,
          kind: "pi.generation",
          order: "descending",
        },
        1,
        undefined,
        ctx,
      );
      const live = await session.snapshot(LiveDoc, ROOT_CONVERSATION_ID, ctx);
      const inbox = await session.snapshot(InboxDoc, ROOT_CONVERSATION_ID, ctx);
      if (
        latest.items[0]?.id !== task.id ||
        !live ||
        live.run ||
        !inbox ||
        inbox.items.length
      )
        return { ...accepted, turnId: String(task.id) };
      return {
        accepted: true,
        turnId: String(task.id),
        settled: true,
        completed: receipt.status === "done",
      };
    } catch {
      // A later task/snapshot read cannot erase an already verified receipt.
      return accepted;
    }
  } finally {
    await session.close(ctx);
  }
}
