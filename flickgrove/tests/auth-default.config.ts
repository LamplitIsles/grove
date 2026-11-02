import { defineConfig } from "@playwright/test";
import mainConfig from "../playwright.config";

export default defineConfig({
  testDir: ".",
  testMatch: "auth-default.spec.ts",
  workers: 1,
  use: mainConfig.use,
  outputDir: "../../.scratch/local-passkey-origin/test-results",
  reporter: "list",
});
