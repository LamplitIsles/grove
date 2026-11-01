<script lang="ts">
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { preferences } from "./connection";
  import App from "./App.svelte";
  import AuthGate from "./AuthGate.svelte";
  import { onMount } from "svelte";
  import type { Human } from "./contracts";
  import * as m from "./paraglide/messages";
  let open = $state(preferences.sidebarOpen);
  let status = $state<"loading" | "signed_in" | "signed_out" | "error">("loading");
  let user = $state<Human | undefined>();
  let colors = $state<string[]>([]);
  async function refresh() {
    status = "loading";
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to connect");
      const result = await response.json();
      user = result.user;
      colors = Array.isArray(result.colors) ? result.colors : [];
      status = result.state === "signed_in" && user ? "signed_in" : "signed_out";
    } catch { status = "error"; }
  }
  async function checkSession() {
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json();
      if (result.state !== "signed_in" || result.user?.id !== user?.id) {
        user = undefined;
        status = "signed_out";
      }
    } catch { /* A temporary network outage is not proof of logout. */ }
  }
  onMount(() => { void refresh(); });
</script>

{#if status === "signed_in" && user}
<Sidebar.Provider bind:open onOpenChange={value => preferences.sidebarOpen = value} class="grove-shell">
  <App {user} {colors} onlogout={refresh} ondisconnect={checkSession} />
</Sidebar.Provider>
{:else if status === "signed_out"}<AuthGate onauthenticated={refresh} />
{:else if status === "error"}<main class="auth-screen"><button onclick={refresh}>{m.connect_retry()}</button></main>
{:else}<main class="auth-screen" aria-busy="true">{m.auth_loading()}</main>{/if}
