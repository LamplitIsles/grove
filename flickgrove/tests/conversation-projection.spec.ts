import { newSession, openSidebar } from "./browser-actions";
import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";

for (const reducedMotion of [false, true]) {
  test(`new result ${reducedMotion ? "skips" : "animates"} folding with reduced motion ${reducedMotion ? "on" : "off"}`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    await page.addInitScript(() => {
      const original = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const animation = original.apply(this, args);
        if (this.classList.contains("folding-preview")) {
          document.documentElement.dataset.foldAnimation = "started";
          animation.playbackRate = 0.05;
        }
        return animation;
      };
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
    await change({ type: "working", turnId: "fold-motion" });
    await change({
      type: "item",
      item: {
        type: "agentMessage",
        id: "motion-progress",
        phase: "commentary",
        text: "Visible work before folding",
      },
    });
    await page.keyboard.press("Meta+ArrowDown");
    await expect(
      page.getByText("Visible work before folding"),
    ).toBeInViewport();
    await change({
      type: "item",
      item: {
        type: "agentMessage",
        id: "motion-result",
        phase: "final_answer",
        text: "Visible final result",
      },
    });
    await expect(
      page.getByRole("button", { name: "Work details 1" }),
    ).toBeVisible();
    await expect(page.getByText("Visible final result")).toBeVisible();
    const preview = page.locator(".folding-preview");
    if (reducedMotion) {
      await expect(preview).toHaveCount(0);
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-fold-animation",
        "started",
      );
    } else {
      await expect(page.locator("html")).toHaveAttribute(
        "data-fold-animation",
        "started",
      );
      await expect(preview).toHaveAttribute("aria-hidden", "true");
      await expect(preview).toHaveAttribute("inert", "");
      await page.screenshot({
        path: "../.scratch/conversation-reading-projection/folding-motion.png",
        animations: "allow",
      });
      await preview.evaluate((element) =>
        element.getAnimations().forEach((animation) => animation.finish()),
      );
      await expect(preview).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Work details 1" }).click();
    await expect(page.getByText("Visible work before folding")).toBeVisible();
  });
}

for (const width of [1440, 390]) {
  test(`${width}: completed work folds and reading never follows new messages`, async ({
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
    const change = (event: object) =>
      request.post(origin + "/fixture/change", {
        data: { execution: { event } },
      });
    await change({ type: "working", turnId: "long-turn" });
    await change({
      type: "item",
      item: {
        type: "agentMessage",
        id: "progress-one",
        phase: "commentary",
        text: "Progress before answer",
      },
    });
    const conversation = page.locator(".conversation");
    await page
      .getByRole("textbox", { name: "Message Orc", exact: true })
      .focus();
    await page.keyboard.press("Meta+ArrowDown");
    await expect(conversation).toContainText("Progress before answer");
    await change({
      type: "item",
      item: { type: "userMessage", id: "steer-one", text: "A user correction" },
    });
    await change({
      type: "item",
      item: {
        type: "agentMessage",
        id: "answer-one",
        phase: "final_answer",
        text: "Completed answer",
      },
    });
    await page.keyboard.press("Meta+ArrowDown");
    await expect(conversation).toContainText("Completed answer");
    const disclosure = page.getByRole("button", { name: "Work details 1" });
    await expect(disclosure).toBeVisible();
    await page.screenshot({
      path: `../.scratch/conversation-reading-projection/${width}-folded.png`,
    });
    await expect(
      page.getByText("Progress before answer", { exact: true }),
    ).not.toBeVisible();
    await disclosure.click();
    await expect(
      page.getByText("Progress before answer", { exact: true }),
    ).toBeVisible();
    await expect(conversation).toContainText("A user correction");
    await page.keyboard.press("Meta+ArrowDown");
    const previous = await conversation.evaluate((el) => el.scrollTop);
    await change({
      type: "item",
      item: {
        type: "agentMessage",
        id: "after-answer",
        text: "New content ".repeat(250),
      },
    });
    await expect
      .poll(() =>
        conversation.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeGreaterThan(100);
    await expect
      .poll(() =>
        conversation.evaluate(
          (el, top) => Math.abs(el.scrollTop - top),
          previous,
        ),
      )
      .toBeLessThan(8);
    await page.keyboard.press("Meta+ArrowDown");
    await expect
      .poll(() =>
        conversation.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(4);
    await page.screenshot({
      path: `../.scratch/conversation-reading-projection/${width}.png`,
    });
  });
}

test("a result keeps the collapsed work at the current reading point", async ({
  page,
  request,
}) => {
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
  await change({ type: "working", turnId: "collapse-reading" });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "long-progress",
      phase: "commentary",
      text: "Working paragraph ".repeat(300),
    },
  });
  await page.keyboard.press("Meta+ArrowDown");
  const conversation = page.locator(".conversation");
  await expect(conversation).toContainText("Working paragraph");
  await conversation.evaluate((el) => {
    el.scrollTop -= 120;
  });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "long-result",
      phase: "final_answer",
      text: "Result paragraph ".repeat(500),
    },
  });
  await expect(
    page.getByRole("button", { name: "Work details 1" }),
  ).toBeInViewport();
  await expect
    .poll(() =>
      conversation.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeGreaterThan(100);
});

test("returning after a result keeps the previously read work in view", async ({
  page,
  request,
}) => {
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
  await change({ type: "working", turnId: "away-result" });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "away-progress",
      phase: "commentary",
      text: "Reading in progress ".repeat(300),
    },
  });
  await page.keyboard.press("Meta+ArrowDown");
  const conversation = page.locator(".conversation");
  await expect(conversation).toContainText("Reading in progress");
  await conversation.evaluate((el) => {
    el.scrollTop -= 120;
  });
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "away-result",
      phase: "final_answer",
      text: "Result while away ".repeat(500),
    },
  });
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect(
    page.getByRole("button", { name: "Work details 1" }),
  ).toBeInViewport();
  await expect
    .poll(() =>
      conversation.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeGreaterThan(100);
});

test("member messages stay out of the Orc transcript and hover preview", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "researchers" },
  });
  await page.goto(origin);
  await openSidebar(page);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await page.keyboard.press("Meta+ArrowDown");
  const question = page
    .locator(".worker-report")
    .filter({ hasText: "Which installed version should evidence cover?" });
  await expect(question).toHaveCount(0);
  await request.post(origin + "/fixture/change", {
    data: {
      execution: {
        event: {
          type: "item",
          item: {
            type: "agentMessage",
            id: "question-following-result",
            phase: "final_answer",
            text: "Result after researcher question",
          },
        },
      },
    },
  });
  await page.keyboard.press("Meta+ArrowDown");
  await expect(
    page.getByText("Result after researcher question"),
  ).toBeVisible();
  await expect(question).toHaveCount(0);
  await page.screenshot({
    path: "../.scratch/conversation-reading-projection/member-hidden-desktop.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  const originalSession = page.getByRole("button", {
    name: "Open Streaming voice input Orc",
    exact: true,
  });
  await originalSession.hover();
  const previewQuestion = page
    .locator(".hover-preview .worker-report")
    .filter({ hasText: "Which installed version should evidence cover?" });
  await expect(page.locator(".hover-preview")).toBeVisible();
  await expect(previewQuestion).toHaveCount(0);
  await originalSession.click();
  await page.keyboard.press("Meta+ArrowDown");
  await expect(question).toHaveCount(0);
});

test("history preview uses the same disclosure", async ({ page, request }) => {
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
  await change({ type: "working", turnId: "history-fold" });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "history-progress",
      phase: "commentary",
      text: "Historical progress",
    },
  });
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "history-result",
      phase: "final_answer",
      text: "Historical result",
    },
  });
  // The generic FakeRuntime does not project phase into its synthetic history.
  // Supply the already-verified backend contract at the browser boundary.
  await page.route("**/api/read/messages?**", async (route) => {
    await route.fulfill({
      headers: {
        "X-Grove-Peer":
          (await route.request().headerValue("X-Grove-Peer")) ?? "",
      },
      json: {
        messages: [
          {
            id: "history-progress",
            role: "assistant",
            kind: "progress",
            text: "Historical progress",
            at: 1,
          },
          {
            id: "history-worker",
            role: "user",
            text: "Worker report\n\nWorker verification details",
            at: 2,
            delivery: {
              id: "history-worker",
              source: "worker",
              status: "sent",
              text: "",
              at: 2,
              questionIds: [],
            },
          },
          {
            id: "history-reviewer",
            role: "user",
            text: "Reviewer report\n\nReviewer verification details",
            at: 2,
            delivery: {
              id: "history-reviewer",
              source: "reviewer",
              status: "sent",
              text: "",
              at: 2,
              questionIds: [],
            },
          },
          {
            id: "history-researcher",
            role: "user",
            text: "Researcher report\n\nResearcher evidence details",
            at: 2,
            delivery: {
              id: "history-researcher",
              source: "researcher",
              status: "sent",
              text: "",
              at: 2,
              questionIds: [],
            },
          },
          {
            id: "history-question",
            clientId: "report:reviewer:question",
            role: "user",
            text: "Reviewer needs a decision\n\nWhich history evidence?",
            at: 2,
            delivery: {
              id: "report:reviewer:question",
              source: "reviewer",
              status: "sent",
              text: "",
              at: 2,
              questionIds: [],
            },
          },
          {
            id: "history-direct-question",
            role: "assistant",
            kind: "progress",
            questionItemId: "history-direct-question",
            text: "Question directly to user",
            at: 2,
          },
          {
            id: "history-result",
            role: "assistant",
            kind: "result",
            text: "Historical result",
            at: 2,
          },
        ],
        nextCursor: null,
      },
    });
  });
  await newSession(page);
  await page
    .getByRole("option", { name: "Codex for Love", exact: true })
    .click();
  await page.getByRole("button", { name: "Find history", exact: true }).click();
  await page
    .locator(".history-result")
    .filter({ hasText: "Streaming voice input" })
    .click();
  const transcript = page.locator(".history-transcript");
  await expect(transcript).toContainText("Historical result");
  const question = transcript
    .locator(".worker-report")
    .filter({ hasText: "Which history evidence?" });
  await expect(question).toHaveCount(0);
  await expect(transcript).toContainText("Question directly to user");
  await expect(
    transcript.getByRole("button", { name: "View questions and answers" }),
  ).toBeVisible();
  await transcript.getByRole("button", { name: "Work details 1" }).click();
  await expect(transcript).toContainText("Historical progress");
  await expect(transcript.locator(".worker-report")).toHaveCount(0);
});
