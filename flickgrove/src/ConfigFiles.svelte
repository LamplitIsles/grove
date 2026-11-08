<script lang="ts">
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { ConfigFileEntry, ConfigFilesStatus } from "./contracts";

  let { peerId, connected } = $props<{peerId:string; connected:boolean}>();
  let status = $state<ConfigFilesStatus | null>(null), loading = $state(false), error = $state("");
  let sequence = 0;
  const groups = [{source:"grove",name:"Grove"},{source:"pi",name:"Pi"},{source:"codex",name:"Codex"}] as const;

  async function load(id: string) {
    const request = ++sequence;
    loading = true; error = "";
    try {
      const response = await fetch("/config-files", {headers:{"X-Grove-Peer":id},cache:"no-store"});
      if (response.headers.get("X-Grove-Peer") !== id) throw new Error("Instance changed. Refresh configuration files.");
      if (!response.ok) throw new Error("Could not load configuration files.");
      const value = await response.json() as ConfigFilesStatus;
      if (!Array.isArray(value.files) || !Array.isArray(value.issues)) throw new Error("Could not load configuration files.");
      if (request === sequence) status = value;
    } catch (cause) {
      if (request === sequence) error = cause instanceof Error ? cause.message : "Could not load configuration files.";
    } finally {
      if (request === sequence) loading = false;
    }
  }

  async function copy(file: ConfigFileEntry) {
    try {
      await navigator.clipboard.writeText(`${file.name}: ${file.description}\n${file.path}`);
      toast.success("Copied to clipboard.");
    } catch {
      toast.error("Could not copy. Please try again.");
    }
  }

  $effect(() => {
    const id = peerId, active = connected;
    untrack(() => {
      sequence++; status = null; error = ""; loading = false;
      if (active && id) void load(id);
    });
    return () => { sequence++; };
  });
</script>

<section class="mt-4 border-t border-border pt-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-sm font-medium">Configuration files</h3>
    <Button variant="outline" size="sm" disabled={!connected || !peerId || loading} onclick={() => load(peerId)}>Refresh</Button>
  </div>
  <p class="mt-2 text-xs text-muted-foreground">Paths may not exist yet. Copying never includes credential contents.</p>
  {#if loading && !status}<p class="mt-2 text-sm text-muted-foreground" role="status">Loading configuration files…</p>{/if}
  {#if error}<p class="mt-2 text-sm text-destructive" role="alert">{error}</p>{/if}
  {#if status}
    {#each status.issues as issue}<p class="mt-2 text-sm text-destructive" role="alert">{issue}</p>{/each}
    {#each groups as group}
      {@const files = status.files.filter(file => file.source === group.source)}
      {#if files.length}
        <h4 class="mt-4 text-xs font-medium text-muted-foreground">{group.name}</h4>
        <ul>
          {#each files as file}
            <li class="flex flex-col items-start justify-between gap-2 border-b border-border py-2 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium">{file.name}</div>
                <div class="text-xs text-muted-foreground">{file.description}</div>
                <div class="break-all text-xs text-muted-foreground">{file.path}</div>
              </div>
              <Button variant="ghost" size="sm" aria-label={`Copy ${file.name} to agent`} onclick={() => copy(file)}>Copy to agent</Button>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
    {#if !status.files.length && !status.issues.length}<p class="mt-2 text-sm text-muted-foreground">No configuration paths found.</p>{/if}
  {/if}
</section>
