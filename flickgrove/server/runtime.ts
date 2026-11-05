import type {
  Detail,
  HistoryPage,
  HistorySession,
  HistoryMessages,
  Model,
  Skill,
  WeeklyUsage,
  Delivery,
} from "../src/contracts";

export interface RuntimeItem {
  id: string;
  type: string;
  text?: string;
  clientId?: string;
  images?: import("../src/contracts").MessageImage[];
  phase?: string | null;
  delivery?: string | null;
  questions?:
    | {
        header?: string;
        question: string;
        options?: { label: string; description?: string }[] | null;
      }[]
    | null;
}
export type RuntimeEvent = { threadId?: string; replayed?: boolean } & (
  | { type: "working"; turnId: string }
  | { type: "thread-status"; turnId?: string }
  | {
      type: "submission";
      operationId: string;
      status: "queued" | "placed" | "done" | "unanswered";
      turnId: string;
      itemId?: string;
      reason?: string;
    }
  | { type: "item"; turnId: string; item: RuntimeItem }
  | {
      type: "completed";
      turnId: string;
      status: string;
      verified?: boolean;
      recoveredActivityAt?: number;
      environmentFailure?: boolean;
      toolFailure?: boolean;
      error?: string;
      errorKind?: "capacity" | "error";
    }
  | { type: "progress"; turnId: string }
  | { type: "tool-warning"; turnId: string; error: string }
  | {
      type: "error";
      turnId: string;
      error: string;
      willRetry: boolean;
      errorKind?: "capacity" | "error";
    }
  | { type: "disconnected"; error: string }
  | { type: "environment-disconnected"; error: string }
);
export interface RuntimeDelivery extends Delivery {
  /** Original steer target and observed terminal, not an admission receipt. */
  steerEvidence?: {
    attemptId: string;
    turnId: string;
    terminalObserved?: true;
  };
}
export interface RuntimeAgent extends Detail {
  token: string;
  deliveries: RuntimeDelivery[];
  orcPromptSnapshot?: string;
  researcherSnapshot?: import("./reviewer-config").ReviewerSnapshot;
  reviewerSnapshot?: import("./reviewer-config").ReviewerSnapshot;
  workerDefaults?: ExecutionSettings & {
    backend?: import("../src/contracts").Backend;
    provider?: string;
  };
  inheritSettings?: boolean;
  restoreArchived?: boolean;
  turnEnded?: boolean;
  piMemberTerminalVerified?: true;
}
export type ExecutionSettings = {
  provider?: string;
  model: string;
  effort: string;
  serviceTier: string;
};
// Positive evidence only: absence of a native record is never a rejection.
export type NativeFollowUpInspection = {
  accepted: boolean;
  turnId?: string;
  settled: boolean;
  // Positive evidence that this operation is the latest successfully completed turn.
  completed?: boolean;
};
export interface RuntimeHandle {
  threadId: string;
  threadName: string | null;
  historyCursor?: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
  currentExecution?(): Promise<
    import("../src/contracts").Agent["currentExecution"]
  >;
  reloadMcp?(): Promise<{ issues: string[] }>;
  readSettings(): Promise<ExecutionSettings>;
  updateSettings(
    settings: ExecutionSettings | { serviceTier: string },
  ): Promise<ExecutionSettings>;
  rename(title: string): Promise<void>;
  inspectFollowUp?(operationId: string): Promise<NativeFollowUpInspection>;
  send(
    text: string,
    turnId?: string,
    images?: string[],
    clientId?: string,
    envelope?: string,
    startOnly?: boolean,
    humanContext?: string,
  ): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  title(input: string): Promise<string | undefined>;
  close(): Promise<void>;
}
export type WindowRead =
  | { operation: string; turnId?: string }
  | { cursor: string; direction: "older" | "newer" };
export interface Runtime {
  reloadMcp?(): Promise<void>;
  // Optional passive inspection for a disconnected Pi session; never starts a writer.
  inspectFollowUp?(
    agent: RuntimeAgent,
    operationId: string,
  ): Promise<NativeFollowUpInspection>;
  // Codex can confirm an unloaded thread without acquiring a writer handle.
  releaseThread?(threadId: string): Promise<void>;
  history(
    cwd: string,
    cursor?: string,
    environment?: import("../src/contracts").ProjectEnvironment,
  ): Promise<HistoryPage>;
  historyThread(threadId: string): Promise<HistorySession>;
  historyImage?(threadId: string, imageId: string): Promise<File | null>;
  messageWindow?(
    threadId: string,
    read: WindowRead,
  ): Promise<import("../src/contracts").MessageWindow>;
  historyMessages(threadId: string, cursor?: string): Promise<HistoryMessages>;
  readTitle(threadId: string): Promise<string | null>;
  weekly(): Promise<WeeklyUsage>;
  models(): Promise<Model[]>;
  skills(
    cwd: string,
    backend?: import("../src/contracts").Backend,
    environment?: import("../src/contracts").ProjectEnvironment,
  ): Promise<Skill[]>;
  open(
    agent: RuntimeAgent,
    notify: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle>;
  close(): Promise<void>;
}
export class StaleTurn extends Error {
  constructor(
    message: string,
    readonly activeTurnId?: string,
  ) {
    super(message);
  }
}
// The operation was refused before the requested mutation was admitted.
export class RequestRefused extends Error {}
export class DeliveryRejected extends Error {}
