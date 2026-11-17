import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`${width}: organization review choices save independently and recover unknown writes`, async ({
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
    await page
      .getByRole("button", { name: "Organizations", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "Organizations" });
    const first = panel.getByRole("switch", {
      name: "Automatic independent review for guionai",
    });
    const second = panel.getByRole("switch", {
      name: "Automatic independent review for lamplitisles",
    });
    await expect(
      panel.getByText(
        "Shared by everyone using this Grove. Changes apply to new sessions only.",
      ),
    ).toBeVisible();
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
    await first.click();
    await expect(first).toBeChecked();
    await expect(second).not.toBeChecked();
    await page.screenshot({
      path: info.outputPath(`organization-settings-${width}.png`),
    });
    expect(
      await page
        .locator(".settings-content")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBe(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Organizations", exact: true })
      .click();
    await expect(first).toBeChecked();
    await expect(second).not.toBeChecked();

    let writes = 0;
    await page.route(
      "**/api/organization-review-settings",
      async (route) => {
        if (route.request().method() === "PUT") {
          writes++;
          await route.fetch();
          await route.abort();
        } else await route.continue();
      },
      { times: 1 },
    );
    await second.click();
    await expect(panel.getByRole("alert")).toContainText(
      "Could not confirm the change",
    );
    await expect(panel.getByRole("alert")).toContainText(
      "may still be applied",
    );
    await expect(first).toBeDisabled();
    await expect(second).toBeDisabled();
    await panel.getByRole("button", { name: "Refresh status" }).click();
    await expect(second).toBeChecked();
    await expect(first).toBeChecked();
    expect(writes).toBe(1);

    await page.request.post("/fixture/organizations-remote", {
      data: { unavailable: true },
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Organizations", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("Remote");
    await expect(first).toBeChecked();
    await page.request.post("/fixture/organizations-remote", {
      data: { unavailable: false },
    });
    await panel.getByRole("button", { name: "Refresh status" }).click();
    await expect(panel.getByRole("alert")).toHaveCount(0);

    await page.route(
      "**/api/organization-review-settings",
      (route) => route.abort(),
      { times: 1 },
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Organizations", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText(
      "Could not load organization settings",
    );
    await panel.getByRole("button", { name: "Refresh status" }).click();
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();

    await page.evaluate(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = (ms) => timeout(ms === 15_000 ? 100 : ms);
    });
    let timedWrites = 0;
    await page.route(
      "**/api/organization-review-settings",
      async (route) => {
        timedWrites++;
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await route.fulfill({ response }).catch(() => {});
      },
      { times: 1 },
    );
    await first.click();
    await expect(panel.getByRole("alert")).toContainText(
      "Could not confirm the change",
    );
    await panel.getByRole("button", { name: "Refresh status" }).click();
    await expect(first).not.toBeChecked();
    await expect(second).toBeChecked();
    expect(timedWrites).toBe(1);
  });
}
