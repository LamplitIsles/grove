import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "external-mcp-settings.spec.ts",
  workers: 1,
  use: {
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
    baseURL: "http://localhost:14320",
  },
  webServer: {
    cwd: "..",
    command: "PREVIEW_AUTH=1 PREVIEW_ASSETS=dist bun tests/preview-serve.ts",
    url: "http://127.0.0.1:14320",
    reuseExistingServer: false,
  },
});
