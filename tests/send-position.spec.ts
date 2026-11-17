import { expect, test } from "@playwright/test";
import { openSidebar } from "./browser-actions";

const origin = "http://127.0.0.1:14319";
for (const width of [1440, 390]) {
  test(`${width}: sending positions the input and retains space through a short answer`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
    await page.goto(origin);
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("Position my new message");
    await input.press("Enter");
    const conversation = page.locator(
      ".detail-slot > .agent-detail:not(.hover-preview) .conversation",
    );
    const row = conversation
      .locator("[data-message-id]")
      .filter({ hasText: "Position my new message" });
    await expect(row).toBeVisible();
    const offset = () =>
      row.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest(".conversation")!.getBoundingClientRect().top,
      );
    await expect.poll(offset).toBeGreaterThanOrEqual(15);
    await expect.poll(offset).toBeLessThan(45);
    await expect
      .poll(async () =>
        (
          (await (await request.get(origin + "/fixture/info")).json())
            .inputs as { text: string }[]
        ).some((item) => item.text === "Position my new message"),
      )
      .toBe(true);
    await page.waitForTimeout(350);
    const before = await conversation.evaluate((el) => ({
      top: el.scrollTop,
      height: el.scrollHeight,
    }));
    const change = (event: object) =>
      request.post(origin + "/fixture/change", {
        data: { execution: { event } },
      });
    await change({ type: "working", turnId: "position-test" });
    await change({
      type: "item",
      item: {
        type: "agentMessage",
        id: "position-result",
        phase: "final_answer",
        text: "A short answer",
      },
    });
    await expect(conversation.getByText("A short answer")).toBeInViewport();
    await request.post(origin + "/fixture/change", {
      data: { complete: "completed" },
    });
    await page.waitForTimeout(350);
    const after = await conversation.evaluate((el) => ({
      top: el.scrollTop,
      height: el.scrollHeight,
    }));
    expect(Math.abs(after.top - before.top)).toBeLessThan(3);
    expect(Math.abs(after.height - before.height)).toBeLessThan(20);
    expect(await offset()).toBeGreaterThanOrEqual(15);
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
      await expect.poll(offset).toBeGreaterThanOrEqual(15);
      await expect.poll(offset).toBeLessThan(45);
    }
    await conversation.evaluate((el) => {
      el.scrollTop -= 120;
    });
    await expect
      .poll(() => conversation.evaluate((el) => el.scrollTop))
      .toBeLessThan(before.top - 110);
    await expect
      .poll(() => conversation.evaluate((el) => el.scrollHeight))
      .toBeLessThan(before.height - 100);
    await page.keyboard.press("Meta+ArrowDown");
    await expect
      .poll(() =>
        conversation.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThan(3);
  });
}

for (const width of [1440, 390]) {
  test(`${width}: answering a question positions its outgoing message`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
    await page.goto(origin);
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await request.post(origin + "/fixture/change", {
      data: { question: true, questionId: "position", questionOptions: true },
    });
    const panel = page.locator(".question-panel");
    await panel.locator(".question-option").first().click();
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "held" },
    });
    await panel.getByRole("button", { name: "Send all answers" }).click();
    const conversation = page.locator(
      ".detail-slot > .agent-detail:not(.hover-preview) .conversation",
    );
    const row = conversation
      .locator("[data-message-id]")
      .filter({ hasText: "Recommended choice" });
    await expect(row).toBeVisible();
    await expect
      .poll(() =>
        row.evaluate(
          (el) =>
            el.getBoundingClientRect().top -
            el.closest(".conversation")!.getBoundingClientRect().top,
        ),
      )
      .toBeGreaterThanOrEqual(15);
    await expect
      .poll(() =>
        row.evaluate(
          (el) =>
            el.getBoundingClientRect().top -
            el.closest(".conversation")!.getBoundingClientRect().top,
        ),
      )
      .toBeLessThan(45);
    await conversation.evaluate((el) => {
      const frames: number[] = [];
      (window as unknown as { answerFrames: number[] }).answerFrames = frames;
      const sample = () => {
        frames.push(el.scrollTop);
        if (frames.length < 45) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "accepted" },
    });
    await expect(panel).not.toBeVisible();
    await page.waitForTimeout(400);
    const frames = await page.evaluate(
      () => (window as unknown as { answerFrames: number[] }).answerFrames,
    );
    expect(Math.max(...frames) - Math.min(...frames)).toBeLessThan(3);
    await expect
      .poll(() =>
        row.evaluate(
          (el) =>
            el.getBoundingClientRect().top -
            el.closest(".conversation")!.getBoundingClientRect().top,
        ),
      )
      .toBeLessThan(45);
  });
}

test("folding completed progress does not bounce the sent input", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Keep my place through folding");
  await input.press("Enter");
  const conversation = page.locator(
    ".detail-slot > .agent-detail:not(.hover-preview) .conversation",
  );
  const row = conversation
    .locator("[data-message-id]")
    .filter({ hasText: "Keep my place through folding" });
  await expect(row).toBeVisible();
  await expect
    .poll(() =>
      row.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest(".conversation")!.getBoundingClientRect().top,
      ),
    )
    .toBeLessThan(45);
  await expect
    .poll(async () =>
      (
        (await (await request.get(origin + "/fixture/info")).json()).inputs as {
          text: string;
        }[]
      ).some((item) => item.text === "Keep my place through folding"),
    )
    .toBe(true);
  const change = (event: object) =>
    request.post(origin + "/fixture/change", {
      data: { execution: { event } },
    });
  await change({ type: "working", turnId: "fold-position" });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "position-progress",
      phase: "commentary",
      text: Array.from(
        { length: 12 },
        (_, i) => `Progress paragraph ${i} with some detail.`,
      ).join("\n\n"),
    },
  });
  await expect(
    conversation.getByText("Progress paragraph 0 with some detail."),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await expect
    .poll(() =>
      row.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest(".conversation")!.getBoundingClientRect().top,
      ),
    )
    .toBeLessThan(45);
  const before = await conversation.evaluate((el) => el.scrollTop);
  await conversation.evaluate((el) => {
    const frames: number[] = [];
    (window as unknown as { foldingFrames: number[] }).foldingFrames = frames;
    const sample = () => {
      frames.push(el.scrollTop);
      if (frames.length < 45) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "position-final",
      phase: "final_answer",
      text: "Finished",
    },
  });
  await expect(conversation.getByText("Finished")).toBeVisible();
  await page.waitForTimeout(400);
  expect(
    Math.abs((await conversation.evaluate((el) => el.scrollTop)) - before),
  ).toBeLessThan(3);
  const frames = await page.evaluate(
    () => (window as unknown as { foldingFrames: number[] }).foldingFrames,
  );
  expect(Math.max(...frames) - Math.min(...frames)).toBeLessThan(3);
});
