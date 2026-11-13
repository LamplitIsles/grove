<script lang="ts">
  import { Collapsible } from "bits-ui";
  import { ChevronRight } from "@lucide/svelte";
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { slide } from "svelte/transition";
  import type { Message } from "./contracts";
  import * as m from "./paraglide/messages";

  let { messages, renderMessage, initiallyExpanded = false, onexpanded, folding = [], onfolding }: {
    messages: Message[]; renderMessage: Snippet<[Message, boolean?]>; initiallyExpanded?: boolean; onexpanded?: (value: boolean) => void; folding?: Message[]; onfolding?: () => void;
  } = $props();
  let expanded = $state(untrack(() => initiallyExpanded));
  const motionDuration = () => matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
  const foldingMessages = untrack(() => folding);
  let showingFolding = $state(untrack(() => foldingMessages.length > 0 && !expanded));
  onMount(() => {
    if (!showingFolding) return;
    onfolding?.();
    void tick().then(() => { showingFolding = false; });
  });
</script>

<Collapsible.Root bind:open={expanded} onOpenChange={value => onexpanded?.(value)} class="message-group">
  <Collapsible.Trigger class="message-group-trigger">
    <ChevronRight size={14} class="message-group-chevron" aria-hidden="true" />
    <span>{m.conversation_progress()}</span><span class="message-group-count">{messages.length}</span>
  </Collapsible.Trigger>
  {#if showingFolding}
    <div class="folding-preview" aria-hidden="true" inert out:slide={{ duration: 220, easing: cubicOut }}>
      {#each foldingMessages as message (message.id)}
        {@render renderMessage(message, true)}
      {/each}
    </div>
  {/if}
  <Collapsible.Content forceMount hiddenUntilFound={false}>
    {#snippet child({ props })}
      <div {...props} inert={!expanded} aria-hidden={!expanded}>
        {#if expanded}
          <div class="message-group-content" transition:slide={{ duration: motionDuration(), easing: cubicOut }}>
            {#each messages as message (message.id)}
              {@render renderMessage(message, true)}
            {/each}
          </div>
        {/if}
      </div>
    {/snippet}
  </Collapsible.Content>
</Collapsible.Root>

<style>
  :global(.message-group) { margin: 0 0 20px; }
  :global(.message-group-trigger) { display: flex; align-items: center; gap: 7px; color: var(--muted-foreground); font-size: 12px; font-weight: 550; cursor: pointer; min-height: 32px; padding: 8px 0; }
  :global(.message-group-trigger:hover) { color: var(--foreground); }
  :global(.message-group-trigger:focus-visible) { outline: 2px solid var(--ring); outline-offset: 3px; border-radius: 3px; }
  :global(.message-group-chevron) { transition: transform 160ms ease-out; }
  :global(.message-group-trigger[data-state="open"] .message-group-chevron) { transform: rotate(90deg); }
  .message-group-count { color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  :global(.message-group-content) { border-left: 1px solid var(--border); margin: 8px 0 0 6px; padding-left: 16px; }
  .folding-preview { max-height: 300px; overflow: hidden; pointer-events: none; }
  :global(.message-group-trigger[data-state="open"]) + .folding-preview { display: none; }
</style>
