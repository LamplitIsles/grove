import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:14319";

for (const kind of ["message", "question"] as const) {
  test(`dismissed legacy ${kind} remains local and native confirmation remains visible`, async ({
    page,
    browser,
    request,
  }) => {
    await page.setViewportSize(
      kind === "question"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
    );
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: kind === "question" ? "working" : "no-workers" },
    });
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "uncertain" },
    });
    await page.goto(origin);
    if (kind === "question")
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (kind === "question") {
      await request.post(`${origin}/fixture/change`, {
        data: {
          question: true,
          questionId: "legacy-q",
          questionOptions: false,
        },
      });
      await page
        .locator(".question-panel textarea")
        .fill("A synthetic legacy answer");
      await page.locator(".question-panel textarea").press("Enter");
    } else {
      await page
        .getByRole("textbox", { name: "Message Orc", exact: true })
        .fill("A synthetic legacy message");
      await page
        .getByRole("textbox", { name: "Message Orc", exact: true })
        .press("Enter");
    }
    const item = await expect
      .poll(
        async () =>
          page.evaluate(() =>
            Object.keys(localStorage)
              .filter((k) => k.includes("/outgoing/"))
              .map((k) => JSON.parse(localStorage.getItem(k)!))
              .find((x) => x.status === "uncertain" || x.status === "sending"),
          ),
        { timeout: 15000 },
      )
      .toBeTruthy()
      .then(async () =>
        page.evaluate(
          () =>
            Object.keys(localStorage)
              .filter((k) => k.includes("/outgoing/"))
              .map((k) => JSON.parse(localStorage.getItem(k)!))[0],
        ),
      );
    await expect
      .poll(
        async () =>
          (
            await (await request.get(`${origin}/fixture/info`)).json()
          ).orcDeliveries.find((d: any) => d.id === item.id)?.status,
      )
      .toBe("uncertain");
    await page.evaluate((id) => {
      for (const key of Object.keys(localStorage))
        if (key.includes("/outgoing/")) {
          const value = JSON.parse(localStorage.getItem(key)!);
          if (value.id === id) {
            delete value.admissionVersion;
            localStorage.setItem(key, JSON.stringify(value));
          }
        }
    }, item.id);
    await page.reload();
    if (kind === "question")
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (kind === "question")
      await page.getByRole("button", { name: /pending question/ }).click();
    await page.getByRole("button", { name: "Remove pending message" }).click();
    await page.getByRole("button", { name: "Remove from this device" }).click();
    await expect(
      page.getByRole("button", { name: "Remove pending message" }),
    ).toHaveCount(0);
    if (kind === "question")
      await expect(page.locator(".question-panel textarea")).toBeEnabled();
    else
      await expect(
        page
          .locator(".user-message")
          .filter({ hasText: "A synthetic legacy message" }),
      ).toHaveCount(0);
    await page.reload();
    if (kind === "question")
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (kind === "question") {
      await page.getByRole("button", { name: /pending question/ }).click();
      await expect(page.locator(".question-panel textarea")).toBeEnabled();
    } else
      await expect(
        page
          .locator(".user-message")
          .filter({ hasText: "A synthetic legacy message" }),
      ).toHaveCount(0);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(origin);
    await otherPage
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (kind === "message") {
      await otherPage
        .getByRole("button", { name: "Read full message" })
        .click();
      await expect(
        otherPage
          .locator(".user-message")
          .filter({ hasText: "A synthetic legacy message" }),
      ).toBeVisible();
    } else
      await expect(
        otherPage.locator(".question-panel .answer-batch"),
      ).toBeVisible();
    await other.close();
    const before = await (await request.get(`${origin}/fixture/info`)).json();
    expect(
      before.orcDeliveries.find((d: any) => d.id === item.id)?.status,
    ).toBe("uncertain");
    await request.post(`${origin}/fixture/change`, {
      data: {
        execution: {
          event: {
            type: "item",
            item: {
              type: "userMessage",
              id: `native-${item.id}`,
              clientId: item.id,
              text: item.text,
            },
          },
        },
      },
    });
    if (kind === "message")
      await expect(
        page
          .locator(".user-message")
          .filter({ hasText: "A synthetic legacy message" }),
      ).toBeVisible();
    else {
      await expect
        .poll(
          async () =>
            (
              await (await request.get(`${origin}/fixture/info`)).json()
            ).orcDeliveries.find((d: any) => d.id === item.id)?.status,
        )
        .toBe("sent");
      await expect(
        page
          .locator(".user-message")
          .filter({ hasText: "A synthetic legacy answer" }),
      ).toBeVisible();
    }
    const after = await (await request.get(`${origin}/fixture/info`)).json();
    expect(
      after.inputs.filter((x: any) => x.clientId === item.id),
    ).toHaveLength(1);
  });
}

for (const scenario of [
  "already dismissed",
  "dismissed during reservation",
] as const) {
  test(`question retry remains safe when an unknown answer is ${scenario}`, async ({
    page,
    context,
    request,
  }) => {
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "working" },
    });
    let release: (() => void) | undefined;
    await page.routeWebSocket("**/api/socket", (socket) => {
      const server = socket.connectToServer();
      let retryCall: number | undefined;
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (
          scenario === "dismissed during reservation" &&
          frame.args?.member === "reserveRetry"
        )
          retryCall = frame.id;
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.t === "result" && frame.id === retryCall && !release) {
          release = () => socket.send(message);
          return;
        }
        socket.send(message);
      });
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await request.post(`${origin}/fixture/change`, {
      data: {
        question: true,
        questionId: "retry-overlap",
        questionOptions: false,
        sendMode: "rejected",
      },
    });
    const question = page.locator(".question-panel");
    const questionId = await question
      .locator("[data-question-id]")
      .getAttribute("data-question-id");
    const agentId = await page.evaluate(() =>
      history.state.grove.details.at(-1),
    );
    await question.locator("textarea").fill("Failed separate answer");
    await question.locator("textarea").press("Enter");
    const retry = question.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    const failedId = await question
      .locator(".answer-batch")
      .getAttribute("data-operation-id");
    const before = (await (await request.get(`${origin}/fixture/info`)).json())
      .inputs.length;
    const second = await context.newPage();
    await second.goto(origin);
    const dismiss = () =>
      second.evaluate(
        ({ agentId, questionId }) => {
          const key = `flickgrove/${location.origin}/dismissed-pending/${encodeURIComponent(agentId)}/${encodeURIComponent("legacy-answer-no-row")}`;
          localStorage.setItem(
            key,
            JSON.stringify({ questionIds: [questionId] }),
          );
        },
        { agentId, questionId },
      );
    if (scenario === "already dismissed") {
      await dismiss();
      await expect(retry).toBeDisabled();
      await retry.dispatchEvent("click");
    } else {
      await retry.click();
      await expect.poll(() => !!release).toBe(true);
      await dismiss();
      release!();
      await expect
        .poll(async () =>
          page.evaluate(
            (failedId) =>
              Object.keys(localStorage)
                .filter((k) => k.includes("/outgoing/"))
                .map((k) => JSON.parse(localStorage.getItem(k)!))
                .some(
                  (item) =>
                    item.retryOf === failedId && !("claimToken" in item),
                ),
            failedId,
          ),
        )
        .toBe(true);
    }
    await expect(
      question.getByText(/earlier answer may have been received/i),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await request.get(`${origin}/fixture/info`)).json()).inputs
            .length,
      )
      .toBe(before);
    await page.waitForTimeout(500);
    expect(
      (await (await request.get(`${origin}/fixture/info`)).json()).inputs,
    ).toHaveLength(before);
    await page.reload();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await expect(
      question.getByText(/earlier answer may have been received/i),
    ).toBeVisible();
    await second.close();
  });
}

for (const width of [1440, 390]) {
  test(`dismissed answer without a server row cannot be submitted again at ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "working" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await request.post(`${origin}/fixture/change`, {
      data: {
        question: true,
        questionId: "legacy-missing",
        questionOptions: false,
      },
    });
    const question = page.locator(".question-panel");
    await expect(question.locator("textarea")).toBeVisible();
    const agentId = await page.evaluate(() =>
      history.state.grove.details.at(-1),
    );
    const questionId = await question
      .locator("[data-question-id]")
      .getAttribute("data-question-id");
    expect(questionId).toBeTruthy();
    await page.evaluate(
      ({ agentId, questionId }) => {
        const id = "legacy-answer-no-row";
        const key = `flickgrove/${location.origin}/outgoing/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`;
        localStorage.setItem(
          key,
          JSON.stringify({
            agentId,
            id,
            text: "Question: legacy\nAnswer: original",
            at: Date.now(),
            status: "uncertain",
            answers: [{ questionId, answer: "original" }],
          }),
        );
      },
      { agentId, questionId },
    );
    await page.reload();
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (!(await question.isVisible()))
      await page.getByRole("button", { name: /pending question/ }).click();
    await page.getByRole("button", { name: "Remove pending message" }).click();
    await page.getByRole("button", { name: "Remove from this device" }).click();
    await expect(question.locator("textarea")).toBeEnabled();
    await question.locator("textarea").fill("An edited answer");
    await expect(
      question.getByRole("button", { name: "Send all answers" }),
    ).toBeDisabled();
    await expect(
      question.getByText(/earlier answer may have been received/i),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`dismissed-question-${width}.png`),
    });
    const nativeBefore = (
      await (await request.get(`${origin}/fixture/info`)).json()
    ).inputs.length;
    await question
      .getByRole("button", { name: "Send all answers" })
      .dispatchEvent("click");
    await question.locator("textarea").press("Enter");
    let info = await (await request.get(`${origin}/fixture/info`)).json();
    expect(info.inputs).toHaveLength(nativeBefore);
    expect(
      info.orcDeliveries.some(
        (d: { id: string }) => d.id === "legacy-answer-no-row",
      ),
    ).toBe(false);
    await page.reload();
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (!(await question.isVisible()))
      await page.getByRole("button", { name: /pending question/ }).click();
    await expect(question.locator("textarea")).toHaveValue("An edited answer");
    await expect(
      question.getByRole("button", { name: "Send all answers" }),
    ).toBeDisabled();
    await question.locator("textarea").press("Enter");
    info = await (await request.get(`${origin}/fixture/info`)).json();
    expect(info.inputs).toHaveLength(nativeBefore);
  });
}
