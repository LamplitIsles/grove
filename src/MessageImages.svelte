<script lang="ts">
  import { messageImagePreview, retryMessageImagePreview, hasMessageImagePreview } from "./message-image-cache";
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import type { MessageImage } from "./contracts";
  import { connection } from "./api";
  let { agentId, operationId, images = [], localImageIds = [], connected, available = true, onviewer }: { agentId: string; operationId: string; images?: MessageImage[]; localImageIds?: string[]; connected: boolean; available?: boolean; onviewer?: (open: boolean) => void } = $props();
  let urls = $state<Record<string,string>>({}); let failures = $state<Record<string,boolean>>({});
  let original = $state(""); let fullError = $state(""); let open = $state(false); let name = $state(""); let active=true;
  const allocated = new Set<string>();
  function blobUrl(blob: Blob) { const url=URL.createObjectURL(blob); allocated.add(url); return url; }
  const previewKey = (id: string) => `${agentId}\0${operationId}\0${id}`;
  function retry(id: string) { retryMessageImagePreview(previewKey(id)); failures[id] = false; }
  $effect(() => {
    if (!available) return;
    const online = connected;
    void Promise.all(images.map(async image => {
      if (urls[image.id] || failures[image.id]) return;
      if (image.availability === "missing") { failures[image.id] = true; return; }
      const key = previewKey(image.id);
      if (!online && !hasMessageImagePreview(key)) return;
      try {
        const preview = await messageImagePreview(key, async () =>
          (await connection().media(agentId, `/api/images/${image.id}/preview?agent=${encodeURIComponent(agentId)}`)).blob(),
        );
        if (active && !urls[image.id]) urls[image.id] = blobUrl(preview);
      } catch { if (active) failures[image.id] = true; }
    }));
  });
  $effect(() => {
    onviewer?.(open);
    if (!open && original) { URL.revokeObjectURL(original); allocated.delete(original); original = ""; }
  });
  async function enlarge(id: string,label:string) {
    name=label; open=true; original=""; fullError="";
    try {
      const blob=await (await connection().media(agentId,`/api/images/${id}/original?agent=${encodeURIComponent(agentId)}`)).blob();
      if(active && open) original=blobUrl(blob);
    } catch { if (active && open) fullError="Image missing or unreadable. Reconnect to its execution host and try again."; }
  }
  onMount(()=>()=>{active=false;for(const url of allocated)URL.revokeObjectURL(url);});
</script>
<div class="message-images">
  {#each images as image,index (image.id)}
    {#if urls[image.id]}<button class="message-image" aria-label={`Open image ${index+1}: ${image.name}`} onclick={()=>enlarge(image.id,image.name)}><img src={urls[image.id]} alt={image.name} /></button>
    {:else if !available}<span class="image-placeholder">{image.name}</span>
    {:else}<span class="image-placeholder" role="status">{failures[image.id] ? "Image missing or unreadable" : "Loading image…"}</span>{#if failures[image.id] && image.availability !== "missing"}<Button variant="ghost" size="sm" onclick={() => retry(image.id)}>Retry image</Button>{/if}{/if}
  {:else}
    {#if localImageIds.length}<span class="image-placeholder">Original images are unavailable</span>{/if}
  {/each}
</div>
<Dialog.Root bind:open><Dialog.Content class="image-viewer"><Dialog.Header><Dialog.Title>{name}</Dialog.Title><Dialog.Description>Full-size message image</Dialog.Description></Dialog.Header>
  {#if original}<img class="full-image" src={original} alt={name} />{:else}<p role="status">{fullError || "Loading image…"}</p>{/if}
  {#if fullError}<Button variant="secondary" onclick={()=>open=false}>Close</Button>{/if}
</Dialog.Content></Dialog.Root>
