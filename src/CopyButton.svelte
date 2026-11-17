<script lang="ts">
  import { onDestroy } from "svelte";
  import { fade } from "svelte/transition";
  import { Check, Copy } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as m from "./paraglide/messages";

  let { text, label, class: className = "", size = "icon-sm" }: { text: string; label: string; class?: string; size?: "icon-sm" | "icon-xs" } = $props();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  onDestroy(() => { destroyed = true; clearTimeout(timer); });

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (destroyed) return;
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => copied = false, 2000);
    } catch {
      if (!destroyed) { clearTimeout(timer); copied = false; toast.error(m.copy_failed()); }
    }
  }
</script>

<Button variant="ghost" {size} class={`copy-button ${className}`} aria-label={label} title={copied ? m.copied() : label} onclick={copy}>
  <span class="copy-icon" aria-hidden="true">
    {#if copied}<span transition:fade={{ duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 100 }}><Check /></span>{:else}<span transition:fade={{ duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 100 }}><Copy /></span>{/if}
  </span>
</Button>

<style>
  .copy-icon { position: relative; display: inline-flex; width: 1rem; height: 1rem; }
  .copy-icon > span { position: absolute; inset: 0; }
  .copy-icon :global(svg) { width: 100%; height: 100%; }
</style>
