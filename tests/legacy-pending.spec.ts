import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:14319";

test("legacy unknown message stays visible and reconciles without replay", async ({
  page,
  request,
  browser,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await request.post(`${origin}/fixture/change`, {
    data: { sendMode: "uncertain" },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("A synthetic legacy message");
  await input.press("Enter");
  const item = await expect
    .poll(async () =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.includes("/outgoing/"))
          .map((k) => JSON.parse(localStorage.getItem(k)!))
          .find((entry) => entry.text === "A synthetic legacy message"),
      ),
    )
    .toBeTruthy()
    .then(() =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.includes("/outgoing/"))
          .map((k) => JSON.parse(localStorage.getItem(k)!))
          .find((entry) => entry.text === "A synthetic legacy message"),
      ),
    );
  await expect
    .poll(
      async () =>
        (
          await (await request.get(`${origin}/fixture/info`)).json()
        ).orcDeliveries.find((d: { id: string }) => d.id === item.id)?.status,
    )
    .toBe("uncertain");
  await page.evaluate((id) => {
    for (const key of Object.keys(localStorage))
      if (key.includes("/outgoing/")) {
        const entry = JSON.parse(localStorage.getItem(key)!);
        if (entry.id === id) {
          delete entry.admissionVersion;
          localStorage.setItem(key, JSON.stringify(entry));
        }
      }
  }, item.id);
  await page.reload();
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const bubble = page.locator(".user-message").filter({ hasText: item.text });
  await expect(bubble).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Remove pending message" }),
  ).toHaveCount(0);
  const other = await browser.newContext();
  try {
    const observer = await other.newPage();
    await observer.goto(origin);
    await observer
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await observer.getByRole("button", { name: "Read full message" }).click();
    await expect(
      observer.locator(".user-message").filter({ hasText: item.text }),
    ).toHaveCount(1);
  } finally {
    await other.close();
  }
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
  await expect(bubble).toHaveCount(1);
  const after = await (await request.get(`${origin}/fixture/info`)).json();
  expect(
    after.inputs.filter(
      (entry: { clientId: string }) => entry.clientId === item.id,
    ),
  ).toHaveLength(1);
});

for (const dismissed of [false, true]) {
  test(`legacy unknown question ${dismissed ? "with" : "without"} an earlier dismissal is never replayed`, async ({
    page,
    request,
  }) => {
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "working" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await request.post(`${origin}/fixture/change`, {
      data: {
        question: true,
        questionId: "legacy-unknown",
        questionOptions: false,
      },
    });
    const panel = page.locator(".question-panel");
    const questionId = await panel
      .locator("[data-question-id]")
      .getAttribute("data-question-id");
    const agentId = await page.evaluate(() =>
      history.state.grove.details.at(-1),
    );
    await page.evaluate(
      ({ agentId, questionId, dismissed }) => {
        const id = "legacy-answer-no-row";
        localStorage.setItem(
          `flickgrove/${location.origin}/outgoing/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`,
          JSON.stringify({
            agentId,
            id,
            text: "Question: legacy\nAnswer: original",
            at: Date.now(),
            status: "uncertain",
            answers: [{ questionId, answer: "original" }],
          }),
        );
        if (dismissed)
          localStorage.setItem(
            `flickgrove/${location.origin}/dismissed-pending/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`,
            JSON.stringify({ questionIds: [questionId] }),
          );
      },
      { agentId, questionId, dismissed },
    );
    const before = (await (await request.get(`${origin}/fixture/info`)).json())
      .inputs.length;
    await page.reload();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message Orc", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send all answers" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove pending message" }),
    ).toHaveCount(0);
    expect(
      (await (await request.get(`${origin}/fixture/info`)).json()).inputs,
    ).toHaveLength(before);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).some(
          (key) =>
            key.includes("/outgoing/") && key.endsWith("legacy-answer-no-row"),
        ),
      ),
    ).toBe(true);
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
    const bubble = page
      .locator(".user-message")
      .filter({ hasText: "Failed separate answer" });
    const retry = bubble.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    const failedId = await page.evaluate(
      () =>
        Object.keys(localStorage)
          .filter((k) => k.includes("/outgoing/"))
          .map((k) => JSON.parse(localStorage.getItem(k)!))
          .find((item) => item.text.includes("Failed separate answer"))?.id,
    );
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
