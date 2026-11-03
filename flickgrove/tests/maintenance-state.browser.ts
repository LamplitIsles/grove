import { expect, test, type Page } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`${width}: maintenance and session indicators follow actual work`, async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(45_000);
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

    const add = (kind: string) =>
      page.request.post("/fixture/maintenance-state", { data: { kind } });
    const openSidebar = async (page: Page) => {
      if (width === 390) {
        const sidebar = page.locator(
          '[data-sidebar="sidebar"][data-mobile="true"]',
        );
        if (!(await sidebar.isVisible()))
          await page.getByRole("button", { name: "Toggle Sidebar" }).click();
        await expect(sidebar).toBeVisible();
      }
    };
    const row = (title: string) =>
      page.getByRole("button", { name: `Open ${title} Orc` });
    const select = async (title: string) => {
      await openSidebar(page);
      await row(title).click();
      await expect(page.locator(".agent-detail")).toHaveAttribute(
        "aria-label",
        title,
      );
    };

    expect((await add("question")).ok()).toBe(true);
    await select("Waiting for an answer");
    await expect(page.locator(".detail-status")).toContainText("Needs input");
    await openSidebar(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Grove", exact: true }).click();
    const settings = page.locator(".instance-actions");
    const status = await page.evaluate(async () =>
      (await fetch("/api/instance")).json(),
    );
    expect(status.busy, JSON.stringify(status)).toBe(false);
    await expect(
      settings.getByRole("button", { name: "Reload MCP" }),
    ).toBeEnabled();
    await expect(
      settings.getByRole("button", { name: "Restart Grove" }),
    ).toBeEnabled();
    await expect(page.getByLabel("Waiting for", { exact: true })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");

    expect((await add("error")).ok()).toBe(true);
    await select("Finished with an error");
    await expect(page.locator(".detail-status")).toContainText(
      "Needs attention",
    );
    await openSidebar(page);
    await expect(
      row("Finished with an error").locator(".session-state-dot"),
    ).toHaveAttribute("aria-label", "Needs attention");
    await row("Finished with an error").click();

    expect((await add("unconfirmed")).ok()).toBe(true);
    await select("Unconfirmed work");
    await expect(page.locator(".detail-status")).toContainText("Working");
    await expect(page.locator(".detail-status")).not.toContainText(
      "Needs attention",
    );
    await expect(page.getByRole("button", { name: "Stop Orc" })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("unconfirmed-work.png"),
    });
    await openSidebar(page);
    await expect(
      row("Unconfirmed work").locator(".session-state-dot"),
    ).toHaveAttribute("aria-label", "Working");
    await row("Unconfirmed work").click();
    expect((await add("stop")).ok()).toBe(true);
    await select("Unconfirmed stop");
    await expect(page.locator(".detail-status")).toContainText("Working");
    await expect(page.locator(".detail-status .failed")).toHaveCount(0);
    await expect(page.getByText(/Stop outcome unknown/)).toBeVisible();
    await openSidebar(page);
    await expect(
      row("Unconfirmed stop").locator(".session-state-dot"),
    ).toHaveAttribute("aria-label", "Working");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Grove", exact: true }).click();
    await expect
      .poll(
        async () =>
          page
            .evaluate(async () => (await fetch("/api/instance")).json())
            .then((value) => value.canConfirmBusy),
        { timeout: 12000 },
      )
      .toBe(true);
    await page.getByRole("button", { name: "Grove", exact: true }).click();
    await expect(
      settings.getByRole("button", { name: "Reload MCP" }),
    ).toBeEnabled();
    await expect(
      settings.getByRole("button", { name: "Restart Grove" }),
    ).toBeEnabled();
    await expect(page.getByLabel("Waiting for", { exact: true })).toContainText(
      "Unconfirmed work",
    );
    await settings.getByRole("button", { name: "Reload MCP" }).click();
    const confirm = page.getByRole("dialog", { name: "Reload MCP?" });
    await expect(confirm).toContainText("Unconfirmed work");
    await expect(confirm).toContainText("Unconfirmed stop");
    await expect(confirm).toContainText("may be interrupted");
    await page.screenshot({ path: testInfo.outputPath("confirm-working.png") });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath("maintenance-state.png"),
    });
  });
}
