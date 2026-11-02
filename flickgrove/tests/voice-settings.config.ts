import { defineConfig } from "@playwright/test";

if (!process.env.VOICE_SETTINGS_ASSETS)
  throw new Error("Set VOICE_SETTINGS_ASSETS to the test-owned build output");

export default defineConfig({
  testDir: ".",
  testMatch: "voice-settings.browser.ts",
  workers: 1,
  use: {
    channel: "chrome",
    ...(process.env.VOICE_SETTINGS_BROWSER
      ? {
          launchOptions: { executablePath: process.env.VOICE_SETTINGS_BROWSER },
        }
      : {}),
    baseURL: "http://localhost:14320",
  },
  webServer: {
    cwd: "..",
    command:
      'PREVIEW_AUTH=1 PREVIEW_VOICE=1 PREVIEW_ASSETS="$VOICE_SETTINGS_ASSETS" bun tests/preview-serve.ts',
    url: "http://127.0.0.1:14320",
    reuseExistingServer: false,
  },
});
