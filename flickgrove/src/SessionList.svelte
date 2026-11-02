<script lang="ts" module>
  // Responsive Sidebar branches remount the same business tree. Re-observe a
  // selection only when its identity changes, not when its container changes.
  let revealedSelection: string | null = null;
</script>
<script lang="ts">
  import ChoiceSelect from "./ChoiceSelect.svelte";
  import * as Select from "$lib/components/ui/select/index.js";
  import { choiceLayer } from "./choice-layer.svelte";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import {environmentId} from "./project-identity";
  import { ChevronDown, ChevronRight, Plus, Zap, MessageCircle, GitBranch } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Settings, LogOut } from "@lucide/svelte";
  import { ContextMenu } from "bits-ui";
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { readPreference, writePreference } from "./connection";
  import type { Agent, Host, Human, Project } from "./contracts";
  import * as m from "./paraglide/messages";
  const windows = { "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000 };
  type Window = keyof typeof windows;
  const nicknameOrder = new Intl.Collator("zh", { sensitivity: "base", numeric: true });
  let { user, version, showAuthors, onsettings, onlogout, agents, projects, projectsLoading, instanceId, activityWindow, onactivitywindow, now, rootOrder, onreorder, hosts, selectedId, loading, connected, onopen, onnew, onclosetree, closingId, closeError, children }: { user: Human; version: string | null; showAuthors: boolean; onsettings: () => void; onlogout: () => void; agents: Agent[]; projects: Project[]; projectsLoading: boolean; instanceId: string; activityWindow: Window; onactivitywindow: (value: Window) => void; now: number; rootOrder: string[]; onreorder: (ids: string[]) => void; hosts: Host[]; selectedId: string | null; loading: boolean; connected: boolean; onopen: (id: string) => void; onnew: () => void; onclosetree: (id: string) => Promise<void>; closingId: string | null; closeError: { id: string; reason: string } | null; children?: Snippet } = $props();
  const savedExpanded = readPreference<unknown>("expanded", []);
  let expanded = $state<string[]>(Array.isArray(savedExpanded) ? savedExpanded.filter((v): v is string => typeof v === "string") : []);
  const savedOrgs = readPreference<unknown>("selected-orgs", {});
  let selectedOrgs = $state<Record<string, string>>(savedOrgs && typeof savedOrgs === "object" && !Array.isArray(savedOrgs) ? Object.fromEntries(Object.entries(savedOrgs).filter(([, v]) => typeof v === "string")) : {});
  const savedFolded = readPreference<unknown>("opened-folded", {});
  let foldedOrgs = $state<Record<string, string[]>>(savedFolded && typeof savedFolded === "object" && !Array.isArray(savedFolded) ? Object.fromEntries(Object.entries(savedFolded).filter(([, v]) => Array.isArray(v) && v.every(x => typeof x === "string"))) : {});
  let orgMenuOpen = $state(false);
  const orgMenuId = $props.id();
  choiceLayer(orgMenuId, () => orgMenuOpen, () => orgMenuOpen = false);
  function selectOrg(key: string) { selectedOrgs = { ...selectedOrgs, [instanceId]: key }; writePreference("selected-orgs", selectedOrgs); endDrag(); }
  function groupKey(agent: Agent) {
    const catalogue = projects.filter(p=>!p.historyRef && environmentId(p)===environmentId(agent.project) && (environmentId(p)==="local" || p.environment?.target===agent.project.environment?.target));
    const project = catalogue.find(p => p.alias === agent.project.alias && p.path === agent.project.path)
      ?? catalogue.find(p => p.path === agent.project.path)
      ?? catalogue.find(p => p.alias === agent.project.alias);
    return project?.owner ?? agent.project.owner ?? (projectsLoading && !projects.length ? "@loading" : "");
  }
  export function selectAgentOrg(agent: Agent) { const key = groupKey(agent); if (key !== "@loading") selectOrg(key); }
  let desktop = $state(matchMedia("(min-width: 701px)").matches);
  let draggingId = $state<string | null>(null);
  let dropAt = $state<{ id: string; after: boolean } | null>(null);
  function dragStart(event: DragEvent, agent: Agent) {
    if (!desktop || agent.role !== "orc" || groupKey(agent) === "@loading" || !event.dataTransfer) { event.preventDefault(); return; }
    draggingId = agent.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", agent.id);
  }
  function dragOver(event: DragEvent, agent: Agent) {
    const id = agent.ownerId ?? agent.id;
    const source = roots.find(a => a.id === draggingId);
    if (!source || !desktop || !draggingId || agent.role !== "orc" || id === draggingId || groupKey(agent) !== groupKey(source)) { dropAt = null; return; }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = { id, after: event.clientY >= rect.top + rect.height / 2 };
  }
  function drop(event: DragEvent) {
    if (!draggingId || !dropAt || !desktop) return;
    event.preventDefault(); event.stopPropagation();
    const source = roots.find(a => a.id === draggingId);
    const target = roots.find(a => a.id === dropAt!.id);
    if (!source || !target || groupKey(source) !== groupKey(target)) { endDrag(); return; }
    const ids = roots.filter(a => groupKey(a) === groupKey(source)).map(a => a.id);
    if (!ids.includes(draggingId)) { endDrag(); return; }
    const next = ids.filter(id => id !== draggingId);
    const index = next.indexOf(dropAt.id);
    if (index >= 0) {
      next.splice(index + Number(dropAt.after), 0, draggingId);
      if (next.some((id, i) => id !== ids[i])) {
        let position = 0;
        // Replace this group's slots only; preserve every other group's order.
        onreorder(roots.map(a => ids.includes(a.id) ? next[position++] : a.id));
      }
    }
    endDrag();
  }
  function endDrag() { if (draggingId) suppressClickUntil = Date.now() + 500; draggingId = null; dropAt = null; }
  let focusedId = $state<string | null>(null);
  let revealedId = $state<string | null>(null);
  let gesture: { id: string; x: number; y: number; horizontal: boolean } | null = null;
  let suppressClickUntil = 0;
  function touchStart(event: TouchEvent, agent: Agent, entryKey: string) {
    suppressClickUntil = 0;
    const touch = event.touches[0];
    if (agent.role !== "orc" || event.touches.length !== 1 || !matchMedia("(max-width: 700px)").matches || touch.clientX < 24) return;
    if (revealedId !== entryKey) revealedId = null;
    gesture = { id: entryKey, x: touch.clientX, y: touch.clientY, horizontal: false };
  }
  function touchMove(event: TouchEvent) {
    if (!gesture) return;
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.horizontal && Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { gesture = null; return; }
    if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      gesture.horizontal = true; suppressClickUntil = Date.now() + 500;
      if (event.cancelable) event.preventDefault();
      if (dx < -40) revealedId = gesture.id;
      else if (dx > 40) revealedId = null;
    }
  }
  export function visibleIds() { return navigationEntries.map(entry => entry.id); }
  export function openVisible(id: string) { const entry = navigationEntries.find(entry => entry.id === id); if (entry) { onopen(id); void reveal(id, entry.recent); } }
  export function switchVisible(event: KeyboardEvent) {
    const index = navigationEntries.findIndex(entry => entry.id === selectedId);
    const number = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    const position = number ? Number(number[1]) - 1 : index < 0 ? (event.code === "KeyJ" ? 0 : navigationEntries.length - 1) : (index + (event.code === "KeyJ" ? 1 : -1) + navigationEntries.length) % navigationEntries.length;
    const entry = navigationEntries[position];
    if (entry) { event.preventDefault(); openVisible(entry.id); }
  }
  export function closeTarget() { const entry = document.activeElement?.closest<HTMLElement>("[data-agent-id][data-location]"); return agents.find(a => a.id === (entry?.dataset.agentId ?? focusedId) && a.role === "orc")?.id ?? null; }
  let list = $state<HTMLElement>(null!);
  const roots = $derived.by(() => {
    const backend = agents.filter(a => a.role === "orc");
    const saved = rootOrder.flatMap(id => backend.find(a => a.id === id) ?? []);
    return [...saved, ...backend.filter(a => !rootOrder.includes(a.id))];
  });
  const recentRoots = $derived.by(() => roots.filter(root => {
    const active = (a: Agent) => a.state === "working" || a.state === "stopping" || (a.followUpCount ?? 0) > 0;
    return active(root) || agents.some(a => a.ownerId === root.id && active(a)) ||
      (typeof root.lastActivityAt === "number" && root.lastActivityAt >= now - windows[activityWindow]);
  }).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)));
  function treeEntries(root: Agent) { return [root, ...(root.role === "orc" && expanded.includes(root.id) ? agents.filter(a => a.ownerId === root.id) : [])]; }
  const recentVisible = $derived(recentRoots.flatMap(treeEntries));
  const orgKeys = $derived.by(() => [...new Set(roots.map(groupKey).filter(key => key !== "@loading"))].sort((a, b) => !a ? 1 : !b ? -1 : a.localeCompare(b)));
  const selectedOrg = $derived.by(() => {
    const saved = selectedOrgs[instanceId];
    return saved !== undefined && orgKeys.includes(saved) ? saved : orgKeys[0] ?? null;
  });
  const openedFolded = $derived(selectedOrg !== null && (foldedOrgs[instanceId] ?? []).includes(selectedOrg));
  function toggleOpened() {
    if (selectedOrg === null) return;
    const folded = foldedOrgs[instanceId] ?? [];
    foldedOrgs = { ...foldedOrgs, [instanceId]: openedFolded ? folded.filter(key => key !== selectedOrg) : [...folded, selectedOrg] };
    writePreference("opened-folded", foldedOrgs);
    endDrag();
  }
  const orgItems = $derived(orgKeys.map(key => ({ value: `org:${key}`, label: key || "Ungrouped" })));
  const openedRoots = $derived(roots.filter(root => groupKey(root) === selectedOrg && !recentRoots.some(recent => recent.id === root.id)));
  const visible = $derived(openedFolded ? [] : openedRoots.flatMap(treeEntries));
  $effect(() => { writePreference("expanded", expanded); });
  const selection = $derived.by(() => {
    const selected = agents.find(a => a.id === selectedId);
    const root = agents.find(a => a.id === (selected?.ownerId ?? selected?.id));
    return selected ? JSON.stringify([selected.id, selected.ownerId, root ? groupKey(root) : ""]) : null;
  });
  $effect(() => {
    if (selection === revealedSelection) return;
    revealedSelection = selection;
    if (!selection) return;
    const [id, ownerId] = JSON.parse(selection) as [string, string | null, string];
    untrack(() => {
      if (ownerId && !expanded.includes(ownerId)) expanded = [...expanded, ownerId];
      void reveal(id);
    });
  });
  $effect(() => { if (focusedId && !visible.some(a => a.id === focusedId) && !recentVisible.some(a => a.id === focusedId)) focusedId = null; });
  function toggle(id: string) { if (expanded.includes(id) && agents.find(a => a.id === selectedId)?.ownerId === id) onopen(id); expanded = expanded.includes(id) ? expanded.filter(v => v !== id) : [...expanded, id]; }
  export async function reveal(id: string, recent?: boolean) { await tick(); const isRecent = recent ?? recentVisible.some(a => a.id === id); list?.querySelector<HTMLButtonElement>(`[data-location="${isRecent ? "recent" : "tree"}"][data-agent-id="${id}"]`)?.scrollIntoView({ block: "nearest" }); }
  export function expandFocused() { const entry = document.activeElement?.closest<HTMLElement>('[data-location][data-agent-id]'); const agent = agents.find(a => a.id === (entry?.dataset.agentId ?? selectedId ?? focusedId)); if (agent?.role === "orc") toggle(agent.id); }
  export async function keydown(event: KeyboardEvent) {
    event.preventDefault();
    const entry = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-location][data-agent-id]") : null;
    const recentId = entry?.dataset.location === "recent" ? entry.dataset.agentId : !entry && recentVisible.some(a => a.id === selectedId) ? selectedId : null;
    if (recentId) {
      const index = recentVisible.findIndex(a => a.id === recentId);
      let target = recentVisible[(index + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0) + recentVisible.length) % recentVisible.length];
      if (!target) return;
      if (event.key === "ArrowRight" && target.role === "orc") { if (!expanded.includes(target.id)) toggle(target.id); else target = agents.find(a => a.ownerId === target.id) ?? target; }
      else if (event.key === "ArrowLeft") { if (target.ownerId) target = agents.find(a => a.id === target.ownerId) ?? target; else if (expanded.includes(target.id)) toggle(target.id); }
      if (event.key === "Enter" || (selectedId && target.id !== recentId)) onopen(target.id);
      await tick();
      list.querySelector<HTMLButtonElement>(`[data-location="recent"][data-agent-id="${target.id}"]`)?.focus({preventScroll: true});
      return;
    }
    if (entry?.dataset.agentId) focusedId = entry.dataset.agentId;
    else if (selectedId) focusedId = selectedId;
    if (event.key === "Enter") { if (focusedId) { onopen(focusedId); await reveal(focusedId); list.querySelector<HTMLButtonElement>(`[data-location="tree"][data-agent-id="${focusedId}"]`)?.focus({preventScroll: true}); } return; }
    const current = visible.find(a => a.id === focusedId);
    if (!current) focusedId = visible[0]?.id ?? null;
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { const i = visible.indexOf(current); focusedId = visible[(i + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length]?.id ?? null; }
    else if (event.key === "ArrowRight" && current.role === "orc") { if (!expanded.includes(current.id)) toggle(current.id); else focusedId = agents.find(a => a.ownerId === current.id)?.id ?? current.id; }
    else if (event.key === "ArrowLeft") { if (current.ownerId) focusedId = current.ownerId; else if (expanded.includes(current.id)) toggle(current.id); }
    if (selectedId && focusedId && focusedId !== selectedId) onopen(focusedId);
    if (focusedId) { await reveal(focusedId); list.querySelector<HTMLButtonElement>(`[data-location="tree"][data-agent-id="${focusedId}"]`)?.focus({ preventScroll: true }); }
  }
  const navigationEntries = $derived.by(() => {
    const seen = new Set<string>();
    return [...recentVisible.map(a => ({ id: a.id, recent: true })), ...visible.map(a => ({ id: a.id, recent: false }))].filter(entry => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id); return true;
    });
  });
  onMount(() => {
    const media = matchMedia("(min-width: 701px)");
    const resize = () => { desktop = media.matches; if (!desktop) endDrag(); };
    media.addEventListener("change", resize);
    void tick().then(() => { const saved = readPreference<unknown>("list-scroll", 0); list.scrollTop = typeof saved === "number" && Number.isFinite(saved) ? saved : 0; });
    return () => media.removeEventListener("change", resize);
  });
</script>
{#snippet sessionRow(agent: Agent, shortcut: boolean)}
    {@const children = agents.filter(w => w.ownerId === agent.id)}{@const host = hosts.find(h => h.id === agent.hostId)}{@const working = children.filter(w => w.state === "working").length}
    {@const queued = (agent.followUpCount ?? 0) > 0}
    {@const root = agent.role === "orc" ? agent : agents.find(a => a.id === agent.ownerId && a.role === "orc")}
    {@const recentParticipants = (agent.participants ?? []).filter(p => p.lastSpokeAt >= now - windows[activityWindow]).sort((a,b) => nicknameOrder.compare(a.user.name,b.user.name) || (a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0))}
    {@const status = agent.closeRequest ? m.closing_worker() : agent.stop?.status === "unknown" ? m.stop_unconfirmed() : agent.state === "stopping" ? m.stopping() : agent.state === "working" ? m.working() : agent.state === "error" ? m.failed() : queued ? agent.followUpPaused ? "Queue paused" : "Queued" : m.idle()}
    {@const entryKey = shortcut ? `recent:${agent.id}` : agent.id}
    <ContextMenu.Root><ContextMenu.Trigger disabled={!desktop}>
    <div role="group" class="session-row" data-swipe-id={entryKey} class:drop-before={!shortcut && dropAt?.id === agent.id && !dropAt.after} class:drop-after={!shortcut && dropAt?.id === agent.id && dropAt.after} ondragover={e => { if (!shortcut) dragOver(e, agent); else dropAt = null; }} ondragleave={e => { if (!(e.relatedTarget instanceof Node) || !(e.currentTarget as HTMLElement).contains(e.relatedTarget)) dropAt = null; }} ondrop={e => { if (!shortcut) drop(e); }} class:revealed={revealedId === entryKey} ontouchstart={e => touchStart(e, agent, entryKey)} ontouchmove={touchMove} ontouchend={() => gesture = null} ontouchcancel={() => { gesture = null; revealedId = null; }}>
    {#if agent.role === "orc" && revealedId === entryKey}<Button class="tree-close-action" variant="destructive" size="sm" disabled={!connected || host?.connected === false || closingId === agent.id} onclick={() => onclosetree(agent.id)}>{m.close_tree()}</Button>{/if}
    <div class="session-item" class:orc-item={agent.role === "orc"} class:worker-item={agent.role !== "orc"} class:active={selectedId === agent.id} class:navigation-focus={!shortcut && !selectedId && focusedId === agent.id}>
      <button class="session-open" draggable={!shortcut && desktop && agent.role === "orc" && groupKey(agent) !== "@loading"} ondragstart={e => dragStart(e, agent)} ondragend={endDrag} tabindex="-1" onfocus={() => { if (shortcut) focusedId = null; }} data-location={shortcut ? "recent" : "tree"} data-agent-id={agent.id} aria-current={selectedId === agent.id ? "true" : undefined} aria-label={m.open_agent({ title: agent.title, role: agent.role === "orc" ? m.orc() : agent.role === "reviewer" ? "Reviewer" : agent.role === "researcher" ? "Researcher" : m.worker() })} onclick={e => { if(Date.now() < suppressClickUntil) { e.preventDefault(); return; } if(revealedId) { revealedId = null; return; } onopen(agent.id); }}>
        <span class="session-title-row"><strong>{agent.title}</strong><span class="session-indicators">{#if agent.role === "orc" && agent.treeFast}<Zap size={12} role="img" aria-label={m.tree_fast()}><title>{m.tree_fast()} — {m.session_next_turn()}</title></Zap>{/if}{#if showAuthors && shortcut && agent.role === "orc" && recentParticipants.length}<span class="participants">{#each recentParticipants.slice(0, 4) as participant (participant.user.id)}<span class="participant-avatar" style:background={participant.user.color} title={participant.user.name} aria-label={participant.user.name}>{participant.user.name.slice(0, 1).toUpperCase()}</span>{/each}{#if recentParticipants.length > 4}<span class="participant-more">+{recentParticipants.length - 4}</span>{/if}</span>{/if}<span class="session-state-dot" class:working={agent.state === "working"} class:attention={agent.state === "error" || !!agent.closeRequest || agent.stop?.status === "unknown" || agent.state === "stopping" || queued && agent.state !== "working"} title={status} role="img" aria-label={status}></span>{#if agent.questions.some(q => q.state !== "answered")}<MessageCircle class="needs-input-icon" aria-label={m.needs_input()} role="img" />{/if}</span></span>
        <span class="session-meta">{#if agent.role === "orc"}{:else}<span>{agent.role === "reviewer" ? "Reviewer" : agent.role === "researcher" ? "Researcher" : m.worker()}</span>{/if}<span>{agent.backend === "pi" ? "Pi" : "Codex"} · {agent.project.alias}{#if environmentId(agent.project)!=="local"} · {agent.project.environment?.name}{/if}</span>{#if agent.directoryBranch}<span class="session-branch" title={agent.directoryBranch}><GitBranch aria-hidden="true" /><span>{agent.directoryBranch}</span></span>{/if}</span>
      </button>
      {#if agent.role === "orc" && children.length}<button class="session-members worker-disclosure" tabindex="-1" aria-label={children.some(w => w.role !== "worker") ? (expanded.includes(agent.id) ? "Collapse Workers, Reviewers and Researchers" : "Expand Workers, Reviewers and Researchers") : expanded.includes(agent.id) ? m.collapse_workers() : m.expand_workers()} title={(children.some(w => w.role !== "worker") ? `${children.filter(w => w.role === "worker").length} Workers · ${children.filter(w => w.role === "reviewer").length} Reviewers · ${children.filter(w => w.role === "researcher").length} Researchers` : m.current_workers({ count: children.length })) + " · " + m.working_count({ count: working })} aria-expanded={expanded.includes(agent.id)} onclick={() => { if(Date.now() >= suppressClickUntil) toggle(agent.id); }}><span>{#if expanded.includes(agent.id)}<ChevronDown />{:else}<ChevronRight />{/if}{children.length}</span>{#if working > 0}<span class="working worker-working-count">{working}<i></i></span>{/if}</button>{/if}
    </div>
    {#if closeError?.id === agent.id}<p class="tree-close-error" role="alert">{closeError.reason}</p>{/if}
    </div>
    </ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content class="session-context-menu"><ContextMenu.Item class="session-context-item" disabled={!root || !connected || host?.connected === false || !!closingId} onSelect={() => { if (root) void onclosetree(root.id); }}>{m.close_tree()}</ContextMenu.Item></ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>
{/snippet}
{#snippet sessionTree(root: Agent, shortcut: boolean)}
  {#each treeEntries(root) as agent (agent.id)}
    {@render sessionRow(agent, shortcut)}
  {/each}
{/snippet}
<svelte:window onpointerdown={e => { if (revealedId && e.target instanceof Element && !e.target.closest(`[data-swipe-id="${revealedId}"]`)) revealedId = null; }} />
<Sidebar.Header class="session-list-heading">
    <h1 class="org-heading">
      <Select.Root type="single" bind:open={orgMenuOpen} value={selectedOrg === null ? undefined : `org:${selectedOrg}`} items={orgItems} onValueChange={value => { if (value?.startsWith("org:")) selectOrg(value.slice(4)); }}>
        <Select.Trigger class="org-selector" aria-label="Select organization" title={selectedOrg === null ? m.product() : selectedOrg || "Ungrouped"} onkeydown={e => e.stopPropagation()}>
          <Select.Value placeholder={m.product()} />
        </Select.Trigger>
        <Select.Content class="min-w-(--bits-select-anchor-width) max-w-[calc(100vw-2rem)] p-1" onEscapeKeydown={event => event.stopPropagation()}>
          {#each orgItems as item (item.value)}<Select.Item value={item.value} label={item.label} />{/each}
        </Select.Content>
      </Select.Root>
    </h1>
    <Button variant="ghost" size="icon-sm" aria-label={m.new_session()} onclick={onnew}><Plus /></Button>
  </Sidebar.Header>
<Sidebar.Content class="session-list" aria-label={m.sessions()} bind:ref={list} onscroll={() => writePreference("list-scroll", list.scrollTop)}>
  {@render children?.()}
  {#if loading && !agents.length}<p class="list-empty" role="status">{m.loading()}</p>{:else if !roots.length}<div class="list-empty"><h2>{m.empty_heading()}</h2><p>{m.empty_help()}</p><Button size="sm" disabled={!connected} onclick={onnew}><Plus />{m.new_session()}</Button></div>{/if}
  <section class="recent-sessions" aria-label={m.recent_activity()}>
    <div class="recent-heading"><h2>{m.recent_activity()}</h2><ChoiceSelect size="sm" label={m.activity_window()} value={activityWindow} items={[{value:"1h",label:"1h"},{value:"4h",label:"4h"},{value:"1d",label:"1d"},{value:"1w",label:"1w"}]} onchange={value => onactivitywindow(value as Window)} /></div>
    {#each recentRoots as agent (agent.id)}{@render sessionTree(agent, true)}{/each}
  </section>
  <section class="opened-sessions" aria-label="Opened">
    <div class="recent-heading"><h2><button class="opened-toggle" aria-expanded={!openedFolded} onclick={toggleOpened} onkeydown={e => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>{#if openedFolded}<ChevronRight size={14} />{:else}<ChevronDown size={14} />{/if}Opened</button></h2></div>
    {#if !openedFolded}
      {#each openedRoots as agent (agent.id)}{@render sessionTree(agent, false)}{:else}
        {#if !loading && !projectsLoading}<p class="opened-empty">No other open sessions</p>{/if}
      {/each}
    {/if}
  </section>
</Sidebar.Content>

<div class="account-footer"><span class="account-avatar" style:background={user.color}>{user.name.slice(0,1).toUpperCase()}</span><span class="account-name" title={user.name}>{user.name}</span><div class="account-footer-actions"><span class="instance-version" title={version ? m.grove_version({version}) : m.grove_version_unknown()} aria-label={version ? m.grove_version({version}) : m.grove_version_unknown()}>{version ?? "—"}</span><Button variant="ghost" size="icon-sm" aria-label={m.settings()} title={m.settings()} onclick={onsettings}><Settings /></Button><Button variant="ghost" size="icon-sm" aria-label={m.sign_out()} title={m.sign_out()} onclick={onlogout}><LogOut /></Button></div></div>
