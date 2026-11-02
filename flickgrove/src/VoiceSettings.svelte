<script lang="ts">
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";
  import ChoiceSelect from "./ChoiceSelect.svelte";
  import * as m from "./paraglide/messages";

  type Region = "beijing" | "singapore";
  type Status = { region: Region; configured: boolean };
  let { peerId, connected } = $props<{peerId: string; connected: boolean}>();
  let status = $state<Status | null>(null), region = $state<Region>("beijing");
  let apiKey = $state(""), loading = $state(true), saving = $state(false), error = $state("");
  const changingRegion = $derived(!!status && region !== status.region);
  const keyRequired = $derived(changingRegion || !status?.configured);
  const choices = $derived([{value:"beijing",label:m.voice_region_beijing()},{value:"singapore",label:m.voice_region_singapore()}]);

  async function load() {
    if (!peerId || !connected) { loading = false; error = m.voice_settings_load_failed(); return; }
    loading = true; error = "";
    try {
      const response = await fetch("/api/voice/settings", {headers:{"X-Grove-Peer":peerId},cache:"no-store"});
      if (!response.ok || response.headers.get("X-Grove-Peer") !== peerId) throw new Error();
      const result = await response.json() as Status;
      if ((result.region !== "beijing" && result.region !== "singapore") || typeof result.configured !== "boolean") throw new Error();
      status = result; region = result.region;
    } catch { error = m.voice_settings_load_failed(); }
    finally { loading = false; }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!status || saving || !connected || (keyRequired && !apiKey.trim())) return;
    saving = true; error = "";
    try {
      const response = await fetch("/api/voice/settings", {method:"POST",headers:{"content-type":"application/json","X-Grove-Peer":peerId},body:JSON.stringify({region,apiKey})});
      const result = await response.json();
      if (!response.ok || response.headers.get("X-Grove-Peer") !== peerId) {
        if (result.code === "settings_saved_status_failed") { apiKey = ""; window.dispatchEvent(new Event("grove-voice-settings-changed")); }
        error = result.code === "key_required" ? m.voice_key_required() : result.code === "invalid_key" ? m.voice_key_invalid() : result.code === "key_saved_region_failed" ? m.voice_key_saved_region_failed() : result.code === "settings_saved_status_failed" ? m.voice_settings_saved_status_failed() : m.voice_settings_save_failed();
        return;
      }
      if ((result.region !== "beijing" && result.region !== "singapore") || typeof result.configured !== "boolean") throw new Error();
      status = result; region = result.region; apiKey = "";
      window.dispatchEvent(new Event("grove-voice-settings-changed"));
      toast.success(m.voice_settings_saved());
    } catch { error = m.voice_settings_save_failed(); }
    finally { saving = false; }
  }
  onMount(() => { void load(); });
</script>

<section class="settings-section voice-settings">
  <h2>{m.voice_settings()}</h2>
  {#if loading}<p role="status">{m.loading()}</p>
  {:else if !status}
    <p class="profile-error" role="alert">{error}</p>
    <Button variant="outline" size="sm" disabled={!connected} onclick={load}>{m.retry()}</Button>
  {:else}
    <form class="profile-form voice-form" onsubmit={save}>
      <span class="voice-region-label">{m.voice_region()}</span>
      <ChoiceSelect label={m.voice_region()} value={region} items={choices} disabled={saving || !connected} onchange={value => region = value as Region} />
      <label for="voice-api-key">{m.voice_api_key()}</label>
      <input id="voice-api-key" type="password" autocomplete="off" spellcheck="false" bind:value={apiKey} disabled={saving || !connected} aria-describedby="voice-key-hint" />
      <p id="voice-key-hint" class="voice-key-hint">{changingRegion ? m.voice_key_new_region() : status.configured ? m.voice_key_keep() : m.voice_key_not_configured()}</p>
      {#if !changingRegion && status.configured}<span class="voice-key-status">{m.voice_key_configured()}</span>{/if}
      {#if error}<p class="profile-error" role="alert">{error}</p>{/if}
      <Button type="submit" size="sm" disabled={saving || !connected || (keyRequired && !apiKey.trim())}>{saving ? m.saving() : m.save_voice_settings()}</Button>
    </form>
  {/if}
</section>
