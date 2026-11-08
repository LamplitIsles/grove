<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { dismissPendingAnswer, forgetLegacyPending, outgoing, submissionResult } from "./outgoing.svelte";
  import type { Delivery } from "./contracts";
  import * as m from "./paraglide/messages";

  let { agentId, operationId, answer }: { agentId: string; operationId: string; answer?: Delivery } = $props();
  let expanded = $state(false), feedback = $state("");
  const item = $derived(outgoing.entries.find(o => o.agentId === agentId && o.id === operationId && o.status === "pending" && (answer || !o.admissionVersion)));
  const answerPending = $derived(answer?.source === "question" && submissionResult(answer) === "pending" && answer.questionIds.length > 0);
  const text = $derived(item?.text ?? answer?.text ?? "");

  async function copy() {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); feedback = m.pending_copied(); }
    catch { feedback = m.pending_copy_failed(); }
  }
  function remove() {
    try { if (answer) dismissPendingAnswer(agentId, answer); else forgetLegacyPending(agentId, operationId); expanded = false; feedback = ""; }
    catch (error) { feedback = error instanceof Error ? error.message : m.load_failure(); }
  }
</script>

{#if item || answerPending}
  {#if !expanded}<Button variant="ghost" size="sm" onclick={() => expanded = true}>{m.pending_remove()}</Button>
  {:else}<div class="legacy-pending-action">
    <p>{m.pending_remove_warning()}</p>
    {#if text}<textarea readonly aria-label={m.pending_original_text()} value={text} rows="3"></textarea>{/if}
    {#if feedback}<p role="status">{feedback}</p>{/if}
    <div class="legacy-pending-buttons">
      {#if text}<Button variant="ghost" size="sm" onclick={copy}>{m.pending_copy()}</Button>{/if}
      <Button variant="ghost" size="sm" onclick={() => { expanded = false; feedback = ""; }}>{m.cancel()}</Button>
      <Button variant="secondary" size="sm" onclick={remove}>{m.pending_remove_confirm()}</Button>
    </div>
  </div>{/if}
{/if}

<style>
  .legacy-pending-action { display: grid; gap: .5rem; max-width: 32rem; margin-top: .5rem; }
  .legacy-pending-action p { color: var(--muted-foreground); font-size: .8rem; }
  .legacy-pending-action textarea { width: 100%; min-height: 4rem; max-height: 10rem; padding: .5rem; border: 1px solid var(--border); border-radius: .375rem; background: transparent; font: inherit; resize: vertical; }
  .legacy-pending-buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .25rem; }
</style>
