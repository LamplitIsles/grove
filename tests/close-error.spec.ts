import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import sharp from "sharp";
import { newSession, openSidebar } from "./browser-actions";

let server: ChildProcess;
test.beforeAll(async () => {
  server = spawn("bun", ["tests/abandon-close-serve.ts"], {
    cwd: new URL("../", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(server.stdout!, "data");
});
test.afterAll(async () => {
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
});

const error = "New session is still working or has an unconfirmed delivery";
async function select(page: Page, id: string) {
  await page.locator(`.session-open[data-agent-id="${id}"]`).first().click();
  await expect
    .poll(() => page.evaluate(() => history.state?.grove?.details.at(-1)))
    .toBe(id);
}
async function closeFromList(page: Page, id: string) {
  if (page.viewportSize()!.width > 700) {
    await page
      .locator(`.session-open[data-agent-id="${id}"]`)
      .first()
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close this tree" }).click();
    return;
  }
  const row = page
    .locator(".session-row")
    .filter({ has: page.locator(`.session-open[data-agent-id="${id}"]`) })
    .first();
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + 250, y: box.y + 20 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: box.x + 160, y: box.y + 20 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  await row
    .getByRole("button", { name: "Close this tree", exact: true })
    .click();
}
for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`${name} close failure is shown only in the target detail`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const { target, other } = await (
      await request.post("/fixture/reset")
    ).json();
    await request.post("/fixture/change", {
      data: { ordinaryCloseError: true },
    });
    await page.goto("/");
    await openSidebar(page);
    await select(page, other);
    if (name === "mobile") await openSidebar(page);
    await closeFromList(page, target);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("close-confirmation.png"),
    });
    await page
      .getByRole("button", { name: "Close session", exact: true })
      .click();
    await expect(page.locator(".agent-detail .detail-close-error")).toHaveText(
      error,
    );
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath("close-error-detail.png"),
      animations: "disabled",
    });
    await expect
      .poll(() => page.evaluate(() => history.state?.grove?.details.at(-1)))
      .toBe(target);
    if (name === "mobile") await openSidebar(page);
    await expect(page.locator(".session-list")).not.toContainText(error);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(viewport.width);
  });
}

test("confirmation can be cancelled and known active work cannot be closed", async ({
  page,
  request,
}) => {
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await page.goto("/");
  await openSidebar(page);
  await select(page, other);
  await closeFromList(page, other);
  await expect(
    page.getByRole("heading", { name: "Close this session?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await (await request.get("/fixture/info")).json()).closeCalls).toBe(
    0,
  );
  await request.post("/fixture/change", { data: { active: true } });
  await expect
    .poll(async () =>
      page
        .locator(
          `.session-open[data-agent-id="${target}"] [aria-label="Working"]`,
        )
        .count(),
    )
    .toBeGreaterThan(0);
  await closeFromList(page, target);
  await expect(page.getByRole("dialog")).toContainText(
    "Wait for work to finish or stop it before closing.",
  );
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeDisabled();
  expect((await (await request.get("/fixture/info")).json()).closeCalls).toBe(
    0,
  );
});

test("Pi confirmation explains durable recovery", async ({ page, request }) => {
  const { target } = await (await request.post("/fixture/reset")).json();
  await request.post("/fixture/change", { data: { piTarget: true } });
  await page.goto("/");
  await openSidebar(page);
  await select(page, target);
  await page.keyboard.press("Alt+KeyX");
  await expect(page.getByRole("dialog")).toContainText(
    "Reopening this Pi session may resume unfinished Pi work.",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await (await request.get("/fixture/info")).json()).closeCalls).toBe(
    0,
  );
});

test("confirmed close retains the original unknown delivery", async ({
  page,
  request,
}) => {
  const { target } = await (await request.post("/fixture/reset")).json();
  await page.goto("/");
  await openSidebar(page);
  await select(page, target);
  await page.keyboard.press("Alt+KeyX");
  await expect(page.getByRole("dialog")).toContainText(/unconfirmed/i);
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect
    .poll(
      async () => (await (await request.get("/fixture/info")).json()).closed,
    )
    .toBe(true);
  expect(await (await request.get("/fixture/info")).json()).toMatchObject({
    closeCalls: 1,
    inputs: 1,
    original: { id: "original-unknown", status: "uncertain" },
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("close warns about a local-only unknown and preserves its image through history reopen", async ({
  page,
  request,
}) => {
  let dropped = false;
  await page.routeWebSocket("**/api/socket", (socket) => {
    const owner = socket.connectToServer();
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (!dropped && frame.args?.member === "send") {
        dropped = true;
        owner.close({ code: 1011 });
        socket.close({ code: 1011 });
      } else owner.send(data);
    });
    owner.onMessage((data) => socket.send(data));
  });
  const { other: target } = await (await request.post("/fixture/reset")).json();
  await request.post("/fixture/change", { data: { clearServerUnknown: true } });
  await page.goto("/");
  await openSidebar(page);
  await select(page, target);
  await page.getByLabel("Choose message attachments").setInputFiles({
    name: "local.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#6488a5" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Local only input");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => dropped).toBe(true);
  const journal = async () =>
    page.evaluate((id) => {
      const prefix = `flickgrove/${location.origin}/outgoing/${encodeURIComponent(id)}/`;
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => JSON.parse(localStorage.getItem(key)!));
    }, target);
  await expect.poll(async () => (await journal()).length).toBe(1);
  const before = (await journal())[0];
  expect(before.text).toBe("Local only input");
  expect(before.images).toHaveLength(1);
  expect(
    (await (await request.get("/fixture/info")).json()).deliveries,
  ).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Session settings", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await page.keyboard.press("Alt+KeyX");
  await expect(page.getByRole("dialog")).toContainText(
    "Unconfirmed work may still be running.",
  );
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect
    .poll(
      async () => (await (await request.get("/fixture/info")).json()).closed,
    )
    .toBe(true);
  expect(await journal()).toMatchObject([
    { id: before.id, text: before.text, images: before.images },
  ]);
  await page.reload();
  await newSession(page);
  await page.getByRole("option", { name: "Fixture", exact: true }).click();
  await page.getByRole("button", { name: "Find history", exact: true }).click();
  await page.getByRole("button", { name: /Local recovery target/ }).click();
  await page
    .getByRole("button", { name: "Resume session", exact: true })
    .click();
  await expect(page.locator(".agent-detail")).toContainText("Local only input");
  await expect(
    page.locator(".image-placeholder").filter({ hasText: "local.png" }),
  ).toBeVisible();
  expect((await (await request.get("/fixture/info")).json()).inputs).toBe(1);
});

for (const kind of ["answer", "follow-up"] as const) {
  test(`close warns about a local-only pending ${kind}`, async ({
    page,
    request,
  }) => {
    const { other: target } = await (
      await request.post("/fixture/reset")
    ).json();
    await request.post("/fixture/change", {
      data: { clearServerUnknown: true },
    });
    await page.goto("/");
    await page.evaluate(
      ({ target, kind }) => {
        const root = `flickgrove/${location.origin}`;
        if (kind === "answer")
          localStorage.setItem(
            `${root}/outgoing/${encodeURIComponent(target)}/pending-answer`,
            JSON.stringify({
              agentId: target,
              id: "pending-answer",
              text: "",
              at: Date.now(),
              status: "uncertain",
              answers: [{ questionId: "q", answer: "yes" }],
            }),
          );
        else
          localStorage.setItem(
            `${root}/follow-up/${encodeURIComponent(target)}/pending-queue`,
            JSON.stringify({
              id: "pending-queue",
              text: "Queued locally",
              imageIds: [],
            }),
          );
      },
      { target, kind },
    );
    await page.reload();
    await openSidebar(page);
    await select(page, target);
    expect(
      (await (await request.get("/fixture/info")).json()).deliveries,
    ).toEqual([]);
    await page.keyboard.press("Alt+KeyX");
    await expect(page.getByRole("dialog")).toContainText(
      "Unconfirmed work may still be running.",
    );
    if (kind === "follow-up")
      await expect(page.getByRole("dialog")).toContainText(
        "Queued messages will stay paused",
      );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
}

test("another open tab warns about a send lost before admission", async ({
  page,
  request,
}) => {
  let dropped = false;
  await page.routeWebSocket("**/api/socket", (socket) => {
    const owner = socket.connectToServer();
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (!dropped && frame.args?.member === "send") {
        dropped = true;
        owner.close({ code: 1011 });
        socket.close({ code: 1011 });
      } else owner.send(data);
    });
    owner.onMessage((data) => socket.send(data));
  });
  const { other: target } = await (await request.post("/fixture/reset")).json();
  await request.post("/fixture/change", { data: { clearServerUnknown: true } });
  const second = await page.context().newPage();
  await page.goto("/");
  await second.goto("/");
  await openSidebar(page);
  await openSidebar(second);
  await select(page, target);
  await select(second, target);
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Cross-tab unknown");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => dropped).toBe(true);
  expect(
    (await (await request.get("/fixture/info")).json()).deliveries,
  ).toEqual([]);
  await second.keyboard.press("Alt+KeyX");
  await expect(second.getByRole("dialog")).toContainText(
    "Unconfirmed work may still be running.",
  );
  await second.close();
});

test("an open confirmation updates for follow-up changes in another tab", async ({
  page,
  request,
}) => {
  const { other: target } = await (await request.post("/fixture/reset")).json();
  await request.post("/fixture/change", { data: { clearServerUnknown: true } });
  const second = await page.context().newPage();
  await page.goto("/");
  await second.goto("/");
  await openSidebar(second);
  await select(second, target);
  await second.keyboard.press("Alt+KeyX");
  await expect(second.getByRole("dialog")).not.toContainText(
    "Unconfirmed work may still be running.",
  );
  await page.evaluate((target) => {
    const key = `flickgrove/${location.origin}/follow-up/${encodeURIComponent(target)}/cross-tab-queue`;
    localStorage.setItem(
      key,
      JSON.stringify({
        id: "cross-tab-queue",
        text: "Queued locally",
        imageIds: [],
      }),
    );
  }, target);
  await expect(second.getByRole("dialog")).toContainText(
    "Unconfirmed work may still be running.",
  );
  await expect(second.getByRole("dialog")).toContainText(
    "Queued messages will stay paused",
  );
  await page.evaluate(
    (target) =>
      localStorage.removeItem(
        `flickgrove/${location.origin}/follow-up/${encodeURIComponent(target)}/cross-tab-queue`,
      ),
    target,
  );
  await expect(second.getByRole("dialog")).not.toContainText(
    "Unconfirmed work may still be running.",
  );
  await page.evaluate((target) => {
    const root = `flickgrove/${location.origin}`;
    localStorage.setItem(
      `${root}/outgoing/${encodeURIComponent(target)}/cross-tab-send`,
      JSON.stringify({
        agentId: target,
        id: "cross-tab-send",
        text: "pending",
        at: Date.now(),
        status: "sending",
      }),
    );
  }, target);
  await expect(second.getByRole("dialog")).toContainText(
    "Unconfirmed work may still be running.",
  );
  await page.evaluate(
    (target) =>
      localStorage.setItem(
        `flickgrove/${location.origin}/accepted/${encodeURIComponent(target)}/cross-tab-send`,
        "true",
      ),
    target,
  );
  await expect(second.getByRole("dialog")).not.toContainText(
    "Unconfirmed work may still be running.",
  );
  await second.close();
});

test("a journal appearing just before confirmation is shown before close", async ({
  page,
  request,
}) => {
  const { other: target } = await (await request.post("/fixture/reset")).json();
  await request.post("/fixture/change", { data: { clearServerUnknown: true } });
  await page.goto("/");
  await openSidebar(page);
  await select(page, target);
  await page.keyboard.press("Alt+KeyX");
  await expect(page.getByRole("dialog")).not.toContainText(
    "Unconfirmed work may still be running.",
  );
  // Same-tab storage writes do not trigger a storage event; this models a
  // pending reservation finishing after the dialog opened.
  await page.evaluate((target) => {
    const key = `flickgrove/${location.origin}/follow-up/${encodeURIComponent(target)}/late-queue`;
    localStorage.setItem(
      key,
      JSON.stringify({ id: "late-queue", text: "Pending", imageIds: [] }),
    );
  }, target);
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Unconfirmed work may still be running.",
  );
  expect((await (await request.get("/fixture/info")).json()).closeCalls).toBe(
    0,
  );
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect
    .poll(
      async () => (await (await request.get("/fixture/info")).json()).closed,
    )
    .toBe(true);
});

test("a late queue is disclosed even when another outcome is already unknown", async ({
  page,
  request,
}) => {
  const { target } = await (await request.post("/fixture/reset")).json();
  await page.goto("/");
  await openSidebar(page);
  await select(page, target);
  await page.keyboard.press("Alt+KeyX");
  await expect(page.getByRole("dialog")).toContainText(
    "Unconfirmed work may still be running.",
  );
  await expect(page.getByRole("dialog")).not.toContainText(
    "Queued messages will stay paused",
  );
  await page.evaluate((target) => {
    localStorage.setItem(
      `flickgrove/${location.origin}/follow-up/${encodeURIComponent(target)}/late-queue`,
      JSON.stringify({ id: "late-queue", text: "Pending", imageIds: [] }),
    );
  }, target);
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Queued messages will stay paused",
  );
  expect((await (await request.get("/fixture/info")).json()).closeCalls).toBe(
    0,
  );
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect
    .poll(
      async () => (await (await request.get("/fixture/info")).json()).closed,
    )
    .toBe(true);
});

test("a real delayed image queue adds its warning before close", async ({
  page,
  request,
}) => {
  let heldEnqueue = false;
  await page.routeWebSocket("**/api/socket", (socket) => {
    const owner = socket.connectToServer();
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (frame.args?.member === "enqueueFollowUp") heldEnqueue = true;
      else owner.send(data);
    });
    owner.onMessage((data) => socket.send(data));
  });
  const { target } = await (await request.post("/fixture/reset")).json();
  await page.goto("/");
  await openSidebar(page);
  await select(page, target);
  await request.post("/fixture/change", { data: { active: true } });
  await expect(
    page.getByRole("button", { name: "Queue for next turn" }),
  ).toBeVisible();
  await page.getByLabel("Choose message attachments").setInputFiles({
    name: "queued.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#6488a5" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Queued after confirmation opens");
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      IDBTransaction.prototype,
      "oncomplete",
    )!;
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      configurable: true,
      get: descriptor.get,
      set(handler) {
        descriptor.set!.call(
          this,
          function (this: IDBTransaction, event: Event) {
            (window as any).resumeQueueStorage = () =>
              handler.call(this, event);
          },
        );
      },
    });
    (window as any).restoreQueueStorage = () =>
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", descriptor);
  });
  await page.getByRole("button", { name: "Queue for next turn" }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).resumeQueueStorage))
    .toBe("function");
  await request.post("/fixture/change", { data: { finishActive: true } });
  await expect(
    page.getByRole("button", { name: "Queue for next turn" }),
  ).toHaveCount(0);
  await page.keyboard.press("Alt+KeyX");
  await expect(page.getByRole("dialog")).toContainText(
    "Unconfirmed work may still be running.",
  );
  await expect(page.getByRole("dialog")).not.toContainText(
    "Queued messages will stay paused",
  );
  await page.evaluate(() => {
    (window as any).restoreQueueStorage();
    (window as any).resumeQueueStorage();
  });
  await expect.poll(() => heldEnqueue).toBe(true);
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Queued messages will stay paused",
  );
  expect((await (await request.get("/fixture/info")).json()).closeCalls).toBe(
    0,
  );
});

test("a lost confirmed-close response is checked without replay", async ({
  page,
  request,
}) => {
  test.setTimeout(70_000);
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = new Proxy(Native, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args) as WebSocket;
        const send = socket.send.bind(socket);
        let closeId: number | undefined;
        socket.send = (data) => {
          const frame = JSON.parse(String(data));
          if (
            frame.args?.member === "closeTree" &&
            frame.args.input?.confirmRisks
          )
            closeId = frame.id;
          send(data);
        };
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (closeId && frame.id === closeId && frame.t === "result") {
            event.stopImmediatePropagation();
            closeId = undefined;
            socket.close(1011, "Fixture lost close response");
          }
        });
        return socket;
      },
    });
  });
  const { target } = await (await request.post("/fixture/reset")).json();
  await page.goto("/");
  await openSidebar(page);
  await select(page, target);
  await page.keyboard.press("Alt+KeyX");
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect
    .poll(
      async () => (await (await request.get("/fixture/info")).json()).closed,
      { timeout: 45_000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            Object.keys(localStorage).filter((key) =>
              key.includes("/abandon-close/"),
            ).length,
        ),
      { timeout: 50_000 },
    )
    .toBe(0);
  expect(await (await request.get("/fixture/info")).json()).toMatchObject({
    closeCalls: 1,
    inputs: 1,
    original: { id: "original-unknown", status: "uncertain" },
  });
});

test("a late close failure does not change the reader's newer selection", async ({
  page,
  request,
}) => {
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await request.post("/fixture/change", {
    data: { ordinaryCloseError: true, ordinaryCloseDelay: 800 },
  });
  await page.goto("/");
  await openSidebar(page);
  await select(page, target);
  await closeFromList(page, target);
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await select(page, other);
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/info")).json()).closeCalls,
    )
    .toBe(1);
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/info")).json())
          .ordinaryCloseFinished,
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => history.state?.grove?.details.at(-1)))
    .toBe(other);
  await expect(page.locator(".session-list")).not.toContainText(error);
  await select(page, target);
  await expect(page.locator(".agent-detail .detail-close-error")).toHaveText(
    error,
  );
});
