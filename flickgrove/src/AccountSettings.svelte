<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import type { Human } from "./contracts";
  import * as m from "./paraglide/messages";
  let { user, colors, onpasskey, onsaved } = $props<{user: Human; colors: string[]; onpasskey: () => void; onsaved: (user: Human) => void}>();
  let name = $state(untrack(() => user.name)), color = $state(untrack(() => user.color)), saving = $state(false), error = $state("");
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    saving = true; error = "";
    try {
      const response = await fetch("/api/auth/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({name, color}) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || m.profile_save_failed());
      name = result.user.name; color = result.user.color; onsaved(result.user); toast.success(m.profile_saved());
    } catch (cause) { error = cause instanceof Error ? cause.message : m.profile_save_failed(); }
    finally { saving = false; }
  }
</script>

<section class="settings-section">
  <h2>{m.account()}</h2>
  <form class="profile-form" onsubmit={save}>
    <label for="profile-name">{m.nickname()}</label>
    <input id="profile-name" maxlength="80" bind:value={name} required />
    <fieldset><legend>{m.color()}</legend><div class="color-options">
      {#each colors as option (option)}<label class="color-choice" title={option}><input type="radio" name="profile-color" value={option} bind:group={color} aria-label={option} /><span style:background={option}></span></label>{/each}
    </div></fieldset>
    {#if error}<p class="profile-error" role="alert">{error}</p>{/if}
    <Button type="submit" size="sm" disabled={saving || !name.trim() || !colors.includes(color)}>{saving ? m.saving() : m.save_profile()}</Button>
  </form>
  <div class="account-security"><h3>{m.passkeys()}</h3><Button variant="outline" size="sm" onclick={onpasskey}>{m.add_passkey()}</Button></div>
</section>
