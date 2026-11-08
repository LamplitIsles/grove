export type Backend = "codex" | "pi";
export type Role = "orc" | "worker" | "reviewer" | "researcher";
export type ReviewerProfile = "standards" | "spec" | "high_risk_spec";
export interface ReviewTarget {
  profile: ReviewerProfile;
  spec: string;
  fixedPoint: string;
  reviewedHead: string;
}
export type WorkState = "idle" | "working" | "stopping" | "error";
export type Effort = string;
export interface ProjectEnvironment {
  id: string;
  name: string;
  /** Captured non-secret administrator target identity. */
  target: string;
}
export interface Project {
  historyRef?: string;
  environment?: ProjectEnvironment;
  owner?: string | null;
  alias: string;
  name: string;
  path: string;
}
export interface Model {
  backend?: Backend;
  provider?: string;
  id: string;
  name: string;
  efforts: Effort[];
  defaultEffort: Effort;
  isDefault: boolean;
  fastTier: string | null;
}
export interface Defaults {
  backend?: Backend;
  provider?: string;
  model: string;
  effort: Effort;
}
export interface Settings {
  fast: boolean;
  orc: Defaults;
}
export interface MemberPresetSummary {
  id: string;
  name: string;
  error?: string;
}
export interface MemberPresetsStatus {
  presets: MemberPresetSummary[];
  /** Selected member preset ID, or the shipped default until one is saved. */
  current: string;
  /** Why the selected preset cannot be used; never a fallback selection. */
  currentError?: string;
}
export type ConfigFileSource = "grove" | "pi" | "codex";
export interface ConfigFileEntry {
  source: ConfigFileSource;
  name: string;
  /** Determined configuration location; it does not promise the file exists. */
  path: string;
  description: string;
}
export interface ConfigFilesStatus {
  files: ConfigFileEntry[];
  /** Short reasons a source could not be listed; other sources stay listed. */
  issues: string[];
}
export interface MessageImage {
  id: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  mediaType: string;
  availability?: "missing";
}
export interface Human {
  id: string;
  name: string;
  color: string;
}
export interface Message {
  author?: Human;
  questionItemId?: string;
  provisional?: boolean;
  clientId?: string;
  delivery?: Delivery;
  bodyRef?: string;
  localImageIds?: string[];
  images?: MessageImage[];
  id: string;
  turnId?: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}
export interface HistorySession {
  environmentId?: string;
  environmentTarget?: string;
  backend?: Backend;
  provider?: string;
  threadId: string;
  title: string;
  preview: string;
  cwd: string;
  updatedAt: number;
  source: string;
  archived: boolean;
  role: Role | "session";
  agentId?: string;
  ownerThreadId?: string;
  ownerProject?: string;
  closed?: boolean;
  model?: string;
  effort?: string;
}
export interface HistoryPage {
  sessions: HistorySession[];
  nextCursor: string | null;
}
export interface UserMessageAnchor {
  operation: string;
  summary: string;
  images: number;
  status: Delivery["status"];
  authorUserId?: string | null;
}
export interface MessageWindow {
  messages: Message[];
  olderCursor: string | null;
  newerCursor: string | null;
  target?: string;
}
export interface HistoryMessages {
  messages: Message[];
  nextCursor: string | null;
}
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface Question {
  /** Bounded snapshot preview; full question text still loads through reading. */
  notificationText?: string;
  // HTTP-only projection of the existing unresolved answer operation.
  answerOperation?: Pick<Delivery, "id" | "status">;
  id: string;
  itemId: string;
  index: number;
  title: string;
  text: string;
  options: QuestionOption[];
  state: "unanswered" | "delegated" | "answered";
  answer?: string;
  at: number;
  recoveryRef?: boolean;
}
export type Answer = { questionId: string; answer: string };
// Local log estimate may include partial/interrupted output; samples are not successes.
export type OutputSpeed = {
  model: string;
  tier: "fast" | "standard" | null;
  summary: import("@experiments/codex-tps").Summary | null;
  status: "loading" | "ready" | "unavailable";
};
export interface Delivery {
  supersededBy?: string;
  authorUserId?: string;
  admissionAt?: number;
  author?: Human;
  mode?: "direct" | "follow_up";
  attemptId?: string;
  recoveryRef?: boolean;
  images?: MessageImage[];
  answers?: Answer[];
  turnId?: string;
  id: string;
  text: string;
  status:
    | "queued"
    | "waiting"
    | "cancelled"
    | "sending"
    | "sent"
    | "failed"
    | "uncertain";
  source: "user" | "worker" | "reviewer" | "researcher" | "question";
  reportingResearcherId?: string;
  researchQuestion?: string;
  reportingReviewerId?: string;
  reviewTarget?: ReviewTarget;
  reportingWorkerId?: string;
  questionIds: string[];
  error?: string;
  at: number;
}
export interface Agent {
  participants?: { user: Human; lastSpokeAt: number }[];
  followUpPaused?: boolean;
  /** Follow-ups still waiting, in admission, unconfirmed, or failed. */
  followUpCount?: number;
  /** Instance-local publication identities; absent after server restart. */
  userHandoff?: { id: string; summary: string };
  finalFailure?: { id: string };
  backend?: Backend;
  provider?: string;
  researchQuestion?: string;
  reviewTarget?: ReviewTarget;
  treeFast?: boolean;
  treeFastBusy?: boolean;
  treeFastError?: string;
  directoryBranch?: string;
  readingRevision?: number;
  historyCursor?: string;
  closeRequest?: {
    reason: string;
  };
  hostId?: string;
  stop?: {
    turnId: string;
    status: "pending" | "unknown" | "confirmed" | "completed";
  };
  serviceTier: string;
  id: string;
  role: Role;
  ownerId?: string;
  project: Project;
  title: string;
  model: string;
  effort: Effort;
  state: WorkState;
  /** The execution or stop has not yet been confirmed to have ended. */
  workUnconfirmed?: boolean;
  /** Volatile state of the currently resumed local Codex thread, not an operation receipt. */
  currentExecution?: { state: "idle" | "working"; lastInterrupted?: true };
  /** Local Codex session connection attempt; independent of execution outcome. */
  connection?: { state: "connecting" | "failed"; error?: string };
  /** The last observed local Codex turn was interrupted. */
  lastInterrupted?: boolean;
  execution?: { kind: "capacity" | "error"; retrying: boolean };
  workingSince?: number;
  /** Most recent observed work in this Orc's tree, in Unix milliseconds. */
  lastActivityAt?: number;
  threadId?: string;
  turnId?: string;
  error?: string;
  closed: boolean;
  questions: Question[];
  unansweredCount?: number;
  recoveryCount?: number;
}
export interface Detail extends Agent {
  messages: Message[];
  deliveries: Delivery[];
  followUps?: Delivery[];
}
export interface Host {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  lastSeen?: number;
  error?: string;
}
export interface WeeklyUsage {
  remaining: number | null;
  resetsAt?: number;
  accountId?: string;
  fetchedAt: number;
  hostId?: string;
  source?: string;
}
export interface Snapshot {
  entryId?: string;
  hosts?: Host[];
  agents: Agent[];
  settings: Settings | null;
  revision: number;
}
export interface Skill {
  name: string;
  description: string;
  shortDescription?: string;
}
export type InstanceSessionReason =
  | "working"
  | "stopping"
  | "session_error"
  | "unverified"
  | "turn"
  | "stop_pending"
  | "stop_unknown"
  | "retrying"
  | "close_requested"
  | "follow_up_inspection"
  | "delivery_waiting"
  | "delivery_queued"
  | "delivery_sending"
  | "delivery_uncertain"
  | "delivery_failed"
  | "opening"
  | "queue"
  | "tree_action"
  | "tree_closing"
  | "child_closing";
export type InstanceGlobalReason =
  | "maintenance"
  | "creating"
  | "disposed"
  | "write_failure"
  | Extract<
      InstanceSessionReason,
      "opening" | "queue" | "tree_action" | "tree_closing" | "child_closing"
    >;
export type InstanceBlockerReason =
  | InstanceSessionReason
  | InstanceGlobalReason;
export type InstanceStatus = {
  id: string;
  version: string | null;
  busy: boolean;
  canConfirmBusy: boolean;
  restartAvailable: boolean;
  sessions: Array<{
    id: string;
    title: string;
    role: Agent["role"];
    reasons: InstanceSessionReason[];
  }>;
  instanceReasons: InstanceGlobalReason[];
};
export type InstanceReloadResult = {
  results: Array<{
    backend: "codex" | "pi";
    session?: string;
    status:
      | "requested"
      | "applied"
      | "partial"
      | "partial_or_unknown"
      | "failed"
      | "deferred";
  }>;
};
export type InstanceRestartResult = { status: "unavailable" | "unknown" };
