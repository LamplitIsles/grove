import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const photo = fileURLToPath(
  new URL("../server/fixtures/attachment-orientation-6.heic", import.meta.url),
);
const file = {
  name: "site-survey-and-notes-for-review.txt",
  buffer: Buffer.from("Reference dimensions: 24 cm.\n"),
  mimeType: "text/plain",
};
const picker = (page: Page) => page.getByLabel("Choose message attachments");
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const send = (page: Page) =>
  page.getByRole("button", { name: "Send message", exact: true });
const screenshots = ".scratch/message-attachments";
async function openConversation(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto("/");
  if (width === 390) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.locator(".session-open").first().click();
  }
  await expect(
    page.getByRole("button", { name: "Add attachments" }),
  ).toBeEnabled();
}
async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function createLargeFile(path: string) {
  const handle = await open(path, "w");
  try {
    await handle.truncate(100_000_000);
    await handle.write("finish", 99_999_994, "utf8");
  } finally {
    await handle.close();
  }
}

for (const width of [1440, 390]) {
  test(`HEIC and plain file share the picker, send, and open at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await request.post("/fixture/reset", { data: { mode: "long" } });
    await openConversation(page, width);
    await picker(page).setInputFiles(photo);
    await expect(page.locator(".composer .attachment-card")).toContainText(
      "attachment-orientation-6.heic",
    );
    await picker(page).setInputFiles(file);
    await expect(page.locator(".composer .attachment-card")).toHaveCount(2);
    await composer(page).fill("Review the photo and the measurements.");
    await page.screenshot({ path: `${screenshots}/${width}-composer.png` });
    await send(page).click();
    await expect(page.locator(".composer .attachment-card")).toHaveCount(0);
    const message = page
      .locator(".user-message")
      .filter({ hasText: "Review the photo and the measurements." });
    const image = message.getByRole("button", {
      name: /Open image.*orientation/,
    });
    const link = message.getByRole("link", { name: `Download ${file.name}` });
    await expect(image).toBeVisible();
    await expect(link).toBeVisible();
    await page.screenshot({ path: `${screenshots}/${width}-message.png` });
    await image.click();
    const full = page.locator(".full-image");
    await expect(full).toBeVisible();
    await expect
      .poll(() =>
        full.evaluate((img: HTMLImageElement) => [
          img.naturalWidth,
          img.naturalHeight,
        ]),
      )
      .toEqual([1200, 800]);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe(file.name);
    expect(await digest(await download.path())).toBe(
      createHash("sha256").update(file.buffer).digest("hex"),
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await testInfo.attach("sent message", {
      path: `${screenshots}/${width}-message.png`,
    });
  });
}

test("100 MB file-only send uploads and downloads native bytes", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(70_000);
  await request.post("/fixture/reset", { data: { mode: "long" } });
  await openConversation(page, 1440);
  const path = testInfo.outputPath("size-limit.bin");
  await testInfo.attach("size checked", {
    body: "100,000,000 bytes",
    contentType: "text/plain",
  });
  await createLargeFile(path);
  try {
    await picker(page).setInputFiles(path);
    await expect(page.locator(".composer .attachment-card")).toContainText(
      "100 MB",
    );
    const [put] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "PUT" &&
          /\/api\/attachments\/0\?/.test(r.url()),
      ),
      send(page).click(),
    ]);
    expect(put.ok()).toBe(true);
    const link = page.getByRole("link", { name: "Download size-limit.bin" });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    expect(await download.failure()).toBeNull();
    expect(await digest(await download.path())).toBe(await digest(path));
  } finally {
    await unlink(path);
  }
});

test("two cancelled 200 MB preparations leave room for the same draft to send", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(70_000);
  await request.post("/fixture/reset", { data: { mode: "long" } });
  await openConversation(page, 1440);
  const paths = ["first.bin", "second.bin"].map((name) =>
    testInfo.outputPath(name),
  );
  const created: string[] = [];
  try {
    for (const path of paths) {
      await createLargeFile(path);
      created.push(path);
    }
    await picker(page).setInputFiles(paths);
    await expect(page.locator(".composer .attachment-card")).toHaveCount(2);
    await composer(page).fill("  Keep these two originals.\n ");
    const cancelledIds = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const began = Promise.withResolvers<string>();
      const release = Promise.withResolvers<void>();
      await page.route(
        "**/api/attachments?*",
        async (route) => {
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          began.resolve(
            new URL(route.request().url()).searchParams.get("operation")!,
          );
          await release.promise;
          await route.fulfill({ response }).catch(() => {});
        },
        { times: 1 },
      );
      try {
        await send(page).click();
        const operation = await began.promise;
        const [discard] = await Promise.all([
          page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              response.request().method() === "DELETE" &&
              url.pathname === "/api/attachments" &&
              url.searchParams.get("operation") === operation
            );
          }),
          page.getByRole("button", { name: "Cancel upload" }).click(),
        ]);
        expect(discard.ok()).toBe(true);
        cancelledIds.add(operation);
      } finally {
        release.resolve();
      }
      await expect(composer(page)).toHaveValue(
        "  Keep these two originals.\n ",
      );
      await expect(page.locator(".composer .attachment-card")).toHaveCount(2);
      await expect(send(page)).toBeEnabled();
    }
    expect(cancelledIds.size).toBe(2);
    await send(page).click();
    await expect(
      page.getByRole("link", { name: "Download first.bin" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download second.bin" }),
    ).toBeVisible();
  } finally {
    await Promise.all(created.map((path) => unlink(path)));
  }
});

test("cancel and failed transfer leave the same draft editable", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "long" } });
  await openConversation(page, 1440);
  await picker(page).setInputFiles(file);
  await composer(page).fill("Keep this draft");
  const hold = Promise.withResolvers<void>();
  await page.route("**/api/attachments/0?*", async (route) => {
    await hold.promise;
    await route.abort().catch(() => {});
  });
  await send(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: /Uploading 1 of 1/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel upload" }).click();
  hold.resolve();
  await expect(composer(page)).toHaveValue("Keep this draft");
  await expect(page.locator(".composer .attachment-card")).toHaveCount(1);
  await expect(send(page)).toBeEnabled();
  const [discard] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === "/api/attachments",
    ),
    send(page).click(),
  ]);
  expect(discard.ok()).toBe(true);
  await expect(page.locator(".composer [role=alert]")).toBeVisible();
  await expect(page.locator(".composer .attachment-card")).toHaveCount(1);
  expect(
    (await (await request.get("/fixture/info")).json()).inputs.some(
      (input: { text: string }) => input.text.includes("Keep this draft"),
    ),
  ).toBe(false);
  await page.unroute("**/api/attachments/0?*");
  await send(page).click();
  await expect(
    page.getByRole("link", { name: `Download ${file.name}` }),
  ).toBeVisible();
});

test("unsent attachment survives switching conversations and refresh restores text only", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "long" } });
  await openConversation(page, 1440);
  const current = page.getByRole("button", {
    name: "Open Reader performance Orc",
  });
  await expect(current).toBeVisible();
  await picker(page).setInputFiles(file);
  await composer(page).fill("Text draft follows this conversation");
  await expect(page.locator(".composer .attachment-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await current.click();
  await expect(page.locator(".composer .attachment-card")).toHaveCount(1);
  await page.reload();
  await expect(composer(page)).toHaveValue(
    "Text draft follows this conversation",
  );
  await expect(page.locator(".composer .attachment-card")).toHaveCount(0);
});

for (const caption of ["", "  Review the file.\n\t"]) {
  test(
    caption
      ? "follow-up preserves its exact caption"
      : "file-only follow-up queues without losing its attachment",
    async ({ page, request }) => {
      await request.post("/fixture/reset", { data: { mode: "working" } });
      await openConversation(page, 1440);
      await page
        .getByRole("button", { name: "Open Streaming voice input Orc" })
        .click();
      await picker(page).setInputFiles(file);
      if (caption) await composer(page).fill(caption);
      const button = page.getByRole("button", { name: "Queue for next turn" });
      await expect(button).toBeEnabled();
      await button.click();
      await expect(
        page.getByRole("region", { name: "Queued messages" }),
      ).toContainText(caption ? caption.trim() : "File attachment");
      await expect(
        page.getByRole("region", { name: "Queued messages" }),
      ).toContainText("1 file");
      await expect(page.locator(".composer .attachment-card")).toHaveCount(0);
      await expect
        .poll(async () => {
          const { hub } = await (await request.get("/fixture/info")).json();
          const detail = await (
            await request.get(
              `/fixture/agents/${encodeURIComponent(hub + ":orc")}`,
            )
          ).json();
          return detail.followUps.find((item: { files?: { name: string }[] }) =>
            item.files?.some((attachment) => attachment.name === file.name),
          );
        })
        .toMatchObject({ status: "waiting", text: caption });
    },
  );
}

test("Retry reuses the rejected file references after reload", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "no-workers" } });
  await request.post("/fixture/change", { data: { sendMode: "rejected" } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        async writeText(text: string) {
          Object.assign(window, { copiedAttachmentText: text });
        },
      },
    });
  });
  const caption = "  Review the attached original\n\t";
  const submissions: { files: unknown; operationId: string; text: string }[] =
    [];
  let uploads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/api/attachments/")
    )
      uploads++;
  });
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.args?.member === "send") submissions.push(frame.args.input);
    }),
  );
  await openConversation(page, 1440);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await picker(page).setInputFiles(file);
  await composer(page).fill(caption);
  await send(page).click();
  const message = page
    .locator(".user-message")
    .filter({ hasText: "Review the attached original" });
  const retry = message.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await composer(page).fill("Keep my new draft");
  await page.reload();
  await expect(retry).toBeVisible();
  await request.post("/fixture/change", { data: { sendMode: "accepted" } });
  await retry.click();
  await expect(
    message.getByRole("link", { name: `Download ${file.name}` }),
  ).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1].operationId).not.toBe(submissions[0].operationId);
  expect(submissions[1].files).toEqual(submissions[0].files);
  expect(submissions.map((submission) => submission.text)).toEqual([
    caption,
    caption,
  ]);
  expect(uploads).toBe(1);
  await expect(composer(page)).toHaveValue("Keep my new draft");
  await page.reload();
  await message.hover();
  await message.getByRole("button", { name: "Copy message" }).click();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { copiedAttachmentText?: string })
          .copiedAttachmentText,
    ),
  ).toBe(caption);
});
