import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexMessageKind } from "./message-kind";
import type {
  Model,
  WeeklyUsage,
  HistorySession,
  Message,
} from "../src/contracts";
import type {
  Runtime,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeHandle,
} from "./runtime";

export const fixtureProjects = [
  { alias: "alpha", name: "Alpha", path: "/fixture/alpha" },
  { alias: "beta", name: "Beta", path: "/fixture/beta" },
];
export class FakeRuntime implements Runtime {
  readonly historySessions = new Map<string, HistorySession>();
  readonly historyItems = new Map<string, Message[]>();
  readonly lockedThreads = new Set<string>();
  async history(cwd: string, cursor?: string) {
    const matches = [...this.historySessions.values()].filter(
      (s) => s.cwd === cwd,
    );
    const offset = Number(cursor ?? 0);
    return {
      sessions: matches.slice(offset, offset + 30),
      nextCursor: matches.length > offset + 30 ? String(offset + 30) : null,
    };
  }
  async historyThread(threadId: string) {
    const session = this.historySessions.get(threadId);
    if (!session) throw new Error("Thread not found");
    return { ...session };
  }
  async historyMessages(threadId: string, cursor?: string) {
    const items = this.historyItems.get(threadId) ?? [];
    const end = cursor ? Number(cursor) : items.length;
    const start = Math.max(0, end - 30);
    return {
      messages: items.slice(start, end),
      nextCursor: start ? String(start) : null,
    };
  }
  async messageWindow(
    threadId: string,
    read: import("./runtime").WindowRead,
  ): Promise<import("../src/contracts").MessageWindow> {
    const items = this.historyItems.get(threadId) ?? [];
    let start: number, end: number, target: string | undefined;
    if ("operation" in read) {
      const index = items.findIndex((m) => m.clientId === read.operation);
      if (index < 0) throw new Error("This input has no native position");
      start = Math.max(0, index - 12);
      end = Math.min(items.length, index + 18);
      target = items[index].id;
    } else {
      const index = Number(read.cursor);
      start = read.direction === "older" ? Math.max(0, index - 30) : index;
      end =
        read.direction === "older" ? index : Math.min(items.length, index + 30);
    }
    return {
      messages: items.slice(start, end),
      target,
      olderCursor: start ? String(start) : null,
      newerCursor: end < items.length ? String(end) : null,
    };
  }
  readonly settingsReads: string[] = [];
  readonly settings = new Map<string, import("./runtime").ExecutionSettings>();
  settingsOverride?: (
    id: string,
    value: import("./runtime").ExecutionSettings,
  ) => Promise<void>;
  readonly names = new Map<string, string>();
  closeOverride?: (id: string) => Promise<void>;
  renameOverride?: (threadId: string, title: string) => Promise<void>;
  async readTitle(threadId: string) {
    return this.names.get(threadId) ?? null;
  }
  readonly agents = new Map<string, RuntimeAgent>();
  readonly listeners = new Map<string, (e: RuntimeEvent) => void>();
  readonly inputs: {
    agentId: string;
    text: string;
    turnId?: string;
    images?: string[];
    clientId?: string;
    startOnly?: boolean;
    humanContext?: string;
  }[] = [];
  sendOverride?: (
    agentId: string,
    text: string,
    turnId?: string,
    startOnly?: boolean,
  ) => Promise<string>;
  inspectOverride?: (
    agentId: string,
    operationId: string,
  ) => Promise<import("./runtime").NativeFollowUpInspection>;
  inspectFollowUp(agent: RuntimeAgent, operationId: string) {
    return (
      this.inspectOverride?.(agent.id, operationId) ??
      Promise.resolve({ accepted: false, settled: false })
    );
  }
  readonly interruptions: { agentId: string; turnId: string }[] = [];
  interruptOverride?: (id: string, turnId: string) => Promise<void>;
  async weekly(): Promise<WeeklyUsage> {
    return {
      remaining: 72,
      fetchedAt: Date.now(),
      accountId: "fixture-account",
      resetsAt: 1791252000,
    };
  }
  async models(): Promise<Model[]> {
    return [
      {
        id: "sol",
        name: "Sol",
        efforts: ["medium", "high"],
        defaultEffort: "medium",
        isDefault: true,
        fastTier: "priority",
      },
      {
        id: "luna",
        name: "Luna",
        efforts: ["low"],
        defaultEffort: "low",
        isDefault: false,
        fastTier: null,
      },
    ];
  }
  async skills() {
    return [
      {
        name: "to-orc-impl",
        description: "Implement one spec with one Worker",
      },
    ];
  }
  async open(
    agent: RuntimeAgent,
    notify: (e: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    if (agent.threadId && this.lockedThreads.has(agent.threadId))
      throw new Error(
        "This session is in use by another Codex instance. Close it there, then retry.",
      );
    const threadId = agent.threadId ?? `thread-${agent.id}`;
    if (!this.historySessions.has(threadId))
      this.historySessions.set(threadId, {
        threadId,
        title: agent.title,
        preview: "",
        cwd: agent.project.path,
        role: agent.role,
        source: "appServer",
        archived: false,
        updatedAt: Date.now(),
      });
    this.agents.set(agent.id, structuredClone(agent));
    this.listeners.set(agent.id, notify);
    const saved = this.settings.get(threadId) ?? {
      model: agent.model || "sol",
      effort: agent.effort || "medium",
      serviceTier: agent.serviceTier,
    };
    this.settings.set(threadId, saved);
    return {
      threadId: agent.threadId ?? `thread-${agent.id}`,
      threadName: await this.readTitle(agent.threadId ?? `thread-${agent.id}`),
      historyCursor: this.historyItems.get(threadId)?.length
        ? String(this.historyItems.get(threadId)!.length)
        : undefined,
      ...saved,
      readSettings: async () => {
        this.settingsReads.push(agent.id);
        return { ...this.settings.get(threadId)! };
      },
      updateSettings: async (value) => {
        const updated = { ...this.settings.get(threadId)!, ...value };
        await this.settingsOverride?.(agent.id, updated);
        this.settings.set(threadId, updated);
        return updated;
      },
      rename: async (title) => {
        const id = agent.threadId ?? `thread-${agent.id}`;
        await this.renameOverride?.(id, title);
        this.names.set(id, title);
      },
      inspectFollowUp: async (operationId) =>
        this.inspectOverride?.(agent.id, operationId) ?? {
          accepted: false,
          settled: false,
        },
      send: async (
        text,
        turnId,
        images,
        clientId,
        _envelope,
        startOnly,
        humanContext,
      ) => {
        this.inputs.push({
          agentId: agent.id,
          text,
          turnId,
          images,
          clientId,
          ...(humanContext ? { humanContext } : {}),
          ...(startOnly ? { startOnly } : {}),
        });
        const result = this.sendOverride
          ? await this.sendOverride(agent.id, text, turnId, startOnly)
          : (turnId ?? `turn-${this.inputs.length}`);
        const message: Message = {
          id: `native-${clientId}`,
          clientId,
          turnId: result,
          role: "user",
          text,
          at: Date.now(),
        };
        const items = this.historyItems.get(threadId) ?? [];
        items.push(message);
        this.historyItems.set(threadId, items);
        notify({
          type: "item",
          turnId: result,
          item: { type: "userMessage", id: message.id, clientId, text },
        });
        return result;
      },
      interrupt: async (turnId) => {
        this.interruptions.push({ agentId: agent.id, turnId });
        if (this.interruptOverride)
          await this.interruptOverride(agent.id, turnId);
      },
      title: async () => undefined,
      close: async () => {
        await this.closeOverride?.(agent.id);
        this.listeners.delete(agent.id);
      },
    };
  }
  emit(id: string, event: RuntimeEvent) {
    const thread = this.agents.get(id)?.threadId ?? `thread-${id}`;
    if (
      event.type === "item" &&
      event.item.type === "agentMessage" &&
      (event.item.text || event.item.questions?.length)
    ) {
      const m: Message = {
        id: event.item.id,
        turnId: event.turnId,
        role: "assistant",
        text: event.item.text ?? "",
        ...(event.item.delivery === "async" && event.item.questions?.length
          ? {}
          : { kind: event.item.kind ?? codexMessageKind(event.item.phase) }),
        at: Date.now(),
      };
      const items = this.historyItems.get(thread) ?? [];
      if (!items.some((v) => v.id === m.id)) items.push(m);
      this.historyItems.set(thread, items);
    }
    this.listeners.get(id)?.(event);
  }
  async close() {
    this.listeners.clear();
  }
}

export interface MemberChoiceFixture {
  backend?: "codex" | "pi";
  provider?: string;
  model: string;
  effort: string;
}
export interface MemberPresetFixture {
  name?: string;
  worker?: MemberChoiceFixture;
  researcher?: MemberChoiceFixture;
  standards?: MemberChoiceFixture;
  spec?: MemberChoiceFixture;
  high_risk_spec?: MemberChoiceFixture;
}
const fixtureChoice = (value: MemberChoiceFixture, indent = "") =>
  [
    `${indent}backend = "${value.backend ?? "codex"}"`,
    ...(value.provider ? [`${indent}provider = "${value.provider}"`] : []),
    `${indent}model = "${value.model}"`,
    `${indent}reasoning_effort = "${value.effort}"`,
  ].join("\n");
export function memberPresetToml(
  value: MemberPresetFixture = {},
  id = "fixture",
) {
  const researcher = value.researcher ?? { model: "sol", effort: "high" };
  return [
    `name = ${JSON.stringify(value.name ?? id)}`,
    "",
    "[worker]",
    fixtureChoice(value.worker ?? { model: "sol", effort: "medium" }),
    "",
    "[reviewers.standards]",
    fixtureChoice(value.standards ?? researcher),
    "",
    "[reviewers.spec]",
    fixtureChoice(value.spec ?? researcher),
    "",
    "[reviewers.high_risk_spec]",
    fixtureChoice(value.high_risk_spec ?? researcher),
    "",
    "[researcher]",
    fixtureChoice(researcher),
    "",
  ].join("\n");
}
/** Write one member preset file by its stable ID (the file name stem). */
export async function writeMemberPreset(
  directory: string,
  id: string,
  value: MemberPresetFixture = {},
) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.toml`), memberPresetToml(value, id));
}
/**
 * Test-owned preset directory. The default `codex-only` file keeps the shipped
 * default selection resolvable with FakeRuntime's own model catalogue.
 */
export async function memberPresetsFixture(
  root: string,
  value: MemberPresetFixture = {},
  id = "codex-only",
) {
  const directory = join(root, "member-presets");
  await writeMemberPreset(directory, id, value);
  return { directory };
}
/** Synchronous variant for fixtures that build a Workspace outside an async body. */
export function memberPresetsFixtureSync(
  root: string,
  value: MemberPresetFixture = {},
  id = "codex-only",
) {
  const directory = join(root, "member-presets");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.toml`), memberPresetToml(value, id));
  return { directory };
}
