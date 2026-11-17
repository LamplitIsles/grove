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
    page.getByRole("button", { name: "Add images", exact: true }),
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
async function media(page: Page) {
  return page.evaluate(async () => {
    const name = (await indexedDB.databases()).find((d) =>
      d.name?.endsWith("/images"),
    )!.name!;
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
    });
    const rows = await new Promise<any[]>((resolve) => {
      const r = db.transaction("drafts").objectStore("drafts").getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return Promise.all(
      rows.map(async (row) => ({
        key: row.key,
        text: row.text,
        images: await Promise.all(
          row.images.map(async (i: any) => ({
            id: i.id,
            name: i.file.name,
            bytes: i.file.size,
            hash: Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  await i.file.arrayBuffer(),
                ),
              ),
            )
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          })),
        ),
      })),
    );
  });
}

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
  await expect(retry(page, text)).toHaveCount(2);
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

test("failed image upload remains pending until the host rejects the reservation", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  const wire = observe(page);
  await open(page);
  await page.getByLabel("Choose message images").setInputFiles({
    name: "owned.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#3377aa" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await page.route("**/api/images?*", (route) => route.abort());
  const caption = "Upload interrupted";
  await input(page).fill(caption);
  await input(page).press("Enter");
  await expect.poll(async () => (await records(page))[0]?.error).toBeTruthy();
  const [entry] = await records(page);
  expect(entry.status).toBe("sending");
  await expect(retry(page, caption)).toHaveCount(0);
  expect(wire.sends).toHaveLength(0);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toHaveLength(0);
  await page.unroute("**/api/images?*");
  await page.evaluate((id) => {
    const key = Object.keys(localStorage).find(
      (k) =>
        k.includes("/outgoing/") &&
        JSON.parse(localStorage.getItem(k)!).id === id,
    )!;
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.at = Date.now() - 61_000;
    localStorage.setItem(key, JSON.stringify(stored));
  }, entry.id);
  await page.reload();
  await expect(retry(page, caption)).toBeVisible({ timeout: 20_000 });
  expect((await records(page)).find((o) => o.id === entry.id).status).toBe(
    "failed",
  );
  expect(wire.sends).toHaveLength(0);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toHaveLength(0);
});

test("draft cleanup abort stays pending until the host rejects the original image submission", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  const native = async () =>
    (await (await request.get(origin + "/fixture/info")).json()).inputs;
  const wire = observe(page),
    caption = "Original image caption",
    draft = "Newer image draft";
  await open(page);
  const file = {
    name: "owned.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#3377aa" },
    })
      .png()
      .toBuffer(),
  };
  await page.getByLabel("Choose message images").setInputFiles(file);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input(page).fill(caption);
  const originalMedia = (await media(page))[0].images;
  await page.evaluate((caption) => {
    const remove = IDBObjectStore.prototype.delete;
    let armed = true;
    IDBObjectStore.prototype.delete = function (key) {
      const r = remove.call(this, key);
      const journal = Object.keys(localStorage)
        .filter((k) => k.includes("/outgoing/"))
        .map((k) => JSON.parse(localStorage.getItem(k)!));
      if (
        armed &&
        String(key).startsWith("draft/") &&
        journal.some((o) => o.text === caption && o.status === "sending")
      ) {
        armed = false;
        (window as any).cleanupJournal = journal;
        this.transaction.abort();
      }
      return r;
    };
  }, caption);
  await input(page).press("Enter");
  await expect(page.locator(".composer-wrap [role=alert]")).toContainText(
    "Image storage full or unavailable",
  );
  const atAbort = await page.evaluate(() => (window as any).cleanupJournal);
  expect(atAbort).toHaveLength(1);
  const A = atAbort[0].id;
  expect(await native()).toHaveLength(0);
  expect(wire.sends).toHaveLength(0);
  expect(
    (await media(page)).find((r) => r.key.endsWith("/" + A)),
  ).toMatchObject({ text: caption, images: originalMedia });
  await expect(bubble(page, caption).locator("small.failed")).toHaveCount(0);
  await expect(retry(page, caption)).toHaveCount(0);
  await expect(page.locator(".detail-status")).not.toContainText("Working");
  expect((await records(page)).find((o) => o.id === A)).toMatchObject({
    status: "sending",
  });
  await expect(input(page)).toHaveValue(caption);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input(page).fill(draft);
  await page.evaluate((id) => {
    const key = Object.keys(localStorage).find((k) => {
      if (!k.includes("/outgoing/")) return false;
      return JSON.parse(localStorage.getItem(k)!).id === id;
    })!;
    const entry = JSON.parse(localStorage.getItem(key)!);
    entry.at = Date.now() - 61_000;
    localStorage.setItem(key, JSON.stringify(entry));
  }, A);
  await page.reload();
  await expect(retry(page, caption)).toBeVisible({ timeout: 20_000 });
  expect((await records(page)).find((o) => o.id === A)).toMatchObject({
    status: "failed",
  });
  await expect(input(page)).toHaveValue(draft);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  expect(await native()).toHaveLength(0);
  expect(
    (await media(page)).find((r) => r.key.endsWith("/" + A)),
  ).toMatchObject({ text: caption, images: originalMedia });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "held" },
  });
  await input(page).evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(2, 6);
  });
  await retry(page, caption).evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect.poll(async () => (await native()).length).toBe(1);
  expect(wire.sends).toHaveLength(1);
  expect(wire.sends[0]).toMatchObject({ text: caption });
  expect(wire.sends[0].operationId).not.toBe(A);
  expect(wire.sends[0].images).toHaveLength(1);
  const duringRetry = await media(page);
  expect(duringRetry.find((r) => r.key.endsWith("/" + A))).toMatchObject({
    text: caption,
    images: originalMedia,
  });
  expect(duringRetry.find((r) => r.key.startsWith("draft/"))!.images).toEqual(
    originalMedia,
  );
  await expect(input(page)).toHaveValue(draft);
  expect(
    await input(page).evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 6]);
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "accepted" },
  });
  await expect.poll(() => wire.results.length).toBe(1);
  await expect(bubble(page, caption)).toHaveCount(1);
  await expect(retry(page, caption)).toHaveCount(0);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(input(page)).toHaveValue(draft);
  const finalNative = await native();
  expect(finalNative).toHaveLength(1);
  expect(finalNative[0]).toMatchObject({
    text: caption,
    images: expect.arrayContaining([expect.any(String)]),
  });
  await page.reload();
  await expect(bubble(page, caption)).toHaveCount(1);
  await expect(input(page)).toHaveValue(draft);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  expect(await native()).toHaveLength(1);
  console.log(
    JSON.stringify({
      case: "draft cleanup repaired",
      A,
      nativeCounts: [0, 0, 1, 1],
      originalMedia,
    }),
  );
});
