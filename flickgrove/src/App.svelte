<script lang="ts">
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Kbd } from "$lib/components/ui/kbd/index.js";
  import { X, Plus, History, CircleHelp } from "@lucide/svelte";
  import { createAuthClient } from "better-auth/svelte";
  import { passkeyClient } from "@better-auth/passkey/client";
  import { Button } from "$lib/components/ui/button/index.js";
  import { navigation, initializeNavigation, resumeFilePreview, openConversation, setSurface, back, validateNavigation, removeSidebarDrawer } from "./navigation.svelte";
  import { readingCache, reading } from "./api";
  import { retainReading } from "./reading-cache";
  import { retainTranscriptPositions } from "./transcript-state";
  import { LocalConnection, preferences, readPreference, writePreference } from "./connection";
  import { choiceLayer } from "./choice-layer.svelte";
  import { onMount, tick, untrack } from "svelte";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button.svelte";
  import { projectReference, mergeProjectCatalogue } from "./project-identity";
  import type { ProjectEnvironment } from "./contracts";
  import type { Answer, Agent, Detail, HistorySession, Human, InstanceReloadResult, InstanceRestartResult, InstanceStatus, Model, Project, Settings, Skill, Snapshot } from "./contracts";
  import { api, editable, setClient } from "./api";
  import { RequestRejected, RequestTimeout } from "./chord-client";
  import { lookupSchema, inspectRetrySchema, abandonCloseSchema, deliverySchema, type Receipt } from "./chord-contract";
  import { addOutgoing, observeRetry, observeRetryLink, observeOutgoing, outgoing, withOutgoing, acceptReceipt, unknownOutgoing, submissionResult, dismissedAnswerOperations } from "./outgoing.svelte";
  import { imageSchema } from "./chord-contract";
  import { loadImages, saveImages, operationKey, type ImageDraft } from "./image-drafts";
  import { receiptAlreadyAccepted, setOutgoingImages, clearClosedPending, closeRecovery, rememberCloseRecovery, forgetCloseRecovery } from "./outgoing.svelte";
  import { observeQuestions, questionPanels, setQuestionPanel } from "./question-state.svelte";
  import ModelFields from "./ModelFields.svelte";
  import Weekly from "./Weekly.svelte";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  const sidebar = Sidebar.useSidebar();
  import SessionList from "./SessionList.svelte";
  import AccountSettings from "./AccountSettings.svelte";
  import VoiceSettings from "./VoiceSettings.svelte";
  import MemberPresets from "./MemberPresets.svelte";
  import ConfigFiles from "./ConfigFiles.svelte";
  import InstanceBlockers from "./InstanceBlockers.svelte";
  import { historyCache } from "./history-cache";
  import AgentDetail from "./AgentDetail.svelte";
  import SessionHistory from "./SessionHistory.svelte";
  import * as m from "./paraglide/messages";
  let { user, colors, onlogout, ondisconnect } = $props<{user:Human; colors:string[]; onlogout:()=>void; ondisconnect:()=>void}>();
  const auth = createAuthClient({ plugins: [passkeyClient()] });
  let users = $state<Human[] | undefined>();
  const showAuthors = $derived((users?.length ?? 0) > 1);
  const currentUser = $derived(users?.find(person => person.id === user.id) ?? user);
  let settingsPage = $state<"account" | "users" | "models" | "voice" | "grove">("account");
  let instance = $state<InstanceStatus | null>(null), instanceError = $state(""), instanceNotice = $state(""), instanceStatusError = $state(""), instanceAction = $state(false);
  let instanceBusyError = false;
  let maintenanceAction = $state<"reload" | "restart">("restart"), confirmationInstance = $state<string | null>(null);
  let restartPending = $state<string | null>(null), instanceSequence = 0;
  const restartKey = "flickgrove.restart.pending";
  function rememberRestart(id: string | null) {
    restartPending = id;
    try { if (id) sessionStorage.setItem(restartKey, id); else sessionStorage.removeItem(restartKey); } catch { /* Keep the in-memory state. */ }
  }
  async function refreshInstance() {
    const sequence = ++instanceSequence;
    try {
      const response = await fetch("/api/instance", {cache:"no-store"});
      if (!response.ok) throw new Error();
      const next = await response.json() as InstanceStatus;
      if (sequence !== instanceSequence) return;
      instance = next; instanceStatusError = "";
      if (!next.busy && instanceBusyError) { instanceBusyError = false; instanceError = ""; }
      if (restartPending && next.id !== restartPending) { rememberRestart(null); toast.success(m.restart_completed()); }
    } catch { if (sequence === instanceSequence) instanceStatusError = m.instance_load_failed(); }
  }
  function beginMaintenance(action: "reload" | "restart") {
    if (!connected || !instance || instanceStatusError || instanceAction || restartPending || (instance.busy && !instance.canConfirmBusy) || (action === "restart" && !instance.restartAvailable)) return;
    if (action === "reload" && !instance.busy) { void reloadMcp(); return; }
    maintenanceAction = action; confirmationInstance = instance.id;
    setSurface("maintenance-confirm", true);
  }
  function confirmMaintenance() {
    if (!connected || !instance || instance.id !== confirmationInstance || instanceStatusError || instanceAction || restartPending || (instance.busy && !instance.canConfirmBusy) || (maintenanceAction === "restart" && !instance.restartAvailable)) return;
    const confirmedInstance = instance.busy ? instance.id : undefined;
    void back();
    if (maintenanceAction === "reload") void reloadMcp(confirmedInstance);
    else void restartGrove(confirmedInstance);
  }
  async function reloadMcp(confirmedInstance?: string) {
    if (instanceAction || restartPending) return;
    instanceAction = true; instanceError = ""; instanceBusyError = false; instanceNotice = "";
    try {
      const response = await fetch("/api/instance/mcp/reload", {method:"POST", ...(confirmedInstance ? {headers:{"Content-Type":"application/json"},body:JSON.stringify({confirmBusy:true,instanceId:confirmedInstance})} : {})});
      if (response.status === 400) { instanceBusyError = true; instanceError = m.instance_changed_reconfirm(); return; }
      if (!response.ok) throw new Error();
      const result = await response.json() as InstanceReloadResult;
      if (result.results.some(item => item.status === "deferred")) instanceNotice = m.mcp_reload_deferred();
      if (result.results.some(item => ["partial", "partial_or_unknown", "failed"].includes(item.status))) instanceError = m.mcp_reload_partial();
      else toast.success(m.mcp_reload_requested());
    } catch { instanceError = m.mcp_reload_failed(); }
    finally { instanceAction = false; void refreshInstance(); }
  }
  async function restartGrove(confirmedInstance?: string) {
    if (!instance || instanceAction || restartPending) return;
    const original = instance.id;
    rememberRestart(original); instanceAction = true; instanceError = ""; instanceBusyError = false;
    try {
      const response = await fetch("/api/instance/restart", {method:"POST", ...(confirmedInstance ? {headers:{"Content-Type":"application/json"},body:JSON.stringify({confirmBusy:true,instanceId:confirmedInstance})} : {})});
      if (response.status >= 400 && response.status < 500) { rememberRestart(null); instanceBusyError = response.status === 400; instanceError = instanceBusyError ? m.instance_changed_reconfirm() : m.instance_load_failed(); }
      else if (response.ok && (await response.json() as InstanceRestartResult).status === "unavailable") { rememberRestart(null); instanceError = m.restart_unavailable(); }
    } catch { /* A disconnected response cannot prove whether restart was requested. */ }
    finally { instanceAction = false; void refreshInstance(); }
  }
  let modelHelpOpen = $state(false);
  const projectListId = $props.id();
  const modelHelpId = projectListId + "-model-help";
  choiceLayer(modelHelpId, () => modelHelpOpen, () => modelHelpOpen = false);
  let invitation = $state<{code:string;expiresAt:string} | null>(null), inviteError = $state(""), inviteBusy = $state(false);
  async function invite() { inviteBusy = true; inviteError = ""; try { const r = await fetch("/api/auth/invitations", { method:"POST" }); if (!r.ok) throw new Error(m.invitation_failed()); invitation = await r.json(); } catch(e) { inviteError = e instanceof Error ? e.message : m.invitation_failed(); } finally { inviteBusy = false; } }
  let logoutBusy = $state(false), logoutError = $state("");
  async function logout() {
    if (logoutBusy) return;
    logoutBusy = true; logoutError = "";
    try { const result = await auth.signOut(); if (result.error) throw new Error(result.error.message ?? m.sign_out_failed()); onlogout(); }
    catch (cause) { logoutError = cause instanceof Error ? cause.message : m.sign_out_failed(); }
    finally { logoutBusy = false; }
  }
  async function addPasskey() { const result = await auth.passkey.addPasskey({createSession:false}); if (result.error) toast.error(result.error.message ?? m.passkey_add_failed()); else toast.success(m.passkey_added()); }

  $effect(() => resumeFilePreview());
  $effect(() => {
    if (!navigation.surfaces.includes("file-preview")) untrack(() => observeQuestions(snapshot.agents, selectedId));
  });
  let client: LocalConnection | undefined;
  let composing = false;
  let snapshot = $state<Snapshot>({ agents: [], settings: null, revision: 0 });
  const savedSelection = preferences.selection;
  let treeOrder = $state(preferences.treeOrder);
  $effect(() => { preferences.treeOrder = $state.snapshot(treeOrder); });
  const savedActivityWindow = readPreference<unknown>("activity-window", "1d");
  let activityWindow = $state<"1h" | "4h" | "1d" | "1w">(savedActivityWindow === "1h" || savedActivityWindow === "4h" || savedActivityWindow === "1w" ? savedActivityWindow : "1d");
  $effect(() => { writePreference("activity-window", activityWindow); });
  let remembered = $state<Record<string, string>>(savedSelection.sessions);
  let selectedId = $state<string | null>(savedSelection.sessions[savedSelection.host] ?? null);
  let navigationReady = $state(false); let connectionReady = $state(false);
  let detail = $state<Detail | null>(null); let skills = $state<Skill[]>([]);
  let queueAuthority = $state<string | null>(null);
  let projects = $state<Project[]>([]); let projectsLoading = $state(true); let models = $state<Model[]>(preferences.models);
  let connected = $state(false); let loading = $state(true); let error = $state("");
  let now = $state(Date.now()); let sessionList: { visibleIds(): string[]; openVisible(id: string): void; switchVisible(event: KeyboardEvent): void; keydown(event: KeyboardEvent): Promise<void>; expandFocused(): void; reveal(id: string): Promise<void>; closeTarget(): string | null; selectAgentOrg(agent: Agent): void };
  let projectSearch = $state<HTMLInputElement | null>(null); let modalOpen = $state(false); let modal = $state<"new" | "settings" | "sign-out" | "keys" | "abandon-close" | null>(null);
  let search = $state(""); let projectId = $state(""); let projectHighlight=$state(""); let projectError=$state(""); let saving = $state(false);
  let modelRefreshBusy = $state(false); let modalModelsLoading=$state(false); let modalModelSequence=0;
  let settings = $state<Settings | null>(null); let sequence = 0; let focusCreatedId = $state<string | null>(null);
  let install = $state<(Event & { prompt: () => Promise<void> }) | null>(null);
  let instanceId = $state(savedSelection.host);
  let desktop = $state(matchMedia("(min-width: 701px)").matches);
  let previousVisible: string[] = [];
  let lostSelection: string | null = null;
  $effect(() => {
    const ids = visibleAgents.map(a => a.id);
    const current = navigation.details.at(-1);
    if (!navigationReady || navigation.surfaces.length) return;
    if (connectionReady && instanceId !== (snapshot.entryId ?? "")) {
      instanceId = snapshot.entryId ?? "";
      return;
    }
    const host = hosts.find(h => h.id === instanceId);
    if (host?.connected && remembered[instanceId] && !ids.includes(remembered[instanceId])) {
      const next = { ...remembered }; delete next[instanceId]; remembered = next;
    }
    if (host?.connected && !loading && (desktop || lostSelection) && (!current || !ids.includes(current))) {
      const position = previousVisible.indexOf(current ?? lostSelection ?? "");
      const visibleIds = sessionList?.visibleIds() ?? [];
      const survivingVisible = (id: string) => ids.includes(id) && visibleIds.includes(id);
      const adjacent = previousVisible.slice(position + 1).find(survivingVisible) ?? previousVisible.slice(0, Math.max(0, position)).reverse().find(survivingVisible);
      const next = lostSelection
        ? adjacent ?? visibleIds[0] ?? null
        : remembered[instanceId] ?? adjacent ?? visibleIds[0] ?? null;
      if (next && lostSelection) sessionList?.openVisible(next);
      else void openConversation(next);
    }
    previousVisible = sessionList?.visibleIds() ?? visibleAgents.filter(a => a.role === "orc").map(a => a.id);
    lostSelection = null;
  });
  const createHost = $derived(snapshot.entryId ?? ""); let catalogSequence = 0;
  const target = $derived(snapshot.agents.find(a => a.id === selectedId));
  // Snapshot identity is display-only; detail remains the write authority.
  const shownDetail = $derived(detail ? withOutgoing(detail) : target ? { ...target, messages: [], deliveries: [] } : null);
  const hosts = $derived(snapshot.hosts ?? []);
  const selectedHost = $derived(hosts.find(h => h.id === shownDetail?.hostId));
  const hostConnected = $derived(!!selectedHost?.connected);
  const visibleAgents = $derived(snapshot.agents.map(a => optimistic(a.id) && a.state !== "working" && a.state !== "stopping" ? {...a,state:"working" as const,currentExecution:undefined} : a));
  $effect(() => { if (navigationReady) preferences.selection = { host: instanceId, sessions: $state.snapshot(remembered) }; });
  let environments = $state<ProjectEnvironment[]>([]);
  let selectedEnvironment = $state("local");
  async function loadEnvironments() { try { environments = await api<ProjectEnvironment[]>("/environments"); } catch(e) { error = e instanceof Error ? e.message : m.load_failure(); } }
  const remotePi = $derived(selectedEnvironment !== "local" && !!settings && settings.orc.backend === "pi");
  async function loadProjects() {
    projectId = ""; projectError=""; projectsLoading=true; const seq = ++catalogSequence;
    const [live,saved] = await Promise.allSettled([api<Project[]>(`/projects?environment=${encodeURIComponent(selectedEnvironment)}`),api<Project[]>("/history/projects")]);
    if(seq !== catalogSequence) return;
    projects = mergeProjectCatalogue(live.status==="fulfilled" ? live.value : [],saved.status==="fulfilled" ? saved.value.filter(p=>(p.environment?.id ?? "local")===selectedEnvironment) : []);
    projectError = [live,saved].flatMap(result=>result.status==="rejected" ? [result.reason instanceof Error ? result.reason.message : m.load_failure()] : []).join(" ");
    projectId = projects[0] ? projectReference(projects[0]) : ""; projectsLoading=false;
  }
  const settingsValid = $derived.by(() => { const current = settings; return !!current && models.some(model => model.id === current.orc.model && (model.backend ?? "codex") === (current.orc.backend ?? "codex") && model.provider === current.orc.provider && model.efforts.includes(current.orc.effort)); });
  const owner = $derived(snapshot.agents.find(a => a.id === shownDetail?.ownerId));
  const filteredProjects = $derived(projectsLoading ? [] : projects.filter(p => `${p.alias} ${p.name}`.toLowerCase().includes(search.toLowerCase())));

  $effect(() => { if (modal === "new" && !filteredProjects.some(p => projectReference(p) === projectId)) projectId = filteredProjects[0] ? projectReference(filteredProjects[0]) : ""; });
  $effect(()=>{projectHighlight=projectId;});
  $effect(()=>{const input=projectSearch;if(input)untrack(()=>{if(modal==="new"&&!navigation.surfaces.includes("history"))input.focus({preventScroll:true});});});
  let hadDetail = false;
  $effect(() => {
    const hasDetail = navigation.details.length > 0;
    if (hadDetail && !hasDetail && !desktop && !navigation.surfaces.length) untrack(() => setSurface("sidebar", true, true));
    hadDetail = hasDetail;
  });
  function closeDetail() { if (navigation.surfaces.length || !desktop) void back(); else if (selectedId && questionPanels[selectedId]) setQuestionPanel(selectedId, false); }
  $effect(() => {
    if (!navigationReady) return;
    const id = navigation.details.at(-1) ?? null;
    if (id !== selectedId) { ++sequence; selectedId = id; detail = null; queueAuthority = null; skills = []; error = ""; if (id) void restoreDetail(id); else { void client?.call("select", {ids:[]}).catch(() => {}); } }
  });
  $effect(() => {
    const kind = navigation.surfaces.find(s => s === "new" || s === "settings" || s === "sign-out" || s === "keys" || s === "abandon-close") ?? null;
    if (kind !== modal) { modal = kind; modalOpen = !!kind; if (kind) void prepareModal(kind); }
  });
  async function refreshDetail(id: string) {
    const seq = ++sequence;
    try {
      const result = await api<Detail>(`/agents/${id}`);
      if (selectedId === id && seq === sequence) { observeOutgoing(result); detail = retainReading(detail, result); queueAuthority = id; readingCache.saveDetail(detail); }
    } catch (e) { if (selectedId === id && seq === sequence && connected) error = e instanceof Error ? e.message : m.load_failure(); }
  }
  function open(id: string, fromDetail = false) { openConversation(id, fromDetail, snapshot.agents.find(a => a.id === id)?.ownerId); }
  async function restoreDetail(id: string) {
    error = ""; selectedId = id;
    const host = id.split(":")[0];
    if (host !== (snapshot.entryId ?? instanceId)) { detail = null; return; }
    observeQuestions(snapshot.agents,id,true);
    remembered = { ...remembered, [host]: id };
    if (detail?.id !== id) detail = readingCache.readDetail(id); skills = [];
    if (hosts.find(h=>h.id===id.split(":")[0])?.connected) {
      void client?.call('select', {ids:[id]}).catch(e => { if(selectedId === id && !(e instanceof RequestTimeout && e.member === "select")) error = e instanceof Error ? e.message : m.load_failure(); });
      if (snapshot.agents.find(a => a.id === id)?.role === "orc" && hosts.find(h => h.id === snapshot.agents.find(a => a.id === id)?.hostId)?.connected) {
        try { const list = await api<Skill[]>(`/agents/${id}/skills`); if (selectedId === id) skills = list; }
        catch (e) { if (selectedId === id) error = e instanceof Error ? e.message : m.load_failure(); }
      }
    }
  }
  function adopt(value: Snapshot, authoritative = false) {
    if (!authoritative && value.revision < snapshot.revision) return;
    // Retain local read-only state until the instance supplies an authoritative snapshot.
    const retained = snapshot.agents.filter(a => value.hosts?.some(h => h.id === a.hostId && !h.connected) && !value.agents.some(next => next.hostId === a.hostId));
    value = { ...value, agents: [...value.agents, ...retained], hosts: value.hosts?.map(h => !h.connected && !h.lastSeen ? { ...h, lastSeen: snapshot.hosts?.find(old => old.id === h.id)?.lastSeen } : h) };
    observeQuestions(value.agents, selectedId);
    if (selectedId && !value.agents.some(a => a.id === selectedId)) lostSelection = selectedId;
    if (authoritative) {
      const order = { ...treeOrder };
      for (const host of value.hosts ?? []) {
        if (!host.connected) continue;
        const ids = value.agents.filter(a => a.hostId === host.id && a.role === "orc").map(a => a.id);
        const saved = (order[host.id] ?? []).filter(id => ids.includes(id));
        order[host.id] = [...saved, ...ids.filter(id => !saved.includes(id))];
      }
      treeOrder = order;
    }
    snapshot = value;
    if (authoritative) for (const host of value.hosts ?? []) {
      if (!host.connected) continue;
      const active = new Set(value.agents.filter(a => a.hostId === host.id).map(a => a.id));
      readingCache.prunePeer(host.id, active);
      retainTranscriptPositions(host.id, active);
    }
    readingCache.saveSnapshot(value);
    historyCache.retain(new Set(value.agents.map(a => a.id)));
    const valid = new Set(value.agents.map(a => a.id));
    for (const id of [...navigation.details, ...Object.values(remembered)]) {
      if (id.startsWith(value.entryId + ":") && (!connectionReady || value.hosts?.some(h => !h.connected))) valid.add(id);
    }
    validateNavigation(valid);

  }
  async function load() {
    loading = true; error = "";
    if(!hosts.find(h=>h.id===snapshot.entryId)?.connected){if(selectedId)await restoreDetail(selectedId);loading=false;projectsLoading=false;return;}
    try {
      const [state, , catalog] = await Promise.all([api<Snapshot>("/snapshot"), Promise.all([loadEnvironments(),loadProjects()]), api<Model[]>("/models")]);
      models = catalog;preferences.models=catalog; if(!preferences.settings&&catalog.length){const model=catalog.find(m=>m.isDefault)??catalog[0];preferences.settings={fast:false,orc:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort}};snapshot={...snapshot,settings:preferences.settings};} if(!connected) adopt(state, true);
      if(!settings && (modal === "new" || modal === "settings") && preferences.settings) settings=structuredClone(preferences.settings);
      if (selectedId) await restoreDetail(selectedId);
    } catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { loading = false; }
  }
  function notifications(before: Snapshot, after: Snapshot) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    for (const a of after.agents) {
      if(!before.hosts?.find(h=>h.id===a.hostId)?.connected || !after.hosts?.find(h=>h.id===a.hostId)?.connected)continue;
      const previous = before.agents.find(p => p.id === a.id); if (!previous) continue;
      if (a.role !== "orc") continue;
      const newQuestions = a.questions.filter(q => q.state === "unanswered" &&
        !previous.questions.some(p => p.id === q.id || p.itemId === q.itemId));
      const batches = [...new Set(newQuestions.map(q => q.itemId))];
      const failed = a.finalFailure && a.finalFailure.id !== previous.finalFailure?.id;
      const handoff = a.userHandoff && a.userHandoff.id !== previous.userHandoff?.id;
      if (!batches.length && !failed && !handoff) continue;
      if (document.hasFocus() && document.visibilityState === "visible" && selectedId === a.id) continue;
      const title = batches.length ? m.notification_input({ title: a.title }) : failed ? m.notification_error({ title: a.title }) : m.notification_handoff({ title: a.title });
      const body = batches.length ? newQuestions.map(q => q.notificationText ?? q.text).join("\n") : failed ? a.error : a.userHandoff?.summary;
      let notification: Notification;
      try {
        notification = new Notification(title, { body, tag: `${a.id}:${batches.length ? `input:${batches.join(",")}` : failed ? `failure:${a.finalFailure!.id}` : `handoff:${a.userHandoff!.id}`}` });
      } catch { continue; }
      notification.onclick = () => { window.focus(); void open(a.ownerId ?? a.id); notification.close(); };
    }
  }
  function show(kind: "new" | "settings" | "sign-out" | "keys") { setSurface(kind, true); }
  async function prepareModal(kind: "new" | "settings" | "sign-out" | "keys" | "abandon-close") {
    error = "";
    if (kind === "abandon-close" && !abandon) {
      const intent = closeRecovery.entries.find(i => i.agentId === selectedId);
      if (!intent) { await closeModal(); return; }
      abandon = { id: intent.agentId, title: snapshot.agents.find(a => a.id === intent.agentId)?.title ?? "Orc", unknownOperationIds: intent.unknownOperationIds };
      closeUnknown = true;
    }
    if (kind === "settings") { settingsPage = "account"; void refreshInstance(); }
    if (kind === "sign-out") logoutError = "";
    if (kind === "new") { search = ""; void loadProjects(); }
    if (kind === "settings" || kind === "new") {
      const saved=preferences.settings;
      const fallback=models.find(m=>m.isDefault) ?? models[0];
      settings=saved ? structuredClone(saved) : fallback ? {fast:false,orc:{backend:fallback.backend ?? "codex",provider:fallback.provider,model:fallback.id,effort:fallback.defaultEffort}} : null;
      const request=++modalModelSequence; modalModelsLoading=true;
      try{const result=await api<Model[]>("/models");if(request!==modalModelSequence)return;models=result;preferences.models=models;}catch(e){if(request!==modalModelSequence)return;if(!models.length)error=e instanceof Error?e.message:m.load_failure();}finally{if(request===modalModelSequence)modalModelsLoading=false;}
      // Catalogue refresh must not replace a foreground settings draft.
      const model = models.find(m => m.isDefault) ?? models[0];
      if(!settings && (modal==='settings' || modal==='new') && model)settings={fast:false,orc:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort}};
    }
    if (kind === "settings" && settings) { settings.fast = !!settings.fast; }

  }
  async function closeModal() { const kind = modal; while (kind && navigation.surfaces.includes(kind)) await back(); }
  async function resumeHistory(session: HistorySession, project: string) {
    const agent = await api<Agent>("/history/resume", { project, threadId: session.threadId, archived: session.archived });
    adopt(await api<Snapshot>("/snapshot"));
    focusCreatedId = agent.id;
    await openConversation(agent.id);
    await sessionList?.reveal(agent.id);
    toast.success(m.session_resumed(), { duration: 3000 });
  }
  $effect(() => { if (detail?.id === focusCreatedId && focusCreatedId) { focusCreatedId = null; void tick().then(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()); } });
  async function creationSettings():Promise<Settings> {
    if (modal === "new" && settings) { preferences.settings = $state.snapshot(settings); return preferences.settings!; }
    if(preferences.settings)return preferences.settings;
    const catalog=await api<Model[]>("/models");
    const model=catalog.find(m=>m.isDefault)??catalog[0];
    if(!model)throw new Error("No models available");
    const initial:Settings={fast:false,orc:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort}};
    preferences.settings=initial;return initial;
  }
  async function create() {
    if (!projectId || saving || !connected) return; saving = true;
    try { const agent = await api<Agent>("/agents", { project: projectReference(projects.find(p=>projectReference(p)===projectId)!), settings: await creationSettings() }); await closeModal(); adopt(await api<Snapshot>("/snapshot")); sessionList?.selectAgentOrg(agent); focusCreatedId = agent.id; open(agent.id); await sessionList?.reveal(agent.id); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  async function refreshModels() {
    if (modelRefreshBusy) return;
    const request=++modalModelSequence; modelRefreshBusy = true; error = "";
    try { const result=await api<Model[]>("/models"); if(request===modalModelSequence){models=result;preferences.models=models;} }
    catch (e) { if(request===modalModelSequence)error = e instanceof Error ? e.message : m.load_failure(); }
    finally { modelRefreshBusy = false; if(request===modalModelSequence)modalModelsLoading=false; }
  }
  async function saveSettings() {
    if (!settings || saving) return; saving = true;
    try { preferences.settings = $state.snapshot(settings); snapshot = {...snapshot,settings:preferences.settings}; closeModal(); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  const lookups=new Set<string>();
  const nextFinalization = new Map<string, number>();
  const retryInspections = new Map<string, number>();
  async function inspectLocalRetry(agentId:string, operationId:string) {
    const key=agentId+"/"+operationId;
    const local=outgoing.entries.find(o=>o.agentId===agentId && o.id===operationId && o.status==="rejected");
    if (!client || !connected || !local || Date.now() < (retryInspections.get(key) ?? 0)) return;
    if (local.localImageIds?.length && local.images?.length !== local.localImageIds.length) return;
    const envelope = local.answers ? {source:"question" as const,answers:$state.snapshot(local.answers)} : {source:"user" as const,text:local.text,...(local.images?.length ? {images:$state.snapshot(local.images)} : {})};
    retryInspections.set(key,Date.now()+30_000);
    try {
      const result=inspectRetrySchema.parse(await client.call('inspectRetry',{id:agentId,operationId,envelope}));
      if (result?.operationId === operationId && result.supersededBy !== operationId && outgoing.entries.some(o=>o.agentId===agentId && o.id===operationId && o.status==="rejected")) { observeRetryLink(agentId,operationId,result.supersededBy); retryInspections.set(key,Infinity); }
    } catch { /* A missing relationship is not a delivery outcome. */ }
  }
  async function lookup(agentId: string, operationId: string) {
    if(!client || !connected || hosts.find(h => h.id === agentId.split(':')[0])?.connected === false) return;
    const key=agentId+"/"+operationId;if(lookups.has(key))return;lookups.add(key);
    const attempt=outgoing.entries.find(o=>o.agentId===agentId && o.id===operationId)?.attemptId;
    try {
      const receipt = lookupSchema.parse(await client.call<Receipt | null>('lookup',{id:agentId,operationId}));
      if (receipt && receipt.operationId !== operationId) throw new Error("Receipt operation identity changed");
      acceptReceipt(agentId, receipt);
      const pending = outgoing.entries.find(o => o.agentId === agentId && o.id === operationId);
      if (receipt || !pending || pending.status !== "pending") { nextFinalization.delete(key); return; }
      // A client marker enables the request; only the issuing Peer can prove
      // this ID has an unclaimed reservation. Legacy IDs stay lookup-only.
      if (!pending.admissionVersion || Date.now() - pending.at < 60_000 || Date.now() < (nextFinalization.get(key) ?? 0)) return;
      if (dispatches.some(d => d.key === key && dispatchActive(d))) return;
      nextFinalization.set(key, Date.now() + 30_000);
      if (!pending.predecessor && pending.localImageIds?.length && pending.images?.length !== pending.localImageIds.length) {
        // Recreate only the staged image references. The original message is
        // never sent here; the Peer permits this upload only while reserved.
        const stored = await loadImages(operationKey(agentId, operationId));
        const images = stored?.images ?? [];
        if (images.length !== pending.localImageIds.length || images.some((image, i) => image.id !== pending.localImageIds![i])) return;
        const form = new FormData();
        form.set("text", JSON.stringify(pending.text));
        for (const image of images) form.append("images", image.file, image.file.name);
        const response = await client.media(agentId, `/api/images?agent=${encodeURIComponent(agentId)}&operation=${encodeURIComponent(operationId)}`, {method:"POST",body:form});
        const upload = await response.json();
        if (!response.ok || upload.agent !== agentId || upload.operation !== operationId) throw new Error(upload.error ?? "Image operation identity changed");
        const refs = upload.images.map((image:unknown) => imageSchema.parse(image));
        if (refs.length !== images.length) throw new Error("Original images are unavailable");
        if (!outgoing.entries.some(o => o.agentId === agentId && o.id === operationId && o.status === "pending")) return;
        setOutgoingImages(agentId, operationId, refs);
      }
      const envelope = pending.predecessor ?? (pending.answers ? {source:"question" as const, answers:pending.answers} : {source:"user" as const, text:pending.text, ...(pending.images?.length ? {images:pending.images} : {})});
      const final = lookupSchema.parse(await client.call<Receipt | null>('finalizeSubmission',{id:agentId,operationId,envelope,...(pending.predecessor ? {predecessor:pending.predecessor} : {})}));
      if (final && final.operationId !== operationId) throw new Error("Receipt operation identity changed");
      acceptReceipt(agentId, final);
    }
    catch(e) { if(outgoing.entries.find(o=>o.agentId===agentId && o.id===operationId)?.attemptId===attempt) unknownOutgoing(agentId,operationId,e instanceof Error?e.message:m.load_failure()); }
    finally{lookups.delete(key);}
  }
  type RetryEnvelope = {source:"user";text:string;images?:import("./contracts").MessageImage[]} | {source:"question";answers:Answer[]};
  async function retryReservation(id:string, operationId:string, envelope:RetryEnvelope) {
    if (!client) throw new Error("Connection offline");
    const connection = client;
    let receipt = lookupSchema.parse(await connection.call<Receipt | null>("lookup", {id,operationId}));
    if (!receipt) receipt = lookupSchema.parse(await connection.call<Receipt | null>("finalizeSubmission", {id,operationId,envelope}));
    if (receipt?.operationId !== operationId || receipt.state !== "rejected") throw new Error("The original message outcome is not confirmed as failed.");
    acceptReceipt(id, receipt);
    const result = await connection.call<{state:string;operationId:string;claimToken?:string}>("reserveRetry", {id,operationId});
    if (!result || !["won","existing"].includes(result.state) || !result.operationId?.startsWith("grove-v1-") || result.operationId === operationId || (result.state === "won" && !/^[A-Za-z0-9_-]{43}$/.test(result.claimToken ?? ""))) throw new Error("Could not prepare the retry. Try again.");
    observeRetryLink(id,operationId,result.operationId);
    retryInspections.set(id+"/"+operationId,Infinity);
    return result;
  }
  async function retryDelivery(operationId: string, supplied?: import("./contracts").Delivery) {
    if (!selectedId || !hostConnected || !client) return;
    const id = selectedId;
    const batch = outgoing.entries.find(o => o.agentId === id && o.id === operationId && o.answers);
    const original = batch ?? supplied ?? detail?.deliveries.find(d => d.id === operationId && d.source === "question");
    if (original) {
      const envelope = "recoveryRef" in original && original.recoveryRef ? await reading<import("./contracts").Delivery>(`/recovery?${new URLSearchParams({agent:id,operation:operationId})}`, id) : original;
      if (!envelope.answers?.length) throw new Error("The original answers are unavailable.");
      const answers = $state.snapshot(envelope.answers);
      const predecessor:RetryEnvelope = {source:"question",answers};
      const retry = await retryReservation(id,operationId,predecessor);
      if (selectedId !== id) return;
      if (retry.state === "won") await answerBatch(answers, retry.operationId, envelope.text, {of:operationId,predecessor,claimToken:retry.claimToken!});
      else { observeRetry(id,envelope.text,retry.operationId,answers,{of:operationId,predecessor}); void lookup(id,retry.operationId); }
      return;
    }
    try { await client.call("retryDelivery", {id:selectedId,deliveryId:operationId}); }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); }
  }
  async function reconcilePending() {
    for(const pending of outgoing.entries) if(pending.status === 'pending') void lookup(pending.agentId,pending.id);
    if(selectedId) for(const pending of dismissedAnswerOperations(selectedId)) if(!receiptAlreadyAccepted(selectedId,pending.id)) void lookup(selectedId,pending.id);
    for(const local of outgoing.entries) if(local.agentId === selectedId && local.status === 'rejected') void inspectLocalRetry(local.agentId,local.id);
  }
  let dispatches = $state<{key:string; token:string; admitting:boolean}[]>([]);
  let retryErrors = $state<Record<string,string>>({});
  const dispatchKey = (id:string, operation:string) => id + "/" + operation;
  const dispatchActive = (dispatch: typeof dispatches[number]) => {
    const local = outgoing.entries.find(o => dispatchKey(o.agentId,o.id) === dispatch.key);
    return !dispatch.admitting || local?.status === "pending";
  };
  const optimistic = (id:string) => {
    const agent = detail?.id === id ? detail : snapshot.agents.find(a => a.id === id);
    return !agent?.connection && dispatches.some(d => d.key.startsWith(id + "/") && dispatchActive(d)) && !!hosts.find(h => h.id === id.split(":")[0])?.connected;
  };
  async function retryUser(id:string, operationId:string, older?:import("./contracts").Delivery) {
    const key = dispatchKey(id,operationId);
    if (!client || dispatches.some(d=>d.key===key && dispatchActive(d)) || receiptAlreadyAccepted(id,operationId)) return;
    const d = (detail?.id === id ? withOutgoing(detail).deliveries.find(d => d.id === operationId) : undefined) ?? older;
    if (!d || d.source !== "user" || submissionResult(d) !== "rejected") return;
    const token=crypto.randomUUID();
    dispatches = [...dispatches,{key,token,admitting:false}];
    retryErrors = {...retryErrors,[key]:""};
    try {
      const local = outgoing.entries.find(o => o.agentId === id && o.id === operationId);
      const original = local ?? (d.recoveryRef ? await reading<import("./contracts").Delivery>(`/recovery?${new URLSearchParams({agent:id,operation:operationId})}`, id) : d);
      if (receiptAlreadyAccepted(id,operationId)) return;
      let images:ImageDraft[] = [];
      const localIds = "localImageIds" in original ? original.localImageIds : undefined;
      if (localIds?.length) {
        const stored = await loadImages(operationKey(id,operationId));
        images = stored?.images ?? [];
        if (images.length !== localIds.length || images.some((image,i) => image.id !== localIds[i])) images = [];
      }
      if (!images.length && original.images?.length) {
        const connection = client;
        images = await Promise.all(original.images.map(async image => {
          const response = await connection.media(id, `/api/images/${encodeURIComponent(image.id)}/original?agent=${encodeURIComponent(id)}`);
          if (!response.ok) throw new Error("Original images are unavailable. Reconnect to the original device and retry.");
          return {id:crypto.randomUUID(),file:new File([await response.blob()],image.name,{type:image.mediaType})};
        }));
      }
      if ((localIds?.length || original.images?.length) && !images.length) throw new Error("Original images are unavailable. Reconnect to the original device and retry.");
      let refs = original.images ? $state.snapshot(original.images) : undefined;
      if (images.length && !refs?.length) {
        const form = new FormData(); form.set("text",JSON.stringify(original.text));
        for(const image of images) form.append("images",image.file,image.file.name);
        const response = await client.media(id,`/api/images?agent=${encodeURIComponent(id)}&operation=${encodeURIComponent(operationId)}`,{method:"POST",body:form});
        const upload = await response.json();
        if(!response.ok || upload.agent!==id || upload.operation!==operationId) throw new Error(upload.error ?? "Image operation identity changed");
        refs = upload.images.map((image:unknown)=>imageSchema.parse(image));
        if(refs?.length!==images.length) throw new Error("Original images are unavailable.");
        setOutgoingImages(id,operationId,refs);
      }
      const predecessor:RetryEnvelope = {source:"user",text:original.text,...(refs?.length ? {images:refs} : {})};
      const retry = await retryReservation(id,operationId,predecessor);
      const meta = {of:operationId,predecessor};
      if(retry.state === "existing") { observeRetry(id,original.text,retry.operationId,undefined,meta); void lookup(id,retry.operationId); return; }
      if (images.length) await saveImages(operationKey(id,retry.operationId),images,original.text);
      addOutgoing(id,original.text,retry.operationId,undefined,undefined,images.map(image=>image.id),meta);
      dispatches = [...dispatches,{key:dispatchKey(id,retry.operationId),token:retry.operationId,admitting:false}];
      try { await dispatch(id,original.text,retry.operationId,images,{...meta,claimToken:retry.claimToken!}); }
      finally { dispatches=dispatches.filter(d=>d.token!==retry.operationId); }
    } catch(e) {
      retryErrors = {...retryErrors,[key]:(e as Error).message};
    } finally { dispatches = dispatches.filter(d => d.token !== token); }
  }
  async function send(id: string, text: string, operationId: string, images: ImageDraft[] = []) {
    if (detail?.id !== id) return false;
    addOutgoing(id,text,operationId,undefined,undefined,images.map(i=>i.id));
    const key=dispatchKey(id,operationId);
    dispatches=[...dispatches,{key,token:operationId,admitting:false}];
    try { await dispatch(id,text,operationId,images); }
    finally { dispatches=dispatches.filter(d=>d.token!==operationId); }
    return true;
  }
  function queueConnection(id:string) {
    if(!client || !connected || !hosts.some(h=>id.startsWith(h.id+":") && h.connected)) throw new Error("Connect to manage the queue.");
    return client;
  }
  async function enqueueFollowUp(id:string, text:string, operationId:string, images:ImageDraft[]) {
    let submitted=false;
    try {
      const connection=queueConnection(id);
      let refs:import("./contracts").MessageImage[] | undefined;
      if(images.length){
        const form=new FormData();form.set("text",JSON.stringify(text));for(const image of images)form.append("images",image.file,image.file.name);
        const response=await connection.media(id,`/api/images?agent=${encodeURIComponent(id)}&operation=${encodeURIComponent(operationId)}`,{method:"POST",body:form});
        const upload=await response.json();
        if(!response.ok || upload.agent!==id || upload.operation!==operationId)throw new Error(upload.error ?? "Image upload failed");
        refs=upload.images.map((item:unknown)=>imageSchema.parse(item));
      }
      submitted=true;
      await connection.call("enqueueFollowUp",{id,text,operationId,...(refs ? {images:refs} : {})});
      return {status:"accepted" as const};
    } catch(e) {
      return {status:(!submitted || e instanceof RequestRejected ? "rejected" : "unknown") as "rejected" | "unknown",error:e instanceof Error ? e.message : m.load_failure()};
    }
  }
  async function lookupFollowUp(id:string,operationId:string) {
    const result=deliverySchema.nullable().parse(await queueConnection(id).call("lookupFollowUp",{id,operationId}));
    if(result && (result.id!==operationId || result.mode!=="follow_up")) throw new Error("Queue operation identity changed");
    return result;
  }
  async function queueAction(id:string,member:"cancelFollowUp" | "resumeFollowUps",operationId?:string) {
    await queueConnection(id).call(member,operationId ? {id,operationId} : {id});
  }
  async function dispatch(id:string,text:string,operationId:string,images:ImageDraft[],retry?:{of:string;predecessor:RetryEnvelope;claimToken:string}) {
    const connection = client;
    let submitted=false;
    try {
      if (!connection || !hosts.find(h=>h.id===id.split(":")[0])?.connected) throw new RequestRejected("Execution host disconnected before submission");
      let refs=outgoing.entries.find(o=>o.agentId===id && o.id===operationId)?.images;
      if(images.length && !refs?.length){
        const form=new FormData();form.set('text',JSON.stringify(text));for(const image of images)form.append('images',image.file,image.file.name);
        const response=await connection.media(id,`/api/images?agent=${encodeURIComponent(id)}&operation=${encodeURIComponent(operationId)}`,{method:'POST',body:form});
        const upload=await response.json();
        if(upload.agent!==id || upload.operation!==operationId)throw new Error(upload.error ?? "Image operation identity changed");
        refs=upload.images.map((i:unknown)=>imageSchema.parse(i));setOutgoingImages(id,operationId,refs!);
      }
      if (receiptAlreadyAccepted(id,operationId)) return;
      submitted=true;
      const active=dispatches.find(d=>d.token===operationId);if(active)active.admitting=true;
      const result=await connection.call<import("./chord-contract").SendResult>('send',{id,text,operationId,...(refs ? {images:refs} : {}),...(retry ? {predecessor:retry.predecessor,claimToken:retry.claimToken} : {})});
      observeOutgoing(result);
      if(!result.deliveries.some(d=>d.id===operationId))unknownOutgoing(id,operationId,"");
    }catch(e){
      unknownOutgoing(id,operationId,e instanceof Error?e.message:m.load_failure());
    }
    if(submitted)void lookup(id,operationId);
  }
  let closingId = $state<string | null>(null);
  let closeError = $state<{ id: string; reason: string } | null>(null);
  let abandon = $state<{ id: string; title: string; unknownOperationIds: string[] } | null>(null);
  let closeUnknown = $state(false);
  let abandonError = $state("");
  let closeRecoveryErrors = $state<Record<string, string>>({});
  let checkingCloses = $state<string[]>([]);
  async function checkPendingClose(id: string, showConfirmation = false) {
    if (closingId === id || checkingCloses.includes(id) || !hosts.some(h => id.startsWith(h.id + ":") && h.connected)) return;
    checkingCloses = [...checkingCloses, id];
    const visit = selectedId; const device = instanceId; const generation = sequence;
    try {
      const state = await readAbandon(id);
      if (state.closed) await finishAbandon(id);
      else if (showConfirmation && selectedId === visit && instanceId === device && sequence === generation && !navigation.surfaces.length) {
        abandon = { id, title: snapshot.agents.find(a => a.id === id)?.title ?? "Orc", unknownOperationIds: state.unknownOperationIds };
        closeUnknown = false; abandonError = ""; setSurface("abandon-close", true);
      }
    } catch(e) { closeRecoveryErrors = { ...closeRecoveryErrors, [id]: e instanceof Error ? e.message : m.load_failure() }; }
    finally { checkingCloses = checkingCloses.filter(target => target !== id); }
  }
  async function readAbandon(id: string) {
    return abandonCloseSchema.parse(await api(`/agents/${id}/abandon-close-candidate`, {}));
  }
  async function finishAbandon(id: string) {
    clearClosedPending(id);
    forgetCloseRecovery(id);
    const errors = { ...closeRecoveryErrors }; delete errors[id]; closeRecoveryErrors = errors;
    if (modal === "abandon-close" && abandon?.id === id) await closeModal();
    if (abandon?.id === id) { abandon = null; closeUnknown = false; abandonError = ""; }
    if (closeError?.id === id) closeError = null;
    toast.success(m.tree_closed(), { duration: 3000 });
    adopt(await api<Snapshot>("/snapshot"), true);
  }
  async function confirmAbandon() {
    if (!abandon || closingId) return;
    const target = $state.snapshot(abandon);
    closingId = target.id; abandonError = "";
    try {
      if (closeUnknown) {
        const state = await readAbandon(target.id);
        if (state.closed) await finishAbandon(target.id);
        else { abandon = { ...target, unknownOperationIds: state.unknownOperationIds }; closeUnknown = false; }
        return;
      }
      // Remember an unknown close until a read confirms its result; never blindly replay.
      rememberCloseRecovery(target.id, target.unknownOperationIds);
      closeUnknown = true;
      await api(`/agents/${target.id}/close`, { abandonUnknownOperationIds: target.unknownOperationIds });
      await finishAbandon(target.id);
    } catch(e) {
      abandonError = e instanceof Error ? e.message : m.load_failure();
      try {
        const state = await readAbandon(target.id);
        if (state.closed) await finishAbandon(target.id);
        else if (e instanceof RequestRejected) {
          abandon = { ...target, unknownOperationIds: state.unknownOperationIds }; closeUnknown = false;
        }
      } catch(readError) {
        closeRecoveryErrors = { ...closeRecoveryErrors, [target.id]: readError instanceof Error ? readError.message : abandonError };
      }
    } finally { closingId = null; }
  }
  async function closeTree(id: string) {
    if (closingId) return;
    closeError = null;
    if (!connected || hosts.find(h => h.id === snapshot.agents.find(a => a.id === id)?.hostId)?.connected === false) { closeError = { id, reason: m.host_offline() }; return; }
    closingId = id;
    const visit = selectedId; const device = instanceId; const generation = sequence;
    try {
      await api(`/agents/${id}/close`, {});
      toast.success(m.tree_closed(), { duration: 3000 });
      adopt(await api<Snapshot>("/snapshot"));
    } catch(e) {
      closeError = { id, reason: e instanceof Error ? e.message : m.load_failure() };
      try {
        const state = await readAbandon(id);
        if (!state.closed && selectedId === visit && instanceId === device && sequence === generation && navigation.surfaces.every(surface => surface === "sidebar")) {
          if (navigation.surfaces.at(-1) === "sidebar") await back();
          if (selectedId !== visit || instanceId !== device || sequence !== generation || navigation.surfaces.length) return;
          abandon = { id, title: snapshot.agents.find(a => a.id === id)?.title ?? "Orc", unknownOperationIds: state.unknownOperationIds };
          closeUnknown = false; abandonError = ""; setSurface("abandon-close", true);
        }
      } catch { /* Ordinary close errors retain their existing inline feedback. */ }
    }
    finally { closingId = null; }
  }
  async function rename(title: string) {
    if (!selectedId || !hostConnected) return m.host_offline();
    const id = selectedId;
    try {
      const result = await api<Detail>(`/agents/${id}/title`, { title });
      if (selectedId === id) detail = result;
      snapshot = { ...snapshot, agents: snapshot.agents.map(a => a.id === id ? { ...a, title: result.title } : a) };
      return undefined;
    } catch (e) { return e instanceof Error ? e.message : m.load_failure(); }
  }
  async function stop() {
    if (!detail?.turnId || !hostConnected || detail.state !== "working") { error = m.stop_not_working(); return false; }
    const id = detail.id; const turnId = detail.turnId;
    try { const result = await api<Detail>(`/agents/${id}/stop`, { turnId }); if (selectedId === id) detail = result; return true; }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); return false; }
  }
  async function answerBatch(answers: Answer[], operationId: string, preparedText?: string, retry?:{of:string;predecessor:RetryEnvelope;claimToken:string}) {
    if (!selectedId || !hostConnected || !client || !detail) throw new Error("Connect to send your answer.");
    const id = selectedId;
    const text = preparedText ?? outgoing.entries.find(o => o.agentId === id && o.id === operationId)?.text ?? answers.map(answer => `Question: ${detail!.questions.find(q => q.id === answer.questionId)?.text}\nAnswer: ${answer.answer}`).join("\n\n");
    addOutgoing(id, text, operationId, answers, undefined, undefined, retry);
    try {
      const result = await client.call<Detail>("answerBatch", { id, answers, operationId, ...(retry ? {predecessor:retry.predecessor,claimToken:retry.claimToken} : {}) });
      observeOutgoing(result);
    } catch (e) { unknownOutgoing(id, operationId, e instanceof Error ? e.message : m.load_failure()); }
    void lookup(id, operationId);
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
    if ((event.metaKey !== event.ctrlKey) && !event.altKey && !event.shiftKey && event.code === "KeyB") {
      if (event.repeat || navigation.surfaces.some(surface => surface !== "sidebar")) return;
      event.preventDefault();
      if (!sidebar.isMobile && sidebar.open && document.activeElement?.closest('[data-sidebar="sidebar"]')) document.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')?.focus({preventScroll: true});
      sidebar.toggle();
      return;
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyX") {
      event.preventDefault();
      if (navigation.surfaces.length) return;
      const id = navigation.details.length ? (detail?.role === "orc" ? detail.id : null) : sessionList?.closeTarget();
      if (id && !event.repeat) void closeTree(id);
      return;
    }
    if (event.key !== "Escape" && event.target instanceof Element && event.target.closest("[role=menu]")) return;
    if (!event.shiftKey && !event.repeat && !editable(event.target) && !navigation.surfaces.some(surface => surface !== "sidebar") && !(event.target instanceof Element && event.target.closest(".question-panel, .pending-entry, .question-record-entry"))) {
      const numbered = (event.metaKey !== event.ctrlKey) && !event.altKey && /^(?:Digit|Numpad)[1-9]$/.test(event.code);
      const adjacent = event.altKey && !event.metaKey && !event.ctrlKey && ["KeyJ", "KeyK"].includes(event.code);
      if (numbered || adjacent) { sessionList?.switchVisible(event); return; }
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault(); closeDetail();
      return;
    }
    if (editable(event.target) || navigation.surfaces.some(surface => surface !== "sidebar")) return;
    if (event.key.toLowerCase() === "i" && detail?.role === "orc") { event.preventDefault(); document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(); return; }
    if (event.target instanceof HTMLElement && event.target.closest(".question-panel, .pending-entry, .question-record-entry")) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key)) { void sessionList?.keydown(event); return; }
    if (event.key.toLowerCase() === "n") { event.preventDefault(); void show("new"); }
    else if (event.key.toLowerCase() === "e") { event.preventDefault(); sessionList?.expandFocused(); }
    else if (event.key === "?") { event.preventDefault(); void show("keys"); }
  }
  onMount(() => {
    try { restartPending = sessionStorage.getItem(restartKey); } catch { /* Storage is optional. */ }
    const cached = readingCache.readSnapshot(); if (cached) snapshot={...cached,agents:cached.agents.filter(a=>a.hostId===cached.entryId),hosts:cached.hosts?.filter(h=>h.id===cached.entryId).map(h=>({...h,connected:false}))};
    if (selectedId && selectedId.startsWith((snapshot.entryId ?? "") + ":")) detail = readingCache.readDetail(selectedId);
    const cleanupNavigation = initializeNavigation(selectedId);
    navigationReady = true;
    const initialId = navigation.details.at(-1);
    if (initialId) { instanceId = initialId.split(":")[0]; remembered = { ...remembered, [instanceId]: initialId }; }
    const media = matchMedia("(min-width: 701px)");
    const resize = () => { desktop = media.matches; if (navigation.surfaces.includes("sidebar")) removeSidebarDrawer(); };
    media.addEventListener("change", resize);
    let disposed=false;
    client=new LocalConnection(value=>{
      if(disposed)return;
      users = value.users;
      const before=snapshot;
      const entryWasConnected=before.hosts?.find(h=>h.id===value.snapshot.entryId)?.connected;
      connected=value.snapshot.hosts?.some(h=>h.connected)??false;
      if(selectedId && !value.snapshot.hosts?.some(h=>selectedId!.startsWith(h.id+":") && h.connected))queueAuthority=null;
      notifications(before,value.snapshot);
      adopt(value.snapshot,true);const entry=value.snapshot.hosts?.find(h=>h.id===value.snapshot.entryId);loading=!!entry&&!entry.connected&&!entry.error;
      const incoming=selectedId&&value.details[selectedId];
      if(incoming && value.snapshot.agents.some(a=>a.id===incoming.id)){observeOutgoing(incoming);detail=retainReading(detail?.messages.length ? detail : readingCache.readDetail(incoming.id),incoming);queueAuthority=incoming.id;readingCache.saveDetail(detail);}
      void reconcilePending();
      for (const intent of closeRecovery.entries) {
        const peer = intent.agentId.split(":")[0];
        if (!before.hosts?.some(h => h.id === peer && h.connected) && value.snapshot.hosts?.some(h => h.id === peer && h.connected)) void checkPendingClose(intent.agentId);
      }
      if(selectedId){const id=selectedId.split(":")[0];if(!before.hosts?.find(h=>h.id===id)?.connected&&value.snapshot.hosts?.find(h=>h.id===id)?.connected)void restoreDetail(selectedId);}
      if(!entryWasConnected&&value.snapshot.hosts?.find(h=>h.id===value.snapshot.entryId)?.connected){
        void load();
        void refreshInstance();
        if(modal==="new")void loadProjects();
      }
    },id=>{
      ondisconnect();
      for(const pending of outgoing.entries)if(pending.agentId.startsWith(id+":")&&pending.status==='pending')unknownOutgoing(pending.agentId,pending.id,m.sending());
    });
    setClient(client);
    void client.start().then(()=>{connectionReady=true;return load();}).catch(e=>{loading=false;projectsLoading=false;error=e.message;});
    const compositionStart = () => composing = true;
    const compositionEnd = () => composing = false;
    window.addEventListener("compositionstart", compositionStart);
    window.addEventListener("compositionend", compositionEnd);
    const timer = setInterval(() => { now = Date.now(); if (connected && now % 5000 < 1000) { void reconcilePending(); if (modal === "settings" && settingsPage === "grove") void refreshInstance(); } }, 1000);
    const permission = () => { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {}); };
    const reserveTab = (e: KeyboardEvent) => { if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && e.keyCode !== 229) e.preventDefault(); };
    window.addEventListener("keydown", reserveTab, true);
    const installer = (e: Event) => { e.preventDefault(); install = e as Event & { prompt: () => Promise<void> }; };
    window.addEventListener("pointerdown", permission, { once: true }); window.addEventListener("keydown", permission, { once: true }); window.addEventListener("keydown", keydown); window.addEventListener("beforeinstallprompt", installer);
    return () => { window.removeEventListener("compositionstart", compositionStart); window.removeEventListener("compositionend", compositionEnd); media.removeEventListener("change", resize); cleanupNavigation(); window.removeEventListener("keydown", reserveTab, true); disposed = true; client?.close(); setClient(undefined); clearInterval(timer);window.removeEventListener("pointerdown", permission); window.removeEventListener("keydown", permission); window.removeEventListener("keydown", keydown); window.removeEventListener("beforeinstallprompt", installer); };
  });
</script>

<Toaster theme="dark" position="bottom-center" />
{#snippet globalActions()}
  <div class="global-actions">{#if !loading && shownDetail?.backend !== "pi" && (!snapshot.agents.length || snapshot.agents.some(agent => agent.backend !== "pi"))}<Weekly agent={detail} hostId={snapshot.entryId} connected={!!hosts.find(h=>h.id===snapshot.entryId)?.connected} />{/if}</div>
{/snippet}
<div class="workbench" class:close-recovery-layout={closeRecovery.entries.some(i => modal !== "abandon-close" || abandon?.id !== i.agentId)}>
<main>
  <Sidebar.Root>
  <SessionList bind:this={sessionList} user={currentUser} version={instance?.version ?? null} {showAuthors} onsettings={() => show("settings")} onlogout={() => show("sign-out")} agents={visibleAgents} {projects} {projectsLoading} {instanceId} {activityWindow} onactivitywindow={value => activityWindow = value} {now} rootOrder={treeOrder[instanceId] ?? []} onreorder={ids => treeOrder = { ...treeOrder, [instanceId]: ids }} {hosts} {selectedId} {loading} {connected} {closingId} closeError={selectedId === closeError?.id && navigation.surfaces.at(-1) !== "sidebar" ? null : closeError} onclosetree={closeTree} onopen={open} onnew={() => show("new")}>
    {#if !connected && !loading}<div class="connection-banner" role="status"><strong>{m.reconnecting()}</strong><span>{m.offline_help()}</span><Button variant="ghost" size="sm" onclick={load}>{m.retry()}</Button></div>{/if}
  </SessionList>
  </Sidebar.Root>
  {#if !shownDetail}<div class="detail-empty"><div class="empty-tools"><Sidebar.Trigger />{@render globalActions()}</div><div class="empty-message" role="status"><p>{selectedId ? m.loading() : m.select_conversation()}</p>{#if selectedId}<Button variant="ghost" size="sm" onclick={closeDetail}>{m.back_sessions()}</Button>{/if}</div></div>{/if}
  {#if error && !modal && !shownDetail}<div class="app-error" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={() => error = ""}><X /></Button></div>{/if}
  {#if shownDetail && selectedId}{#key selectedId}<AgentDetail {globalActions} {showAuthors} {users} detail={shownDetail!} ready={!!detail} queueReady={queueAuthority === selectedId && connected && hostConnected} onenqueue={enqueueFollowUp} oncheckqueue={lookupFollowUp} onqueueaction={queueAction} tree={shownDetail!.role === "orc" ? target : owner} {owner} {skills} {now} connected={hostConnected} mediaConnected={connected && hostConnected} onstop={stop} onupdate={result => { if (selectedId === result.id) detail = result; snapshot = { ...snapshot, agents: snapshot.agents.map(a => a.id === result.id ? { ...a, model: result.model, effort: result.effort, serviceTier: result.serviceTier } : a) }; }} onrename={rename} onrefresh={load} onretryuser={retryUser} {retryErrors} dispatching={dispatches.filter(d=>d.key.startsWith(selectedId + "/") && dispatchActive(d)).map(d=>d.key.slice(selectedId!.length+1))} optimisticWorking={optimistic(selectedId)} actionError={error} closeError={closeError?.id === shownDetail.id ? closeError.reason : undefined} lastSeen={selectedHost?.lastSeen} workers={snapshot.agents.filter(w => w.ownerId === detail?.id)} onclose={closeDetail} onopen={id => open(id, true)} onsend={send} onanswer={answerBatch} onretry={retryDelivery} />{/key}{/if}
</main>

{#if closeRecovery.entries.some(i => modal !== "abandon-close" || abandon?.id !== i.agentId)}
  <div class="close-recovery flex-col items-start" role="status" aria-label={m.abandon_close_recovery()}>
    {#each closeRecovery.entries.filter(i => i.agentId.startsWith(snapshot.entryId + ":") && (modal !== "abandon-close" || abandon?.id !== i.agentId)) as intent (intent.agentId)}<div class="flex flex-wrap items-center gap-2 min-w-0"><div class="min-w-0"><strong>{m.abandon_close_recovery()}</strong><p class="break-all text-xs">{intent.agentId}</p>{#if closeRecoveryErrors[intent.agentId]}<p role="alert" class="break-words">{closeRecoveryErrors[intent.agentId]}</p>{/if}</div><Button variant="ghost" size="sm" disabled={closingId === intent.agentId || checkingCloses.includes(intent.agentId) || !hosts.some(h => intent.agentId.startsWith(h.id + ":") && h.connected)} onclick={() => checkPendingClose(intent.agentId, true)}>{m.abandon_close_check()}</Button></div>{/each}
  </div>
{/if}
</div>
<Dialog.Root open={modalOpen} onOpenChange={value => { if (!value && modal) void closeModal(); }}>
  <Dialog.Content onEscapeKeydown={event=>{event.preventDefault();event.stopPropagation();void back();}} showCloseButton={false} class={`grove-dialog ${modal === "new" ? "new-modal" : modal === "settings" ? "settings-modal" : modal === "sign-out" ? "signout-dialog" : ""}`} onOpenAutoFocus={e => { e.preventDefault(); if (modal === "new") projectSearch?.focus(); }}><Button class="modal-close" variant="ghost" size="icon-sm" aria-label={m.close()} onclick={closeModal}><X /></Button>
    {#if modal === "sign-out"}
      <Dialog.Header><Dialog.Title>{m.sign_out_confirm()}</Dialog.Title><Dialog.Description>{m.sign_out_help()}</Dialog.Description></Dialog.Header>
      {#if logoutError}<p class="inline-error" role="alert">{logoutError}</p>{/if}
      <Dialog.Footer class="signout-actions"><Button variant="ghost" size="sm" disabled={logoutBusy} onclick={closeModal}>{m.cancel()}</Button><Button variant="default" size="sm" disabled={logoutBusy} onclick={logout}>{logoutBusy ? m.signing_out() : m.sign_out()}</Button></Dialog.Footer>
    {:else if modal === "abandon-close" && abandon}
      <Dialog.Title>{m.abandon_close_title()}</Dialog.Title>
      <Dialog.Description>{m.abandon_close_help()}</Dialog.Description>
      <p class="break-words font-medium">{abandon.title}</p>
      <details open><summary>{m.abandon_close_submissions({ count: abandon.unknownOperationIds.length })}</summary><ul class="max-h-32 overflow-y-auto text-xs break-all">{#each abandon.unknownOperationIds as id}<li>{id}</li>{/each}</ul></details>
      {#if abandonError}<p class="inline-error" role="alert">{abandonError}</p>{/if}
      <div class="flex flex-wrap justify-end gap-2"><Button variant="ghost" size="sm" disabled={!!closingId} onclick={closeModal}>{m.cancel()}</Button><Button variant="destructive" size="sm" disabled={!!closingId || !hosts.find(h => abandon?.id.startsWith(h.id + ":"))?.connected} onclick={confirmAbandon}>{closingId ? m.sending() : closeUnknown ? m.abandon_close_check() : m.abandon_close_title()}</Button></div>
    {:else if modal === "new"}
      <Dialog.Title>{navigation.surfaces.includes("history") ? m.open_session() : m.new_session()}</Dialog.Title>
      {#if navigation.surfaces.includes("history") && projects.find(p => projectReference(p) === projectId)}
        {#key createHost + ":" + selectedEnvironment + ":" + projectId}<SessionHistory {showAuthors} {users} hostId={createHost} project={projects.find(p => projectReference(p) === projectId)!} connected={connected && !!hosts.find(h => h.id === createHost)?.connected} onresume={resumeHistory} />{/key}
      {:else}
      {#if environments.length > 1 || selectedEnvironment !== "local"}
      <label class="form-section-label" for="execution-environment">Execution environment</label>
      <Select.Root type="single" value={selectedEnvironment} onValueChange={value=>{selectedEnvironment=value;search="";void loadProjects();}} disabled={saving}>
        <Select.Trigger id="execution-environment" class="w-full min-w-0"><span class="truncate">{environments.find(e=>e.id===selectedEnvironment)?.name ?? "Unavailable environment"}</span></Select.Trigger>
        <Select.Content>{#each environments as environment}<Select.Item value={environment.id}>{environment.name}</Select.Item>{/each}</Select.Content>
      </Select.Root>
      {/if}
      <p class="form-section-label">{m.project_label()}</p>
      <Command.Root class="project-choice h-auto border border-input" shouldFilter={false} bind:value={projectHighlight} label={m.search_projects()}>
        <Command.Input aria-controls={projectListId} bind:ref={projectSearch} aria-label={m.search_projects()} placeholder={m.search_projects()} bind:value={search} disabled={saving} onkeydown={event=>{if(event.key==="Tab"&&!event.isComposing&&!event.shiftKey){event.preventDefault();if(filteredProjects.some(project=>projectReference(project)===projectHighlight))projectId=projectHighlight;}}} />
        <Command.List id={projectListId} class="max-h-44" aria-label={m.project_label()} aria-busy={projectsLoading}>
          {#each filteredProjects as project (projectReference(project))}
            <Command.Item value={projectReference(project)} aria-label={project.historyRef ? project.name+" · Saved history" : project.name} data-checked={projectReference(project)===projectId} disabled={saving||!connected||!hosts.find(host=>host.id===createHost)?.connected} onSelect={()=>projectId=projectReference(project)}>
              <div class="min-w-0 flex-1"><strong class="block break-words font-medium">{project.name}</strong><span class="block break-all text-xs text-muted-foreground">{project.name!==project.alias ? project.alias+" · " : ""}{project.path}{#if project.historyRef} · Saved history{/if}</span></div>
            </Command.Item>
          {:else}<p class="px-2 py-3 text-sm text-muted-foreground" role="status">{projectsLoading ? m.loading() : !connected ? m.offline_help() : projectError ? m.load_failure() : m.no_projects()}</p>{/each}
        </Command.List>
      </Command.Root>
      {#if projectError}<p role="alert">{projectError} <Button variant="ghost" size="sm" disabled={!connected||projectsLoading} onclick={loadProjects}>{m.retry()}</Button></p>{/if}
      {#if !settings&&modalModelsLoading}<p role="status">{m.loading()}</p>{/if}
      {#if settings}<section class="role-settings"><h3>{m.orc()}</h3><ModelFields bind:value={settings.orc} {models} loading={modelRefreshBusy||modalModelsLoading} disabled={saving||!connected} label={m.orc()} /></section>{/if}
      <Button variant="ghost" size="sm" disabled={modelRefreshBusy || !connected} onclick={refreshModels}>Refresh models</Button>
      {#if remotePi}<p role="alert" class="inline-error">Pi supports this machine only. Choose Codex for Orc.</p>{/if}
      <p class="project-keyboard">{m.project_keyboard()}</p>
      <div class="modal-action"><Button variant="ghost" size="sm" disabled={!connected || !hosts.find(h => h.id === createHost)?.connected || saving || !projectId} onclick={() => setSurface("history", true)}><History />{m.find_history()}</Button><Button variant="default" size="sm" disabled={!connected || !hosts.find(h => h.id === createHost)?.connected || saving || remotePi || !!projects.find(p=>projectReference(p)===projectId)?.historyRef || !settingsValid || !filteredProjects.some(p => projectReference(p) === projectId)} onclick={create}>{saving ? m.sending() : m.new_session()}</Button></div>
      {/if}
    {:else if modal === "settings"}
      <Dialog.Title>{m.settings()}</Dialog.Title>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label={m.settings_sections()}>
          <button class:active={settingsPage === "account"} aria-current={settingsPage === "account" ? "page" : undefined} onclick={() => settingsPage = "account"}>{m.account()}</button>
          <button class:active={settingsPage === "users"} aria-current={settingsPage === "users" ? "page" : undefined} onclick={() => settingsPage = "users"}>{m.users()}</button>
          <button class:active={settingsPage === "models"} aria-current={settingsPage === "models" ? "page" : undefined} onclick={() => settingsPage = "models"}>{m.models()}</button>
          <button class:active={settingsPage === "voice"} aria-current={settingsPage === "voice" ? "page" : undefined} onclick={() => settingsPage = "voice"}>{m.voice_settings()}</button>
          <button class:active={settingsPage === "grove"} aria-current={settingsPage === "grove" ? "page" : undefined} onclick={() => { settingsPage = "grove"; void refreshInstance(); }}>{m.grove_settings()}</button>
        </nav>
        <div class="settings-content">
          {#if settingsPage === "account"}
            <AccountSettings user={currentUser} {colors} onpasskey={addPasskey} onsaved={value => { users = users?.map(person => person.id === value.id ? value : person); }} />
          {:else if settingsPage === "users"}
            <section class="settings-section"><h2>{m.users()}</h2>{#if users}<ul class="account-users">{#each users as person (person.id)}<li><span class="account-avatar" style:background={person.color}>{person.name.slice(0,1).toUpperCase()}</span><span>{person.name}</span>{#if person.id === user.id}<small>{m.you()}</small>{/if}</li>{/each}</ul>{:else}<p>{m.loading_users()}</p>{/if}<div class="account-actions"><Button variant="outline" size="sm" disabled={inviteBusy} onclick={invite}>{m.create_invitation()}</Button></div>{#if invitation}<div class="invite-code"><code>{invitation.code}</code><Button variant="ghost" size="sm" onclick={() => navigator.clipboard.writeText(invitation!.code).then(() => toast.success(m.copied())).catch(() => toast.error(m.could_not_copy()))}>{m.copy()}</Button><small>{m.expires_at({time:new Date(invitation.expiresAt).toLocaleTimeString()})}</small></div>{/if}{#if inviteError}<p role="alert">{inviteError}</p>{/if}</section>
          {:else if settingsPage === "voice"}
            <VoiceSettings peerId={snapshot.entryId ?? ""} {connected} />
          {:else if settingsPage === "grove"}
            <section class="settings-section instance-settings"><h2>{m.grove_settings()}</h2>
              <div class="instance-actions"><Button variant="outline" size="sm" disabled={!connected || !instance || !!instanceStatusError || (instance.busy && !instance.canConfirmBusy) || instanceAction || !!restartPending} onclick={() => beginMaintenance("reload")}>{instanceAction && !restartPending ? m.reloading_mcp() : m.reload_mcp()}</Button><Button variant="outline" size="sm" disabled={!connected || !instance || !!instanceStatusError || (instance.busy && !instance.canConfirmBusy) || !instance.restartAvailable || instanceAction || !!restartPending} onclick={() => beginMaintenance("restart")}>{m.restart_grove()}</Button></div>
              {#if restartPending}<p role="status">{m.restart_unknown()} <Button variant="ghost" size="sm" disabled={!connected} onclick={refreshInstance}>{m.restart_check()}</Button></p>
              {:else if instance?.busy}<p role="status">{instance.canConfirmBusy ? m.instance_busy_confirmable() : m.restart_wait_idle()}</p><InstanceBlockers sessions={instance.sessions} instanceReasons={instance.instanceReasons} />
              {:else if instance && !instance.restartAvailable}<p role="status">{m.restart_unavailable()}</p>{/if}
              {#if instanceError}<p class="inline-error" role="alert">{instanceError}</p>{/if}
              {#if instanceNotice}<p role="status">{instanceNotice}</p>{/if}
              {#if instanceStatusError}<p class="inline-error" role="alert">{instanceStatusError}</p>{/if}
              <ConfigFiles peerId={snapshot.entryId ?? ""} {connected} />
              <Dialog.Root open={navigation.surfaces.includes("maintenance-confirm")} onOpenChange={value => { if (!value) setSurface("maintenance-confirm", false); }}>
                <Dialog.Content class="grove-dialog signout-dialog" showCloseButton={false} onEscapeKeydown={event => { event.preventDefault(); event.stopPropagation(); void back(); }}>
                  <Dialog.Header><Dialog.Title>{maintenanceAction === "reload" ? m.reload_mcp_confirm() : m.restart_grove_confirm()}</Dialog.Title><Dialog.Description>{#if maintenanceAction === "restart"}{m.restart_grove_help()}{/if}{#if instance?.busy}{maintenanceAction === "restart" ? " " : ""}{m.instance_busy_warning()}{/if}</Dialog.Description></Dialog.Header>
                  {#if instance?.busy}<InstanceBlockers sessions={instance.sessions} instanceReasons={instance.instanceReasons} />{/if}
                  {#if instance && instance.id !== confirmationInstance}<p class="inline-error" role="alert">{m.instance_changed_reconfirm()}</p>{/if}
                  <Dialog.Footer class="signout-actions"><Button variant="ghost" size="sm" onclick={() => back()}>{m.cancel()}</Button><Button variant="default" size="sm" disabled={!connected || !instance || instance.id !== confirmationInstance || !!instanceStatusError || (instance.busy && !instance.canConfirmBusy) || (maintenanceAction === "restart" && !instance.restartAvailable) || instanceAction || !!restartPending} onclick={confirmMaintenance}>{maintenanceAction === "reload" ? m.reload_mcp() : m.restart_grove()}</Button></Dialog.Footer>
                </Dialog.Content>
              </Dialog.Root>
            </section>
          {:else}
            <section class="settings-section"><div class="settings-heading"><h2>{m.models()}</h2><Popover.Root bind:open={modelHelpOpen}><Popover.Trigger aria-label={m.model_settings_help()} title={m.settings_help()} class={buttonVariants({variant:"ghost",size:"icon-xs"})}><CircleHelp aria-hidden="true" /></Popover.Trigger><Popover.Content align="start" sideOffset={6} class="w-64 max-w-[calc(100vw-2rem)] p-3 text-xs" onEscapeKeydown={event => event.stopPropagation()}>{m.settings_help()}</Popover.Content></Popover.Root></div>
            {#if !settings&&modalModelsLoading}<p role="status">{m.loading()}</p>{/if}
            {#if settings}<section class="role-settings"><h3>{m.orc()}</h3><ModelFields bind:value={settings.orc} {models} loading={modelRefreshBusy||modalModelsLoading} disabled={saving||!connected} label={m.orc()} /></section><label class="fast-setting"><span><strong>{m.fast_mode()}</strong></span><Switch aria-label={m.fast_mode()} bind:checked={settings.fast} /></label>{/if}
            <MemberPresets peerId={snapshot.entryId ?? ""} {connected} />
            <div class="modal-action"><span class="settings-action-start"><Button variant="ghost" size="sm" disabled={modelRefreshBusy || !connected} onclick={refreshModels}>Refresh models</Button>{#if install}<button class="install-link" onclick={() => install?.prompt()}>{m.install_app()}</button>{/if}</span><Button variant="default" size="sm" disabled={!settings || !settingsValid || saving} onclick={saveSettings}>{saving ? m.sending() : m.save_changes()}</Button></div></section>
          {/if}
        </div>
      </div>
    {:else if modal === "keys"}
      <Dialog.Title>{m.shortcuts()}</Dialog.Title><p class="modal-help">{m.keyboard_help()}</p><dl class="shortcut-list">{#each [["⌘ / Ctrl + B", m.toggle_sidebar()], ["⌘ / Ctrl + 1–9", m.key_visible_number()], ["Option/Alt + J / K", m.key_visible_cycle()], ["↑ ↓ ← →", m.key_focus()], ["Enter", m.key_open()], ["E", m.key_expand()], ["N", m.key_new()], ["I", m.key_input()], ["Option/Alt + S", m.search_skills()], ["Option/Alt + X", m.close_tree()], ["Esc", m.key_escape()], ["Tab", m.key_completion()], ["Tab", "Queue message while working"], ["Enter", m.key_send()], ["Shift + Enter", m.key_newline()]] as [key, label]}<div><dt><Kbd>{key}</Kbd></dt><dd>{label}</dd></div>{/each}</dl><p class="keyboard-scope">{m.keyboard_scope()}</p>
    {/if}
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
  </Dialog.Content>
</Dialog.Root>
