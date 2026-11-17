import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:14319";

for (const { kind, current } of [
  { kind: "message", current: false },
  { kind: "question", current: false },
  { kind: "question", current: true },
] as const) {
  test(`dismissed ${current ? "current" : "legacy"} ${kind} remains local and native confirmation remains visible`, async ({
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
    if (!current)
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
    if (current)
      expect(
        await page.evaluate(
          (id) =>
            Object.keys(localStorage).some(
              (key) =>
                key.includes("/outgoing/") &&
                JSON.parse(localStorage.getItem(key)!).id === id,
            ),
          item.id,
        ),
      ).toBe(true);
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

for (const scenario of ["current journal", "server only"] as const) {
  test(`an unknown answer with ${scenario} can be dismissed and answered explicitly`, async ({
    page,
    request,
  }) => {
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "working" },
    });
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "uncertain" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await request.post(`${origin}/fixture/change`, {
      data: {
        question: true,
        questionId: "legacy-server",
        questionOptions: false,
      },
    });
    const question = page.locator(".question-panel");
    await question.locator("textarea").fill("First answer");
    await question.locator("textarea").press("Enter");
    const oldId = await expect
      .poll(async () => {
        const info = await (await request.get(`${origin}/fixture/info`)).json();
        return info.orcDeliveries.find(
          (d: { source: string; status: string }) =>
            d.source === "question" && d.status === "uncertain",
        )?.id;
      })
      .toBeTruthy()
      .then(async () => {
        const info = await (await request.get(`${origin}/fixture/info`)).json();
        return info.orcDeliveries.find(
          (d: { source: string; status: string }) =>
            d.source === "question" && d.status === "uncertain",
        ).id as string;
      });
    const storedBefore = await page.evaluate(
      ({ id, scenario }) => {
        for (const key of Object.keys(localStorage))
          if (key.includes("/outgoing/")) {
            const value = JSON.parse(localStorage.getItem(key)!);
            if (value.id === id) {
              if (scenario === "server only") localStorage.removeItem(key);
              return value.admissionVersion;
            }
          }
      },
      { id: oldId, scenario },
    );
    expect(storedBefore).toBe(1);
    await page.reload();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (!(await question.isVisible()))
      await page.getByRole("button", { name: /pending question/ }).click();
    const remove = page.getByRole("button", { name: "Remove pending message" });
    await expect(remove).toBeVisible();
    await expect(
      question.getByText("Answer delivery unconfirmed."),
    ).toBeVisible();
    await remove.click();
    await page.getByRole("button", { name: "Remove from this device" }).click();
    const retained = await page.evaluate(
      (id) =>
        Object.keys(localStorage).some(
          (key) =>
            key.includes("/outgoing/") &&
            JSON.parse(localStorage.getItem(key)!).id === id,
        ),
      oldId,
    );
    expect(retained).toBe(scenario === "current journal");
    await page.reload();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (!(await question.isVisible()))
      await page.getByRole("button", { name: /pending question/ }).click();
    await expect(
      question.getByText(/sending again may answer the question twice/i),
    ).toBeVisible();
    const before = (await (await request.get(`${origin}/fixture/info`)).json())
      .inputs.length;
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "accepted" },
    });
    await question.locator("textarea").fill("New answer");
    const send = question.getByRole("button", { name: "Send all answers" });
    await expect(send).toBeEnabled();
    await expect(
      question.getByText(/sending again may answer the question twice/i),
    ).toBeVisible();
    expect(
      (await (await request.get(`${origin}/fixture/info`)).json()).inputs,
    ).toHaveLength(before);
    await send.click();
    await expect
      .poll(
        async () =>
          (await (await request.get(`${origin}/fixture/info`)).json()).inputs
            .length,
      )
      .toBe(before + 1);
    const info = await (await request.get(`${origin}/fixture/info`)).json();
    expect(info.inputs.at(-1).text).toContain("New answer");
    expect(info.inputs.at(-1).clientId).not.toBe(oldId);
    expect(
      info.orcDeliveries.find((d: { id: string }) => d.id === oldId).status,
    ).toBe("uncertain");
  });
}

for (const scenario of [
  "already dismissed",
  "dismissed during reservation",
] as const) {
  test(`question retry remains available when an unknown answer is ${scenario}`, async ({
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
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "accepted" },
    });
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
      await expect(retry).toBeEnabled();
      await retry.click();
    } else {
      await retry.click();
      await expect.poll(() => !!release).toBe(true);
      await dismiss();
      release!();
    }
    await expect
      .poll(
        async () =>
          (await (await request.get(`${origin}/fixture/info`)).json()).inputs
            .length,
      )
      .toBe(before + 1);
    const info = await (await request.get(`${origin}/fixture/info`)).json();
    expect(info.inputs.at(-1).text).toContain("Failed separate answer");
    expect(info.inputs.at(-1).clientId).not.toBe(failedId);
    await second.close();
  });
}

for (const width of [1440, 390]) {
  test(`dismissed answer without a server row can be submitted again at ${width}`, async ({
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
    ).toBeEnabled();
    await expect(
      question.getByText(/earlier answer may have been received/i),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`dismissed-question-${width}.png`),
    });
    const nativeBefore = (
      await (await request.get(`${origin}/fixture/info`)).json()
    ).inputs.length;
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
    ).toBeEnabled();
    await question.getByRole("button", { name: "Send all answers" }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get(`${origin}/fixture/info`)).json()).inputs
            .length,
      )
      .toBe(nativeBefore + 1);
    info = await (await request.get(`${origin}/fixture/info`)).json();
    expect(info.inputs.at(-1).text).toContain("An edited answer");
    expect(info.inputs.at(-1).clientId).not.toBe("legacy-answer-no-row");
  });
}
