import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`${width}: manage the shared Context7 key`, async ({
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
    await page.getByRole("button", { name: "Web", exact: true }).click();
    const web = page.getByRole("region", { name: "Web" });
    const key = web.getByLabel("Context7 API key");
    await expect(web.getByText("Using anonymous access")).toBeVisible();
    await expect(
      web.locator("p").filter({ hasText: "Shared by everyone" }),
    ).toBeVisible();
    await key.fill("fixture-first-key");
    await web.getByRole("button", { name: "Save key" }).click();
    await expect(web.getByText("Key configured")).toBeVisible();
    await expect(key).toHaveValue("");
    await page.screenshot({
      path: info.outputPath(`web-settings-${width}.png`),
    });
    expect(
      await page
        .locator(".settings-content")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBe(0);
    await key.fill("fixture-second-key");
    await web.getByRole("button", { name: "Save key" }).click();
    await expect(key).toHaveValue("");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Web", exact: true }).click();
    await expect(web.getByText("Key configured")).toBeVisible();
    await expect(key).toHaveValue("");
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      ),
    ).not.toContain("fixture-second-key");
    await key.fill("invalid key");
    await web.getByRole("button", { name: "Save key" }).click();
    await expect(web.getByRole("alert")).toContainText("valid API key");
    await expect(key).toHaveValue("invalid key");
    await web.getByRole("button", { name: "Remove key", exact: true }).click();
    await expect(web.getByText(/Remove this key\?/)).toBeVisible();
    await web.getByRole("button", { name: "Cancel" }).click();
    await expect(web.getByText("Key configured")).toBeVisible();
    await web.getByRole("button", { name: "Remove key", exact: true }).click();
    await web.getByRole("button", { name: "Remove key", exact: true }).click();
    await expect(web.getByText("Using anonymous access")).toBeVisible();

    await page.route(
      "**/api/web/settings",
      async (route) => {
        if (route.request().method() === "PUT") {
          await route.fetch();
          await route.abort();
        } else await route.continue();
      },
      { times: 1 },
    );
    await key.fill("fixture-lost-receipt-key");
    await web.getByRole("button", { name: "Save key" }).click();
    await expect(web.getByRole("alert")).toContainText(
      "Could not confirm the change",
    );
    await web.getByRole("button", { name: "Refresh status" }).click();
    await expect(web.getByText("Key configured")).toBeVisible();
    await expect(key).toHaveValue("fixture-lost-receipt-key");
  });
}
