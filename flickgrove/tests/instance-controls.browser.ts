import { expect, test } from "@playwright/test";
import type { InstanceStatus } from "../src/contracts";

for (const width of [1440, 390]) {
  test(`${width}: instance actions show version and reconcile restart without replay`, async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    let instance: InstanceStatus = {
      id: "process-one",
      version: "a1b2c3d",
      busy: false,
      restartAvailable: true,
      sessions: [],
      instanceReasons: [],
    };
    let refuseRestart = false;
    let reloadFailure = 0;
    let reloads = 0,
      restarts = 0;
    await page.route("**/api/instance**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/instance") return route.fulfill({ json: instance });
      if (path === "/api/instance/mcp/reload") {
        reloads++;
        if (reloadFailure)
          return route.fulfill({
            status: reloadFailure,
            json: { error: "Unavailable" },
          });
        return route.fulfill({
          json: {
            results: [
              {
                backend: "codex",
                status: reloads === 1 ? "partial_or_unknown" : "requested",
              },
              ...(reloads === 2 ? [{ backend: "pi", status: "deferred" }] : []),
            ],
          },
        });
      }
      if (path === "/api/instance/restart") {
        restarts++;
        if (refuseRestart)
          return route.fulfill({
            status: 400,
            json: { error: "Instance busy" },
          });
        return route.fulfill({ json: { status: "unknown" } });
      }
      return route.abort();
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
    if (width === 390)
      await expect(
        page.locator('[data-sidebar="sidebar"][data-mobile="true"]'),
      ).toHaveCSS("opacity", "1");
    const version = page.locator(".account-footer .instance-version");
    await expect(version).toHaveText("a1b2c3d");
    const settingsButton = page.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    expect((await version.boundingBox())!.x).toBeLessThan(
      (await settingsButton.boundingBox())!.x,
    );
    await page.screenshot({ path: testInfo.outputPath("footer.png") });
    await settingsButton.click();
    await expect(page.locator(".settings-modal")).toHaveCSS("opacity", "1");
    await page.getByRole("button", { name: "Grove", exact: true }).click();
    const reload = page.getByRole("button", { name: "Reload MCP" });
    const restart = page.locator(".instance-actions").getByRole("button", {
      name: "Restart Grove",
      exact: true,
    });
    await expect(reload).toBeEnabled();
    await expect(restart).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("settings.png") });
    await reload.click();
    await expect(
      page.getByText(/Some MCP connections could not be reloaded/),
    ).toBeVisible();
    await reload.click();
    await expect(page.getByText("MCP reload requested.")).toBeVisible();
    await expect(
      page.getByText(/Inactive Pi sessions will read/),
    ).toBeVisible();
    expect(reloads).toBe(2);
    instance = { ...instance, busy: true, instanceReasons: ["creating"] };
    reloadFailure = 400;
    await reload.click();
    await expect(page.getByLabel("Waiting for")).toContainText(
      "Creating session",
    );
    await expect(
      page.getByRole("alert").filter({ hasText: /Wait for all sessions/ }),
    ).toBeVisible();
    instance = { ...instance, busy: false, instanceReasons: [] };
    await expect(reload).toBeEnabled({ timeout: 12000 });
    await expect(
      page.getByRole("alert").filter({ hasText: /Wait for all sessions/ }),
    ).toHaveCount(0);
    reloadFailure = 503;
    await reload.click();
    await expect(
      page.getByRole("alert").filter({ hasText: /Could not reload MCP/ }),
    ).toBeVisible();
    reloadFailure = 0;
    await restart.click();
    const dialog = page.getByRole("dialog", { name: "Restart Grove?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("confirmation.png") });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(restarts).toBe(0);
    instance = {
      ...instance,
      busy: true,
      sessions: [
        {
          id: "fixture:orc",
          title:
            "A long session name that should fit in the available space alpha",
          role: "orc",
          reasons: ["working", "question", "delivery_uncertain"],
        },
        {
          id: "fixture:orc2",
          title:
            "A long session name that should fit in the available space beta",
          role: "orc",
          reasons: ["working"],
        },
        {
          id: "fixture:worker",
          title: "Background worker",
          role: "worker",
          reasons: ["opening", "queue"],
        },
      ],
      instanceReasons: ["creating"],
    };
    await page.getByRole("button", { name: "Grove", exact: true }).click();
    await expect(restart).toBeDisabled();
    await expect(page.getByText(/Wait for all sessions/)).toBeVisible();
    const blockers = page.getByLabel("Waiting for");
    const rows = blockers.locator("li");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("A long session name");
    await expect(rows.nth(0)).toContainText("Orc");
    await expect(rows.nth(0)).toContainText(
      "Working · Awaiting an answer · Message delivery unconfirmed",
    );
    for (const [index, suffix] of [
      [0, "alpha"],
      [1, "beta"],
    ] as const) {
      const title = rows.nth(index).locator("details");
      await title.locator("summary").click();
      await expect(title).toHaveAttribute("open", "");
      await expect(title.locator("strong")).toHaveCSS("white-space", "normal");
      await expect(title.locator("strong")).toContainText(suffix);
    }
    await expect(rows.nth(2)).toContainText("Worker");
    await expect(rows.nth(2)).toContainText(
      "Opening session · Processing a request",
    );
    await expect(blockers).toContainText("Creating session");
    expect(
      await blockers.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("blockers.png") });
    instance = {
      ...instance,
      sessions: instance.sessions.slice(2),
      instanceReasons: [],
    };
    await expect(rows).toHaveCount(1, { timeout: 12000 });
    await expect(rows.nth(0)).toContainText("Background worker");
    await expect(blockers).not.toContainText("Creating session");
    instance = { ...instance, sessions: [], instanceReasons: ["creating"] };
    await expect(rows).toHaveCount(0, { timeout: 12000 });
    await expect(blockers).toContainText("Creating session");
    instance = { ...instance, busy: false, sessions: [], instanceReasons: [] };
    await expect(restart).toBeEnabled({ timeout: 12000 });
    await expect(blockers).toHaveCount(0);
    await restart.click();
    instance = { ...instance, busy: true, instanceReasons: ["creating"] };
    refuseRestart = true;
    await dialog
      .getByRole("button", { name: "Restart Grove", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: /Wait for all sessions/ }),
    ).toBeVisible();
    instance = { ...instance, busy: false, instanceReasons: [] };
    await expect(restart).toBeEnabled({ timeout: 12000 });
    await expect(
      page.getByRole("alert").filter({ hasText: /Wait for all sessions/ }),
    ).toHaveCount(0);
    refuseRestart = false;
    await restart.click();
    await dialog
      .getByRole("button", { name: "Restart Grove", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/result is not confirmed/)).toBeVisible();
    await expect(restart).toBeDisabled();
    expect(restarts).toBe(2);
    await page.reload();
    await expect(page.locator(".settings-modal")).toBeVisible();
    await page.getByRole("button", { name: "Grove", exact: true }).click();
    await expect(page.getByText(/result is not confirmed/)).toBeVisible();
    expect(restarts).toBe(2);
    instance = { ...instance, id: "process-two" };
    await page.getByRole("button", { name: "Check status" }).click();
    await expect(page.getByText("Grove restarted.")).toBeVisible();
    await expect(restart).toBeEnabled();
    expect(restarts).toBe(2);
    instance = { ...instance, version: null, restartAvailable: false };
    await page.getByRole("button", { name: "Grove", exact: true }).click();
    await expect(restart).toBeDisabled();
    await expect(
      page.getByText("Restart is unavailable for this Grove."),
    ).toBeVisible();
    await expect(version).toHaveText("—");
  });
}
