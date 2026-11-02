import { createAuthClient } from "better-auth/svelte";
import { passkeyClient } from "@better-auth/passkey/client";

const auth = createAuthClient({ plugins: [passkeyClient()] });

// Same client calls as AuthGate and App, hosted in a test-owned document.
Object.assign(window, {
  groveTest: {
    async register(code: string) {
      const response = await fetch("/api/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, nickname: "Test User" }),
      });
      if (!response.ok) throw new Error(`Pairing failed: ${response.status}`);
      const result = await auth.passkey.addPasskey({ createSession: true });
      if (result.error) throw new Error(result.error.message);
    },
    async signOut() {
      const result = await auth.signOut();
      if (result.error) throw new Error(result.error.message);
    },
    async signIn() {
      const result = await auth.signIn.passkey();
      if (result.error) throw new Error(result.error.message);
    },
  },
});
