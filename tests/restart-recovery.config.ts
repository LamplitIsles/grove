import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "restart-recovery.browser.ts",
  outputDir: process.env.GROVE_TEST_OUTPUT,
  workers: 1,
  use: {
    ...(process.env.GROVE_TEST_CHROMIUM
      ? { launchOptions: { executablePath: process.env.GROVE_TEST_CHROMIUM } }
      : { channel: "chrome" }),
    baseURL: "http://127.0.0.1:14319",
  },
  webServer: {
    command: "bun tests/design-serve.ts",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: "http://127.0.0.1:14319",
    reuseExistingServer: false,
  },
});
