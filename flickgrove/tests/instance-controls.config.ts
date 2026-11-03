import { defineConfig } from "@playwright/test";

if (!process.env.INSTANCE_TEST_ASSETS)
  throw new Error("Set INSTANCE_TEST_ASSETS to the test-owned build output");

export default defineConfig({
  testDir: ".",
  testMatch: ["instance-controls.browser.ts", "maintenance-state.browser.ts"],
  workers: 1,
  use: {
    channel: "chrome",
    ...(process.env.INSTANCE_TEST_BROWSER
      ? { launchOptions: { executablePath: process.env.INSTANCE_TEST_BROWSER } }
      : {}),
    baseURL: "http://localhost:14320",
  },
  webServer: {
    cwd: "..",
    command:
      'PREVIEW_AUTH=1 PREVIEW_INSTANCE=1 PREVIEW_ASSETS="$INSTANCE_TEST_ASSETS" bun tests/preview-serve.ts',
    url: "http://127.0.0.1:14320",
    reuseExistingServer: false,
  },
});
