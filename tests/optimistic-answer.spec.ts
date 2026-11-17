import { expect, test } from "@playwright/test";
import sharp from "sharp";

const origin = "http://127.0.0.1:14319";
test.use({ hasTouch: true });
for (const width of [1440, 390]) {
  test(`answers return to conversation while delivery is unresolved ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "working" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const composer = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await composer.fill("newer draft");
    await request.post(origin + "/fixture/change", {
      data: {
        question: true,
        questionId: "first",
        questionOptions: false,
        sendMode: "held",
      },
    });
    const panel = page.locator(".question-panel");
    if (!(await panel.isVisible()))
      await page.getByRole("button", { name: /pending question/ }).click();
    await panel.locator("textarea").fill("original answer");
    await panel.getByRole("button", { name: "Send all answers" }).click();
    await expect(panel).not.toBeVisible();
    await expect(composer).toHaveValue("newer draft");
    const answer = page
      .locator(".user-message")
      .filter({ hasText: "original answer" });
    await expect(answer).toHaveCount(1);
    await expect(answer.locator("[role=status]")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`answer-${width}.png`) });
    const beforeHeight = (await answer.boundingBox())!.height;
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "accepted" },
    });
    await expect(answer).toHaveCount(1);
    await expect(
      answer.getByRole("button", { name: "View questions and answers" }),
    ).toHaveCount(1);
    expect(
      Math.abs((await answer.boundingBox())!.height - beforeHeight),
    ).toBeLessThan(1);
    await expect(composer).toHaveValue("newer draft");
    const history = answer.getByRole("button", {
      name: "View questions and answers",
    });
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`answer-confirmed-${width}.png`),
    });
    const box = (await history.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".question-panel")).toContainText(
      "original answer",
    );
  });
}

for (const kind of ["message", "image", "answer"] as const) {
  test(`accepted ${kind} survives reload until native history arrives`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "working" },
    });
    await request.post(origin + "/fixture/change", {
      data: { nativeInput: "hold" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const text = `receipt before native ${kind}`;
    if (kind === "answer") {
      await request.post(origin + "/fixture/change", {
        data: {
          question: true,
          questionId: "receipt-first",
          questionOptions: false,
        },
      });
      await page.locator(".question-panel textarea").fill(text);
      await page
        .locator(".question-panel")
        .getByRole("button", { name: "Send all answers" })
        .click();
    } else {
      const composer = page.getByRole("textbox", {
        name: "Message Orc",
        exact: true,
      });
      if (kind === "image") {
        await page.getByLabel("Choose message images").setInputFiles({
          name: "receipt.png",
          mimeType: "image/png",
          buffer: await sharp({
            create: {
              width: 20,
              height: 20,
              channels: 3,
              background: "#406f91",
            },
          })
            .png()
            .toBuffer(),
        });
        await expect(page.locator(".image-draft")).toHaveCount(1);
      }
      await composer.fill(text);
      await composer.press("Enter");
    }
    const bubble = page.locator(".user-message").filter({ hasText: text });
    await expect(bubble).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await (await request.get(origin + "/fixture/info")).json())
            .heldNativeInputs,
      )
      .toBe(1);
    await expect
      .poll(() =>
        page.evaluate(
          (value) =>
            Object.keys(localStorage)
              .filter((key) => key.includes("/outgoing/"))
              .map((key) => JSON.parse(localStorage.getItem(key)!))
              .find((item) => item.text.includes(value))?.status,
          text,
        ),
      )
      .toBe("sent");
    await page.reload();
    await expect(bubble).toHaveCount(1);
    if (kind === "image")
      await expect(bubble.locator(".message-image")).toBeVisible();
    await expect(bubble.locator("[role=status]")).toHaveCount(0);
    await request.post(origin + "/fixture/change", {
      data: { nativeInput: "release" },
    });
    await expect(bubble).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(
          (value) =>
            Object.keys(localStorage)
              .filter((key) => key.includes("/outgoing/"))
              .some((key) =>
                JSON.parse(localStorage.getItem(key)!).text.includes(value),
              ),
          text,
        ),
      )
      .toBe(false);
    const info = await (await request.get(origin + "/fixture/info")).json();
    expect(
      info.inputs.filter((input: { text: string }) =>
        input.text.includes(text),
      ),
    ).toHaveLength(1);
  });
}

for (const kind of ["message", "answer"] as const) {
  test(`accepted ${kind} reconciles after native history leaves the recent window`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "working" },
    });
    await request.post(origin + "/fixture/change", {
      data: { nativeInput: "hold" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const text = `old accepted ${kind}`;
    if (kind === "answer") {
      await request.post(origin + "/fixture/change", {
        data: {
          question: true,
          questionId: "old-accepted-answer",
          questionOptions: false,
        },
      });
      await page.locator(".question-panel textarea").fill(text);
      await page
        .locator(".question-panel")
        .getByRole("button", { name: "Send all answers" })
        .click();
    } else {
      const composer = page.getByRole("textbox", {
        name: "Message Orc",
        exact: true,
      });
      await composer.fill(text);
      await composer.press("Enter");
    }
    await expect
      .poll(() =>
        page.evaluate(
          (value) =>
            Object.keys(localStorage)
              .filter((key) => key.includes("/outgoing/"))
              .map((key) => JSON.parse(localStorage.getItem(key)!))
              .find((entry) => entry.text.includes(value))?.status,
          text,
        ),
      )
      .toBe("sent");
    const operation = await page.evaluate(
      (value) =>
        Object.keys(localStorage)
          .filter((key) => key.includes("/outgoing/"))
          .map((key) => JSON.parse(localStorage.getItem(key)!))
          .find((entry) => entry.text.includes(value)).id,
      text,
    );
    await request.post(origin + "/fixture/change", { data: { outage: true } });
    await expect(page.locator(".host-outage")).toBeVisible();
    await request.post(origin + "/fixture/change", {
      data: { nativeInput: "release" },
    });
    await request.post(origin + "/fixture/change", {
      data: { laterSubmissions: 105 },
    });
    let observedNative = false;
    page.on("response", async (response) => {
      if (
        !/\/api\/read\/(?:messages|window)\?/.test(response.url()) ||
        !response.ok()
      )
        return;
      const body = await response.json().catch(() => null);
      if (
        body?.messages?.some(
          (message: { clientId?: string; provisional?: boolean }) =>
            message.clientId === operation && !message.provisional,
        )
      )
        observedNative = true;
    });
    await request.post(origin + "/fixture/change", { data: { outage: false } });
    await expect.poll(() => observedNative, { timeout: 20000 }).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          (value) =>
            Object.keys(localStorage)
              .filter((key) => key.includes("/outgoing/"))
              .some(
                (key) => JSON.parse(localStorage.getItem(key)!).id === value,
              ),
          operation,
        ),
      )
      .toBe(false);
    await page.reload();
    await expect(
      page
        .locator(".user-message")
        .filter({ hasText: "Owned later input 104" }),
    ).toHaveCount(1);
    await expect(
      page.locator(".user-message").filter({ hasText: text }),
    ).toHaveCount(0);
    const info = await (await request.get(origin + "/fixture/info")).json();
    expect(
      info.inputs.filter(
        (input: { clientId?: string }) => input.clientId === operation,
      ),
    ).toHaveLength(1);
  });
}

test("a failed old-history read keeps an accepted journal until native evidence arrives", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await request.post(origin + "/fixture/change", {
    data: { nativeInput: "hold" },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const text = "accepted before unavailable history";
  const composer = page.getByRole("textbox", {
    name: "Message Orc",
    exact: true,
  });
  await composer.fill(text);
  await composer.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          Object.keys(localStorage)
            .filter((key) => key.includes("/outgoing/"))
            .map((key) => JSON.parse(localStorage.getItem(key)!))
            .find((entry) => entry.text === value)?.status,
        text,
      ),
    )
    .toBe("sent");
  const operation = await page.evaluate(
    (value) =>
      Object.keys(localStorage)
        .filter((key) => key.includes("/outgoing/"))
        .map((key) => JSON.parse(localStorage.getItem(key)!))
        .find((entry) => entry.text === value).id,
    text,
  );
  await request.post(origin + "/fixture/change", {
    data: { nativeInput: "defer" },
  });
  await request.post(origin + "/fixture/change", {
    data: { laterSubmissions: 105 },
  });
  let failedReads = 0;
  await page.route("**/api/read/messages?*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      failedReads++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Synthetic history outage"}',
      });
    } else await route.continue();
  });
  await page.reload();
  await expect.poll(() => failedReads, { timeout: 15000 }).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      (id) =>
        Object.keys(localStorage)
          .filter((key) => key.includes("/outgoing/"))
          .map((key) => JSON.parse(localStorage.getItem(key)!))
          .find((entry) => entry.id === id)?.status,
      operation,
    ),
  ).toBe("sent");
  const before = await (await request.get(origin + "/fixture/info")).json();
  expect(
    before.inputs.filter(
      (input: { clientId?: string }) => input.clientId === operation,
    ),
  ).toHaveLength(1);
  await page.unroute("**/api/read/messages?*");
  await request.post(origin + "/fixture/change", {
    data: { nativeInput: "release" },
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          Object.keys(localStorage)
            .filter((key) => key.includes("/outgoing/"))
            .some((key) => JSON.parse(localStorage.getItem(key)!).id === id),
        operation,
      ),
    )
    .toBe(false);
});

test("a transient old-history failure is retried without a new native event", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await request.post(origin + "/fixture/change", {
    data: {
      nativeInput: "hold",
      question: true,
      questionId: "retry-old-history",
      questionOptions: false,
    },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const answer = "answer in old history after outage";
  await page.locator(".question-panel textarea").fill(answer);
  await page
    .locator(".question-panel")
    .getByRole("button", { name: "Send all answers" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          Object.keys(localStorage)
            .filter((key) => key.includes("/outgoing/"))
            .map((key) => JSON.parse(localStorage.getItem(key)!))
            .find((entry) => entry.text.includes(value))?.status,
        answer,
      ),
    )
    .toBe("sent");
  const operation = await page.evaluate(
    (value) =>
      Object.keys(localStorage)
        .filter((key) => key.includes("/outgoing/"))
        .map((key) => JSON.parse(localStorage.getItem(key)!))
        .find((entry) => entry.text.includes(value)).id,
    answer,
  );
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await expect(page.locator(".host-outage")).toBeVisible();
  // Populate native history without publishing this input to the browser.
  await request.post(origin + "/fixture/change", {
    data: { nativeInput: "history-only" },
  });
  await request.post(origin + "/fixture/change", {
    data: { laterSubmissions: 105 },
  });
  const agent = await page.evaluate(() => history.state.grove.details.at(-1));
  const detail = await (
    await request.get(origin + "/fixture/agents/" + encodeURIComponent(agent))
  ).json();
  expect(
    detail.messages.some(
      (message: { clientId?: string }) => message.clientId === operation,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      (id) =>
        Object.keys(localStorage)
          .filter((key) => key.includes("/outgoing/"))
          .some((key) => JSON.parse(localStorage.getItem(key)!).id === id),
      operation,
    ),
  ).toBe(true);
  let failedReads = 0,
    firstFailureAt = 0,
    firstRecoveryAt = 0,
    allowReads = false,
    observedNative = false;
  await page.route("**/api/read/messages?*", async (route) => {
    if (
      !allowReads &&
      new URL(route.request().url()).searchParams.has("cursor")
    ) {
      failedReads++;
      firstFailureAt ||= Date.now();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Synthetic history outage"}',
      });
    } else {
      if (
        allowReads &&
        new URL(route.request().url()).searchParams.has("cursor")
      )
        firstRecoveryAt ||= Date.now();
      await route.continue();
    }
  });
  page.on("response", async (response) => {
    if (!response.url().includes("/api/read/messages?") || !response.ok())
      return;
    const body = await response.json().catch(() => null);
    if (
      body?.messages?.some(
        (message: { clientId?: string; provisional?: boolean }) =>
          message.clientId === operation && !message.provisional,
      )
    )
      observedNative = true;
  });
  await request.post(origin + "/fixture/change", { data: { outage: false } });
  await expect.poll(() => failedReads, { timeout: 15000 }).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      (id) =>
        Object.keys(localStorage)
          .filter((key) => key.includes("/outgoing/"))
          .map((key) => JSON.parse(localStorage.getItem(key)!))
          .find((entry) => entry.id === id)?.status,
      operation,
    ),
  ).toBe("sent");
  allowReads = true;
  await expect.poll(() => observedNative, { timeout: 15000 }).toBe(true);
  expect(firstRecoveryAt - firstFailureAt).toBeGreaterThanOrEqual(1500);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          Object.keys(localStorage)
            .filter((key) => key.includes("/outgoing/"))
            .some((key) => JSON.parse(localStorage.getItem(key)!).id === id),
        operation,
      ),
    )
    .toBe(false);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.filter(
      (input: { clientId?: string }) => input.clientId === operation,
    ),
  ).toHaveLength(1);
});

test("a no-match history scan retries when native history later appears silently", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await request.post(origin + "/fixture/change", {
    data: {
      nativeInput: "hold",
      question: true,
      questionId: "retry-missing-history",
      questionOptions: false,
    },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const answer = "answer delayed in native history";
  await page.locator(".question-panel textarea").fill(answer);
  await page
    .locator(".question-panel")
    .getByRole("button", { name: "Send all answers" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          Object.keys(localStorage)
            .filter((key) => key.includes("/outgoing/"))
            .map((key) => JSON.parse(localStorage.getItem(key)!))
            .find((entry) => entry.text.includes(value))?.status,
        answer,
      ),
    )
    .toBe("sent");
  const operation = await page.evaluate(
    (value) =>
      Object.keys(localStorage)
        .filter((key) => key.includes("/outgoing/"))
        .map((key) => JSON.parse(localStorage.getItem(key)!))
        .find((entry) => entry.text.includes(value)).id,
    answer,
  );
  let reads = 0;
  page.on("response", (response) => {
    if (response.url().includes("/api/read/messages?") && response.ok())
      reads++;
  });
  await expect.poll(() => reads, { timeout: 12000 }).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      (id) =>
        Object.keys(localStorage)
          .filter((key) => key.includes("/outgoing/"))
          .some((key) => JSON.parse(localStorage.getItem(key)!).id === id),
      operation,
    ),
  ).toBe(true);
  await request.post(origin + "/fixture/change", {
    data: { nativeInput: "history-only" },
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            Object.keys(localStorage)
              .filter((key) => key.includes("/outgoing/"))
              .some((key) => JSON.parse(localStorage.getItem(key)!).id === id),
          operation,
        ),
      { timeout: 15000 },
    )
    .toBe(false);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.filter(
      (input: { clientId?: string }) => input.clientId === operation,
    ),
  ).toHaveLength(1);
});

test("history retry stops on session switch and resumes on return", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await request.post(origin + "/fixture/change", {
    data: { nativeInput: "hold" },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await request.post(origin + "/fixture/change", {
    data: { question: true, questionId: "retry-visit", questionOptions: false },
  });
  const answer = "answer while switching sessions";
  await page.locator(".question-panel textarea").fill(answer);
  await page
    .locator(".question-panel")
    .getByRole("button", { name: "Send all answers" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          Object.keys(localStorage)
            .filter((key) => key.includes("/outgoing/"))
            .map((key) => JSON.parse(localStorage.getItem(key)!))
            .find((entry) => entry.text.includes(value))?.status,
        answer,
      ),
    )
    .toBe("sent");
  const operation = await page.evaluate(
    (value) =>
      Object.keys(localStorage)
        .filter((key) => key.includes("/outgoing/"))
        .map((key) => JSON.parse(localStorage.getItem(key)!))
        .find((entry) => entry.text.includes(value)).id,
    answer,
  );
  const agent = await page.evaluate(() => history.state.grove.details.at(-1));
  let reads = 0;
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (
      url.pathname === "/api/read/messages" &&
      url.searchParams.get("agent") === agent
    )
      reads++;
  });
  await expect.poll(() => reads, { timeout: 12000 }).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await expect(page.getByRole("button", { name: "Edit title" })).toHaveText(
    "Reader performance",
  );
  await page.waitForTimeout(200);
  const stoppedAt = reads;
  await page.waitForTimeout(3200);
  expect(reads).toBe(stoppedAt);
  await request.post(origin + "/fixture/change", {
    data: { nativeInput: "history-only" },
  });
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            Object.keys(localStorage)
              .filter((key) => key.includes("/outgoing/"))
              .some((key) => JSON.parse(localStorage.getItem(key)!).id === id),
          operation,
        ),
      { timeout: 15000 },
    )
    .toBe(false);
});

test("question preparation failure keeps the draft and error in the open panel", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await request.post(origin + "/fixture/change", {
    data: {
      question: true,
      questionId: "storage-failure",
      questionOptions: false,
    },
  });
  const panel = page.locator(".question-panel");
  await panel.locator("textarea").fill("keep this answer");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes("/outgoing/"))
        throw new Error("Cannot save the answer on this device");
      return original.call(this, key, value);
    };
  });
  await panel.getByRole("button", { name: "Send all answers" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator("textarea")).toHaveValue("keep this answer");
  await expect(panel.getByRole("status")).toContainText(
    "Cannot save the answer on this device",
  );
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.filter(
      (input: { text: string }) => input.text.includes("keep this answer"),
    ),
  ).toHaveLength(0);
});

test("disconnect during answer reservation preserves the draft without sending", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await request.post(origin + "/fixture/change", {
    data: {
      question: true,
      questionId: "reservation-outage",
      questionOptions: false,
      reservation: "hold",
    },
  });
  const panel = page.locator(".question-panel");
  await panel.locator("textarea").fill("answer through outage");
  await panel.getByRole("button", { name: "Send all answers" }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/info")).json())
          .reservationWaiting,
    )
    .toBe(true);
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await expect(panel).toBeVisible();
  await expect(panel.locator("textarea")).toHaveValue("answer through outage");
  await expect(panel.getByRole("status")).not.toBeEmpty();
  await request.post(origin + "/fixture/change", {
    data: { reservation: "release", outage: false },
  });
  await expect(
    panel.getByRole("button", { name: "Send all answers" }),
  ).toBeEnabled({ timeout: 15000 });
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.filter(
      (input: { text: string }) => input.text.includes("answer through outage"),
    ),
  ).toHaveLength(0);
  await panel.getByRole("button", { name: "Send all answers" }).click();
  await expect(
    page.locator(".user-message").filter({ hasText: "answer through outage" }),
  ).toHaveCount(1);
});

test("unknown answers remain single and cannot be replayed, while new questions are answerable", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await request.post(origin + "/fixture/change", {
    data: {
      question: true,
      questionId: "unknown-answer",
      questionOptions: false,
      sendMode: "uncertain",
    },
  });
  const panel = page.locator(".question-panel");
  await panel.locator("textarea").fill("unconfirmed original");
  await panel.getByRole("button", { name: "Send all answers" }).click();
  const bubble = page
    .locator(".user-message")
    .filter({ hasText: "unconfirmed original" });
  await expect(panel).not.toBeVisible();
  await expect(bubble).toHaveCount(1);
  await expect(bubble.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await request.post(origin + "/fixture/change", {
    data: { question: true, questionId: "next-answer", questionOptions: false },
  });
  await expect(panel.getByRole("heading", { level: 3 })).toHaveText(
    "next-answer question 1",
  );
  await page.reload();
  await expect(bubble).toHaveCount(1);
  await expect(bubble.getByRole("button", { name: "Retry" })).toHaveCount(0);
  const info = await (await request.get(origin + "/fixture/info")).json();
  expect(
    info.inputs.filter((item: { text: string }) =>
      item.text.includes("unconfirmed original"),
    ),
  ).toHaveLength(1);
});

test("another browser can recover a failed answer outside the recent delivery window", async ({
  page,
  request,
  browser,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await request.post(origin + "/fixture/change", {
    data: {
      question: true,
      questionId: "remote-failure",
      questionOptions: false,
      sendMode: "rejected",
    },
  });
  await page
    .locator(".question-panel textarea")
    .fill("answer retained on owner");
  await page.locator(".question-panel textarea").press("Enter");
  await expect(
    page
      .locator(".user-message")
      .filter({ hasText: "answer retained on owner" })
      .getByRole("button", { name: "Retry" }),
  ).toBeVisible();
  const operation = await page.evaluate(
    () =>
      Object.keys(localStorage)
        .filter((key) => key.includes("/outgoing/"))
        .map((key) => JSON.parse(localStorage.getItem(key)!))
        .find((entry) => entry.text.includes("answer retained on owner"))?.id,
  );
  const initialState = await (
    await request.get(origin + "/fixture/info")
  ).json();
  expect(
    initialState.orcDeliveries.find(
      (entry: { id: string }) => entry.id === operation,
    )?.status,
  ).toBe("failed");
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "accepted", laterSubmissions: 105 },
  });
  const state = await (await request.get(origin + "/fixture/info")).json();
  expect(
    state.orcDeliveries.some((entry: { id: string }) => entry.id === operation),
  ).toBe(false);
  const context = await browser.newContext();
  try {
    const observer = await context.newPage();
    await observer.goto(origin);
    await observer
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const retry = observer
      .locator(".user-message")
      .filter({ hasText: "Synthetic rejection" })
      .getByRole("button", { name: "Retry" });
    for (let index = 0; index < 30 && !(await retry.isVisible()); index++) {
      await observer
        .locator(".conversation")
        .evaluate((element) =>
          element.scrollBy(0, -element.clientHeight * 0.8),
        );
      await observer.waitForTimeout(100);
    }
    await expect(retry).toBeVisible();
  } finally {
    await context.close();
  }
});
