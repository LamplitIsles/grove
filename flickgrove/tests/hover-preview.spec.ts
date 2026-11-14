import { expect, test } from "@playwright/test";
import { openSidebar, newSession } from "./browser-actions";

const origin = "http://127.0.0.1:14319";
const open = (title: string, role = "Orc") => `Open ${title} ${role}`;

test("hover previews without changing selection, draft, caret or reading position; click selects", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  const selected = page.getByRole("button", {
    name: open("Streaming voice input"),
    exact: true,
  });
  await selected.click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Unsent selected draft");
  const conversation = page.locator(
    ".detail-slot > .agent-detail:not(.hover-preview) .conversation",
  );
  await expect(conversation).toContainText("Paragraph 70");
  await conversation.evaluate((el) => {
    el.scrollTop -= 350;
  });
  const before = await conversation.evaluate((el) => el.scrollTop);
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(3, 9);
    (
      window as unknown as { originalInput: HTMLTextAreaElement }
    ).originalInput = el;
  });
  const row = page.getByRole("button", {
    name: open("Reader performance"),
    exact: true,
  });
  const id = await row.getAttribute("data-agent-id");
  await row.hover();
  const preview = page.locator(".hover-preview");
  await expect(preview).toHaveAttribute("data-preview-id", id!);
  await expect(preview).toContainText("Reader performance");
  await expect(preview).toContainText("Reader performance: Paragraph");
  await expect(preview).toHaveAttribute("inert", "");
  await expect(selected).toHaveAttribute("aria-current", "true");
  expect(
    await input.evaluate(
      (el) =>
        el ===
          (window as unknown as { originalInput: HTMLTextAreaElement })
            .originalInput && document.activeElement === el,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../.scratch/conversation-reading-projection/hover-preview-desktop.png",
  });
  await page.mouse.move(500, 50);
  await expect(preview).toHaveCount(0);
  await expect(input).toHaveValue("Unsent selected draft");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([3, 9]);
  expect(
    Math.abs((await conversation.evaluate((el) => el.scrollTop)) - before),
  ).toBeLessThan(3);
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(
    page.locator(".detail-slot > .agent-detail:not(.hover-preview)"),
  ).toHaveAttribute("aria-label", "Reader performance");
  await selected.click();
  await expect(input).toHaveValue("Unsent selected draft");
});

test("late preview responses cannot replace another row or restore after leave", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  await page
    .getByRole("button", { name: open("Streaming voice input"), exact: true })
    .click();
  await page
    .locator(".session-row")
    .filter({
      has: page.getByRole("button", {
        name: open("Streaming voice input"),
        exact: true,
      }),
    })
    .getByRole("button", { name: "Expand Workers", exact: true })
    .click();
  await request.post(origin + "/fixture/change", {
    data: { detailDelay: 1200 },
  });
  const slow = page.getByRole("button", {
    name: open("Reader performance"),
    exact: true,
  });
  const quick = page.getByRole("button", {
    name: open("Documentation", "Worker"),
    exact: true,
  });
  await slow.hover();
  await expect(page.locator(".hover-preview")).toContainText(
    "Reader performance",
  );
  // Let the delayed read start before moving to another row.
  await page.waitForTimeout(120);
  await quick.hover();
  const preview = page.locator(".hover-preview");
  await expect(preview).toContainText("Documentation");
  await page.waitForTimeout(1400);
  await expect(preview).toContainText("Documentation");
  await expect(preview).not.toContainText("Reader performance");
  await slow.hover();
  await page.mouse.move(500, 50);
  await page.waitForTimeout(1400);
  await expect(preview).toHaveCount(0);
});

test("foreground dialogs and touch do not activate hover previews", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  await page
    .getByRole("button", { name: open("Streaming voice input"), exact: true })
    .click();
  const row = page.getByRole("button", {
    name: open("Reader performance"),
    exact: true,
  });
  await row.hover();
  await expect(page.locator(".hover-preview")).toHaveCount(1);
  await newSession(page);
  await expect(page.locator(".hover-preview")).toHaveCount(0);
  await row
    .locator("xpath=../..")
    .evaluate((el) =>
      el.dispatchEvent(
        new PointerEvent("pointerenter", { pointerType: "mouse" }),
      ),
    );
  await expect(page.locator(".hover-preview")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await openSidebar(page);
  const mobileRow = page.getByRole("button", {
    name: open("Reader performance"),
    exact: true,
  });
  await mobileRow
    .locator("xpath=../..")
    .evaluate((el) =>
      el.dispatchEvent(
        new PointerEvent("pointerenter", { pointerType: "touch" }),
      ),
    );
  await expect(page.locator(".hover-preview")).toHaveCount(0);
});

test("preview uses the same result grouping without changing selected session", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  const selected = page.getByRole("button", {
    name: open("Streaming voice input"),
    exact: true,
  });
  await selected.click();
  const emit = (event: object) =>
    request.post(origin + "/fixture/change", {
      data: { execution: { agentId: "reader-orc", event } },
    });
  await emit({ type: "working", turnId: "hover-group" });
  await emit({
    type: "item",
    item: {
      type: "agentMessage",
      id: "hover-progress",
      phase: "commentary",
      text: "Preview progress",
    },
  });
  await emit({
    type: "item",
    item: {
      type: "agentMessage",
      id: "hover-result",
      phase: "final_answer",
      text: "Preview final answer",
    },
  });
  await page
    .getByRole("button", { name: open("Reader performance"), exact: true })
    .hover();
  const preview = page.locator(".hover-preview");
  await expect(preview).toContainText("Preview final answer");
  await expect(preview.locator(".message-group-trigger")).toContainText(
    "Work details",
  );
  await expect(preview).not.toContainText("Preview progress");
  await expect(selected).toHaveAttribute("aria-current", "true");
  const reader = page.getByRole("button", {
    name: open("Reader performance"),
    exact: true,
  });
  await reader.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.getByRole("button", { name: "Work details 1" }).click();
  await expect(
    page.getByText("Preview progress", { exact: true }),
  ).toBeVisible();
  await selected.click();
  await reader.hover();
  await expect(preview).toContainText("Preview progress");
});

test("offline hover uses saved reading and labels its disconnected state", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  const reader = page.getByRole("button", {
    name: open("Reader performance"),
    exact: true,
  });
  const selected = page.getByRole("button", {
    name: open("Streaming voice input"),
    exact: true,
  });
  await reader.click();
  await expect(page.locator(".conversation")).toContainText(
    "Reader performance: Paragraph",
  );
  await selected.click();
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await expect(
    page.getByRole("status").filter({ hasText: "Reconnecting" }).first(),
  ).toBeVisible();
  await reader.hover();
  const preview = page.locator(".hover-preview");
  await expect(preview).toContainText("Disconnected.");
  await expect(preview).toContainText("Reader performance: Paragraph");
  await expect(selected).toHaveAttribute("aria-current", "true");
});

test("previewing a Worker does not consume its pending question", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "device-worker" },
  });
  await page.goto(origin);
  await openSidebar(page);
  const selected = page.getByRole("button", {
    name: open("Streaming voice input"),
    exact: true,
  });
  await selected.click();
  await page
    .locator(".session-row")
    .filter({ has: selected })
    .getByRole("button", { name: "Expand Workers", exact: true })
    .click();
  const worker = page.getByRole("button", {
    name: open("Voice input", "Worker"),
    exact: true,
  });
  await worker.hover();
  await expect(page.locator(".hover-preview")).toContainText("Needs input");
  await expect(selected).toHaveAttribute("aria-current", "true");
  await page.mouse.move(500, 50);
  await worker.click();
  await expect(
    page.locator(".detail-slot > .agent-detail:not(.hover-preview)"),
  ).toHaveAttribute("aria-label", "Voice input");
  await expect(
    page.getByRole("region", { name: "Pending questions" }),
  ).toBeVisible();
});

test("hover shows recent content while selecting restores the reading anchor", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  const reader = page.getByRole("button", {
    name: open("Reader performance"),
    exact: true,
  });
  const selected = page.getByRole("button", {
    name: open("Streaming voice input"),
    exact: true,
  });
  await reader.click();
  const conversation = page.locator(
    ".detail-slot > .agent-detail:not(.hover-preview) .conversation",
  );
  await expect(conversation).toContainText("Reader performance: Paragraph 70");
  await conversation.evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollTop - 500);
  });
  const visible = await conversation.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll(".markdown p")].find((p) => {
      const r = p.getBoundingClientRect();
      return (
        r.top >= bounds.top &&
        r.bottom <= bounds.bottom &&
        p.textContent?.includes("Reader performance: Paragraph")
      );
    })?.textContent;
  });
  expect(visible).toBeTruthy();
  await selected.click();
  await reader.hover();
  const preview = page.locator(".hover-preview");
  await expect(
    preview
      .locator(".markdown p")
      .filter({ hasText: "Reader performance: Paragraph 70." }),
  ).toBeInViewport();
  await expect(
    preview.getByText(visible!, { exact: true }),
  ).not.toBeInViewport();
  await expect(selected).toHaveAttribute("aria-current", "true");
  await reader.click();
  await expect(
    conversation.getByText(visible!, { exact: true }),
  ).toBeInViewport();
});

test("hover moves from cached content to the latest fresh detail once", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  const reader = page.getByRole("button", {
    name: open("Reader performance"),
    exact: true,
  });
  const selected = page.getByRole("button", {
    name: open("Streaming voice input"),
    exact: true,
  });
  await reader.click();
  await expect(page.locator(".conversation")).toContainText(
    "Reader performance: Paragraph 70",
  );
  await selected.click();
  await request.post(origin + "/fixture/change", {
    data: { detailDelay: 800 },
  });
  await request.post(origin + "/fixture/change", {
    data: {
      execution: {
        agentId: "reader-orc",
        event: { type: "working", turnId: "hover-fresh" },
      },
    },
  });
  await request.post(origin + "/fixture/change", {
    data: {
      execution: {
        agentId: "reader-orc",
        event: {
          type: "item",
          item: {
            type: "agentMessage",
            id: "hover-fresh-result",
            phase: "final_answer",
            text: "Newest fresh preview",
          },
        },
      },
    },
  });
  await reader.hover();
  const preview = page.locator(".hover-preview");
  await expect(preview).toContainText("Reader performance: Paragraph");
  await expect(
    preview.getByText("Newest fresh preview", { exact: true }),
  ).toBeInViewport();
});

test("hovered conversation refreshes without following newly appended messages", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await openSidebar(page);
  const selected = page.getByRole("button", {
    name: open("Streaming voice input"),
    exact: true,
  });
  await selected.click();
  await page
    .getByRole("button", { name: open("Reader performance"), exact: true })
    .hover();
  const preview = page.locator(".hover-preview");
  await expect(preview).toContainText("Reader performance: Paragraph 70");
  const transcript = preview.locator(".preview-conversation");
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  const before = await transcript.evaluate((el) => el.scrollTop);
  const emit = (event: object) =>
    request.post(origin + "/fixture/change", {
      data: { execution: { agentId: "reader-orc", event } },
    });
  await emit({ type: "working", turnId: "hover-live" });
  await emit({
    type: "item",
    item: {
      type: "agentMessage",
      id: "hover-live-progress",
      phase: "commentary",
      text: "New live preview content",
    },
  });
  await expect(preview).toContainText("New live preview content");
  expect(
    Math.abs((await transcript.evaluate((el) => el.scrollTop)) - before),
  ).toBeLessThan(4);
  await expect(selected).toHaveAttribute("aria-current", "true");
});
