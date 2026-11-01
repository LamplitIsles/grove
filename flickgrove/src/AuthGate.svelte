<script lang="ts">
  import { createAuthClient } from "better-auth/svelte";
  import { passkeyClient } from "@better-auth/passkey/client";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as m from "./paraglide/messages";
  let { onauthenticated } = $props<{ onauthenticated: () => void }>();
  const auth = createAuthClient({ plugins: [passkeyClient()] });
  let code = $state(""), nickname = $state(""), busy = $state(false), error = $state("");
  let pairing = $state(false);
  async function login() {
    busy = true; error = "";
    try { const result = await auth.signIn.passkey(); if (result.error) throw new Error(result.error.message ?? m.sign_in_failed()); onauthenticated(); }
    catch (e) { error = e instanceof Error ? e.message : m.sign_in_failed(); }
    finally { busy = false; }
  }
  async function register(event: SubmitEvent) {
    event.preventDefault(); busy = true; error = "";
    try {
      const response = await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, nickname }) });
      if (!response.ok) throw new Error(m.invalid_code());
      const result = await auth.passkey.addPasskey({ createSession: true });
      if (result.error) throw new Error(result.error.message ?? m.registration_failed());
      onauthenticated();
    } catch (e) { error = e instanceof Error ? e.message : m.registration_failed(); }
    finally { busy = false; }
  }
</script>

<main class="auth-screen"><section class="auth-panel">
  <div class="auth-mark">G</div><h1>{m.product()}</h1>
  {#if pairing}
    <p>{m.pairing_help()}</p>
    <form onsubmit={register} class="auth-form">
      <label>{m.pairing_code()}<input bind:value={code} autocomplete="off" required /></label>
      <label>{m.nickname()} <span class="auth-optional">{m.recovery_nickname_optional()}</span><input bind:value={nickname} maxlength="80" autocomplete="nickname" /></label>
      {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
      <Button type="submit" disabled={busy}>{busy ? m.please_wait() : m.create_passkey()}</Button>
      <Button variant="ghost" type="button" onclick={() => { pairing = false; error = ""; }}>{m.back_to_sign_in()}</Button>
    </form>
  {:else}
    <p>{m.sign_in_help()}</p>
    {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
    <div class="auth-form"><Button disabled={busy} onclick={login}>{m.sign_in_passkey()}</Button><Button variant="ghost" onclick={() => { pairing = true; error = ""; }}>{m.use_code()}</Button></div>
  {/if}
</section></main>
