import { expect, test } from "@playwright/test";
import { join } from "node:path";
import sharp from "sharp";
import type { Page } from "@playwright/test";
import { openSidebar } from "./browser-actions";

for (const width of [1440, 390]) {
  test(`stopped queue remains active until continued at ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await request.post("/fixture/reset", { data: { mode: "working" } });
    // The fixture's activity is outside the selected window, so the queue itself
    // must keep this session in Recent after its native turn stops.
    await page.clock.setFixedTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    await openSidebar(page);
    const recent = page.getByRole("region", { name: "Recent activity" });
    const row = recent.getByRole("button", {
      name: "Open Streaming voice input Orc",
    });
    await row.click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("Continue after stopping");
    await input.press("Tab");
    const queue = page.getByRole("region", { name: "Queued messages" });
    await expect(queue).toContainText("Continue after stopping");
    await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
    await request.post("/fixture/change", {
      data: { complete: "interrupted" },
    });
    await expect(queue).toContainText("Queued · paused");
    await expect(page.locator(".detail-status")).toContainText("Queue paused");
    await openSidebar(page);
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("img", { name: "Queue paused" })).toBeVisible();
    if (width === 390) {
      await row.click();
      await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);
    }
    await page.screenshot({
      path: testInfo.outputPath(`paused-queue-${width}.png`),
    });
    const before = await (await request.get("/fixture/info")).json();
    expect(
      before.inputs.some(
        (item: { text: string }) => item.text === "Continue after stopping",
      ),
    ).toBe(false);
    await queue.getByRole("button", { name: "Continue" }).click();
    await expect
      .poll(async () =>
        (await (await request.get("/fixture/info")).json()).inputs.some(
          (item: { text: string }) => item.text === "Continue after stopping",
        ),
      )
      .toBe(true);
    await expect(queue).toHaveCount(0);
  });
}

async function holdQueueResponse(page: Page) {
  const control = (action: string) =>
    page.request.post("/fixture/queue-gates", { data: { action } });
  const info = async () => (await page.request.get("/fixture/info")).json();
  await control("arm");
  return {
    held: async () => (await info()).queueAckWaiting,
    lookupCount: async () => (await info()).queueLookupCount,
    release: () => control("release"),
    pauseLookups: () => control("pause-lookups"),
    releaseLookups: () => control("release-lookups"),
  };
}

test("normal queue admission does not briefly ask to check the message", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  const gate = await holdQueueResponse(page);
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Normal follow-up");
  await input.press("Tab");
  await expect.poll(gate.held).toBe(true);
  await expect(
    page.getByText("Check the queued message before sending this draft."),
  ).toHaveCount(0);
  await expect(page.getByText("Queueing…", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Normal follow-up");
  await expect(
    page.getByRole("button", { name: "Check", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await gate.release();
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Normal follow-up");
  await expect(input).toHaveValue("");
});

test("fast queue admission never flashes the check warning", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  await page.evaluate(() => {
    const state = window as unknown as { queueWarningCount: number };
    state.queueWarningCount = 0;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node.textContent?.includes(
              "Check the queued message before sending this draft.",
            )
          )
            state.queueWarningCount++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Fast follow-up");
  await input.press("Tab");
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Fast follow-up");
  await expect(input).toHaveValue("");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { queueWarningCount: number }).queueWarningCount,
    ),
  ).toBe(0);
});

test("a rejected queue request clears its pending state after switching back", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await request.post("/fixture/queue-rejection", { data: { action: "arm" } });
  await page.goto("/");
  const session = (title: string) =>
    page.locator(".session-open").filter({ hasText: title }).first();
  await session("Streaming voice input").click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await page.getByLabel("Choose message images").setInputFiles({
    name: "draft.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#6488a5" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input.fill("Retain rejected draft");
  await input.press("Tab");
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/info")).json())
          .queueRejectionWaiting,
    )
    .toBe(true);
  await session("Reader performance").click();
  await session("Streaming voice input").click();
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Retain rejected draft");
  await request.post("/fixture/queue-rejection", {
    data: { action: "release" },
  });
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Failed");
  await expect(
    page
      .getByRole("region", { name: "Queued messages" })
      .getByText("Queue rejected"),
  ).toBeVisible();
  await expect(input).toHaveValue("Retain rejected draft");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(input).toHaveValue("Retain rejected draft");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  const failed = page.getByRole("region", { name: "Queued messages" });
  await expect(failed).toContainText("Failed");
  await failed.getByRole("button", { name: "Remove failed message" }).click();
  await expect(failed).toHaveCount(0);
});

test("switching sessions before queue acknowledgement preserves original identity", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  const gate = await holdQueueResponse(page);
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await expect(
    page.getByRole("button", { name: "Add images", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Choose message images").setInputFiles({
    name: "draft.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#6488a5" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input.fill("Queued before switching");
  await input.press("Tab");
  await expect.poll(gate.held).toBe(true);
  await page
    .locator(".session-open")
    .filter({ hasText: "Reader performance" })
    .first()
    .click();
  await gate.release();
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(input).toHaveValue("");
  await expect(page.locator(".image-draft")).toHaveCount(0);
  await expect(queue).toContainText("Queued before switching");
});

test("a delayed queue acknowledgement is reconciled without another enqueue", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  const gate = await holdQueueResponse(page);
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Delivery to check");
  await input.press("Tab");
  await expect.poll(gate.held).toBe(true);
  await request.post("/fixture/change", { data: { outage: true } });
  await request.post("/fixture/change", { data: { outage: false } });
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).not.toContainText("reconnect to update");
  await expect(
    queue.locator(".follow-up-item").filter({ hasText: "Delivery to check" }),
  ).toHaveCount(1);
  await expect.poll(gate.lookupCount, { timeout: 15000 }).toBeGreaterThan(0);
  await expect(input).toHaveValue("", { timeout: 15000 });
  const info = await (await request.get("/fixture/info")).json();
  const detail = await (
    await request.get(
      `/fixture/agents/${encodeURIComponent(`${info.hub}:orc`)}`,
    )
  ).json();
  expect(
    detail.followUps.filter(
      (item: { text: string }) => item.text === "Delivery to check",
    ),
  ).toHaveLength(1);
});

test("image follow-up is recovered after switching sessions", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  const gate = await holdQueueResponse(page);
  await page.goto("/");
  const session = (name: string) =>
    page.locator(".session-open").filter({ hasText: name }).first();
  await session("Streaming voice input").click();
  await page.getByLabel("Choose message images").setInputFiles({
    name: "draft.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#6488a5" },
    })
      .png()
      .toBuffer(),
  });
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Pending with attachment");
  await input.press("Tab");
  await expect.poll(gate.held).toBe(true);
  await session("Reader performance").click();
  await gate.release();
  await session("Streaming voice input").click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(
    queue
      .locator(".follow-up-item")
      .filter({ hasText: "Pending with attachment" }),
  ).toHaveCount(1);
  await expect(queue).toContainText("1 image");
  await expect(input).toHaveValue("");
  await expect(page.locator(".image-draft")).toHaveCount(0);
});

for (const interruption of ["edit", "switch", "reload"] as const) {
  test(`image draft survives ${interruption} while queue cleanup is pending`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", { data: { mode: "working" } });
    const gate = await holdQueueResponse(page);
    await gate.pauseLookups();
    await page.goto("/");
    const session = (name: string) =>
      page.locator(".session-open").filter({ hasText: name }).first();
    await session("Streaming voice input").click();
    await expect(
      page.getByRole("button", { name: "Add images" }),
    ).toBeEnabled();
    await page.getByLabel("Choose message images").setInputFiles({
      name: "draft.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: { width: 10, height: 10, channels: 3, background: "#6488a5" },
      })
        .png()
        .toBuffer(),
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("Pending with attachment");
    await input.press("Tab");
    await expect.poll(gate.held).toBe(true);
    await session("Reader performance").click();
    await gate.release();
    await session("Streaming voice input").click();
    await expect(
      page.getByRole("region", { name: "Queued messages" }),
    ).toContainText("Pending with attachment");
    await page.evaluate(() => {
      const state = window as typeof window & {
        holdCompletion?: boolean;
        heldCompletion?: () => void;
      };
      const descriptor = Object.getOwnPropertyDescriptor(
        IDBTransaction.prototype,
        "oncomplete",
      )!;
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
        configurable: true,
        get: descriptor.get,
        set(this: IDBTransaction, callback: (event: Event) => void) {
          descriptor.set!.call(this, (event: Event) => {
            if (state.holdCompletion) {
              state.holdCompletion = false;
              state.heldCompletion = () => callback.call(this, event);
            } else callback.call(this, event);
          });
        },
      });
      state.holdCompletion = true;
    });
    await gate.releaseLookups();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            !!(window as typeof window & { heldCompletion?: () => void })
              .heldCompletion,
        ),
      )
      .toBe(true);
    if (interruption === "reload") {
      await gate.pauseLookups();
      await page.reload();
      await expect(page.locator(".image-draft")).toHaveCount(1);
      await expect(input).toHaveValue("Pending with attachment");
      await expect(
        page.getByRole("region", { name: "Queued messages" }),
      ).toContainText("Pending with attachment");
      await page.getByRole("button", { name: "Remove image 1" }).click();
      await expect(page.locator(".image-draft")).toHaveCount(0);
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Add images" }),
      ).toBeEnabled();
      await expect(page.locator(".image-draft")).toHaveCount(0);
      await expect(input).toHaveValue("Pending with attachment");
      await expect(
        page.getByRole("region", { name: "Queued messages" }),
      ).toContainText("Pending with attachment");
      return;
    }
    if (interruption === "edit") await input.fill("Edited with attachment");
    else await session("Reader performance").click();
    await page.evaluate(() =>
      (
        window as typeof window & { heldCompletion: () => void }
      ).heldCompletion(),
    );
    const info = await (await request.get("/fixture/info")).json();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const opened = indexedDB.open(
            `flickgrove/${location.origin}/images`,
            1,
          );
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            opened.onsuccess = () => resolve(opened.result);
            opened.onerror = () => reject(opened.error);
          });
          const request = db
            .transaction("drafts")
            .objectStore("drafts")
            .getAll();
          const records = await new Promise<
            { key: string; images: unknown[] }[]
          >((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return records
            .filter((record) => record.key.startsWith("draft/"))
            .map((record) => [record.key, record.images.length]);
        }),
      )
      .toEqual([[`draft/${info.hub}:orc`, 1]]);
    if (interruption === "switch")
      await session("Streaming voice input").click();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await page.reload();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await expect(input).toHaveValue(
      interruption === "edit"
        ? "Edited with attachment"
        : "Pending with attachment",
    );
    if (interruption === "switch")
      await expect(
        page.getByRole("region", { name: "Queued messages" }),
      ).toContainText("Pending with attachment");
  });
}

for (const width of [1440, 390]) {
  test(`queue waits for the current turn and can be cancelled at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", { data: { mode: "working" } });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .locator(".session-open")
      .filter({ hasText: "Streaming voice input" })
      .first()
      .click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await expect(
      page.getByRole("button", { name: "Queue for next turn" }),
    ).toBeVisible();
    await input.fill("First follow-up");
    await input.press("Tab");
    const queue = page.getByRole("region", { name: "Queued messages" });
    await expect(queue).toContainText("First follow-up");
    const first = queue
      .locator(".follow-up-item")
      .filter({ hasText: "First follow-up" });
    await expect(first).not.toContainText("Waiting");
    await expect(
      first.getByRole("button", { name: "Remove queued message" }),
    ).toBeVisible();
    const textBox = await first.locator(".follow-up-text").boundingBox();
    const removeBox = await first
      .getByRole("button", { name: "Remove queued message" })
      .boundingBox();
    expect(
      textBox && removeBox && textBox.x + textBox.width <= removeBox.x,
    ).toBeTruthy();
    await expect(input).toHaveValue("");
    if (process.env.GROVE_TEST_SCREENSHOTS)
      await page.screenshot({
        path: join(
          process.env.GROVE_TEST_SCREENSHOTS,
          `follow-up-${width}.png`,
        ),
      });
    await request.post("/fixture/change", { data: { outage: true } });
    await expect(queue).toContainText("reconnect to update");
    await expect(
      queue.getByRole("button", { name: "Remove queued message" }),
    ).toBeDisabled();
    await request.post("/fixture/change", { data: { outage: false } });
    await expect(queue).not.toContainText("reconnect to update");
    const longText = "A long queued message ".repeat(12) + "end";
    await input.fill(longText);
    await page.getByRole("button", { name: "Queue for next turn" }).click();
    await expect(queue).toContainText(longText);
    const longItem = queue
      .locator(".follow-up-item")
      .filter({ hasText: longText });
    const longRemove = longItem.getByRole("button", {
      name: "Remove queued message",
    });
    await expect(longRemove).toBeVisible();
    const longBox = await longItem.locator(".follow-up-text").boundingBox();
    const longRemoveBox = await longRemove.boundingBox();
    expect(
      longBox && longRemoveBox && longBox.x + longBox.width <= longRemoveBox.x,
    ).toBeTruthy();
    expect(longBox && longBox.height > 20).toBeTruthy();
    await longItem.screenshot({
      path: test.info().outputPath(`long-queue-${width}.png`),
    });
    await longRemove.click();
    await expect(queue).not.toContainText(longText);
    const before = await (await request.get("/fixture/info")).json();
    expect(
      before.inputs.some(
        (item: { text: string }) => item.text === "First follow-up",
      ),
    ).toBe(false);
    await request.post("/fixture/change", { data: { complete: "completed" } });
    await expect
      .poll(async () =>
        (await (await request.get("/fixture/info")).json()).inputs.some(
          (item: { text: string }) => item.text === "First follow-up",
        ),
      )
      .toBe(true);
    await expect(queue).toHaveCount(0);
  });
}

test("an unconfirmed queue request can be checked after reload without sending again", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Check original operation");
  await input.press("Tab");
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Check original operation");
  await expect(input).toHaveValue("");
  const info = await (await request.get("/fixture/info")).json();
  const agent = `${info.hub}:orc`;
  const detail = await (
    await request.get(`/fixture/agents/${encodeURIComponent(agent)}`)
  ).json();
  const operation = detail.followUps.find(
    (item: { text: string }) => item.text === "Check original operation",
  ).id;
  await page.evaluate(
    ({ agent, operation }) => {
      const prefix = `flickgrove/${location.origin}`;
      localStorage.setItem(
        `${prefix}/follow-up/${encodeURIComponent(agent)}/${encodeURIComponent(operation)}`,
        JSON.stringify({
          id: operation,
          text: "Check original operation",
          imageIds: [],
        }),
      );
      localStorage.setItem(
        `${prefix}/composer/${agent}`,
        "Check original operation",
      );
    },
    { agent, operation },
  );
  await page.reload();
  await expect(input).toHaveValue("");
  const after = await (
    await request.get(`/fixture/agents/${encodeURIComponent(agent)}`)
  ).json();
  expect(
    after.followUps.filter((item: { id: string }) => item.id === operation),
  ).toHaveLength(1);
});

test("queue preserves an image attachment and its text", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Add images", exact: true }),
  ).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#6488a5" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Image follow-up");
  await input.press("Tab");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toContainText("Image follow-up");
  await expect(queue).toContainText("1 image");
  await expect(page.locator(".image-draft")).toHaveCount(0);
  const info = await (await request.get("/fixture/info")).json();
  const detail = await (
    await request.get(
      `/fixture/agents/${encodeURIComponent(`${info.hub}:orc`)}`,
    )
  ).json();
  expect(
    detail.followUps.find(
      (item: { text: string }) => item.text === "Image follow-up",
    ).images,
  ).toHaveLength(1);
});

test("Tab while composing does not queue a partial message", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("中文草稿");
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.dispatchEvent("keydown", {
    key: "Tab",
    code: "Tab",
    isComposing: true,
    keyCode: 229,
  });
  await expect(input).toHaveValue("中文草稿");
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toHaveCount(0);
  await input.dispatchEvent("compositionend", { data: "中文草稿" });
  await input.press("Tab");
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("中文草稿");
});

test("text follow-up still works when image storage is unavailable", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      value: {
        open() {
          throw new Error("blocked");
        },
      },
    });
  });
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Text without image storage");
  await input.press("Tab");
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Text without image storage");
  await expect(input).toHaveValue("");
});

test("automatic inspection waits for completion before resuming the queue", async ({
  page,
  request,
}) => {
  test.setTimeout(45000);
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Uncertain follow-up");
  await input.press("Tab");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toContainText("Uncertain follow-up");
  await input.fill("Next follow-up");
  await input.press("Tab");
  await expect(queue).toContainText("Next follow-up");
  await request.post("/fixture/change", {
    data: { sendMode: "uncertain", complete: "completed" },
  });
  await expect(queue).toContainText("Sending…");
  await expect(page.locator(".detail-heading .detail-status")).toContainText(
    "Queue paused",
  );
  await expect(queue).not.toContainText("Synthetic native outcome unknown");
  await expect(queue.getByRole("button", { name: "Continue" })).toBeDisabled();
  await request.post("/fixture/change", {
    data: {
      inspection: { accepted: true, settled: false, turnId: "recovered-turn" },
    },
  });
  await expect(queue).toContainText("Processing…", { timeout: 15000 });
  await expect(page.locator(".detail-heading .detail-status")).toContainText(
    "Queue paused",
  );
  await expect(queue.getByRole("button", { name: "Continue" })).toBeDisabled();
  await request.post("/fixture/change", {
    data: {
      inspection: {
        accepted: true,
        settled: true,
        completed: true,
        turnId: "recovered-turn",
      },
      sendMode: "accepted",
    },
  });
  await expect
    .poll(async () => {
      const info = await (await request.get("/fixture/info")).json();
      return info.inputs.filter(
        (item: { text: string }) => item.text === "Next follow-up",
      ).length;
    })
    .toBe(1);
  const info = await (await request.get("/fixture/info")).json();
  expect(
    info.inputs.filter(
      (item: { text: string }) => item.text === "Uncertain follow-up",
    ),
  ).toHaveLength(1);
});

test("a settled follow-up that needs Continue keeps a neutral paused heading", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Unconfirmed original");
  await input.press("Tab");
  await input.fill("Waiting next");
  await input.press("Tab");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toContainText("Waiting next");
  await request.post("/fixture/change", {
    data: { sendMode: "uncertain", complete: "completed" },
  });
  await expect(queue).toContainText("Sending…");
  await request.post("/fixture/change", {
    data: {
      inspection: {
        accepted: true,
        settled: true,
        completed: false,
        turnId: "recovered-turn",
      },
    },
  });
  await expect(queue).not.toContainText("Unconfirmed original", {
    timeout: 15000,
  });
  await expect(queue).toContainText("Waiting next");
  await expect(page.locator(".detail-heading .detail-status")).toContainText(
    "Queue paused",
  );
  await expect(queue.getByRole("button", { name: "Continue" })).toBeEnabled();
});

test("a separate execution error remains visible while a queued message is unconfirmed", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: { mode: "working" } });
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Message Orc", exact: true })
    .fill("Unconfirmed message");
  await page
    .getByRole("textbox", { name: "Message Orc", exact: true })
    .press("Tab");
  await request.post("/fixture/change", {
    data: { sendMode: "uncertain", complete: "completed" },
  });
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Sending…");
  await request.post("/fixture/change", {
    data: {
      execution: {
        event: {
          type: "error",
          willRetry: false,
          errorKind: "error",
          error: "Synthetic execution failure",
        },
      },
    },
  });
  await expect(
    page.locator(".detail-heading .execution-feedback"),
  ).toContainText("Execution error");
});
