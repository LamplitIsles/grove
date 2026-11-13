import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, Storage } from "@earendil-works/pi-durable";
import type { Message } from "../src/contracts";

export function codexMessageKind(
  phase: string | null | undefined,
): Message["kind"] {
  return phase === "commentary"
    ? "progress"
    : phase === "final_answer"
      ? "result"
      : undefined;
}

// Durable stores a complete model response in one pi.assistant entry. Do not
// infer a relationship from neighboring entries or a tool-result entry.
export function piToolProgress(entry: EntryRecord): Message["kind"] {
  if (entry.kind !== "pi.assistant" || entry.model?.length !== 1) return;
  const model = entry.model[0];
  if (
    model.role === "assistant" &&
    model.content.some((part) => part.type === "toolCall")
  )
    return "progress";
}

// Only inspect inputs present in this bounded native view. A missing input or
// incomplete receipt cannot prove anything about the assistant entry.
export async function piAnswerKinds(
  storage: Pick<Storage, "submissionByRequest" | "task">,
  entries: readonly EntryRecord[],
): Promise<Set<number>> {
  const answers = new Set<number>();
  const inputs = entries.filter((entry) => entry.kind === "grove.input");
  for (const input of inputs) {
    const operation = (input.data as { operation?: unknown } | undefined)
      ?.operation;
    if (typeof operation !== "string") continue;
    const submission = await storage.submissionByRequest(
      input.conversationId,
      operation,
      BACKGROUND_CONTEXT,
    );
    if (
      submission?.type !== "input" ||
      submission.status !== "done" ||
      submission.entry !== input.id ||
      submission.conversationId !== input.conversationId
    )
      continue;
    const answer = entries.find(
      (entry) =>
        entry.id === submission.answer &&
        entry.conversationId === input.conversationId &&
        entry.kind === "pi.assistant",
    );
    if (!answer?.byTaskId || answer.model?.length !== 1) continue;
    const model = answer.model[0];
    if (
      model.role !== "assistant" ||
      !["stop", "length", "toolUse"].includes(model.stopReason) ||
      model.content.some((part) => part.type === "toolCall")
    )
      continue;
    const task = await storage.task(answer.byTaskId, BACKGROUND_CONTEXT);
    if (
      task?.id !== answer.byTaskId ||
      task.conversationId !== answer.conversationId ||
      task.kind !== "pi.generation" ||
      task.owner !== undefined ||
      task.background ||
      task.state.status !== "terminal" ||
      task.state.outcome.status !== "completed"
    )
      continue;
    const result = task.state.outcome.result;
    if (
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.entryId === answer.id
    )
      answers.add(answer.id);
  }
  return answers;
}
