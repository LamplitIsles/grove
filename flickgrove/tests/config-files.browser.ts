import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`${width}: configuration paths can be copied and partial errors stay visible`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            (window as Window & { copiedText?: string }).copiedText = text;
          },
        },
      });
    });
    let requests = 0;
    await page.route("**/config-files", async (route) => {
      requests++;
      const peer = route.request().headers()["x-grove-peer"];
      expect(peer).toBeTruthy();
      await route.fulfill({
        headers: { "X-Grove-Peer": peer },
        json: {
          files: [
            {
              source: "grove",
              name: "Task division",
              path: "/fixture/prompts/role-division.md",
              description:
                "Default task division captured by new Orcs; editing it affects only Orcs created afterwards",
            },
            {
              source: "pi",
              name: "Pi MCP servers",
              path: "/fixture/pi/mcp.json",
              description: "Pi MCP configuration",
            },
          ],
          issues: ["Could not list Codex configuration."],
        },
      });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    await page.request.post("/fixture/reset");
    const { code } = await (
      await page.request.post("/fixture/bootstrap")
    ).json();
    await page.goto("/");
    await page.getByRole("button", { name: "Use a code" }).click();
    await page.getByLabel("Code", { exact: true }).fill(code);
    await page.getByLabel(/Nickname/).fill("Alice");
    await page.getByRole("button", { name: "Create passkey" }).click();
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Grove", exact: true }).click();
    await expect(
      page.getByText("/fixture/prompts/role-division.md"),
    ).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Could not list Codex configuration." }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Copy Task division to agent" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedText?: string }).copiedText,
        ),
      )
      .toBe(
        "Task division: Default task division captured by new Orcs; editing it affects only Orcs created afterwards\n/fixture/prompts/role-division.md",
      );
    const before = requests;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(before);
    await page.screenshot({
      path: testInfo.outputPath(`config-files-${width}.png`),
    });
    await page
      .getByRole("button", { name: "Copy Pi MCP servers to agent" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedText?: string }).copiedText,
        ),
      )
      .toBe("Pi MCP servers: Pi MCP configuration\n/fixture/pi/mcp.json");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
