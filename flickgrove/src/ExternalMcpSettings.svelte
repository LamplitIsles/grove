<script lang="ts">
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";

  let active = $state<boolean | null>(null), token = $state(""), error = $state("");
  let busy = $state(false), confirm = $state<"rotate" | "revoke" | null>(null);
  let alive = true;
  const endpoint = `${window.location.origin}/external-mcp`;

  async function refresh() {
    busy = true; error = "";
    try {
      const response = await fetch("/api/external-mcp/token", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load MCP token status.");
      const value = await response.json();
      if (typeof value.active !== "boolean") throw new Error("Could not load MCP token status.");
      if (alive) active = value.active;
    } catch {
      if (alive) { active = null; error = "Could not load MCP token status. Try again."; }
    } finally { if (alive) busy = false; }
  }

  async function change(method: "POST" | "DELETE") {
    if (busy) return;
    busy = true; error = ""; token = ""; confirm = null;
    try {
      const response = await fetch("/api/external-mcp/token", { method, cache: "no-store" });
      if (!response.ok) throw new Error("request failed");
      const value = await response.json();
      if (method === "POST") {
        if (typeof value.token !== "string" || !value.token) throw new Error("missing token");
        if (alive) { active = true; token = value.token; }
      } else {
        if (value.active !== false) throw new Error("invalid response");
        if (alive) active = false;
      }
    } catch {
      if (alive) {
        active = null;
        error = method === "POST"
          ? "Could not confirm the change. The previous token may have stopped working. Refresh status, then generate a new token."
          : "Could not confirm revocation. Refresh status before trying again.";
      }
    } finally { if (alive) busy = false; }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast.success("Copied to clipboard."); }
    catch { toast.error("Could not copy. Please try again."); }
  }

  onMount(() => { void refresh(); return () => { alive = false; }; });
</script>

<section class="account-security" aria-labelledby="external-mcp-heading">
  <h3 id="external-mcp-heading">External MCP</h3>
  <p class="text-xs text-muted-foreground">Connect an MCP client using this URL and your token.</p>
  <div class="mt-2 flex flex-wrap items-center gap-2">
    <code class="min-w-0 break-all text-xs">{endpoint}</code>
    <Button variant="ghost" size="sm" onclick={() => copy(endpoint)}>Copy URL</Button>
  </div>
  <p class="mt-3 text-sm" role="status">{active === null ? (busy ? "Loading token status…" : "Token status unavailable") : active ? "Token active" : "No token"}</p>
  {#if error}<p class="mt-2 text-sm text-destructive" role="alert">{error}</p>{/if}
  {#if token}
    <div class="mt-3 rounded-md border border-border p-3">
      <p class="text-sm">Copy this token now. It won't be shown again.</p>
      <code class="mt-2 block break-all text-xs">{token}</code>
      <div class="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onclick={() => copy(token)}>Copy token</Button>
        <Button variant="ghost" size="sm" onclick={() => token = ""}>Done</Button>
      </div>
    </div>
  {/if}
  {#if confirm}
    <div class="mt-3 rounded-md border border-border p-3">
      <p class="text-sm">{confirm === "rotate" ? "Generate a new token? The current token will stop working." : "Revoke this token? Connected clients will lose access."}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onclick={() => change(confirm === "rotate" ? "POST" : "DELETE")}>{confirm === "rotate" ? "Generate new token" : "Revoke token"}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onclick={() => confirm = null}>Cancel</Button>
      </div>
    </div>
  {:else if active === null}
    {#if !busy}<Button class="mt-2" variant="outline" size="sm" onclick={refresh}>Refresh status</Button>{/if}
  {:else}
    <div class="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={busy} onclick={() => active ? confirm = "rotate" : change("POST")}>{active ? "Rotate token" : "Generate token"}</Button>
      {#if active}<Button variant="ghost" size="sm" disabled={busy} onclick={() => confirm = "revoke"}>Revoke token</Button>{/if}
    </div>
  {/if}
</section>
