import { expect, test } from "@playwright/test";
import { openSidebar } from "./browser-actions";

for (const width of [1440, 390]) {
  test(`pending Stop remains visible while a send is pending at ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await request.post("/fixture/reset", { data: { mode: "working" } });
    await page.goto("/");
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await request.post("/fixture/change", {
      data: { sendMode: "held", stopMode: "held" },
    });
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("Steer while working");
    await input.press("Enter");
    const bubble = page
      .locator(".user-message")
      .filter({ hasText: "Steer while working" });
    await expect(bubble).toContainText("Sending");
    const localOrc = async () =>
      (await (await request.get("/fixture/info")).json()).localAgents.find(
        (agent: { id: string }) => agent.id === "orc",
      );
    await expect
      .poll(async () =>
        (await (await request.get("/fixture/info")).json()).orcDeliveries.some(
          (delivery: { status: string; source: string }) =>
            delivery.status === "sending" && delivery.source === "user",
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
    await expect
      .poll(async () => (await localOrc()).stop?.status)
      .toBe("pending");
    await expect(bubble).toContainText("Sending");
    await expect(page.locator(".detail-status")).toContainText("Stopping");
    await openSidebar(page);
    await expect(
      page
        .getByRole("button", { name: "Open Streaming voice input Orc" })
        .first()
        .getByRole("img", { name: "Stopping" }),
    ).toBeVisible();
    await request.post("/fixture/change", {
      data: { sendMode: "accepted", stopMode: "pending" },
    });
  });
  for (const projected of [false, true]) {
    test(`pending Stop is visible with${projected ? "" : "out"} current view at ${width}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await request.post("/fixture/reset", { data: { mode: "working" } });
      await page.goto("/");
      await openSidebar(page);
      await page
        .getByRole("button", { name: "Open Streaming voice input Orc" })
        .click();
      await request.post("/fixture/change", {
        data: {
          stopMode: "held",
          ...(projected
            ? {
                executionViews: [
                  { id: "orc", state: "working", keepState: true },
                ],
              }
            : {}),
        },
      });
      const localOrc = async () =>
        (await (await request.get("/fixture/info")).json()).localAgents.find(
          (agent: { id: string }) => agent.id === "orc",
        );
      expect((await localOrc()).currentExecution?.state).toBe(
        projected ? "working" : undefined,
      );
      await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
      await expect
        .poll(async () => (await localOrc()).stop?.status)
        .toBe("pending");
      expect((await localOrc()).currentExecution?.state).toBe(
        projected ? "working" : undefined,
      );
      await expect(page.locator(".detail-status")).toContainText("Stopping");
      await openSidebar(page);
      await expect(
        page
          .getByRole("button", { name: "Open Streaming voice input Orc" })
          .first()
          .getByRole("img", { name: "Stopping" }),
      ).toBeVisible();
      await request.post("/fixture/change", { data: { stopMode: "pending" } });
    });
  }
  test(`current execution is distinct from unresolved history at ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await request.post("/fixture/reset", { data: { mode: "working" } });
    await page.goto("/");
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const result = await request.post("/fixture/change", {
      data: {
        executionViews: [
          { id: "orc", state: "idle", interrupted: true },
          { id: "voice", state: "idle", interrupted: true },
        ],
      },
    });
    expect(result.ok()).toBeTruthy();
    await expect(page.locator(".detail-status")).toContainText("Idle");
    await expect(
      page.getByText("The previous response was interrupted."),
    ).toBeVisible();
    await expect(
      page.getByText(
        "App-server disconnected. Send a message to resume the thread.",
      ),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`current-idle-${width}.png`),
    });

    await openSidebar(page);
    const treeRoot = page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .first();
    await expect(treeRoot.getByRole("img", { name: "Idle" })).toBeVisible();
    const disclosure = treeRoot.locator("..").locator(".worker-disclosure");
    if ((await disclosure.getAttribute("aria-expanded")) !== "true")
      await disclosure.click();
    const worker = page
      .getByRole("button", { name: "Open Voice input Worker" })
      .first();
    await expect(worker.getByRole("img", { name: "Idle" })).toBeVisible();
    await expect(disclosure.locator(".worker-working-count")).toHaveCount(0);
    await request.post("/fixture/change", {
      data: { executionViews: [{ id: "voice", state: "working" }] },
    });
    await expect(worker.getByRole("img", { name: "Working" })).toBeVisible();
    await expect(disclosure.locator(".worker-working-count")).toContainText(
      "1",
    );
    await request.post("/fixture/change", {
      data: { executionViews: [{ id: "voice", state: null }] },
    });
    await expect(worker.getByRole("img", { name: "Working" })).toBeVisible();
  });

  test(`interrupted session remains usable during recovery at ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await request.post("/fixture/reset", { data: { mode: "working" } });
    await page.goto("/");
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await expect(input).toBeEnabled();
    await request.post("/fixture/change", {
      data: { complete: "interrupted" },
    });
    await expect(page.locator(".detail-status")).toContainText("Idle");
    await expect(
      page.getByText("The previous response was interrupted."),
    ).toBeInViewport();

    await request.post("/fixture/change", {
      data: { sessionConnection: { state: "connecting" }, sendMode: "held" },
    });
    await expect(page.getByText("Restoring conversation…")).toBeInViewport();
    await input.fill("Send while restoring");
    await input.press("Enter");
    const bubble = page
      .locator(".user-message")
      .filter({ hasText: "Send while restoring" });
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText("Sending");
    await input.fill("Next draft remains editable");
    await expect(input).toHaveValue("Next draft remains editable");
    await page.screenshot({
      path: testInfo.outputPath(`restoring-${width}.png`),
    });

    await request.post("/fixture/change", {
      data: {
        sessionConnection: {
          state: "failed",
          error: "Fixture connection failure ".repeat(100),
        },
        sendMode: "rejected",
      },
    });
    await expect(
      page.getByText("Could not restore this conversation."),
    ).toBeInViewport();
    await page.getByText("Details", { exact: true }).click();
    await expect(page.getByText("Fixture connection failure")).toBeVisible();
    expect(
      (await page.locator(".session-recovery-detail").boundingBox())!.height,
    ).toBeLessThanOrEqual(80);
    await expect(bubble.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(input).toHaveValue("Next draft remains editable");
    await expect(input).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`restore-failed-${width}.png`),
    });
  });
}
