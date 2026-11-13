import { expect, test, type Page } from "@playwright/test";
import { createSession, openSidebar } from "./browser-actions";

const origin = "http://127.0.0.1:14319";
const org = (page: Page) =>
  page.getByRole("combobox", { name: "Select organization" });
const recent = (page: Page) =>
  page.getByRole("region", { name: "Recent activity" });
const opened = (page: Page) => page.getByRole("region", { name: "Opened" });
async function chooseOrg(page: Page, name: string) {
  await org(page).click();
  await page.getByRole("option", { name, exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "org-groups" },
  });
});

for (const width of [1440, 390]) {
  test(`creating a session selects its project's organization at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await openSidebar(page);
    await expect(org(page)).toContainText("guionai");
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    let dialog = page.getByRole("dialog", { name: "New session" });
    await dialog
      .getByRole("combobox", { name: "Search projects" })
      .fill("Personal");
    await expect(
      dialog.getByRole("option", { name: "Personal", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await openSidebar(page);
    await expect(org(page)).toContainText("guionai");
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "New session" });
    await dialog
      .getByRole("combobox", { name: "Search projects" })
      .fill("Personal");
    await dialog.getByRole("option", { name: "Personal", exact: true }).click();
    await createSession(page);
    await openSidebar(page);
    await expect(org(page)).toContainText("personal");
    await page.reload();
    await openSidebar(page);
    await expect(org(page)).toContainText("personal");
  });

  test(`cross-org recent and selected opened are disjoint at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await openSidebar(page);
    await expect(org(page)).toContainText("guionai");
    await expect(recent(page).locator(".session-open strong")).toHaveText([
      "Reader performance",
      "Streaming voice input",
    ]);
    await expect(opened(page).locator(".session-open strong")).toHaveText([
      "Forge repository in the same organization",
    ]);
    await page.screenshot({ path: testInfo.outputPath(`${width}-org.png`) });
    if (width === 1440) {
      await org(page).hover();
      await expect(org(page).locator("svg")).toHaveCSS("opacity", "1");
      await page.screenshot({ path: testInfo.outputPath("desktop-hover.png") });
    }
    await chooseOrg(page, "lamplitisles");
    await expect(org(page)).toContainText("lamplitisles");
    await expect(recent(page).locator(".session-open strong")).toHaveText([
      "Reader performance",
      "Streaming voice input",
    ]);
    await expect(opened(page).locator(".session-open")).toHaveCount(0);
    await expect(opened(page)).toContainText("No other open sessions");
    await chooseOrg(page, "personal");
    await expect(opened(page).locator(".session-open strong")).toHaveText([
      "Personal repository",
    ]);
    const allIds = await page
      .locator(".session-open")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-agent-id")));
    expect(new Set(allIds).size).toBe(allIds.length);
    await recent(page)
      .getByRole("button", { name: "Open Reader performance Orc" })
      .click();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Reader performance",
    );
    await openSidebar(page);
    await expect(org(page)).toContainText("personal");
    await page.reload();
    await openSidebar(page);
    await expect(org(page)).toContainText("personal");
    await expect(opened(page)).toContainText("Personal repository");
    await chooseOrg(page, "Ungrouped");
    await expect(opened(page).locator(".session-open strong")).toHaveText([
      "Local repository without remote",
      "Project removed from catalogue",
    ]);
  });
}

test("activity moves an opened tree into recent without losing detail", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "org-groups-idle" },
  });
  await page.goto(origin);
  await expect(org(page)).toContainText("guionai");
  const root = opened(page).getByRole("button", {
    name: "Open Streaming voice input Orc",
  });
  await root.click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Start work");
  await input.press("Enter");
  await expect(
    recent(page).getByRole("button", {
      name: "Open Streaming voice input Orc",
    }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    opened(page).getByRole("button", {
      name: "Open Streaming voice input Orc",
    }),
  ).toHaveCount(0);
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
});

test("choosing another org keeps the current detail and unsent draft", async ({
  page,
}) => {
  await page.goto(origin);
  await recent(page)
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Keep this draft");
  await chooseOrg(page, "personal");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await expect(input).toHaveValue("Keep this draft");
  await expect(opened(page)).toContainText("Personal repository");
});

test("recent members stay with their root when switching organization", async ({
  page,
}) => {
  await page.goto(origin);
  const row = recent(page)
    .locator(".session-row")
    .filter({
      has: page.getByRole("button", { name: "Open Streaming voice input Orc" }),
    });
  await row.getByRole("button", { name: "Expand Workers" }).click();
  const member = recent(page).getByRole("button", {
    name: "Open Voice input Worker",
  });
  await member.click();
  await chooseOrg(page, "personal");
  await expect(member).toHaveAttribute("aria-current", "true");
  await expect(
    opened(page).getByRole("button", { name: "Open Voice input Worker" }),
  ).toHaveCount(0);
  await expect(page.locator(".agent-detail h1")).toHaveText("Voice input");
});

test("keyboard navigation expands and enters a recent tree", async ({
  page,
}) => {
  await page.goto(origin);
  const root = recent(page).getByRole("button", {
    name: "Open Streaming voice input Orc",
  });
  const member = recent(page).getByRole("button", {
    name: "Open Voice input Worker",
  });
  await root.focus();
  await page.keyboard.press("ArrowRight");
  await expect(member).toBeVisible();
  await expect(root).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(member).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(root).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(member).toHaveCount(0);
  await page.keyboard.press("e");
  await expect(member).toBeVisible();
});

for (const selection of ["guionai", "lamplitisles"]) {
  test(`shortcut-selected recent trees accept arrow navigation with ${selection} selected`, async ({
    page,
  }) => {
    await page.goto(origin);
    await expect(org(page)).toContainText("guionai");
    if (selection !== "guionai") await chooseOrg(page, selection);
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.focus();
    await page.keyboard.press("Escape");
    await expect(input).not.toBeFocused();
    await page.keyboard.press("Alt+j");
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    const member = recent(page).getByRole("button", {
      name: "Open Voice input Worker",
    });
    await page.keyboard.press("ArrowRight");
    await expect(member).toBeVisible();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".agent-detail h1")).toHaveText("Voice input");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
  });
}

test("Tab keeps focus in the sidebar and project selection", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(org(page)).toContainText("guionai");
  await org(page).focus();
  await page.keyboard.press("Tab");
  await expect(org(page)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(org(page)).toBeFocused();
  await org(page).click();
  const focused = await page.evaluate(() => document.activeElement?.outerHTML);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(
    focused,
  );
  await expect(
    page.getByRole("option", { name: "personal", exact: true }),
  ).toBeVisible();
  await page.getByRole("option", { name: "guionai", exact: true }).click();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New session" });
  const search = dialog.getByRole("combobox", { name: "Search projects" });
  await search.fill("Personal");
  await search.press("Tab");
  await expect(search).toBeFocused();
  await expect(
    dialog.getByRole("option", { name: "Personal", exact: true }),
  ).toHaveAttribute("data-checked", "true");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Orc model" }).click();
  const modelSearch = page.getByRole("combobox", { name: "Search orc model" });
  await expect(modelSearch).toBeFocused();
  await modelSearch.press("Tab");
  await expect(modelSearch).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
});

test("catalogue delay keeps the remembered organization and recovers", async ({
  page,
  request,
}) => {
  await page.goto(origin);
  await chooseOrg(page, "personal");
  await request.post(origin + "/fixture/change", {
    data: { projectsDelay: 1200 },
  });
  await page.reload();
  await expect(org(page)).toContainText("personal");
  await expect(opened(page)).toContainText("Personal repository");
});

test("catalogue failure keeps sessions reachable and recovers organization choices", async ({
  page,
  request,
}) => {
  await page.goto(origin);
  await chooseOrg(page, "personal");
  await request.post(origin + "/fixture/change", {
    data: { projectsFailure: true },
  });
  await page.reload();
  await expect(org(page)).toContainText("Ungrouped");
  await expect(opened(page)).toContainText("Personal repository");
  await request.post(origin + "/fixture/change", {
    data: { projectsFailure: false },
  });
  await page.reload();
  await expect(org(page)).toContainText("personal");
  await expect(opened(page)).toContainText("Personal repository");
});

test("organization choices follow open trees, including trees only in recent", async ({
  page,
  request,
}) => {
  await page.goto(origin);
  await chooseOrg(page, "personal");
  const restart = await request.post(origin + "/fixture/change", {
    data: { restartHub: true, closedAgent: "personal-orc" },
  });
  expect(restart.ok()).toBe(true);
  await expect(org(page)).toContainText("guionai");
  await org(page).click();
  await expect(
    page.getByRole("option", { name: "personal", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "lamplitisles", exact: true }),
  ).toBeVisible();
  await page.getByRole("option", { name: "lamplitisles", exact: true }).click();
  await expect(opened(page)).toContainText("No other open sessions");
  await expect(
    recent(page).locator('.session-open[data-agent-id$=":reader-orc"]'),
  ).toBeVisible();
});

test("creating the first open tree selects its previously unavailable organization", async ({
  page,
  request,
}) => {
  await page.goto(origin);
  await expect(org(page)).toContainText("guionai");
  const restart = await request.post(origin + "/fixture/change", {
    data: { restartHub: true, closedAgent: "personal-orc" },
  });
  expect(restart.ok()).toBe(true);
  await org(page).click();
  await expect(
    page.getByRole("option", { name: "personal", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: "guionai", exact: true }).click();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New session" });
  await dialog
    .getByRole("combobox", { name: "Search projects" })
    .fill("Personal");
  await dialog.getByRole("option", { name: "Personal", exact: true }).click();
  await createSession(page);
  await expect(org(page)).toContainText("personal");
});

test("long organization names leave the new session action usable", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "org-groups-long" },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await openSidebar(page);
  await expect(org(page)).toContainText("a-very-long-organization-name");
  const title = (await org(page).boundingBox())!;
  const add = page.getByRole("button", { name: "New session", exact: true });
  const button = (await add.boundingBox())!;
  expect(title.x + title.width).toBeLessThanOrEqual(button.x);
  await add.click();
  await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
});

test("organization choice accepts keyboard and Escape preserves detail", async ({
  page,
}) => {
  await page.goto(origin);
  const title = page.locator(".agent-detail h1");
  const original = await title.textContent();
  await org(page).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", { name: "personal", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(title).toHaveText(original!);
  await expect(org(page)).toContainText("guionai");
});

test("Opened folding keeps detail and draft, is per org, and survives reload", async ({
  page,
}, testInfo) => {
  await page.goto(origin);
  const openedToggle = opened(page).getByRole("button", {
    name: "Opened",
    exact: true,
  });
  await opened(page)
    .getByRole("button", {
      name: "Open Forge repository in the same organization Orc",
    })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Draft stays here");
  await openedToggle.click();
  await expect(openedToggle).toHaveAttribute("aria-expanded", "false");
  await expect(opened(page).locator(".session-open")).toHaveCount(0);
  await expect(recent(page).locator(".session-open")).toHaveCount(2);
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Forge repository in the same organization",
  );
  await expect(input).toHaveValue("Draft stays here");
  await page.screenshot({ path: testInfo.outputPath("desktop-folded.png") });
  await chooseOrg(page, "personal");
  await expect(openedToggle).toHaveAttribute("aria-expanded", "true");
  await expect(opened(page)).toContainText("Personal repository");
  await chooseOrg(page, "guionai");
  await expect(openedToggle).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(openedToggle).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveValue("Draft stays here");
  await openedToggle.click();
  await expect(opened(page)).toContainText(
    "Forge repository in the same organization",
  );
});

test.describe("touch Opened disclosure", () => {
  test.use({ hasTouch: true });
  test("Opened folds and unfolds by touch without hiding Recent activity", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin);
    await openSidebar(page);
    const toggle = opened(page).getByRole("button", {
      name: "Opened",
      exact: true,
    });
    await expect(opened(page).locator(".session-open")).toHaveCount(1);
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(opened(page).locator(".session-open")).toHaveCount(0);
    await expect(recent(page).locator(".session-open")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("mobile-folded.png") });
    await toggle.tap();
    await expect(opened(page).locator(".session-open")).toHaveCount(1);
  });
});

test("session shortcuts skip folded Opened entries", async ({ page }) => {
  await page.goto(origin);
  await opened(page)
    .getByRole("button", {
      name: "Open Forge repository in the same organization Orc",
    })
    .click();
  await opened(page)
    .getByRole("button", { name: "Opened", exact: true })
    .click();
  await page.keyboard.press("Alt+KeyJ");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  await page.keyboard.press("Alt+KeyJ");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await page.keyboard.press("Alt+KeyJ");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  const toggle = opened(page).getByRole("button", {
    name: "Opened",
    exact: true,
  });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
