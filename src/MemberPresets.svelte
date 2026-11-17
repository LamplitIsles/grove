<script lang="ts">
  import { untrack } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import ChoiceSelect from "./ChoiceSelect.svelte";
  import type { MemberPresetsStatus } from "./contracts";

  let { peerId, connected } = $props<{peerId: string; connected: boolean}>();
  let status = $state<MemberPresetsStatus | null>(null);
  let selected = $state("");
  let loading = $state(false), saving = $state(false), error = $state("");
  const items = $derived(status?.presets.map(preset => ({
    value: preset.id,
    label: preset.error ? `${preset.name} (unavailable)` : preset.name,
  })) ?? []);

  async function readResponse(response: Response): Promise<MemberPresetsStatus> {
    const value = await response.json();
    if (response.headers.get("X-Grove-Peer") !== peerId) throw new Error("Instance changed. Refresh presets.");
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Could not update presets.");
    if (!Array.isArray(value.presets) || typeof value.current !== "string") throw new Error("Could not read presets.");
    return value as MemberPresetsStatus;
  }
  async function load() {
    if (!connected || !peerId || loading || saving) return;
    loading = true; error = "";
    try {
      const value = await readResponse(await fetch("/member-presets", {headers:{"X-Grove-Peer":peerId},cache:"no-store"}));
      status = value; selected = value.current;
    } catch (cause) { error = cause instanceof Error ? cause.message : "Could not read presets."; }
    finally { loading = false; }
  }
  async function save() {
    if (!status || !connected || !selected || saving || loading) return;
    saving = true; error = "";
    try {
      const response = await fetch("/member-presets", {method:"PUT",headers:{"content-type":"application/json","X-Grove-Peer":peerId},body:JSON.stringify({preset:selected})});
      const value = await readResponse(response);
      status = value; selected = value.current;
    } catch (cause) {
      error = cause instanceof TypeError ? "Could not confirm the change. Refresh presets." : cause instanceof Error ? cause.message : "Could not confirm the change. Refresh presets.";
      // A lost response cannot establish which preset was saved.
      status = null;
    } finally { saving = false; }
  }
  $effect(() => { if (connected && peerId) untrack(() => { if (!status) void load(); }); });
</script>

<section class="member-presets mt-4 border-t border-border pt-4">
  <h3 class="mb-2 text-sm font-medium">Member preset</h3>
  <p class="mb-2 text-xs text-muted-foreground">Applies to newly created Workers, Reviewers and Researchers.</p>
  {#if status}
    <ChoiceSelect label="Member preset" value={selected} {items} disabled={!connected || loading || saving || !items.length} onchange={value => selected = value} />
    {#if status.currentError}<p class="profile-error" role="alert">{status.currentError}</p>{/if}
  {:else if loading}<p role="status">Loading presets…</p>{/if}
  {#if error}<p class="profile-error" role="alert">{error}</p>{/if}
  <div class="mt-2 flex flex-wrap gap-2">
    <Button variant="outline" size="sm" disabled={!connected || loading || saving} onclick={load}>Refresh presets</Button>
    <Button size="sm" disabled={!connected || loading || saving || !status || !selected || selected === status.current} onclick={save}>{saving ? "Applying…" : "Apply preset"}</Button>
  </div>
</section>
