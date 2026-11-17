import sharp from "sharp";
import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14320";
const design = "http://127.0.0.1:14319";
test.use({ timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
for (const width of [1440, 390]) {
  test(`${width} times survive history reload, hidden member reports and pending confirmation`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.request.post(origin + "/fixture/reset");
    const today = Date.now(),
      previous = today - 86400000;
    const { id } = await (
      await page.request.post(origin + "/fixture/history", {
        data: {
          title: "Message time",
          messages: [
            {
              id: "old-user",
              role: "user",
              text: "Historical user message",
              at: previous,
            },
            {
              id: "old-answer",
              role: "assistant",
              text: "Historical answer with missing time",
              at: 0,
            },
            {
              id: "today-answer",
              role: "assistant",
              text:
                "Current answer.\n\n" +
                "A longer paragraph wraps naturally beside compact metadata. ".repeat(
                  5,
                ),
              at: today,
            },
          ],
        },
      })
    ).json();
    await page.goto(origin);
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Message time Orc", exact: true })
      .click();
    const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
    const oldTime = row("old-user").locator("time");
    await expect(oldTime).toBeVisible();
    const oldLabel = await oldTime.textContent();
    expect(oldLabel).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
    await expect(oldTime).toHaveAttribute(
      "datetime",
      new Date(previous).toISOString(),
    );
    await expect(oldTime).toHaveAttribute("title", /GMT\+8/);
    await expect(oldTime).not.toHaveAttribute("tabindex");
    await expect(row("old-answer").locator("time")).toHaveCount(0);
    await expect(row("today-answer").locator("time")).toHaveText(
      /^\d{2}:\d{2}$/,
    );
    await page.screenshot({
      path: testInfo.outputPath(`${width}-history.png`),
    });
    await page.reload();
    await expect(row("old-user").locator("time")).toHaveText(oldLabel!);
    await expect(row("old-answer").locator("time")).toHaveCount(0);
    // Establish the reader's end position after asynchronous initial measurements.
    await expect
      .poll(async () =>
        page.locator(".conversation").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          return el.scrollHeight - el.scrollTop - el.clientHeight;
        }),
      )
      .toBeLessThanOrEqual(1);
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        input: "User sends a live message",
        text: "Assistant response",
        report:
          "Time report\n\n" +
          "Long report paragraph. ".repeat(30) +
          "\n\n[Worker chart](plot.png)",
      },
    });
    await page.keyboard.press("Meta+ArrowDown");
    await expect(page.locator(".conversation")).toContainText(
      "Assistant response",
    );
    await expect(page.locator(".worker-report")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.request.post(design + "/fixture/reset", {
      data: { mode: "long" },
    });
    await page.goto(design);
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await page.request.post(design + "/fixture/change", {
      data: { sendMode: "held" },
    });
    const composer = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await page.getByLabel("Choose message images").setInputFiles({
      name: "time-image.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: { width: 600, height: 240, channels: 3, background: "#406f91" },
      })
        .png()
        .toBuffer(),
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await composer.fill("Time pending message");
    await composer.press("Enter");
    const pending = page
      .locator(".user-message")
      .filter({ hasText: "Time pending message" });
    await expect(pending).toHaveCount(1);
    await expect(pending.locator("time")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some(
            (key) =>
              key.includes("/outgoing/") &&
              JSON.parse(localStorage.getItem(key) ?? "null")?.status ===
                "sending",
          ),
        ),
      )
      .toBe(true);
    await expect(pending.locator(".message-image")).toBeVisible();
    const pendingId = await pending.evaluate((el) =>
      el.closest("[data-row-key]")!.getAttribute("data-row-key"),
    );
    const pendingTime = await pending.locator("time").getAttribute("datetime");
    await page.screenshot({
      path: testInfo.outputPath(`${width}-pending.png`),
    });
    await page.request.post(design + "/fixture/change", {
      data: { sendMode: "accepted" },
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some((key) => key.includes("/accepted/")),
        ),
      )
      .toBe(true);
    await expect(pending).toHaveCount(1);
    await expect(page.locator(`[data-row-key="${pendingId}"]`)).toHaveCount(1);
    const agentId = await page.evaluate(() =>
      history.state.grove.details.at(-1),
    );
    const nativeAt = await expect
      .poll(async () => {
        const detail = await (
          await page.request.get(
            design + "/fixture/agents/" + encodeURIComponent(agentId),
          )
        ).json();
        return detail.messages.find(
          (message: { clientId?: string; provisional?: boolean }) =>
            message.clientId === pendingId && !message.provisional,
        )?.at;
      })
      .toBeTruthy()
      .then(async () => {
        const detail = await (
          await page.request.get(
            design + "/fixture/agents/" + encodeURIComponent(agentId),
          )
        ).json();
        return detail.messages.find(
          (message: { clientId?: string; provisional?: boolean }) =>
            message.clientId === pendingId && !message.provisional,
        ).at;
      });
    await expect(pending.locator("time")).toHaveAttribute(
      "datetime",
      new Date(nativeAt).toISOString(),
    );
    const confirmedTime = await pending
      .locator("time")
      .getAttribute("datetime");
    expect(
      Math.abs(Date.parse(confirmedTime!) - Date.parse(pendingTime!)),
    ).toBeLessThan(60000);
    await expect(pending.locator("time")).toHaveText(/^\d{2}:\d{2}$/);
    const read = page.waitForResponse(
      (response) =>
        response.url().includes("/api/read/messages?") && response.ok(),
    );
    await page.reload();
    const history = await (await read).json();
    const recorded = history.messages.find(
      (message: { clientId?: string }) => message.clientId === pendingId,
    );
    expect(recorded?.at).toBeTruthy();
    await expect(pending).toHaveCount(1);
    await expect(pending.locator("time")).toHaveAttribute(
      "datetime",
      new Date(recorded.at).toISOString(),
    );
    await page.screenshot({
      path: testInfo.outputPath(`${width}-confirmed.png`),
    });
    expect(errors).toEqual([]);
  });
}

test("image messages keep time and copy below the attachment", async ({
  page,
}) => {
  await page.request.post(design + "/fixture/reset", {
    data: { mode: "long" },
  });
  await page.goto(design);
  await page.request.post(design + "/fixture/change", {
    data: { sendMode: "held" },
  });
  await page.getByLabel("Choose message images").setInputFiles({
    name: "footer-image.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 300, height: 120, channels: 3, background: "#406f91" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Image and text");
  await input.press("Enter");
  const message = page
    .locator(".user-message")
    .filter({ hasText: "Image and text" });
  const attachment = message.locator(".message-image");
  const footer = message.locator(".message-actions");
  await expect(attachment).toBeVisible();
  await expect(footer.locator("time")).toHaveCount(1);
  await expect(
    footer.getByRole("button", { name: "Copy message" }),
  ).toHaveCount(1);
  const layout = await message.evaluate((element) => ({
    imageBottom: element
      .querySelector(".message-image")!
      .getBoundingClientRect().bottom,
    footerTop: element
      .querySelector(".message-actions")!
      .getBoundingClientRect().top,
  }));
  expect(layout.footerTop).toBeGreaterThanOrEqual(layout.imageBottom);
});
