import { expect, test } from "@playwright/test";
import { openSidebar } from "./browser-actions";

const origin = "http://127.0.0.1:14319";

test("manual disclosure, desktop outline, tree and copy provide restrained motion", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const state = window as unknown as Window & {
      motionEvents: string[];
      copiedText?: string;
    };
    state.motionEvents = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.classList.contains("message-group-content"))
        state.motionEvents.push("group");
      if (this.classList.contains("outline-rail"))
        state.motionEvents.push("outline");
      if (this.classList.contains("session-tree-children"))
        state.motionEvents.push("tree");
      if (this.parentElement?.classList.contains("copy-icon"))
        state.motionEvents.push("copy");
      return animate.apply(this, args);
    };
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          state.copiedText = text;
        },
      },
    });
  });
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const change = (event: object) =>
    request.post(origin + "/fixture/change", {
      data: { execution: { event } },
    });
  await change({ type: "working", turnId: "manual-motion" });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "manual-progress",
      phase: "commentary",
      text: "Work shown inside details",
    },
  });
  await page.keyboard.press("Meta+ArrowDown");
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "manual-result",
      phase: "final_answer",
      text: "Finished result for copying",
    },
  });
  const disclosure = page.getByRole("button", { name: "Work details 1" });
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(
    page
      .locator(".message-group-content")
      .getByText("Work shown inside details"),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as Window & { motionEvents: string[] }
        ).motionEvents.includes("group"),
      ),
    )
    .toBe(true);
  await disclosure.click();
  await expect(
    page
      .locator(".message-group-content")
      .getByText("Work shown inside details"),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "Message outline", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Message outline" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as Window & { motionEvents: string[] }
        ).motionEvents.includes("outline"),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Message outline", exact: true })
    .click();
  const workerToggle = page
    .getByRole("button", { name: "Expand Workers", exact: true })
    .first();
  await workerToggle.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as Window & { motionEvents: string[] }
        ).motionEvents.includes("tree"),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Meta+ArrowDown");
  const result = page.locator('[data-message-id="manual-result"]');
  await result.hover();
  const copy = result.getByRole("button", { name: "Copy message" });
  await copy.click();
  await expect(copy).toHaveAttribute("title", "Copied");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as Window & { motionEvents: string[] }
        ).motionEvents.includes("copy"),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Window & { copiedText?: string }).copiedText,
      ),
    )
    .toBe("Finished result for copying");
});

test("reduced motion keeps disclosure, outline and copy usable without movement", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const state = window as unknown as Window & { motionDurations: number[] };
    state.motionDurations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (
        this.matches(
          ".message-group-content, .outline-rail, .session-tree-children",
        ) ||
        this.parentElement?.classList.contains("copy-icon")
      ) {
        const duration = animation.effect?.getTiming().duration;
        if (typeof duration === "number") state.motionDurations.push(duration);
      }
      return animation;
    };
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
    });
  });
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const change = (event: object) =>
    request.post(origin + "/fixture/change", {
      data: { execution: { event } },
    });
  await change({ type: "working", turnId: "reduced-manual-motion" });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "reduced-progress",
      phase: "commentary",
      text: "Reduced motion work",
    },
  });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "reduced-result",
      phase: "final_answer",
      text: "Reduced motion result",
    },
  });
  await page.keyboard.press("Meta+ArrowDown");
  const group = page.getByRole("button", { name: "Work details 1" });
  await group.click();
  await expect(page.getByText("Reduced motion work")).toBeVisible();
  await page
    .getByRole("button", { name: "Message outline", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Message outline" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand Workers", exact: true })
    .first()
    .click();
  await page.keyboard.press("Meta+ArrowDown");
  const result = page.locator('[data-message-id="reduced-result"]');
  await result.hover();
  await result.getByRole("button", { name: "Copy message" }).click();
  await expect(
    result.getByRole("button", { name: "Copy message" }),
  ).toHaveAttribute("title", "Copied");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as Window & { motionDurations: number[] }
      ).motionDurations.every((duration) => duration === 0),
    ),
  ).toBe(true);
  const chevron = group.locator("svg");
  expect(
    await chevron.evaluate((el) =>
      parseFloat(getComputedStyle(el).transitionDuration),
    ),
  ).toBeLessThan(0.001);
});

test("desktop outline preserves the reading point and composer draft", async ({
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
  await input.fill("Keep my draft");
  const conversation = page.locator(".conversation");
  await expect(conversation).toContainText("Paragraph 70");
  await conversation.evaluate((el) => {
    el.scrollTop -= 500;
  });
  const anchor = await conversation.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>(".timeline-message")].find(
      (item) => item.getBoundingClientRect().top >= top + 5,
    );
    if (!row) throw new Error("No visible anchor");
    return {
      id: row.dataset.messageId!,
      offset: row.getBoundingClientRect().top - top,
    };
  });
  const check = async () => {
    await expect
      .poll(async () =>
        conversation.evaluate((el, anchor) => {
          const row = [
            ...el.querySelectorAll<HTMLElement>(".timeline-message"),
          ].find((item) => item.dataset.messageId === anchor.id);
          return row
            ? Math.abs(
                row.getBoundingClientRect().top -
                  el.getBoundingClientRect().top -
                  anchor.offset,
              )
            : 9999;
        }, anchor),
      )
      .toBeLessThan(12);
  };
  await page
    .getByRole("button", { name: "Message outline", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Message outline" }),
  ).toBeVisible();
  await page.waitForTimeout(250);
  await check();
  await expect(input).toHaveValue("Keep my draft");
  await page.screenshot({
    path: "../.scratch/conversation-reading-projection/outline-motion-desktop.png",
  });
  await page
    .getByRole("button", { name: "Message outline", exact: true })
    .click();
  await page.waitForTimeout(250);
  await check();
  await expect(input).toHaveValue("Keep my draft");
});

test("expanding a long work group keeps its header at the reading point", async ({
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
  const change = (event: object) =>
    request.post(origin + "/fixture/change", {
      data: { execution: { event } },
    });
  await change({ type: "working", turnId: "long-manual-group" });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "group-long-progress",
      phase: "commentary",
      text: "Lengthy work ".repeat(600),
    },
  });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "group-long-result",
      phase: "final_answer",
      text: "Result after long work " + "result ".repeat(300),
    },
  });
  await page.keyboard.press("Meta+ArrowDown");
  const group = page.getByRole("button", { name: "Work details 1" });
  await group.scrollIntoViewIfNeeded();
  const conversation = page.locator(".conversation");
  const offset = async () =>
    (await group.boundingBox())!.y - (await conversation.boundingBox())!.y;
  const before = await offset();
  await group.click();
  await expect(
    page.getByText("Lengthy work", { exact: false }).first(),
  ).toBeVisible();
  await page.waitForTimeout(250);
  expect(Math.abs((await offset()) - before)).toBeLessThan(12);
  await group.click();
  await page.waitForTimeout(250);
  expect(Math.abs((await offset()) - before)).toBeLessThan(12);
});
