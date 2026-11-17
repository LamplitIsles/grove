import { defineConfig } from "@playwright/test";

if (!process.env.ORGANIZATION_SETTINGS_ASSETS)
  throw new Error(
    "Set ORGANIZATION_SETTINGS_ASSETS to the test-owned build output",
  );

export default defineConfig({
  testDir: ".",
  testMatch: "organization-settings.browser.ts",
  workers: 1,
  use: { channel: "chrome", baseURL: "http://localhost:14320" },
  webServer: {
    cwd: "..",
    command:
      'PREVIEW_AUTH=1 PREVIEW_ORGANIZATIONS=1 PREVIEW_ASSETS="$ORGANIZATION_SETTINGS_ASSETS" bun tests/preview-serve.ts',
    url: "http://127.0.0.1:14320",
    reuseExistingServer: false,
  },
});
