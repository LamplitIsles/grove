import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`${width}: configure voice without exposing the saved key`, async ({
    page,
    context,
  }, testInfo) => {
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
    if (
      width === 390 &&
      !(await page
        .locator('[data-sidebar="sidebar"][data-mobile="true"]')
        .isVisible())
    )
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Local reports Orc", exact: true })
      .click();
    const voice = page.getByRole("button", { name: "Start voice input" });
    await expect(voice).toBeDisabled();
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".settings-modal")).toHaveCSS("opacity", "1");
    await page.getByRole("button", { name: "Voice", exact: true }).click();
    await expect(page.getByText("No key configured")).toBeVisible();
    const region = page.getByRole("combobox", { name: "Region" });
    const key = page.getByLabel("Alibaba Cloud API key", { exact: true });
    const save = page.getByRole("button", { name: "Save voice settings" });
    await expect(region).toContainText("Beijing");
    await expect(save).toBeDisabled();
    await key.fill("fixture-beijing-key");
    await save.click();
    await expect(page.getByText("Voice settings saved.")).toBeVisible();
    await expect(key).toHaveValue("");
    await expect(page.getByText("Key configured")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("voice-beijing.png") });
    await region.click();
    await page.getByRole("option", { name: "Singapore" }).click();
    await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
    await expect(
      page.getByText("Enter an API key for the selected region."),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    await key.fill("fixture-singapore-key");
    await page.screenshot({ path: testInfo.outputPath("voice-singapore.png") });
    await save.click();
    await expect(key).toHaveValue("");
    await expect(region).toContainText("Singapore");
    await expect(page.getByText("Key configured")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(voice).toBeEnabled();
    if (
      width === 390 &&
      !(await page
        .locator('[data-sidebar="sidebar"][data-mobile="true"]')
        .isVisible())
    )
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Voice", exact: true }).click();
    await expect(region).toContainText("Singapore");
    await expect(key).toHaveValue("");
    await expect(page.getByText("Key configured")).toBeVisible();
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored).not.toContain("fixture-beijing-key");
    expect(stored).not.toContain("fixture-singapore-key");
    await region.click();
    await page.getByRole("option", { name: "Beijing" }).click();
    await key.fill("invalid key");
    await save.click();
    await expect(
      page.getByText("Enter a valid API key without spaces."),
    ).toBeVisible();
    await expect(key).toHaveValue("invalid key");
    let attempts = 0;
    await page.route("**/api/voice/settings", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++;
      return route.fulfill({
        status: 500,
        headers: { "X-Grove-Peer": route.request().headers()["x-grove-peer"]! },
        json: { error: "fixture", code: "key_saved_region_failed" },
      });
    });
    await key.fill("fixture-new-key");
    await save.click();
    await expect(
      page.getByText(/API key saved, but the region was not/),
    ).toBeVisible();
    await expect(key).toHaveValue("fixture-new-key");
    expect(attempts).toBe(1);
  });
}

test("another signed-in user sees voice become available without refocusing", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(60000);
  await page.request.post("/fixture/reset");
  const aliceCdp = await context.newCDPSession(page);
  await aliceCdp.send("WebAuthn.enable");
  await aliceCdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  const { code } = await (await page.request.post("/fixture/bootstrap")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "Use a code" }).click();
  await page.getByLabel("Code", { exact: true }).fill(code);
  await page.getByLabel(/Nickname/).fill("Alice");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  const voice = page.getByRole("button", { name: "Start voice input" });
  await expect(voice).toBeDisabled();
  const invitation = await page.evaluate(async () => {
    const response = await fetch("/api/auth/invitations", { method: "POST" });
    if (!response.ok) throw new Error("fixture invitation failed");
    return (await response.json()).code as string;
  });
  const other = await browser.newContext({ baseURL: "http://localhost:14320" });
  try {
    const bob = await other.newPage();
    const bobCdp = await other.newCDPSession(bob);
    await bobCdp.send("WebAuthn.enable");
    await bobCdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    await bob.goto("/");
    await bob.getByRole("button", { name: "Use a code" }).click();
    await bob.getByLabel("Code", { exact: true }).fill(invitation);
    await bob.getByLabel(/Nickname/).fill("Bob");
    await bob.getByRole("button", { name: "Create passkey" }).click();
    await bob.getByRole("button", { name: "Settings", exact: true }).click();
    await bob.getByRole("button", { name: "Voice", exact: true }).click();
    await expect(bob.getByText("No key configured")).toBeVisible();
    await page.evaluate(() => {
      (window as typeof window & { fixtureFocuses: number }).fixtureFocuses = 0;
      window.addEventListener(
        "focus",
        () =>
          (window as typeof window & { fixtureFocuses: number })
            .fixtureFocuses++,
      );
    });
    await bob
      .getByLabel("Alibaba Cloud API key", { exact: true })
      .fill("fixture-bob-key");
    await bob.getByRole("button", { name: "Save voice settings" }).click();
    await expect(bob.getByText("Voice settings saved.")).toBeVisible();
    await expect(voice).toBeEnabled({ timeout: 25000 });
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { fixtureFocuses: number }).fixtureFocuses,
      ),
    ).toBe(0);
  } finally {
    await other.close();
  }
});
