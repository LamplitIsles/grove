import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "auth-preview.spec.ts",
  workers: 1,
  use: {
    launchOptions: { executablePath: "/usr/bin/chromium" },
    baseURL: "http://localhost:14320",
  },
  webServer: {
    cwd: "..",
    command: "PREVIEW_AUTH=1 PREVIEW_ASSETS=dist bun tests/preview-serve.ts",
    url: "http://127.0.0.1:14320",
    reuseExistingServer: false,
  },
});
