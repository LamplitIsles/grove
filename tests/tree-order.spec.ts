import { expect, test } from "@playwright/test";
import { openSidebar } from "./browser-actions";

const origin = "http://127.0.0.1:14319";
test.use({ serviceWorkers: "block" });

test("opened sessions ignore previous manual order and are not draggable", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "org-groups-idle" },
  });
  await page.goto(origin);
  const rows = page
    .getByRole("region", { name: "Opened" })
    .locator(".session-open");
  await expect(rows.locator("strong")).toHaveText([
    "Streaming voice input",
    "Forge repository in the same organization",
  ]);
  const original = await rows.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-agent-id")!),
  );
  await page.evaluate((ids) => {
    const host = ids[0].split(":")[0];
    localStorage.setItem(
      `flickgrove/${location.origin}/tree-order`,
      JSON.stringify({ [host]: [...ids].reverse() }),
    );
  }, original);
  await page.reload();
  await expect(rows.locator("strong")).toHaveText([
    "Streaming voice input",
    "Forge repository in the same organization",
  ]);
  expect(
    await rows.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).draggable),
    ),
  ).toEqual([false, false]);
  await page.setViewportSize({ width: 390, height: 844 });
  await openSidebar(page);
  await expect(rows.locator("strong")).toHaveText([
    "Streaming voice input",
    "Forge repository in the same organization",
  ]);
});
