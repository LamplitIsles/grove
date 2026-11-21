import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

const origin = "http://127.0.0.1:14319";
const input = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const bubble = (page: Page, text: string) =>
  page.locator(".user-message").filter({ hasText: text });
const retry = (page: Page, text: string) =>
  bubble(page, text).getByRole("button", { name: "Retry", exact: true });
async function open(page: Page) {
  await page.goto(origin);
  await page
    .getByRole("button", {
      name: "Open Streaming voice input Orc",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Add attachments", exact: true }),
  ).toBeEnabled();
}
function observe(page: Page) {
  const sends: any[] = [],
    results: any[] = [],
    lookups: any[] = [];
  page.on("websocket", (socket) => {
    const calls = new Map<number, any>();
    socket.on("framesent", ({ payload }) => {
      const f = JSON.parse(String(payload));
      if (["send", "lookup"].includes(f.args?.member)) {
        calls.set(f.id, { member: f.args.member, args: f.args.input });
        if (f.args.member === "send") sends.push(f.args.input);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const f = JSON.parse(String(payload)),
        call = calls.get(f.id);
      if (call && f.t === "result")
        (call.member === "send" ? results : lookups).push({
          request: call.args,
          result: f.value?.value,
        });
    });
  });
  return { sends, results, lookups };
}
const records = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.includes("/outgoing/"))
      .map((k) => JSON.parse(localStorage.getItem(k)!)),
  );
test("explicit retries preserve a newer draft across repeated rejections", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "rejected" },
  });
  const native = async () =>
    (await (await request.get(origin + "/fixture/info")).json()).inputs;
  const wire = observe(page),
    text = "Shared rejected original",
    draft = "Newer page draft";
  await open(page);
  await input(page).fill(text);
  await input(page).press("Enter");
  await expect(retry(page, text)).toBeVisible();
  await input(page).fill(draft);
  await input(page).evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(2, 7);
  });
  await retry(page, text).click();
  await expect.poll(async () => (await native()).length).toBe(2);
  await expect(retry(page, text)).toHaveCount(1);
  expect(wire.sends[1].operationId).not.toBe(wire.sends[0].operationId);
  await expect(input(page)).toHaveValue(draft);
  expect(
    await input(page).evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 7]);
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "accepted" },
  });
  await retry(page, text).last().click();
  await expect.poll(async () => (await native()).length).toBe(3);
  await expect(bubble(page, text)).toHaveCount(1);
  await expect(retry(page, text)).toHaveCount(0);
  expect(new Set(wire.sends.map((s) => s.operationId)).size).toBe(3);
  await expect(input(page)).toHaveValue(draft);
  await page.reload();
  await expect(bubble(page, text)).toHaveCount(1);
  await expect(input(page)).toHaveValue(draft);
  expect(await native()).toHaveLength(3);
});

test("failed attachment journal keeps the editable draft and sends no native input", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  const wire = observe(page);
  await open(page);
  const buffer = await sharp({
    create: { width: 32, height: 32, channels: 4, background: "#3377aa" },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel("Choose message attachments")
    .setInputFiles({ name: "owned.png", mimeType: "image/png", buffer });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input(page).fill("Never discard this");
  await page.evaluate(() => {
    const store = Storage.prototype.setItem;
    Object.assign(window, {
      restoreJournal: () => {
        Storage.prototype.setItem = store;
      },
    });
    Storage.prototype.setItem = function (key, value) {
      if (key.includes("/outgoing/"))
        throw new DOMException("Synthetic storage full", "QuotaExceededError");
      store.call(this, key, value);
    };
  });
  await input(page).press("Enter");
  await expect(page.locator(".composer [role=alert]")).toContainText(
    "Synthetic storage full",
  );
  await expect(input(page)).toHaveValue("Never discard this");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  expect(wire.sends).toEqual([]);
  expect(await records(page)).toEqual([]);
  await page.evaluate(() => (window as any).restoreJournal());
  await input(page).press("Enter");
  await expect(page.locator(".message-image")).toHaveCount(1);
  expect(wire.sends).toHaveLength(1);
  expect(wire.sends[0].images).toHaveLength(1);
});
