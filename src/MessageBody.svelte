<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { reading } from "./api";
  import * as m from "./paraglide/messages";
  import Markdown from "./Markdown.svelte";
  import CopyButton from "./CopyButton.svelte";
  import MessageTime from "./MessageTime.svelte";
  let { text, bodyRef, agentId, readPath, expand = false, fileAgentId = agentId, copyMessage = false, at, children }: { text: string; bodyRef?: string; agentId: string; readPath?: string; expand?: boolean; fileAgentId?: string; copyMessage?: boolean; at?: number; children?: Snippet } = $props();
  let body = $state<string>();
  let loading = $state(false), error = $state("");
  const abort = new AbortController();
  async function load() {
    if (!bodyRef || loading || body !== undefined) return;
    loading = true; error = "";
    try {
      const p = new URLSearchParams({ agent: agentId, item: bodyRef });
      const result = await reading<{text: string}>(readPath ?? `/body?${p}`, agentId, abort.signal);
      if (!abort.signal.aborted) body = result.text;
    } catch(e) { if (!abort.signal.aborted) error = (e as Error).message; }
    finally { if (!abort.signal.aborted) loading = false; }
  }
  $effect(() => { if (expand && bodyRef) void load(); });
  onMount(() => () => abort.abort());
</script>
<div class="message-content">
{#if !bodyRef || body !== undefined}<Markdown text={body ?? text} agentId={fileAgentId} />
{:else}<div class="message-body">{#if error}<p class="inline-error" role="alert">{error}</p>{/if}<Button variant="ghost" size="sm" disabled={loading} onclick={load}>{loading ? m.loading_message() : error ? m.retry() : m.read_full_message()}</Button></div>{/if}
{@render children?.()}
</div>
{#if at !== undefined || copyMessage}<div class="message-actions">{#if at !== undefined}<MessageTime {at} />{/if}{#if copyMessage && (!bodyRef || body !== undefined) && (body ?? text)}<CopyButton text={body ?? text} label={m.copy_message()} size="icon-xs" class="copy-message" />{/if}</div>{/if}
