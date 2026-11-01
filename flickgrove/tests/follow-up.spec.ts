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
  let callId: string | undefined;
  let held: (() => void) | undefined;
  await page.routeWebSocket("**/api/socket", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.call?.member === "enqueueFollowUp") callId = frame.id;
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "result" && frame.id === callId) {
        held = () => socket.send(message);
        return;
      }
      socket.send(message);
    });
  });
  return { held: () => !!held, release: () => held?.() };
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
  await expect(page.getByText("Queueing…", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  gate.release();
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
  let reject: (() => void) | undefined;
  await page.routeWebSocket("**/api/socket", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.call?.member === "enqueueFollowUp" && !reject) {
        reject = () =>
          socket.send(
            JSON.stringify({
              type: "error",
              id: frame.id,
              error: "Queue rejected",
            }),
          );
      } else server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });
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
  await expect.poll(() => !!reject).toBe(true);
  await session("Reader performance").click();
  await session("Streaming voice input").click();
  await expect(page.getByText("Queue status not confirmed")).toBeVisible();
  reject!();
  await expect(page.getByText("Queue status not confirmed")).toHaveCount(0);
  await expect(page.getByText("Queue rejected")).toBeVisible();
  await expect(input).toHaveValue("Retain rejected draft");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(input).toHaveValue("Retain rejected draft");
  await expect(page.locator(".image-draft")).toHaveCount(1);
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
  gate.release();
  await page
    .locator(".session-open")
    .filter({ hasText: "Streaming voice input" })
    .first()
    .click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toContainText("Queue status not confirmed");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Check the queued message before sending this draft."),
  ).toBeVisible();
  await queue.getByRole("button", { name: "Check", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".image-draft")).toHaveCount(0);
  await expect(queue).toContainText("Queued before switching");
});

test("unknown admission blocks the same draft but permits a new steer", async ({
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
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).not.toContainText("reconnect to update");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Queue status not confirmed");
  await expect(
    page.getByText("Check the queued message before sending this draft."),
  ).toBeVisible();
  await input.press("Enter");
  let info = await (await request.get("/fixture/info")).json();
  expect(
    info.inputs.filter(
      (item: { text: string }) => item.text === "Delivery to check",
    ),
  ).toHaveLength(0);
  await input.fill("Different new steer");
  await input.press("Enter");
  await expect
    .poll(async () => {
      info = await (await request.get("/fixture/info")).json();
      return info.inputs.filter(
        (item: { text: string }) => item.text === "Different new steer",
      ).length;
    })
    .toBe(1);
});

for (const interruption of ["edit", "switch", "reload"] as const) {
  test(`image draft survives ${interruption} while queue cleanup is pending`, async ({
    page,
    request,
  }) => {
    await request.post("/fixture/reset", { data: { mode: "working" } });
    const gate = await holdQueueResponse(page);
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
    gate.release();
    await session("Streaming voice input").click();
    await expect(
      page.getByRole("region", { name: "Queued messages" }),
    ).toContainText("Queue status not confirmed");
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
    await page
      .getByRole("region", { name: "Queued messages" })
      .getByRole("button", { name: "Check", exact: true })
      .click();
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
      await page.reload();
      await expect(page.locator(".image-draft")).toHaveCount(1);
      await expect(input).toHaveValue("Pending with attachment");
      await expect(
        page.getByRole("region", { name: "Queued messages" }),
      ).toContainText("Queue status not confirmed");
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
      ).toContainText("Queue status not confirmed");
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
      ).toContainText("Queue status not confirmed");
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
    await input.fill("Cancel this follow-up");
    await page.getByRole("button", { name: "Queue for next turn" }).click();
    await expect(queue).toContainText("Cancel this follow-up");
    await queue
      .locator(".follow-up-item")
      .filter({ hasText: "Cancel this follow-up" })
      .getByRole("button", { name: "Remove queued message" })
      .click();
    await expect(queue).not.toContainText("Cancel this follow-up");
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
  await expect(
    page.getByRole("button", { name: "Check", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check", exact: true }),
  ).toHaveCount(0);
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

test("inspect distinguishes receipt from completion before resuming the queue", async ({
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
  await expect(queue).toContainText("Delivery unconfirmed");
  await expect(queue.getByRole("button", { name: "Continue" })).toBeDisabled();
  await queue.getByRole("button", { name: "Check", exact: true }).click();
  await expect(queue).toContainText(
    "Could not confirm whether this message was received",
  );
  await request.post("/fixture/change", {
    data: {
      inspection: { accepted: true, settled: false, turnId: "recovered-turn" },
    },
  });
  await queue.getByRole("button", { name: "Check", exact: true }).click();
  await expect(queue).toContainText("Received · completion unconfirmed");
  await expect(queue).toContainText("its turn has not been confirmed finished");
  await expect(queue.getByRole("button", { name: "Continue" })).toBeDisabled();
  await request.post("/fixture/change", {
    data: {
      inspection: { accepted: true, settled: true, turnId: "recovered-turn" },
      sendMode: "accepted",
    },
  });
  await queue.getByRole("button", { name: "Check", exact: true }).click();
  await expect(queue).toContainText(
    "Message received and the turn has finished",
  );
  await queue.getByRole("button", { name: "Continue" }).click();
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
