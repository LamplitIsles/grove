import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  foreignKey,
  uniqueIndex,
  customType,
} from "drizzle-orm/sqlite-core";
import type { Agent, Delivery, Project, Question } from "../src/contracts";
import type { RuntimeAgent, ExecutionSettings } from "./runtime";

export type RecoveryContext = Pick<
  RuntimeAgent,
  "turnId" | "turnEnded" | "stop" | "closeRequest"
> & { followUpPaused?: boolean; piMemberTerminalVerified?: true };
export type TaskContext = Pick<Agent, "reviewTarget" | "researchQuestion">;
export type SessionDiagnostics = Pick<
  Agent,
  "error" | "execution" | "treeFastError"
>;
export type CapturedConfig = Pick<
  RuntimeAgent,
  | "orcPromptSnapshot"
  | "reviewerSnapshot"
  | "researcherSnapshot"
  | "workerDefaults"
>;
export type ReportContext = Pick<
  Delivery,
  | "reportingWorkerId"
  | "reportingReviewerId"
  | "reportingResearcherId"
  | "reviewTarget"
  | "researchQuestion"
>;
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
// Better Auth's SQLite adapter owns the encoding of its DATE columns.
const authDate = customType<{ data: string }>({ dataType: () => "date" });
export const authUsers = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified").notNull(),
  image: text("image"),
  createdAt: authDate("createdAt").notNull(),
  updatedAt: authDate("updatedAt").notNull(),
  color: text("color").notNull(),
});
export const authSessions = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: authDate("expiresAt").notNull(),
    token: text("token").notNull().unique(),
    createdAt: authDate("createdAt").notNull(),
    updatedAt: authDate("updatedAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);
export const authAccounts = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: authDate("accessTokenExpiresAt"),
    refreshTokenExpiresAt: authDate("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: authDate("createdAt").notNull(),
    updatedAt: authDate("updatedAt").notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);
export const authVerifications = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: authDate("expiresAt").notNull(),
    createdAt: authDate("createdAt").notNull(),
    updatedAt: authDate("updatedAt").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
export const authPasskeys = sqliteTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("publicKey").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    credentialID: text("credentialID").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("deviceType").notNull(),
    backedUp: integer("backedUp").notNull(),
    transports: text("transports"),
    createdAt: authDate("createdAt"),
    aaguid: text("aaguid"),
  },
  (t) => [
    index("passkey_userId_idx").on(t.userId),
    index("passkey_credentialID_idx").on(t.credentialID),
  ],
);
export const authPairing = sqliteTable("authPairing", {
  id: text("id").primaryKey(),
  codeHash: text("codeHash").notNull().unique(),
  kind: text("kind").$type<"bootstrap" | "invite" | "recovery">().notNull(),
  targetUserId: text("targetUserId").references(() => authUsers.id),
  expiresAt: authDate("expiresAt").notNull(),
  generation: text("generation").notNull(),
});
export const voiceSettings = sqliteTable("voice_settings", {
  id: integer("id").primaryKey(),
  region: text("region").$type<"beijing" | "singapore">().notNull(),
});
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    role: text("role").$type<Agent["role"]>().notNull(),
    ownerId: text("owner_id"),
    backend: text("backend").$type<"codex" | "pi">().notNull().default("codex"),
    threadId: text("thread_id"),
    title: text("title").notNull(),
    token: text("token").notNull().unique(),
    closed: integer("closed", { mode: "boolean" }).notNull(),
    state: text("state").$type<Agent["state"]>().notNull(),
    project: json<Project>("project").notNull(),
    settings: json<ExecutionSettings>("settings").notNull(),
    recovery: json<RecoveryContext>("recovery").notNull(),
    task: json<TaskContext>("task").notNull(),
    diagnostics: json<SessionDiagnostics>("diagnostics").notNull(),
    lastActivityAt: integer("last_activity_at"),
    treeFast: integer("tree_fast", { mode: "boolean" }),
  },
  (t) => [
    uniqueIndex("sessions_backend_thread").on(t.backend, t.threadId),
    index("sessions_open").on(t.closed),
    index("sessions_owner").on(t.ownerId),
  ],
);
export const sessionConfig = sqliteTable("session_config", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  captured: json<CapturedConfig>("captured").notNull(),
});
export const deliveries = sqliteTable(
  "deliveries",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    mode: text("mode")
      .$type<"direct" | "follow_up">()
      .notNull()
      .default("direct"),
    source: text("source").$type<Delivery["source"]>().notNull(),
    status: text("status").$type<Delivery["status"]>().notNull(),
    attemptId: text("attempt_id"),
    turnId: text("turn_id"),
    at: integer("at").notNull(),
    authorUserId: text("author_user_id").references(() => authUsers.id),
    admissionAt: integer("admission_at"),
    error: text("error"),
    images: json<NonNullable<Delivery["images"]>>("images"),
    report: json<ReportContext>("report").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.operationId] }),
    index("deliveries_status").on(t.sessionId, t.status),
    index("deliveries_order").on(t.sessionId, t.position),
  ],
);
export const treeUserActivity = sqliteTable(
  "tree_user_activity",
  {
    rootSessionId: text("root_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id),
    lastSpokeAt: integer("last_spoke_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.rootSessionId, t.userId] })],
);
export const questions = sqliteTable(
  "questions",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    position: integer("position").notNull(),
    itemId: text("item_id").notNull(),
    itemIndex: integer("item_index").notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    options: json<Question["options"]>("options").notNull(),
    state: text("state").$type<Question["state"]>().notNull(),
    answer: text("answer"),
    at: integer("at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.id] }),
    index("questions_item").on(t.sessionId, t.itemId),
    index("questions_state").on(t.sessionId, t.state),
  ],
);
export const deliveryQuestions = sqliteTable(
  "delivery_questions",
  {
    sessionId: text("session_id").notNull(),
    operationId: text("operation_id").notNull(),
    questionId: text("question_id").notNull(),
    position: integer("position").notNull(),
    answer: text("answer"),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.operationId, t.position] }),
    foreignKey({
      columns: [t.sessionId, t.operationId],
      foreignColumns: [deliveries.sessionId, deliveries.operationId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.sessionId, t.questionId],
      foreignColumns: [questions.sessionId, questions.id],
    }),
  ],
);
