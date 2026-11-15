import { expect, test } from "@playwright/test";
import { openSidebar } from "./browser-actions";

const origin = "http://127.0.0.1:14320";

for (const mode of ["failure", "unknown"] as const) {
  test(`member ${mode} reports stay hidden while Orc questions remain visible`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset");
    expect(
      (
        await request.post(origin + "/fixture/member-recovery", {
          data: { mode },
          timeout: 60000,
        })
      ).ok(),
    ).toBe(true);
    await page.goto(origin);
    await openSidebar(page);
    await page
      .getByRole("button", {
        name: "Open Recovery diagnostic Orc",
        exact: true,
      })
      .last()
      .click();
    await expect(page.locator(".conversation-loading")).toHaveCount(0);
    const errors = page.locator(".delivery-error");
    await expect(errors).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Earlier submissions", exact: true }),
    ).toHaveCount(0);
    const initial = await (
      await request.get(origin + "/fixture/member-recovery-state")
    ).json();
    expect(initial.status).toBe(mode === "failure" ? "failed" : "uncertain");
    expect(initial.sends).toBe(1);
    if (mode === "failure") {
      await request.post(origin + "/fixture/member-recovery-hold", {
        data: { outcome: "uncertain" },
      });
      try {
        await request.post(origin + "/fixture/member-recovery-retry");
        await expect
          .poll(
            async () =>
              (
                await (
                  await request.get(origin + "/fixture/member-recovery-state")
                ).json()
              ).status,
          )
          .toBe("sending");
        await expect(errors).toHaveCount(0);
      } finally {
        await request.post(origin + "/fixture/member-recovery-release");
      }
      await expect
        .poll(
          async () =>
            (
              await (
                await request.get(origin + "/fixture/member-recovery-state")
              ).json()
            ).status,
        )
        .toBe("uncertain");
    } else {
      await request.post(origin + "/fixture/member-recovery-confirm");
      await expect
        .poll(
          async () =>
            (
              await (
                await request.get(origin + "/fixture/member-recovery-state")
              ).json()
            ).status,
        )
        .toBe("sent");
      await request.post(origin + "/fixture/member-recovery-error");
    }
    await request.post(origin + "/fixture/member-recovery-questions");
    await expect(
      page.getByText("Orc question #150", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Member question #150", { exact: true }),
    ).toHaveCount(0);
    await page.locator(".question-panel textarea").fill("User answer #150");
    await page
      .locator(".question-panel")
      .getByRole("button", { name: "Send all answers", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(origin + "/fixture/member-recovery-state")
            ).json()
          ).orcQuestion,
      )
      .toBe("answered");
    await expect(errors).toHaveCount(0);
    await expect(
      page.getByText("Target failed #150", { exact: true }),
    ).toHaveCount(0);
    const final = await (
      await request.get(origin + "/fixture/member-recovery-state")
    ).json();
    expect(final.sends).toBe(mode === "failure" ? 2 : 1);
  });
}

for (const older of [false, true]) {
  test(`reconnect retains history behind filtered pages with older cursor ${older}`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset");
    const setup = await (
      await request.post(origin + "/fixture/member-gap", { data: { older } })
    ).json();
    await page.goto(origin);
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Open Gap diagnostic Orc", exact: true })
      .click();
    await expect(page.getByText("Old gap #150", { exact: true })).toBeVisible();
    await request.post(origin + "/fixture/offline");
    await expect(
      page.getByText("Connection lost. Reconnecting…", { exact: true }),
    ).toHaveCount(1);
    expect(
      (
        await request.post(origin + "/fixture/member-gap-append", {
          timeout: 60000,
        })
      ).ok(),
    ).toBe(true);
    const refresh = page.waitForResponse(
      (r) =>
        r.url().includes("/api/read/messages?") &&
        new URL(r.url()).searchParams.get("agent") === setup.id &&
        !new URL(r.url()).searchParams.has("cursor"),
    );
    await request.post(origin + "/fixture/online");
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    if (await retry.count()) await retry.first().click();
    const latest = await (await refresh).json();
    expect(latest.messages).toEqual([]);
    expect(latest.nextCursor).toBeTruthy();
    const earlier = page.getByRole("button", {
      name: "Load earlier messages",
      exact: true,
    });
    let found = false;
    for (let i = 0; i < 8 && !found; i++) {
      await expect(earlier).toBeVisible();
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/api/read/messages?") &&
          new URL(r.url()).searchParams.has("cursor"),
      );
      await earlier.click();
      const data = await (await response).json();
      found = data.messages.some(
        (m: { id: string }) => m.id === "native-gap-middle",
      );
    }
    expect(found).toBe(true);
    await page.keyboard.press("Meta+ArrowDown");
    await expect(
      page.getByText("Middle gap #150", { exact: true }),
    ).toBeVisible();
  });
}
