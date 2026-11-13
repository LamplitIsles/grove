<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Agent, Detail, Human, Message } from "./contracts";
  import type { ReadingDetail } from "./reading-cache";
  import { projectConversation } from "./conversation-projection";
  import { executionStatus } from "./execution-status";
  import { transcriptPositions } from "./transcript-state";
  import Markdown from "./Markdown.svelte";
  import MessageTime from "./MessageTime.svelte";
  import MessageImages from "./MessageImages.svelte";
  import MessageGroup from "./MessageGroup.svelte";
  import WorkerReport from "./WorkerReport.svelte";
  import * as m from "./paraglide/messages";

  let { agent, detail, loading, error, cached, connected, agents, showAuthors, users }: {
    agent: Agent; detail: Detail | ReadingDetail | null; loading: boolean; error: string; cached: boolean; connected: boolean; agents: Agent[]; showAuthors: boolean; users?: Human[];
  } = $props();
  const savedPosition = untrack(() => transcriptPositions.get(agent.id));
  const savedAnchor = savedPosition?.anchor;
  const rows = $derived.by(() => {
    const all = projectConversation(detail?.messages ?? [], detail?.deliveries ?? []);
    const index = savedAnchor ? all.findIndex(row => row.id === savedAnchor.id || (row.type === "group" && row.messages.some(message => message.id === savedAnchor.id))) : -1;
    return index < 0 ? all.slice(-25) : all.slice(Math.max(0, index - 12), index + 13);
  });
  const state = $derived(executionStatus(agent));
  let transcript: HTMLDivElement;
  // One initial position per displayed copy, never the selected transcript's anchor.
  let positioned = false, restoredAnchor = false;
  $effect(() => {
    const current = detail;
    if (!current) return;
    const row = savedAnchor && rows.find(row => row.id === savedAnchor.id || (row.type === "group" && row.messages.some(message => message.id === savedAnchor.id)));
    if (positioned && (!row || restoredAnchor)) return;
    positioned = true; restoredAnchor = !!row;
    untrack(() => void tick().then(() => {
      if (!transcript?.isConnected) return;
      const element = row && transcript.querySelector<HTMLElement>(`[data-preview-row="${CSS.escape(row.id)}"]`);
      if (!row || !element) transcript.scrollTop = transcript.scrollHeight;
      else transcript.scrollTop += element.getBoundingClientRect().top - transcript.getBoundingClientRect().top + (row.id === savedAnchor?.id ? savedAnchor.offset : 0);
    }));
  });
</script>

<aside class="agent-detail hover-preview" data-preview-id={agent.id} aria-hidden="true" inert>
  <header class="detail-heading">
    <div class="detail-meta">
      <div class="role-project">{agent.role === "orc" ? m.orc() : agent.role === "worker" ? m.worker() : agent.role === "reviewer" ? "Reviewer" : "Researcher"} / {agent.project.alias}</div>
      <div class="detail-status"><span class:working={state === "working"} class:failed={state === "error"}><i></i>{state === "working" ? m.working() : state === "stopping" ? m.stopping() : state === "error" ? m.failed() : m.idle()}</span></div>
      {#if (agent.unansweredCount ?? agent.questions.filter(q => q.state === "unanswered").length) > 0}<span class="preview-attention">{m.needs_input()}</span>{/if}
      <span class="preview-model">{agent.backend === "pi" ? "Pi" : "Codex"} · {agent.provider ? agent.provider + "/" : ""}{agent.model} · {agent.effort}</span>
      <span class="preview-label">{m.session_preview()}</span>
    </div>
    <h1>{agent.title}</h1>
  </header>
  <div class="conversation preview-conversation" bind:this={transcript}>
    {#if error}<p class="preview-status">{error}</p>{/if}
    {#if cached}<p class="preview-status">{m.hover_preview_saved()}</p>{:else if loading}<p class="preview-status">{m.loading_conversation()}</p>{/if}
    {#if agent.closeRequest}<p class="preview-status">{agent.closeRequest.reason}</p>{/if}
    {#if agent.error && state === "error"}<p class="preview-error">{agent.error}</p>{/if}
    {#if agent.researchQuestion}<p class="preview-status">Question: {agent.researchQuestion}</p>{/if}
    {#if detail}
      {#snippet renderMessage(message: Message, grouped = false)}
        {@const delivery = detail!.deliveries.find(d => d.id === (message.clientId ?? message.id)) ?? message.delivery}
        {@const report = delivery && ["worker", "reviewer", "researcher"].includes(delivery.source) ? delivery : undefined}
        {@const author = message.author ? users?.find(person => person.id === message.author?.id) ?? message.author : undefined}
        {#if report}
          <WorkerReport preview at={message.at} text={message.text} bodyRef={message.bodyRef} initiallyExpanded={!!savedPosition?.reports.has(message.clientId ?? message.id) || (grouped && !savedPosition?.closedReports?.has(message.clientId ?? message.id))} agentId={report.reportingResearcherId ?? report.reportingReviewerId ?? report.reportingWorkerId} owningAgentId={agent.id} sender={agents.find(a => a.id === (report.reportingResearcherId ?? report.reportingReviewerId ?? report.reportingWorkerId))?.title} kind={report.source === "reviewer" ? "Reviewer report" : report.source === "researcher" ? "Researcher report" : undefined} />
        {:else}
          <div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}>
            <div class="message-role">{#if showAuthors && author}<span class="message-author" style:--author-color={author.color}><span>{author.name.slice(0,1).toUpperCase()}</span>{author.name}</span>{:else}{message.role === "assistant" ? agent.role === "orc" ? m.orc() : agent.role === "worker" ? m.worker() : agent.role === "reviewer" ? "Reviewer" : "Researcher" : ""}{/if}</div>
            <div class="message-content">
              {#if message.bodyRef}<p class="preview-status">{m.hover_preview_long_message()}</p>{:else}<Markdown text={message.text} agentId={agent.id} />{/if}
              {#if message.images?.length || message.localImageIds?.length}<MessageImages agentId={agent.id} operationId={message.id} images={message.images} localImageIds={message.localImageIds} {connected} />{/if}
            </div>
            <div class="message-actions"><MessageTime at={message.at} /></div>
          </div>
        {/if}
      {/snippet}
      {#each rows as row (row.id)}
        <div data-preview-row={row.id}>
        {#if row.type === "message"}{@render renderMessage(row.message)}{:else}
          <MessageGroup messages={row.messages} {renderMessage} initiallyExpanded={savedPosition?.groups?.has(row.id)} />
        {/if}
        </div>
      {/each}
      {#if !rows.length && !loading}<p class="preview-status">{m.hover_preview_empty()}</p>{/if}
    {/if}
  </div>
</aside>

<style>
  .hover-preview { position: absolute; inset: 0; z-index: 40; pointer-events: none; }
  .preview-label { margin-left: auto; color: var(--muted-foreground); font-size: 12px; }
  .preview-model { color: var(--muted-foreground); font-size: 12px; }
  .preview-attention { color: #e6ba7b; font-size: 12px; }
  .preview-conversation { min-height: 0; }
  .preview-status { color: var(--muted-foreground); font-size: 12px; margin: 0 0 16px; }
  .preview-error { color: #e6ba7b; font-size: 12px; margin: 0 0 16px; }
</style>
