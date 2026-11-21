import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import sharp from "sharp";

const input = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const pending = (page: Page) =>
  page.getByRole("button", { name: /pending question/ });
async function start(page: Page, request: APIRequestContext, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.goto("/");
  if (width === 390)
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await page
    .getByRole("button", {
      name: "Open Streaming voice input Orc",
      exact: true,
    })
    .click();
  await expect(input(page)).toBeVisible();
}
const question = (request: APIRequestContext, id: string) =>
  request.post("/fixture/change", {
    data: { question: true, questionId: id, questionOptions: false },
  });

for (const width of [1440, 390]) {
  test(`question waits for an existing composer draft at ${width}`, async ({
    page,
    request,
  }, info) => {
    await start(page, request, width);
    await input(page).fill("Writing a message");
    await input(page).evaluate((element: HTMLTextAreaElement) =>
      element.setSelectionRange(7, 7),
    );
    await question(request, "during-draft");
    await expect(pending(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(page.locator(".question-panel")).not.toBeVisible();
    expect(
      await input(page).evaluate(
        (element: HTMLTextAreaElement) => element.selectionStart,
      ),
    ).toBe(7);
    await input(page).pressSequentially(" now");
    await expect(input(page)).toHaveValue("Writing now a message");
    await page.screenshot({
      path: info.outputPath(`draft-pending-${width}.png`),
    });
    await page.reload();
    await expect(input(page)).toHaveValue("Writing now a message");
    await expect(pending(page)).toBeVisible();
    await expect(page.locator(".question-panel")).not.toBeVisible();
    if (width === 1440) {
      await page
        .getByRole("button", {
          name: "Open Reader performance Orc",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: "Open Streaming voice input Orc",
          exact: true,
        })
        .click();
      await expect(input(page)).toHaveValue("Writing now a message");
      await expect(pending(page)).toBeVisible();
      await expect(page.locator(".question-panel")).not.toBeVisible();
    }
    await pending(page).click();
    await expect(page.locator(".question-panel")).toBeVisible();
    if (width === 1440) {
      await page
        .getByRole("button", {
          name: "Open Reader performance Orc",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: "Open Streaming voice input Orc",
          exact: true,
        })
        .click();
      await expect(input(page)).toHaveValue("Writing now a message");
      await expect(page.locator(".question-panel")).not.toBeVisible();
      await pending(page).click();
      await expect(page.locator(".question-panel")).toBeVisible();
    }
    await page.getByRole("button", { name: "Collapse questions" }).click();
    await expect(input(page)).toHaveValue("Writing now a message");
    await input(page).fill("");
    await expect(pending(page)).toBeVisible();
    await expect(page.locator(".question-panel")).not.toBeVisible();
    await question(request, "after-clearing");
    await expect(page.locator(".question-panel")).toBeVisible();
  });
}

test("live draft protects typing when local storage cannot save it", async ({
  page,
  request,
}) => {
  await start(page, request, 1440);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes("/composer/"))
        throw new Error("fixture storage unavailable");
      return original.call(this, key, value);
    };
  });
  await input(page).fill("unsaved text");
  await question(request, "storage-failure");
  await expect(pending(page)).toBeVisible();
  await expect(input(page)).toHaveValue("unsaved text");
  await expect(input(page)).toBeFocused();
  await expect(page.locator(".question-panel")).not.toBeVisible();
});

test("manually opening a question preserves text and image drafts", async ({
  page,
  request,
}) => {
  await start(page, request, 1440);
  await input(page).fill("draft with image");
  await page.getByLabel("Choose message attachments").setInputFiles({
    name: "fixture.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 10, height: 10, channels: 4, background: "#7799cc" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await question(request, "image-draft");
  await expect(pending(page)).toBeVisible();
  await pending(page).click();
  await expect(page.locator(".question-panel")).toBeVisible();
  await page.getByRole("button", { name: "Collapse questions" }).click();
  await expect(input(page)).toHaveValue("draft with image");
  await expect(page.locator(".image-draft")).toHaveCount(1);
});
