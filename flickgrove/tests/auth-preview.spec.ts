import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`${width}: authenticated preview loads sandbox resources and expires on sign out`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 600 : 900 });
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const initialAuthenticator = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      },
    );
    await page.request.post("/fixture/reset");
    const setup = await page.request.post("/fixture/bootstrap");
    const { code } = await setup.json();
    await page.goto("/");
    await page.getByRole("button", { name: "Use a code" }).click();
    await page.getByLabel("Code", { exact: true }).fill(code);
    await page.getByLabel(/Nickname/).fill("Alice");
    await page.getByRole("button", { name: "Create passkey" }).click();
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Local reports Orc", exact: true })
      .click();
    await page.getByRole("link", { name: "HTML", exact: true }).click();
    const frame = page.frameLocator(".file-preview iframe");
    await expect(frame.locator("#module")).toHaveText(
      "Local module loaded / Local",
    );
    await expect(frame.locator("#isolation")).toHaveText(
      JSON.stringify({
        cdn: true,
        parent: false,
        storage: false,
        api: false,
        ws: false,
        font: true,
      }),
    );
    await expect
      .poll(() =>
        frame
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(900);
    const url = await page.locator(".file-preview iframe").getAttribute("src");
    expect(url).toBeTruthy();
    await page.getByRole("button", { name: "Close preview" }).click();
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.locator(".account-footer .account-name")).toHaveText(
      "Alice",
    );
    if (width === 390)
      await expect(
        page.locator('[data-sidebar="sidebar"][data-mobile="true"]'),
      ).toHaveCSS("opacity", "1");
    await expect
      .poll(
        async () =>
          (
            await page
              .getByRole("button", { name: "Sign out", exact: true })
              .boundingBox()
          )?.x ?? -1,
      )
      .toBeGreaterThan(200);
    await page.screenshot({ path: testInfo.outputPath("account-footer.png") });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".settings-modal")).toHaveCSS("opacity", "1");
    const panelHeight = (await page.locator(".settings-modal").boundingBox())!
      .height;
    expect(panelHeight).toBeLessThanOrEqual(540);
    await page.screenshot({
      path: testInfo.outputPath("settings-account.png"),
    });
    const secondTab = await context.newPage();
    await secondTab.goto("/");
    await expect(secondTab.locator(".account-footer .account-name")).toHaveText(
      "Alice",
    );
    await cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: initialAuthenticator.authenticatorId,
    });
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    await page.bringToFront();
    await page.getByRole("button", { name: "Add passkey" }).click();
    await expect(
      page.locator("[data-sonner-toast]").getByText("Passkey added"),
    ).toBeVisible();
    expect((await page.request.get(url!)).status()).toBe(200);
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
    const modelHelp = page.getByText(
      "Preferences for new sessions in this browser.",
      { exact: true },
    );
    await expect(modelHelp).toHaveCount(0);
    await page.getByRole("button", { name: "About model settings" }).click();
    await expect(modelHelp).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modelHelp).toHaveCount(0);
    await expect(page.locator(".settings-modal")).toBeVisible();
    await page.getByRole("button", { name: "About model settings" }).click();
    await expect(modelHelp).toBeVisible();
    await page.goBack();
    await expect(modelHelp).toHaveCount(0);
    await expect(page.locator(".settings-modal")).toBeVisible();
    const orc = page.getByRole("button", { name: "Orc", exact: true });
    const worker = page.getByRole("button", { name: "Worker", exact: true });
    await expect(orc).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("combobox", { name: "Orc model" }),
    ).toBeVisible();
    await worker.click();
    await expect(worker).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("combobox", { name: "Worker model" }),
    ).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Orc model" })).toHaveCount(
      0,
    );
    await page
      .getByRole("combobox", { name: "Worker reasoning effort" })
      .click();
    await page.getByRole("option", { name: "high", exact: true }).click();
    await orc.click();
    await expect(
      page.getByRole("combobox", { name: "Orc reasoning effort" }),
    ).toContainText("medium");
    await worker.click();
    await expect(
      page.getByRole("combobox", { name: "Worker reasoning effort" }),
    ).toContainText("high");
    await expect
      .poll(() =>
        page
          .locator(".settings-content")
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBe(0);
    await expect
      .poll(() =>
        page
          .locator(".settings-content")
          .evaluate((element) => element.scrollHeight - element.clientHeight),
      )
      .toBe(0);
    await page.screenshot({ path: testInfo.outputPath("settings-models.png") });
    await orc.click();
    await expect(
      page.getByRole("combobox", { name: "Orc model" }),
    ).toBeVisible();
    expect((await page.locator(".settings-modal").boundingBox())!.height).toBe(
      panelHeight,
    );
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await expect(page.getByLabel("Nickname", { exact: true })).toHaveValue(
      "Alice",
    );
    await page.getByRole("button", { name: "Users", exact: true }).click();
    expect((await page.locator(".settings-modal").boundingBox())!.height).toBe(
      panelHeight,
    );
    await page.getByRole("button", { name: "Create invitation" }).click();
    await expect(page.locator(".invite-code code")).not.toBeEmpty();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    if (
      width === 390 &&
      !(await page
        .getByRole("button", { name: "Sign out", exact: true })
        .isVisible())
    )
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Sign out?" });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toHaveCSS("opacity", "1");
    const titleBox = await confirmation
      .getByRole("heading", { name: "Sign out?" })
      .boundingBox();
    const descriptionBox = await confirmation
      .getByText("You can sign in again with your passkey.")
      .boundingBox();
    expect(titleBox && descriptionBox).toBeTruthy();
    expect(
      descriptionBox!.y - (titleBox!.y + titleBox!.height),
    ).toBeGreaterThanOrEqual(7);
    await page.screenshot({
      path: testInfo.outputPath("sign-out-confirmation.png"),
    });
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "HTML", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(confirmation).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(confirmation).toBeVisible();
    await page.goBack();
    await expect(confirmation).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.route("**/api/auth/sign-out", (route) =>
      route.fulfill({ status: 500, json: { message: "Sign out failed" } }),
    );
    await confirmation
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await expect(confirmation.getByRole("alert")).toBeVisible();
    await page.unroute("**/api/auth/sign-out");
    await confirmation
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Sign in with passkey" }),
    ).toBeVisible();
    await expect(
      secondTab.getByRole("button", { name: "Sign in with passkey" }),
    ).toBeVisible();
    await secondTab.close();
    expect((await page.request.get(url!)).status()).toBe(410);
    await expect(page.getByText("Local reports", { exact: true })).toHaveCount(
      0,
    );
  });
}

test("new user updates identities and revocation hides cached conversations", async ({
  page,
  context,
}, testInfo) => {
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
  const { code } = await (await page.request.post("/fixture/bootstrap")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "Use a code" }).click();
  await page.getByLabel("Code", { exact: true }).fill(code);
  await page.getByLabel(/Nickname/).fill("Alice");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "HTML", exact: true }),
  ).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Hello from Alice");
  await input.press("Enter");
  await expect(page.locator(".user-message .message-author")).toHaveCount(0);
  await expect(page.locator(".participant-avatar")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page.locator(".account-users")).toContainText("Alice");
  await page.getByRole("button", { name: "Create invitation" }).click();
  const invite = await page.locator(".invite-code code").textContent();
  expect(invite).toBeTruthy();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const second = await context
    .browser()!
    .newContext({ baseURL: "http://localhost:14320" });
  try {
    const other = await second.newPage();
    const otherCdp = await second.newCDPSession(other);
    await otherCdp.send("WebAuthn.enable");
    await otherCdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    await other.goto("/");
    await other.getByRole("button", { name: "Use a code" }).click();
    await other.getByLabel("Code", { exact: true }).fill(invite!);
    await other.getByLabel(/Nickname/).fill("Bob");
    await other.getByRole("button", { name: "Create passkey" }).click();
    await expect(other.locator(".account-footer .account-name")).toHaveText(
      "Bob",
    );
    await other
      .getByRole("button", { name: "Open Local reports Orc", exact: true })
      .click();
    const bobInput = other.getByRole("textbox", { name: "Message Orc" });
    await bobInput.fill("Hello from Bob");
    await bobInput.press("Enter");
    await expect(
      other.locator(".participant-avatar[aria-label='Bob']"),
    ).toBeVisible();
    await other.getByRole("button", { name: "Settings", exact: true }).click();
    await other.getByLabel("Nickname", { exact: true }).fill("Robert");
    const options = other.locator(".color-choice input");
    const chosen = await options.nth(2).getAttribute("value");
    await options.nth(2).check();
    const heightBeforeSave = (await other
      .locator(".settings-modal")
      .boundingBox())!.height;
    await other.getByRole("button", { name: "Save profile" }).click();
    await expect(
      other.locator("[data-sonner-toast]").getByText("Profile saved"),
    ).toBeVisible();
    expect((await other.locator(".settings-modal").boundingBox())!.height).toBe(
      heightBeforeSave,
    );
    await expect(
      page.locator(".participant-avatar[aria-label='Robert']"),
    ).toBeVisible();
    await expect(
      page
        .locator(".user-message .message-author")
        .filter({ hasText: "Robert" }),
    ).toBeVisible();
    await expect(
      page.locator(".participant-avatar[aria-label='Robert']"),
    ).toHaveCSS(
      "background-color",
      await other
        .locator(".color-choice")
        .nth(2)
        .locator("span")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    expect(chosen).toBeTruthy();
  } finally {
    await second.close();
  }
  await expect(
    page.locator(".user-message .message-author").filter({ hasText: "Alice" }),
  ).toBeVisible();
  await expect(
    page.locator(".participant-avatar[aria-label='Alice']"),
  ).toBeVisible();
  const participantNames = page.locator(".recent-sessions .participant-avatar");
  await expect
    .poll(() =>
      participantNames.evaluateAll((items) =>
        items.map((item) => item.getAttribute("aria-label")),
      ),
    )
    .toEqual(["Alice", "Robert"]);
  await input.fill("Another message from Alice");
  await input.press("Enter");
  await expect
    .poll(() =>
      participantNames.evaluateAll((items) =>
        items.map((item) => item.getAttribute("aria-label")),
      ),
    )
    .toEqual(["Alice", "Robert"]);
  await page.getByRole("button", { name: "Edit title" }).click();
  await page
    .getByRole("textbox", { name: "Session title" })
    .fill(
      "A deliberately long conversation title that must never cover the participant avatar or the status indicator in the sidebar",
    );
  await page.getByRole("button", { name: "Save title" }).click();
  const row = page.locator(".recent-sessions .session-open").first();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    if (width === 390)
      await expect(
        page.locator('[data-sidebar="sidebar"][data-mobile="true"]'),
      ).toHaveCSS("opacity", "1");
    const title = await row.locator("strong").boundingBox();
    const avatar = await row
      .locator(".participant-avatar")
      .first()
      .boundingBox();
    const status = await row.locator(".session-state-dot").boundingBox();
    expect(title && avatar && status).toBeTruthy();
    expect(title!.x + title!.width).toBeLessThanOrEqual(avatar!.x);
    expect(avatar!.x + avatar!.width).toBeLessThanOrEqual(status!.x);
    expect(Math.abs(title!.y - avatar!.y)).toBeLessThan(4);
    await page.screenshot({
      path: testInfo.outputPath(`participants-${width}.png`),
    });
    if (width === 390) await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page.locator(".account-users")).toContainText("Robert");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close this tree" }).click();
  await expect(row).toBeVisible();
  await expect(page.locator(".detail-close-error")).toBeVisible();
  await page.request.post("/fixture/cold-reading", { data: { empty: true } });
  const idle = page.getByRole("button", {
    name: "Open Cold reading Orc",
    exact: true,
  });
  await expect(idle).toBeVisible();
  await idle.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close this tree" }).click();
  await expect(idle).toHaveCount(0);
  const signout = await page.request.post("/api/auth/sign-out", {
    headers: { origin: "http://localhost:14320" },
  });
  expect(signout.ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: "Sign in with passkey" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "HTML", exact: true }),
  ).toHaveCount(0);
});

test("reconnecting a selected conversation does not show a delayed timeout", async ({
  page,
  context,
}) => {
  test.setTimeout(50_000);
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
  const { code } = await (await page.request.post("/fixture/bootstrap")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "Use a code" }).click();
  await page.getByLabel("Code", { exact: true }).fill(code);
  await page.getByLabel(/Nickname/).fill("Alice");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "HTML", exact: true }),
  ).toBeVisible();
  await page.request.post("/fixture/history-control", {
    data: { delay: 32_000 },
  });
  await page.request.post("/fixture/offline");
  await page.request.post("/fixture/online");
  await page.waitForTimeout(32_000);
  expect(
    await page
      .getByText("Response timed out. Outcome unknown.", { exact: true })
      .count(),
  ).toBe(0);
});
