import { test, expect } from "@playwright/test";
import sharp from "sharp";
const origin = "http://127.0.0.1:14319";
for (const kind of ["question", "message", "image", "image-remote"] as const) {
  test(`${kind}: dropped request is fenced and can be retried with a new identity`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(
      kind === "question"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
    );
    let captured: any;
    let dropped = false;
    const sends: any[] = [];
    await page.routeWebSocket("ws://127.0.0.1:14319/api/socket", (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((raw) => {
        const f = JSON.parse(String(raw));
        if (
          f.t === "call" &&
          f.args?.member === (kind === "question" ? "answerBatch" : "send")
        ) {
          sends.push(f.args.input);
          if (!dropped) {
            dropped = true;
            captured = f.args.input;
            // A dropped Chord frame leaves a gap in the link sequence. Close
            // both sides so recovery uses a fresh connection.
            ws.close({ code: 1011 });
            server.close({ code: 1011 });
            return;
          }
        }
        server.send(raw);
      });
      server.onMessage((raw) => ws.send(raw));
    });
    await request.post(origin + "/fixture/reset", {
      data: { mode: kind === "question" ? "working" : "no-workers" },
    });
    await page.goto(origin);
    if (kind === "question")
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await expect(input).toBeVisible();
    if (kind === "question") {
      await request.post(origin + "/fixture/change", {
        data: {
          question: true,
          questionId: "diag-pair",
          questionOptions: false,
        },
      });
      await page.locator(".question-panel textarea").fill("synthetic answer");
      await page.locator(".question-panel textarea").press("Enter");
    } else {
      if (kind === "image" || kind === "image-remote") {
        const buffer = await sharp({
          create: { width: 32, height: 32, channels: 4, background: "#3377aa" },
        })
          .png()
          .toBuffer();
        await page
          .getByLabel("Choose message images")
          .setInputFiles({ name: "owned.png", mimeType: "image/png", buffer });
        await expect(page.locator(".image-draft")).toHaveCount(1);
      }
      await input.fill("synthetic normal message");
      await input.press("Enter");
    }
    await expect.poll(() => captured, { timeout: 15000 }).toBeDefined();
    const operation = captured.operationId;
    expect(operation).toMatch(/^grove-v1-/);
    await page.evaluate((operation) => {
      for (const key of Object.keys(localStorage))
        if (key.includes("/outgoing/")) {
          const v = JSON.parse(localStorage.getItem(key)!);
          if (v.id === operation) {
            v.at = Date.now() - 61000;
            localStorage.setItem(key, JSON.stringify(v));
          }
        }
    }, operation);
    await page.reload();
    if (kind === "question")
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (kind === "question")
      await page.getByRole("button", { name: /pending question/ }).click();
    const root =
      kind === "question"
        ? page.locator(".question-panel")
        : page.locator(".agent-detail");
    await expect(
      root.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    let info = await (await request.get(origin + "/fixture/info")).json();
    expect(
      info.inputs.filter((x: any) => x.clientId === operation),
    ).toHaveLength(0);
    if (kind === "image-remote")
      await page.evaluate(
        async ({ agent, operation }) => {
          const name = (await indexedDB.databases()).find((d) =>
            d.name?.endsWith("/images"),
          )!.name!;
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open(name);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("drafts", "readwrite");
            tx.objectStore("drafts").delete(`operation/${agent}/${operation}`);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          db.close();
        },
        { agent: captured.id, operation },
      );
    await root.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => sends.length, { timeout: 15000 }).toBe(2);
    expect(sends[1].operationId).not.toBe(operation);
    if (kind === "image" || kind === "image-remote") {
      expect(captured.images).toHaveLength(1);
      expect(sends[1].images).toHaveLength(1);
    }
    await expect
      .poll(
        async () => {
          const i = await (await request.get(origin + "/fixture/info")).json();
          return i.inputs.filter(
            (x: any) => x.clientId === sends[1].operationId,
          ).length;
        },
        { timeout: 15000 },
      )
      .toBe(1);
    info = await (await request.get(origin + "/fixture/info")).json();
    expect(
      info.inputs.filter((x: any) => x.clientId === operation),
    ).toHaveLength(0);
  });
}
test("a lost reservation response leaves the message and image draft intact", async ({
  page,
  request,
}) => {
  let reserve = 0,
    sends = 0;
  await page.routeWebSocket("ws://127.0.0.1:14319/api/socket", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const f = JSON.parse(String(raw));
      if (f.t === "call" && f.args?.member === "reserveSubmission") {
        reserve++;
        ws.close();
        return;
      }
      if (f.t === "call" && f.args?.member === "send") sends++;
      server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  const buffer = await sharp({
    create: { width: 32, height: 32, channels: 4, background: "#3377aa" },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel("Choose message images")
    .setInputFiles({ name: "owned.png", mimeType: "image/png", buffer });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input.fill("keep this draft");
  await input.press("Enter");
  await expect.poll(() => reserve).toBe(1);
  await expect(input).toHaveValue("keep this draft");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  expect(sends).toBe(0);
  const rows = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.includes("/outgoing/")),
  );
  expect(rows).toHaveLength(0);
});

for (const uploaded of [false, true]) {
  test(`image preparation interrupted ${uploaded ? "after" : "before"} upload converges without sending`, async ({
    page,
    context,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "no-workers" },
    });
    let intercepted = false,
      release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/images?*", async (route) => {
      if (route.request().method() === "POST" && !intercepted) {
        if (uploaded) await route.fetch();
        intercepted = true;
        await held;
        try {
          await route.abort();
        } catch {
          /* closed with the tab */
        }
      } else await route.continue();
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const buffer = await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#3377aa" },
    })
      .png()
      .toBuffer();
    await page
      .getByLabel("Choose message images")
      .setInputFiles({ name: "owned.png", mimeType: "image/png", buffer });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("interrupted image preparation");
    await input.press("Enter");
    await expect.poll(() => intercepted).toBe(true);
    const journal = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((k) =>
        k.includes("/outgoing/"),
      )!;
      const v = JSON.parse(localStorage.getItem(k)!);
      v.at = Date.now() - 61000;
      localStorage.setItem(k, JSON.stringify(v));
      return v;
    });
    await page.close();
    release();
    const next = await context.newPage();
    await next.goto(origin);
    await next
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await expect(
      next
        .locator(".agent-detail")
        .getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    const info = await (await request.get(origin + "/fixture/info")).json();
    expect(
      info.inputs.filter((x: any) => x.clientId === journal.id),
    ).toHaveLength(0);
    const stored = await next.evaluate(
      (id) =>
        Object.keys(localStorage)
          .filter((k) => k.includes("/outgoing/"))
          .map((k) => JSON.parse(localStorage.getItem(k)!))
          .find((x) => x.id === id),
      journal.id,
    );
    expect(stored.images).toHaveLength(1);
    expect(stored.status).toBe("failed");
  });
}

test("simultaneous retries of one rejected message do not send it twice", async ({
  page: first,
  context,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "rejected" },
  });
  const second = await context.newPage();
  const held: (() => void)[] = [],
    sends: string[] = [],
    tokens: string[] = [];
  for (const page of [first, second])
    await page.routeWebSocket("ws://127.0.0.1:14319/api/socket", (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.t === "call" && frame.args?.member === "send") {
          sends.push(frame.args.input.operationId);
          if (frame.args.input.claimToken)
            tokens.push(frame.args.input.claimToken);
        }
        if (frame.t === "call" && frame.args?.member === "reserveRetry") {
          held.push(() => server.send(raw));
          return;
        }
        server.send(raw);
      });
      server.onMessage((raw) => ws.send(raw));
    });
  await first.goto(origin);
  await first
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const text = "original failed shared message";
  const input = first.getByRole("textbox", {
    name: "Message Orc",
    exact: true,
  });
  await input.fill(text);
  await input.press("Enter");
  const retry = (page: typeof first) =>
    page
      .locator(".user-message")
      .filter({ hasText: text })
      .getByRole("button", { name: "Retry", exact: true });
  await expect(retry(first)).toBeVisible();
  await second.goto(origin);
  await second
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect(retry(second)).toBeVisible();
  const original = sends[0];
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "held" },
  });
  await Promise.all([retry(first).click(), retry(second).click()]);
  await expect.poll(() => held.length, { timeout: 10000 }).toBe(2);
  for (const send of held) send();
  await expect
    .poll(() => sends.filter((id) => id !== original).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
  await expect(
    first.locator(".user-message").filter({ hasText: text }),
  ).toHaveCount(2);
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "accepted" },
  });
  await expect(
    first.locator(".user-message").filter({ hasText: text }),
  ).toHaveCount(1);
  await expect(
    second.locator(".user-message").filter({ hasText: text }),
  ).toHaveCount(1);
  expect(sends.filter((id) => id !== original)).toHaveLength(1);
  expect(tokens).toHaveLength(1);
  for (const page of [first, second])
    expect(
      await page.evaluate(
        (token) =>
          Object.keys(localStorage).some((key) =>
            localStorage.getItem(key)?.includes(token),
          ),
        tokens[0],
      ),
    ).toBe(false);
  await first.reload();
  await first
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect(
    first.locator(".user-message").filter({ hasText: text }),
  ).toHaveCount(1);
});

test("lost retry reservation response is inspected without automatic resend or saving its token", async ({
  page,
  request,
}) => {
  let retryId: number | undefined,
    successor: string | undefined,
    claim: string | undefined,
    sends = 0,
    lost = false;
  await page.routeWebSocket("ws://127.0.0.1:14319/api/socket", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.t === "call" && frame.args?.member === "reserveRetry" && !lost)
        retryId = frame.id;
      if (frame.t === "call" && frame.args?.member === "send") sends++;
      server.send(raw);
    });
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (
        frame.t === "result" &&
        frame.id === retryId &&
        !lost &&
        frame.value?.value?.state === "won"
      ) {
        successor = frame.value.value.operationId;
        claim = frame.value.value.claimToken;
        lost = true;
        ws.close({ code: 1011 });
        return;
      }
      ws.send(raw);
    });
  });
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "rejected" },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("lost retry permit");
  await input.press("Enter");
  const retry = page
    .locator(".user-message")
    .filter({ hasText: "lost retry permit" })
    .getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => successor).toBeDefined();
  expect(claim).toBeTruthy();
  await page.reload();
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect(retry).toBeVisible();
  await retry.click();
  await expect
    .poll(
      async () =>
        await page.evaluate(
          (id) =>
            Object.keys(localStorage)
              .filter((k) => k.includes("/outgoing/"))
              .map((k) => JSON.parse(localStorage.getItem(k)!))
              .some((v) => v.id === id),
          successor,
        ),
    )
    .toBe(true);
  const journal = await page.evaluate(
    ({ id, claim }) => {
      const keys = Object.keys(localStorage);
      const data = keys.map((k) => localStorage.getItem(k) ?? "").join("\n");
      const key = keys.find(
        (k) =>
          k.includes("/outgoing/") &&
          JSON.parse(localStorage.getItem(k)!).id === id,
      )!;
      const value = JSON.parse(localStorage.getItem(key)!);
      value.at = Date.now() - 61000;
      localStorage.setItem(key, JSON.stringify(value));
      return { containsClaim: data.includes(claim!), value };
    },
    { id: successor, claim },
  );
  expect(journal.containsClaim).toBe(false);
  expect(journal.value.predecessor).toBeTruthy();
  await page.reload();
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect
    .poll(
      async () =>
        page.evaluate(
          (id) =>
            Object.keys(localStorage)
              .filter((k) => k.includes("/outgoing/"))
              .map((k) => JSON.parse(localStorage.getItem(k)!))
              .find((v) => v.id === id)?.status,
          successor,
        ),
      { timeout: 20000 },
    )
    .toBe("failed");
  expect(sends).toBe(1);
});
