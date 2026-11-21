<script lang="ts">
  import { Download, FileIcon } from "@lucide/svelte";
  import { fileSize } from "./attachments";
  import type { MessageFile } from "./contracts";

  let { agentId, files, downloadable = true }: {
    agentId: string;
    files: MessageFile[];
    downloadable?: boolean;
  } = $props();
</script>

<div class="message-files">
  {#each files as file (file.id)}
    {#snippet label()}
      <FileIcon />
      <div class="attachment-label">
        <span title={file.name}>{file.name}</span>
        <small>{fileSize(file.bytes)}</small>
      </div>
    {/snippet}
    {#if downloadable}
      <a class="attachment-card" href={`/api/attachments/${encodeURIComponent(file.id)}/download?${new URLSearchParams({ agent: agentId })}`} download aria-label={`Download ${file.name}`}>
        {@render label()}
        <Download />
      </a>
    {:else}
      <div class="attachment-card">{@render label()}</div>
    {/if}
  {/each}
</div>
