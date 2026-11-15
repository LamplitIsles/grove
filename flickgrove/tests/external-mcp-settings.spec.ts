import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`${width}: manage an external MCP token`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
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
    const section = page.getByRole("region", { name: "External MCP" });
    await expect(section.getByText("No token", { exact: true })).toBeVisible();
    await section
      .getByRole("button", { name: "Generate token", exact: true })
      .click();
    await expect(
      section.getByText("Copy this token now. It won't be shown again."),
    ).toBeVisible();
    const first = await section
      .locator("code")
      .filter({ hasText: "grove_ext_" })
      .innerText();
    expect(first).toMatch(/^grove_ext_/);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await section.getByRole("button", { name: "Copy token" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(first);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`external-mcp-${width}.png`),
    });
    expect(
      await page
        .locator(".settings-content")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBe(0);
    await section.getByRole("button", { name: "Done" }).click();
    await expect(section.getByText(first, { exact: true })).toHaveCount(0);
    await section.getByRole("button", { name: "Rotate token" }).click();
    await expect(
      section.getByText(
        "Generate a new token? The current token will stop working.",
      ),
    ).toBeVisible();
    await section.getByRole("button", { name: "Cancel" }).click();
    await section.getByRole("button", { name: "Rotate token" }).click();
    await section.getByRole("button", { name: "Generate new token" }).click();
    const second = await section
      .locator("code")
      .filter({ hasText: "grove_ext_" })
      .innerText();
    expect(second).not.toBe(first);
    await section.getByRole("button", { name: "Done" }).click();
    await section
      .getByRole("button", { name: "Revoke token", exact: true })
      .click();
    await expect(
      section.getByText(
        "Revoke this token? Connected clients will lose access.",
      ),
    ).toBeVisible();
    await section
      .getByRole("button", { name: "Revoke token", exact: true })
      .click();
    await expect(section.getByText("No token", { exact: true })).toBeVisible();

    await page.route(
      "**/api/external-mcp/token",
      async (route) => {
        if (route.request().method() === "POST") {
          await route.fetch();
          await route.abort();
        } else await route.continue();
      },
      { times: 1 },
    );
    await section
      .getByRole("button", { name: "Generate token", exact: true })
      .click();
    await expect(section.getByRole("alert")).toContainText(
      "Could not confirm the change",
    );
    await section.getByRole("button", { name: "Refresh status" }).click();
    await expect(
      section.getByText("Token active", { exact: true }),
    ).toBeVisible();
    await expect(
      section.locator("code").filter({ hasText: "grove_ext_" }),
    ).toHaveCount(0);
  });
}
