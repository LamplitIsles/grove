<script lang="ts">
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as m from "./paraglide/messages";

  let { peerId, connected } = $props<{peerId: string; connected: boolean}>();
  let configured = $state<boolean | null>(null), apiKey = $state("");
  let loading = $state(false), error = $state(""), uncertain = $state(false);
  let confirmRemove = $state(false), alive = true;

  async function load() {
    if (!peerId || !connected || loading) return;
    loading = true; error = "";
    try {
      const response = await fetch("/api/web/settings", {headers:{"X-Grove-Peer":peerId},cache:"no-store"});
      if (!response.ok || response.headers.get("X-Grove-Peer") !== peerId) throw new Error();
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("context7Configured" in result) || typeof result.context7Configured !== "boolean") throw new Error();
      if (alive) { configured = result.context7Configured; uncertain = false; }
    } catch { if (alive) error = m.web_key_load_failed(); }
    finally { if (alive) loading = false; }
  }

  async function change(method: "PUT" | "DELETE") {
    if (loading || uncertain || configured === null || !connected || (method === "PUT" && !apiKey.trim())) return;
    loading = true; error = ""; confirmRemove = false;
    try {
      const response = await fetch("/api/web/settings", {
        method, cache:"no-store",
        headers: {"X-Grove-Peer":peerId, ...(method === "PUT" ? {"content-type":"application/json"} : {})},
        ...(method === "PUT" ? {body:JSON.stringify({context7ApiKey:apiKey})} : {}),
      });
      const result = await response.json();
      if (response.headers.get("X-Grove-Peer") !== peerId) throw new Error();
      if (!response.ok) {
        if (result.code === "invalid_key") { if (alive) error = m.web_key_invalid(); return; }
        throw new Error();
      }
      if (result.context7Configured !== (method === "PUT")) throw new Error();
      if (alive) {
        configured = result.context7Configured; apiKey = "";
        toast.success(method === "PUT" ? m.web_key_saved() : m.web_key_removed());
      }
    } catch {
      if (alive) { uncertain = true; error = m.web_key_change_unknown(); }
    } finally { if (alive) loading = false; }
  }

  onMount(() => { void load(); return () => { alive = false; }; });
</script>

<section class="settings-section" aria-labelledby="web-settings-heading">
  <h2 id="web-settings-heading">{m.web_settings()}</h2>
  <div class="profile-form">
    <p class="voice-key-hint">{m.web_key_shared()}</p>
    {#if configured !== null && !uncertain}
      <p role="status">{configured ? m.web_key_configured() : m.web_key_anonymous()}</p>
      <form class="grid gap-2" onsubmit={event => { event.preventDefault(); void change("PUT"); }}>
        <label for="context7-api-key" class="font-semibold">{m.web_key_label()}</label>
        <Input id="context7-api-key" type="password" autocomplete="off" spellcheck="false" bind:value={apiKey} disabled={loading || !connected} aria-describedby="web-key-hint" />
        {#if configured}<p id="web-key-hint" class="voice-key-hint">{m.web_key_replace_hint()}</p>{:else}<span id="web-key-hint" class="sr-only">{m.web_key_shared()}</span>{/if}
        <div class="flex flex-wrap gap-2 mt-1">
          <Button type="submit" size="sm" disabled={loading || !connected || !apiKey.trim()}>{loading ? m.saving() : m.web_key_save()}</Button>
          {#if configured && !confirmRemove}<Button type="button" variant="ghost" size="sm" disabled={loading || !connected} onclick={() => confirmRemove = true}>{m.web_key_remove()}</Button>{/if}
        </div>
      </form>
      {#if confirmRemove}
        <div class="rounded-md border border-border p-3">
          <p>{m.web_key_remove_confirm()}</p>
          <div class="mt-2 flex flex-wrap gap-2"><Button variant="destructive" size="sm" disabled={loading || !connected} onclick={() => change("DELETE")}>{m.web_key_remove()}</Button><Button variant="ghost" size="sm" disabled={loading} onclick={() => confirmRemove = false}>{m.cancel()}</Button></div>
        </div>
      {/if}
    {:else if loading && configured === null}<p role="status">{m.loading()}</p>{/if}
    {#if error}<p class="profile-error" role="alert">{error}</p>{/if}
    {#if !loading && (configured === null || uncertain)}<Button variant="outline" size="sm" disabled={!connected} onclick={load}>{m.web_key_refresh()}</Button>{/if}
  </div>
</section>
