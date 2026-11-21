import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

const origin = "http://127.0.0.1:14319";
const input = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });

for (const width of [1440, 390]) {
  test(`ordinary sends release focus and allow shortcuts at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "no-workers" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    if (width === 390) {
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await page.locator(".session-open").first().click();
    } else
      await page
        .getByRole("button", { name: "Open Streaming voice input Orc" })
        .click();
    const composer = input(page);
    await expect(
      page.getByRole("button", { name: "Add attachments" }),
    ).toBeEnabled();
    const title = await page.locator(".agent-detail h1").textContent();

    await composer.focus();
    await composer.press("Enter");
    await expect(composer).toBeFocused();
    await composer.fill("Enter message");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(composer).not.toBeFocused();
    await expect(page.locator(".agent-detail h1")).toHaveText(title!);
    await page.keyboard.press("i");
    await expect(composer).toBeFocused();

    await composer.fill("Button message");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(composer).toHaveValue("");
    await expect(composer).not.toBeFocused();
    await expect(page.locator(".agent-detail h1")).toHaveText(title!);
    await page.keyboard.press("i");
    await expect(composer).toBeFocused();
    await expect(
      page.locator(".user-message").filter({ hasText: "Button message" }),
    ).toHaveCount(1);

    const buffer = await sharp({
      create: { width: 4, height: 4, channels: 4, background: "red" },
    })
      .png()
      .toBuffer();
    await page
      .getByLabel("Choose message attachments")
      .setInputFiles({ name: "image.png", mimeType: "image/png", buffer });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await composer.focus();
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(composer).not.toBeFocused();
    await expect(page.locator(".image-draft")).toHaveCount(0);
    await expect(page.locator(".agent-detail h1")).toHaveText(title!);
  });
}

test("delayed image delivery and failure leave a later focus and draft intact", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect(
    page.getByRole("button", { name: "Add attachments" }),
  ).toBeEnabled();
  const info = await (await request.get(`${origin}/fixture/info`)).json();
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const upload = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route("**/api/attachments/0?*", async (route) => {
    arrived();
    await gate;
    await route.fulfill({
      status: 400,
      headers: { "X-Grove-Peer": info.hub },
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic upload rejection" }),
    });
  });
  const buffer = await sharp({
    create: { width: 4, height: 4, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel("Choose message attachments")
    .setInputFiles({ name: "image.png", mimeType: "image/png", buffer });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input(page).fill("Image caption");
  await input(page).press("Enter");
  await upload;
  await expect(input(page)).not.toBeFocused();
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator(".composer [role=alert]")).toContainText(
    "Synthetic upload rejection",
  );
  await expect(input(page)).toHaveValue("Image caption");
  await expect(input(page)).not.toBeFocused();
  await input(page).fill("Later draft");
  await expect(input(page)).toHaveValue("Later draft");
  await expect(input(page)).toBeFocused();
  expect(
    (await (await request.get(`${origin}/fixture/info`)).json()).inputs,
  ).toHaveLength(info.inputs.length);
});

test("delayed local image preparation does not steal focus from another control", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect(
    page.getByRole("button", { name: "Add attachments" }),
  ).toBeEnabled();
  const buffer = await sharp({
    create: { width: 4, height: 4, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel("Choose message attachments")
    .setInputFiles({ name: "image.png", mimeType: "image/png", buffer });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  await page.route("**/api/attachments/0?*", async (route) => {
    started.resolve();
    await held.promise;
    await route.continue();
  });
  await input(page).fill("Held image");
  await input(page).press("Enter");
  await started.promise;
  await expect(input(page)).toBeDisabled();
  const other = page.getByRole("button", { name: "Toggle Sidebar" });
  await other.focus();
  await expect(other).toBeFocused();
  held.resolve();
  await expect(input(page)).toBeEnabled();
  await expect(other).toBeFocused();
  await expect(
    page.locator(".user-message").filter({ hasText: "Held image" }),
  ).toHaveCount(1);
});
