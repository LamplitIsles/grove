import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "question-draft.browser.ts",
    "questions-completion.spec.ts",
    "composer-voice.spec.ts",
    "images-questions.spec.ts",
  ],
  outputDir: process.env.GROVE_TEST_OUTPUT,
  workers: 1,
  use: { channel: "chrome", baseURL: "http://127.0.0.1:14319" },
  webServer: {
    command: "bun tests/design-serve.ts",
    cwd: "..",
    url: "http://127.0.0.1:14319",
    reuseExistingServer: false,
  },
});
