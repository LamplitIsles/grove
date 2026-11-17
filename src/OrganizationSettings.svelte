<script lang="ts">
  import { untrack } from "svelte";
  import { z } from "zod";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import * as m from "./paraglide/messages";

  const entrySchema = z.object({ organization: z.string().min(1), enabled: z.boolean() });
  const responseSchema = z.object({
    organizations: z.array(entrySchema),
    unavailableEnvironments: z.array(z.object({ id: z.string(), name: z.string() })),
  });
  type Organization = z.infer<typeof entrySchema>;
  let { peerId, connected } = $props<{peerId: string; connected: boolean}>();
  let organizations = $state<Organization[] | null>(null);
  let unavailable = $state<string[]>([]), loading = $state(false), saving = $state<string | null>(null);
  let error = $state(""), uncertain = $state(false), alive = true;

  async function load() {
    if (!connected || !peerId || loading || saving) return;
    const peer = peerId;
    loading = true; error = "";
    try {
      const response = await fetch("/api/organization-review-settings", { headers: { "X-Grove-Peer": peer }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok || response.headers.get("X-Grove-Peer") !== peer) throw new Error();
      const result = responseSchema.parse(await response.json());
      if (!alive || peer !== peerId || !connected) throw new Error();
      organizations = result.organizations;
      unavailable = result.unavailableEnvironments.map(item => item.name);
      uncertain = false;
    } catch { if (alive) error = m.organization_review_load_failed(); }
    finally { if (alive) loading = false; }
  }

  async function change(organization: string, enabled: boolean) {
    if (!connected || !peerId || loading || saving || uncertain || !organizations) return;
    const peer = peerId;
    saving = organization; error = "";
    try {
      const response = await fetch("/api/organization-review-settings", {
        method: "PUT", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { "X-Grove-Peer": peer, "content-type": "application/json" },
        body: JSON.stringify({ organization, enabled }),
      });
      if (!response.ok || response.headers.get("X-Grove-Peer") !== peer) throw new Error();
      const result = entrySchema.parse(await response.json());
      if (result.organization !== organization || result.enabled !== enabled || !alive || peer !== peerId || !connected) throw new Error();
      organizations = organizations.map(item => item.organization === organization ? result : item);
    } catch {
      if (alive) { uncertain = true; error = m.organization_review_unconfirmed(); }
    } finally { if (alive) saving = null; }
  }

  $effect(() => {
    if (connected && peerId) untrack(() => void load());
  });
  $effect(() => () => { alive = false; });
</script>

<section class="settings-section" aria-labelledby="organization-settings-heading">
  <h2 id="organization-settings-heading">{m.organization_settings()}</h2>
  <div class="organization-review">
    <h3>{m.organization_review_title()}</h3>
    <p class="voice-key-hint">{m.organization_review_help()}</p>
    {#if loading && organizations === null}
      <p role="status">{m.loading()}</p>
    {:else if !connected && organizations === null}
      <p role="status">{m.offline_help()}</p>
    {:else if organizations?.length}
      <ul class="organization-review-list">
        {#each organizations as item (item.organization)}
          <li>
            <span class="organization-review-name">{item.organization}</span>
            {#if saving === item.organization}<span class="voice-key-hint" role="status">{m.saving()}</span>{/if}
            {#key `${item.organization}:${item.enabled}:${saving ?? ""}:${uncertain}`}
              <Switch checked={item.enabled} aria-label={m.organization_review_label({organization:item.organization})} disabled={!connected || loading || !!saving || uncertain} onCheckedChange={enabled => void change(item.organization, enabled)} />
            {/key}
          </li>
        {/each}
      </ul>
    {:else if organizations}
      <p class="voice-key-hint">{m.organization_review_empty()}</p>
    {/if}
    {#if unavailable.length}<p class="profile-error" role="alert">{m.organization_review_partial({environments:unavailable.join(", ")})}</p>{/if}
    {#if error}<p class="profile-error" role="alert">{error}</p>{/if}
    {#if (error || unavailable.length) && !loading}<Button variant="outline" size="sm" disabled={!connected || !!saving} onclick={load}>{m.web_key_refresh()}</Button>{/if}
  </div>
</section>
