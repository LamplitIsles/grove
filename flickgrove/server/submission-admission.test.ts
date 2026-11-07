import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { FollowUpRejected, Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { DeliveryRejected } from "./runtime";
import { encodeFence, envelopeHash, parseFence } from "./submission-admission";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-admission-"));
  let runtime = new FakeRuntime();
  let app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
  );
  const a = await app.createOrc("alpha");
  return {
    get app() {
      return app;
    },
    get runtime() {
      return runtime;
    },
    id: a.id,
    restart() {
      app.dispose();
      runtime = new FakeRuntime();
      app = new Workspace({
        directory,
        runtime,
        projects: async () => fixtureProjects,
      });
    },
  };
}
const message = { source: "user" as const, text: "hello" };

test("independent reservations honor maintenance and shutdown gates", async () => {
  const f = await fixture();
  f.app.beginMaintenance();
  await expect(f.app.reserveSubmission(f.id)).rejects.toThrow("maintenance");
  f.app.endMaintenance();
  const first = await f.app.reserveSubmission(f.id);
  expect(first.operationId).toStartWith("grove-v1-");
  await f.app.prepareShutdown();
  await expect(f.app.reserveSubmission(f.id)).rejects.toThrow("shutting down");
  expect(f.runtime.inputs).toHaveLength(0);
});

test("independent reservations honor an in-progress tree settings operation", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.runtime.settingsOverride = async () => {
    entered.resolve();
    await gate.promise;
  };
  const updating = f.app.updateTreeFast(f.id, true);
  try {
    await entered.promise;
    await expect(f.app.reserveSubmission(f.id)).rejects.toThrow(
      "settings are being saved",
    );
    gate.resolve();
    await updating;
    expect((await f.app.reserveSubmission(f.id)).operationId).toStartWith(
      "grove-v1-",
    );
  } finally {
    gate.resolve();
    await updating.catch(() => {});
  }
});

test("follow-up refusal binds owner and content and preserves ordinary cancellation", async () => {
  const f = await fixture();
  const users = f.app.store.sqlite.query(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, color) VALUES (?, ?, ?, 0, ?, ?, ?)",
  );
  for (const id of ["alice", "bob"])
    users.run(
      id,
      id,
      `${id}@fixture.invalid`,
      "2026-01-01",
      "2026-01-01",
      "#123456",
    );
  await f.app.send(f.id, "start", "fixture-start");
  for (let i = 0; i < 50; i++)
    await f.app.enqueueFollowUp(
      f.id,
      `queued ${i}`,
      `queued-${i}`,
      undefined,
      "alice",
    );
  await expect(
    f.app.enqueueFollowUp(f.id, "once", "full", undefined, "alice"),
  ).rejects.toBeInstanceOf(FollowUpRejected);
  await expect(
    f.app.enqueueFollowUp(f.id, "once", "full", undefined, "bob"),
  ).rejects.toThrow("another user");
  await expect(
    f.app.enqueueFollowUp(f.id, "changed", "full", undefined, "alice"),
  ).rejects.toThrow("different content");
  await f.app.cancelFollowUp(f.id, "full");
  expect(f.app.lookupFollowUp(f.id, "full")).toMatchObject({
    status: "cancelled",
    error: "Follow-up queue is full",
  });
  await f.app.cancelFollowUp(f.id, "queued-0");
  expect(f.app.lookupFollowUp(f.id, "queued-0")).toMatchObject({
    status: "cancelled",
  });
  expect(f.app.lookupFollowUp(f.id, "queued-0")?.error).toBeUndefined();
  f.restart();
  await expect(
    f.app.enqueueFollowUp(f.id, "once", "full", undefined, "alice"),
  ).rejects.toBeInstanceOf(FollowUpRejected);
  expect(f.runtime.inputs).toHaveLength(0);
});

test("a second SQLite connection finalizing before claim cannot be overwritten or sent", async () => {
  const f = await fixture();
  const { operationId } = await f.app.reserveSubmission(f.id);
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const images = await f.app.uploadSubmissionImages(
    f.id,
    operationId,
    "hello",
    [new File([png], "x.png", { type: "image/png" })],
  );
  const envelope = { source: "user" as const, text: "hello", images };
  const path = (
    f.app.store.sqlite.query("PRAGMA database_list").get() as { file: string }
  ).file;
  const other = new Database(path);
  const validate = f.app.images.validate.bind(f.app.images);
  f.app.images.validate = (...args) => {
    const result = validate(...args);
    const raw = f.app.store.submissionFence(f.id, operationId)!;
    const fence = parseFence(raw);
    const rejected = encodeFence({
      state: "rejected",
      owner: fence.owner,
      hash: envelopeHash(envelope),
    });
    expect(
      other
        .query(
          "UPDATE submission_fences SET envelope_hash = ? WHERE session_id = ? AND operation_id = ? AND envelope_hash = ?",
        )
        .run(rejected, f.id, operationId, raw).changes,
    ).toBe(1);
    return result;
  };
  try {
    await expect(
      f.app.send(f.id, "hello", operationId, images, undefined, true),
    ).rejects.toThrow("reservation changed");
    expect(f.runtime.inputs).toHaveLength(0);
    f.restart();
    expect(
      await f.app.finalizeSubmission(f.id, operationId, envelope),
    ).toMatchObject({ state: "rejected" });
    expect(f.runtime.inputs).toHaveLength(0);
  } finally {
    other.close();
  }
});

test("reservations are unique, durable, session and human bound, and never invoke native", async () => {
  const f = await fixture();
  const first = await f.app.reserveSubmission(f.id, "alice");
  // A lost response is not an instruction to use or submit that operation.
  const second = await f.app.reserveSubmission(f.id, "alice");
  expect(first.operationId).not.toBe(second.operationId);
  expect(f.runtime.inputs).toHaveLength(0);
  f.restart();
  await expect(
    f.app.finalizeSubmission(f.id, first.operationId, message, "bob"),
  ).rejects.toThrow("another user");
  const other = await f.app.createOrc("alpha");
  expect(
    await f.app.finalizeSubmission(
      other.id,
      first.operationId,
      message,
      "alice",
    ),
  ).toBeNull();
  expect(
    await f.app.finalizeSubmission(f.id, first.operationId, message, "alice"),
  ).toMatchObject({ state: "rejected" });
  expect(f.runtime.inputs).toHaveLength(0);
});

test("finalize first persists an envelope-bound fence and blocks late sends after restart", async () => {
  const f = await fixture();
  const { operationId } = await f.app.reserveSubmission(f.id);
  expect(
    await f.app.finalizeSubmission(f.id, operationId, message),
  ).toMatchObject({ state: "rejected" });
  f.restart();
  await expect(
    f.app.send(f.id, "hello", operationId, undefined, undefined, true),
  ).rejects.toThrow("not admitted");
  await expect(
    f.app.uploadSubmissionImages(f.id, operationId, "hello", []),
  ).rejects.toThrow("no longer open");
  await expect(
    f.app.send(f.id, "changed", operationId, undefined, undefined, true),
  ).rejects.toThrow("different content");
  await expect(
    f.app.enqueueFollowUp(f.id, "hello", operationId),
  ).rejects.toThrow("direct submission");
  expect(f.runtime.inputs).toHaveLength(0);
});

test("submit first wins serialization, duplicate calls do not replay, and unknown remains unknown", async () => {
  const f = await fixture();
  const { operationId } = await f.app.reserveSubmission(f.id);
  const gate = Promise.withResolvers<string>();
  f.runtime.sendOverride = () => gate.promise;
  const sent = f.app.send(
    f.id,
    "hello",
    operationId,
    undefined,
    undefined,
    true,
  );
  while (!f.runtime.inputs.length) await Bun.sleep(1);
  const final = f.app.finalizeSubmission(f.id, operationId, message);
  gate.reject(new Error("native outcome unknown"));
  await sent;
  expect(await final).toBeNull();
  await f.app.send(f.id, "hello", operationId, undefined, undefined, true);
  expect(f.runtime.inputs).toHaveLength(1);
  f.restart();
  expect(await f.app.finalizeSubmission(f.id, operationId, message)).toBeNull();
  expect(f.runtime.inputs).toHaveLength(0);
});

test("legacy absence remains unknown and a failed reservation write cannot authorize a send", async () => {
  const f = await fixture();
  expect(
    await f.app.finalizeSubmission(f.id, "legacy-unknown", message),
  ).toBeNull();
  f.app.store.sqlite.exec(
    "CREATE TRIGGER fail_reserve BEFORE INSERT ON submission_fences BEGIN SELECT RAISE(ABORT, 'fixture reservation write failed'); END",
  );
  await expect(f.app.reserveSubmission(f.id)).rejects.toThrow(
    "fixture reservation write failed",
  );
  expect(f.runtime.inputs).toHaveLength(0);
});

test("question answer finalize binds its batch and cannot be bypassed by retry", async () => {
  const f = await fixture();
  await f.app.send(f.id, "start", "fixture-start");
  f.runtime.emit(f.id, {
    type: "item",
    turnId: f.app.detail(f.id).turnId!,
    item: {
      id: "q",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Continue?" }],
    },
  });
  const { operationId } = await f.app.reserveSubmission(f.id);
  const envelope = {
    source: "question" as const,
    answers: [{ questionId: "q:0", answer: "Yes" }],
  };
  expect(
    await f.app.finalizeSubmission(f.id, operationId, envelope),
  ).toMatchObject({ state: "rejected" });
  await expect(
    f.app.answerBatch(f.id, envelope.answers, operationId, undefined, true),
  ).rejects.toThrow("not admitted");
  await expect(
    f.app.answerBatch(
      f.id,
      [{ questionId: "q:0", answer: "No" }],
      operationId,
      undefined,
      true,
    ),
  ).rejects.toThrow("different content");
  expect(
    f.runtime.inputs.filter((input) => input.clientId === operationId),
  ).toHaveLength(0);
});

test("a failed claim transaction keeps the reservation and does not invoke native", async () => {
  const f = await fixture();
  const { operationId } = await f.app.reserveSubmission(f.id);
  f.app.store.sqlite.exec(
    "CREATE TRIGGER fail_claim BEFORE UPDATE ON submission_fences BEGIN SELECT RAISE(ABORT, 'fixture claim failed'); END",
  );
  await expect(
    f.app.send(f.id, "hello", operationId, undefined, undefined, true),
  ).rejects.toThrow("fixture claim failed");
  expect(f.runtime.inputs).toHaveLength(0);
  expect(
    f.app.store.sqlite
      .query("SELECT status FROM deliveries WHERE operation_id=?")
      .get(operationId),
  ).toBeNull();
  f.app.store.sqlite.exec("DROP TRIGGER fail_claim");
  f.restart();
  expect(
    await f.app.finalizeSubmission(f.id, operationId, message),
  ).toMatchObject({ state: "rejected" });
  expect(f.runtime.inputs).toHaveLength(0);
});

test("failed finalization stays unknown, preserves the reservation and cannot admit while storage failed", async () => {
  const f = await fixture();
  const { operationId } = await f.app.reserveSubmission(f.id);
  f.app.store.sqlite.exec(
    "CREATE TRIGGER fail_finalize BEFORE UPDATE ON submission_fences BEGIN SELECT RAISE(ABORT, 'fixture finalize failed'); END",
  );
  await expect(
    f.app.finalizeSubmission(f.id, operationId, message),
  ).rejects.toThrow("fixture finalize failed");
  await expect(
    f.app.send(f.id, "hello", operationId, undefined, undefined, true),
  ).rejects.toThrow("storage failed");
  expect(f.runtime.inputs).toHaveLength(0);
  f.app.store.sqlite.exec("DROP TRIGGER fail_finalize");
  f.restart();
  expect(
    await f.app.finalizeSubmission(f.id, operationId, message),
  ).toMatchObject({ state: "rejected" });
});

test("an admitted question answer is not replayed and binds its original question and answer", async () => {
  const f = await fixture();
  await f.app.send(f.id, "start", "fixture-start");
  const turnId = f.app.detail(f.id).turnId!;
  f.runtime.emit(f.id, {
    type: "item",
    turnId,
    item: {
      id: "q",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Continue?" }],
    },
  });
  const { operationId } = await f.app.reserveSubmission(f.id);
  const answers = [{ questionId: "q:0", answer: "Yes" }];
  await f.app.answerBatch(f.id, answers, operationId, undefined, true);
  expect(
    await f.app.finalizeSubmission(f.id, operationId, {
      source: "question",
      answers,
    }),
  ).toMatchObject({ state: "accepted" });
  await f.app.answerBatch(f.id, answers, operationId, undefined, true);
  await expect(
    f.app.answerBatch(
      f.id,
      [{ questionId: "q:0", answer: "No" }],
      operationId,
      undefined,
      true,
    ),
  ).rejects.toThrow("different content");
  expect(
    f.runtime.inputs.filter((input) => input.clientId === operationId),
  ).toHaveLength(1);
});

test("a failed question with unsynchronized native acceptance cannot be answered again", async () => {
  const f = await fixture();
  await f.app.send(f.id, "start", "fixture-start");
  const detail = f.app.detail(f.id);
  f.runtime.emit(f.id, {
    type: "item",
    turnId: detail.turnId!,
    item: {
      id: "q",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Continue?" }],
    },
  });
  const answers = [{ questionId: "q:0", answer: "Yes" }];
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.answerBatch(f.id, answers, old.operationId, undefined, true);
  expect(f.app.lookup(f.id, old.operationId)?.state).toBe("rejected");
  const oldNative = {
    id: "old-native-answer",
    clientId: old.operationId,
    role: "user" as const,
    text: "Question: Continue?\nAnswer: Yes",
    turnId: detail.turnId,
    at: 1,
  };
  f.runtime.historyItems.set(detail.threadId!, [
    oldNative,
    ...Array.from({ length: 31 }, (_, i) => ({
      id: `later-${i}`,
      role: "assistant" as const,
      text: "Later history",
      at: i + 2,
    })),
  ]);
  f.runtime.sendOverride = undefined;
  const next = await f.app.reserveSubmission(f.id);
  let error: unknown;
  try {
    await f.app.answerBatch(f.id, answers, next.operationId, undefined, true);
  } catch (caught) {
    error = caught;
  }
  expect(
    f.runtime.inputs.filter((v) => v.clientId === next.operationId),
  ).toHaveLength(0);
  expect(error).toBeInstanceOf(Error);
  expect(f.app.lookup(f.id, old.operationId)?.state).toBe("accepted");
  expect(f.app.questionHistory(f.id)[0]).toMatchObject({
    state: "answered",
    answer: "Yes",
  });
  expect(
    await f.app.finalizeSubmission(f.id, next.operationId, {
      source: "question",
      answers,
    }),
  ).toMatchObject({ state: "rejected" });
  f.restart();
  expect(f.app.lookup(f.id, old.operationId)?.state).toBe("accepted");
  expect(f.app.questionHistory(f.id)[0]).toMatchObject({
    state: "answered",
    answer: "Yes",
  });
});

async function failedQuestion() {
  const f = await fixture();
  await f.app.send(f.id, "start", "fixture-start");
  const detail = f.app.detail(f.id);
  f.runtime.emit(f.id, {
    type: "item",
    turnId: detail.turnId!,
    item: {
      id: "q",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Continue?" }],
    },
  });
  const answers = [{ questionId: "q:0", answer: "Yes" }];
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.answerBatch(f.id, answers, old.operationId, undefined, true);
  f.runtime.sendOverride = undefined;
  return { f, detail, answers, old };
}

test("a failed question is not retried when a later native history page is unavailable", async () => {
  const { f, detail, answers, old } = await failedQuestion();
  f.runtime.historyItems.set(
    detail.threadId!,
    Array.from({ length: 31 }, (_, i) => ({
      id: `history-${i}`,
      role: "assistant" as const,
      text: "History",
      at: i,
    })),
  );
  const history = f.runtime.historyMessages.bind(f.runtime);
  f.runtime.historyMessages = async (thread, cursor) => {
    if (cursor) throw new Error("Synthetic history unavailable");
    return history(thread, cursor);
  };
  const next = await f.app.reserveSubmission(f.id);
  await expect(
    f.app.answerBatch(f.id, answers, next.operationId, undefined, true),
  ).rejects.toThrow("Synthetic history unavailable");
  expect(
    f.runtime.inputs.filter((v) => v.clientId === next.operationId),
  ).toHaveLength(0);
  expect(f.app.lookup(f.id, old.operationId)?.state).toBe("rejected");
  expect(f.app.detail(f.id).questions[0].state).toBe("unanswered");
  expect(
    await f.app.finalizeSubmission(f.id, next.operationId, {
      source: "question",
      answers,
    }),
  ).toMatchObject({ state: "rejected" });
});

test("a native confirmation during history inspection prevents another answer", async () => {
  const { f, detail, answers, old } = await failedQuestion();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const history = f.runtime.historyMessages.bind(f.runtime);
  f.runtime.historyMessages = async (thread, cursor) => {
    entered.resolve();
    await release.promise;
    return history(thread, cursor);
  };
  const next = await f.app.reserveSubmission(f.id);
  const attempt = f.app.answerBatch(
    f.id,
    answers,
    next.operationId,
    undefined,
    true,
  );
  await entered.promise;
  f.runtime.emit(f.id, {
    type: "item",
    turnId: detail.turnId!,
    item: {
      type: "userMessage",
      id: "late-native-answer",
      clientId: old.operationId,
      text: "Question: Continue?\nAnswer: Yes",
    },
  });
  release.resolve();
  await expect(attempt).rejects.toThrow("remain unanswered");
  expect(
    f.runtime.inputs.filter((v) => v.clientId === next.operationId),
  ).toHaveLength(0);
  expect(f.app.lookup(f.id, old.operationId)?.state).toBe("accepted");
  expect(f.app.questionHistory(f.id)[0]).toMatchObject({
    state: "answered",
    answer: "Yes",
  });
});

test("concurrent new answer reservations serialize after a failed answer", async () => {
  const { f, answers, old } = await failedQuestion();
  const first = await f.app.reserveRetry(f.id, old.operationId);
  if (first.state !== "won") throw new Error("Expected winner");
  const second = await f.app.reserveSubmission(f.id);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const history = f.runtime.historyMessages.bind(f.runtime);
  f.runtime.historyMessages = async (thread, cursor) => {
    entered.resolve();
    await release.promise;
    return history(thread, cursor);
  };
  const firstAnswer = f.app.answerBatch(
    f.id,
    answers,
    first.operationId,
    undefined,
    true,
    { source: "question", answers },
    first.claimToken,
  );
  await entered.promise;
  const secondAnswer = f.app
    .answerBatch(f.id, answers, second.operationId, undefined, true)
    .then(
      () => null,
      (error: unknown) => error,
    );
  release.resolve();
  await firstAnswer;
  expect(await secondAnswer).toBeInstanceOf(Error);
  expect(
    f.runtime.inputs.filter((v) => v.clientId === first.operationId),
  ).toHaveLength(1);
  expect(
    f.runtime.inputs.filter((v) => v.clientId === second.operationId),
  ).toHaveLength(0);
  expect(f.app.questionHistory(f.id)[0]).toMatchObject({
    state: "answered",
    answer: "Yes",
  });
});

test("native positive evidence resolves the original ID without replay", async () => {
  const f = await fixture();
  const { operationId } = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new Error("native outcome unknown");
  };
  await f.app.send(f.id, "hello", operationId, undefined, undefined, true);
  expect(await f.app.inspectSubmission(f.id, operationId)).toBeNull();
  f.runtime.inspectOverride = async (_id, inspected) => ({
    accepted: inspected === operationId,
    settled: false,
    turnId: "confirmed-turn",
  });
  expect(await f.app.inspectSubmission(f.id, operationId)).toMatchObject({
    state: "accepted",
    turnId: "confirmed-turn",
  });
  expect(f.runtime.inputs).toHaveLength(1);
});

test("finalize binds validated original image references and rejects altered images", async () => {
  const f = await fixture();
  const { operationId } = await f.app.reserveSubmission(f.id);
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "blue" },
  })
    .png()
    .toBuffer();
  const images = await f.app.uploadSubmissionImages(
    f.id,
    operationId,
    "caption",
    [new File([bytes], "image.png", { type: "image/png" })],
  );
  const envelope = { source: "user" as const, text: "caption", images };
  expect(
    await f.app.finalizeSubmission(f.id, operationId, envelope),
  ).toMatchObject({ state: "rejected" });
  await expect(
    f.app.send(
      f.id,
      "caption",
      operationId,
      [{ ...images[0], name: "changed.png" }],
      undefined,
      true,
    ),
  ).rejects.toThrow("different content");
  await expect(
    f.app.send(f.id, "caption", operationId, images, undefined, true),
  ).rejects.toThrow("not admitted");
  expect(f.runtime.inputs).toHaveLength(0);
});

test("one linked retry wins, requires its private capability, and survives restart without replay", async () => {
  const f = await fixture();
  f.app.store.sqlite
    .query(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, color) VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .run("alice", "Alice", "alice@example.invalid", 1, 1, "#000000");
  const old = await f.app.reserveSubmission(f.id, "alice");
  await expect(
    f.app.reserveRetry(f.id, old.operationId, "alice"),
  ).rejects.toThrow("unknown");
  await f.app.finalizeSubmission(f.id, old.operationId, message, "alice");
  const results = await Promise.all([
    f.app.reserveRetry(f.id, old.operationId, "alice"),
    f.app.reserveRetry(f.id, old.operationId, "alice"),
  ]);
  const winner = results.find((r) => r.state === "won")!;
  const existing = results.find((r) => r.state === "existing")!;
  if (winner.state !== "won") throw new Error("Expected retry winner");
  expect(existing).toEqual({
    state: "existing",
    operationId: winner.operationId,
  });
  expect(f.app.store.submissionFence(f.id, winner.operationId)).not.toContain(
    winner.claimToken,
  );
  await expect(
    f.app.reserveRetry(f.id, old.operationId, "bob"),
  ).rejects.toThrow("another user");
  await expect(
    f.app.send(
      f.id,
      message.text,
      winner.operationId,
      undefined,
      "alice",
      true,
      message,
    ),
  ).rejects.toThrow("authorization");
  await expect(
    f.app.send(
      f.id,
      message.text,
      winner.operationId,
      undefined,
      "bob",
      true,
      message,
      winner.claimToken,
    ),
  ).rejects.toThrow("another user");
  await expect(
    f.app.send(
      f.id,
      "changed",
      winner.operationId,
      undefined,
      "alice",
      true,
      message,
      winner.claimToken,
    ),
  ).rejects.toThrow("differs");
  f.restart();
  expect(await f.app.reserveRetry(f.id, old.operationId, "alice")).toEqual(
    existing,
  );
  await f.app.send(
    f.id,
    message.text,
    winner.operationId,
    undefined,
    "alice",
    true,
    message,
    winner.claimToken,
  );
  await f.app.send(
    f.id,
    message.text,
    winner.operationId,
    undefined,
    "alice",
    true,
  );
  expect(
    f.runtime.inputs.filter((i) => i.clientId === winner.operationId),
  ).toHaveLength(1);
  await expect(
    f.app.send(f.id, message.text, old.operationId, undefined, "alice", true),
  ).rejects.toThrow("replaced");
  expect(
    await f.app.finalizeSubmission(f.id, old.operationId, message, "alice"),
  ).toMatchObject({ state: "rejected" });
});

test("lost retry response can only be finalized; old unknown and cross-session absence stay unknown", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  const other = await f.app.createOrc("alpha");
  await expect(f.app.reserveRetry(other.id, old.operationId)).rejects.toThrow(
    "unknown",
  );
  await expect(f.app.reserveRetry(f.id, "legacy-not-found")).rejects.toThrow(
    "unknown",
  );
  await expect(f.app.reserveRetry(f.id, old.operationId)).rejects.toThrow(
    "unknown",
  );
  await f.app.finalizeSubmission(f.id, old.operationId, message);
  const lost = await f.app.reserveRetry(f.id, old.operationId);
  if (lost.state !== "won") throw new Error("Expected winner");
  f.restart();
  const existing = await f.app.reserveRetry(f.id, old.operationId);
  expect(existing).toEqual({
    state: "existing",
    operationId: lost.operationId,
  });
  expect(
    await f.app.finalizeSubmission(
      f.id,
      existing.operationId,
      message,
      undefined,
      message,
    ),
  ).toMatchObject({ state: "rejected" });
  await expect(
    f.app.send(
      f.id,
      message.text,
      existing.operationId,
      undefined,
      undefined,
      true,
      message,
      lost.claimToken,
    ),
  ).rejects.toThrow("not admitted");
  const next = await f.app.reserveRetry(f.id, existing.operationId);
  expect(next.state).toBe("won");
  expect(f.runtime.inputs).toHaveLength(0);
});

test("retry reservation transaction rolls back both sides on successor insert failure", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  await f.app.finalizeSubmission(f.id, old.operationId, message);
  const original = f.app.store.submissionFence(f.id, old.operationId);
  f.app.store.sqlite.exec(
    "CREATE TRIGGER fail_retry_insert BEFORE INSERT ON submission_fences BEGIN SELECT RAISE(ABORT, 'retry insert failure'); END",
  );
  await expect(f.app.reserveRetry(f.id, old.operationId)).rejects.toThrow(
    "retry insert failure",
  );
  expect(f.app.store.submissionFence(f.id, old.operationId)).toBe(original);
  expect(
    f.app.store.sqlite
      .query("SELECT count(*) AS n FROM submission_fences")
      .get(),
  ).toEqual({ n: 1 });
  f.app.store.sqlite.exec("DROP TRIGGER fail_retry_insert");
  f.restart();
  expect((await f.app.reserveRetry(f.id, old.operationId)).state).toBe("won");
  expect(f.runtime.inputs).toHaveLength(0);
});

test("late original native acceptance blocks both retry reservation and claimed submission", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.send(
    f.id,
    message.text,
    old.operationId,
    undefined,
    undefined,
    true,
  );
  f.runtime.sendOverride = undefined;
  const thread = f.app.detail(f.id).threadId!;
  const winner = await f.app.reserveRetry(f.id, old.operationId);
  if (winner.state !== "won") throw new Error("Expected winner");
  await expect(
    f.app.deleteFailedSubmission(f.id, old.operationId),
  ).rejects.toThrow("retry");
  f.runtime.historyItems.set(thread, [
    {
      id: "native-old",
      clientId: old.operationId,
      role: "user",
      text: message.text,
      at: 1,
    },
  ]);
  await expect(
    f.app.send(
      f.id,
      message.text,
      winner.operationId,
      undefined,
      undefined,
      true,
      message,
      winner.claimToken,
    ),
  ).rejects.toThrow("Native history");
  expect(
    f.runtime.inputs.filter((i) => i.clientId === winner.operationId),
  ).toHaveLength(0);
  expect(f.app.lookup(f.id, old.operationId)?.state).toBe("accepted");
});

test("retry images require original fingerprints, including a recovered server original", async () => {
  const f = await fixture();
  const pixels = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const different = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const old = await f.app.reserveSubmission(f.id);
  const images = await f.app.uploadSubmissionImages(
    f.id,
    old.operationId,
    "hello",
    [new File([pixels], "picture.png")],
  );
  const original = { source: "user" as const, text: "hello", images };
  await f.app.finalizeSubmission(f.id, old.operationId, original);
  const bad = await f.app.reserveRetry(f.id, old.operationId);
  if (bad.state !== "won") throw new Error("Expected winner");
  const wrong = await f.app.uploadSubmissionImages(
    f.id,
    bad.operationId,
    "hello",
    [new File([different], "picture.png")],
  );
  await expect(
    f.app.send(
      f.id,
      "hello",
      bad.operationId,
      wrong,
      undefined,
      true,
      original,
      bad.claimToken,
    ),
  ).rejects.toThrow("Cannot verify");
  expect(f.runtime.inputs).toHaveLength(0);
  await expect(
    f.app.finalizeSubmission(
      f.id,
      bad.operationId,
      { source: "user", text: "hello", images: wrong },
      undefined,
      original,
    ),
  ).rejects.toThrow("Cannot verify");
  await f.app.finalizeSubmission(
    f.id,
    bad.operationId,
    original,
    undefined,
    original,
  );
  const next = await f.app.reserveRetry(f.id, bad.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  const full = f.app.images.read(f.id, images[0].id, false)!;
  const restored = await f.app.uploadSubmissionImages(
    f.id,
    next.operationId,
    "hello",
    [new File([full.bytes], "picture.png")],
  );
  await f.app.send(
    f.id,
    "hello",
    next.operationId,
    restored,
    undefined,
    true,
    original,
    next.claimToken,
  );
  expect(
    f.runtime.inputs.filter((i) => i.clientId === next.operationId),
  ).toHaveLength(1);
});

test("question retry preserves answers and requires a linked winner", async () => {
  const { f, answers, old } = await failedQuestion();
  const generic = await f.app.reserveSubmission(f.id);
  await expect(
    f.app.answerBatch(f.id, answers, generic.operationId, undefined, true),
  ).rejects.toThrow("linked reservation");
  const winner = await f.app.reserveRetry(f.id, old.operationId);
  if (winner.state !== "won") throw new Error("Expected winner");
  const predecessor = { source: "question" as const, answers };
  await expect(
    f.app.answerBatch(
      f.id,
      [{ ...answers[0], answer: "No" }],
      winner.operationId,
      undefined,
      true,
      predecessor,
      winner.claimToken,
    ),
  ).rejects.toThrow("differ");
  await f.app.answerBatch(
    f.id,
    answers,
    winner.operationId,
    undefined,
    true,
    predecessor,
    winner.claimToken,
  );
  expect(
    f.runtime.inputs.filter((i) => i.clientId === winner.operationId),
  ).toHaveLength(1);
});

test("unknown successor remains unknown across duplicate calls and restart", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  await f.app.finalizeSubmission(f.id, old.operationId, message);
  const winner = await f.app.reserveRetry(f.id, old.operationId);
  if (winner.state !== "won") throw new Error("Expected winner");
  f.runtime.sendOverride = async () => {
    throw new Error("Native response lost");
  };
  await f.app.send(
    f.id,
    message.text,
    winner.operationId,
    undefined,
    undefined,
    true,
    message,
    winner.claimToken,
  );
  await f.app.send(
    f.id,
    message.text,
    winner.operationId,
    undefined,
    undefined,
    true,
  );
  expect(
    f.runtime.inputs.filter((i) => i.clientId === winner.operationId),
  ).toHaveLength(1);
  expect(
    await f.app.finalizeSubmission(
      f.id,
      winner.operationId,
      message,
      undefined,
      message,
    ),
  ).toBeNull();
  await expect(f.app.reserveRetry(f.id, winner.operationId)).rejects.toThrow(
    "rejected",
  );
  f.restart();
  await f.app.send(
    f.id,
    message.text,
    winner.operationId,
    undefined,
    undefined,
    true,
  );
  expect(f.runtime.inputs).toHaveLength(0);
  await expect(f.app.reserveRetry(f.id, winner.operationId)).rejects.toThrow(
    "rejected",
  );
});

test("a late accepted ancestor blocks every later retry in a persisted chain", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.send(
    f.id,
    message.text,
    old.operationId,
    undefined,
    undefined,
    true,
  );
  f.runtime.sendOverride = undefined;
  const thread = f.app.detail(f.id).threadId!;
  const first = await f.app.reserveRetry(f.id, old.operationId);
  if (first.state !== "won") throw new Error("Expected winner");
  await f.app.finalizeSubmission(
    f.id,
    first.operationId,
    message,
    undefined,
    message,
  );
  const second = await f.app.reserveRetry(f.id, first.operationId);
  if (second.state !== "won") throw new Error("Expected winner");
  f.restart();
  f.runtime.historyItems.set(thread, [
    {
      id: "ancestor-native",
      clientId: old.operationId,
      role: "user",
      text: message.text,
      at: 1,
    },
  ]);
  await expect(
    f.app.send(
      f.id,
      message.text,
      second.operationId,
      undefined,
      undefined,
      true,
      message,
      second.claimToken,
    ),
  ).rejects.toThrow("Native history");
  expect(f.runtime.inputs).toHaveLength(0);
  expect(
    await f.app.finalizeSubmission(
      f.id,
      second.operationId,
      message,
      undefined,
      message,
    ),
  ).toMatchObject({ state: "rejected" });
  await expect(f.app.reserveRetry(f.id, second.operationId)).rejects.toThrow(
    "outcome changed",
  );
  expect(f.runtime.inputs).toHaveLength(0);
});

test("unavailable ancestor history leaves the rejected original unbound", async () => {
  const { f, old } = await failedQuestion();
  const before = f.app.store.submissionFence(f.id, old.operationId);
  f.runtime.historyMessages = async () => {
    throw new Error("History unavailable");
  };
  await expect(f.app.reserveRetry(f.id, old.operationId)).rejects.toThrow(
    "History unavailable",
  );
  expect(f.app.store.submissionFence(f.id, old.operationId)).toBe(before);
  expect(
    f.runtime.inputs.filter((i) => i.clientId === old.operationId),
  ).toHaveLength(1);
});

test("corrupt versioned retry fences fail closed", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  await f.app.finalizeSubmission(f.id, old.operationId, message);
  const next = await f.app.reserveRetry(f.id, old.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  const original = f.app.store.submissionFence(f.id, next.operationId)!;
  for (const corrupted of [
    original + ":unexpected",
    original.replace("v2:retry-reserved", "v3:retry-reserved"),
    original.replace(/:[A-Za-z0-9_-]+$/, ":_"),
  ]) {
    f.app.store.sqlite
      .query(
        "UPDATE submission_fences SET envelope_hash = ? WHERE session_id = ? AND operation_id = ?",
      )
      .run(corrupted, f.id, next.operationId);
    await expect(
      f.app.send(
        f.id,
        message.text,
        next.operationId,
        undefined,
        undefined,
        true,
        message,
        next.claimToken,
      ),
    ).rejects.toThrow("Invalid submission reservation");
  }
  expect(f.runtime.inputs).toHaveLength(0);
});

test("failed originals project their durable direct successor without changing either delivery", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.send(
    f.id,
    message.text,
    old.operationId,
    undefined,
    undefined,
    true,
  );
  f.runtime.sendOverride = undefined;
  const next = await f.app.reserveRetry(f.id, old.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  const originalFence = f.app.store.submissionFence(f.id, old.operationId);
  const successorFence = f.app.store.submissionFence(f.id, next.operationId);
  expect(
    f.app.detail(f.id).deliveries.find((d) => d.id === old.operationId),
  ).toMatchObject({ status: "failed", supersededBy: next.operationId });
  expect(f.app.recovery(f.id, old.operationId)).toMatchObject({
    status: "failed",
    text: message.text,
    supersededBy: next.operationId,
  });
  expect(
    f.app.recoveryPage(f.id).deliveries.find((d) => d.id === old.operationId),
  ).toMatchObject({ status: "failed", supersededBy: next.operationId });
  expect(
    f.runtime.inputs.filter((i) => i.clientId === next.operationId),
  ).toHaveLength(0);
  await f.app.send(
    f.id,
    message.text,
    next.operationId,
    undefined,
    undefined,
    true,
    message,
    next.claimToken,
  );
  const detail = f.app.detail(f.id);
  expect(
    detail.messages.some(
      (m) =>
        m.role === "user" &&
        m.clientId === next.operationId &&
        m.text === message.text,
    ),
  ).toBe(true);
  expect(detail.deliveries.find((d) => d.id === old.operationId)).toMatchObject(
    { status: "failed", supersededBy: next.operationId },
  );
  expect(f.app.store.submissionFence(f.id, old.operationId)).toBe(
    originalFence,
  );
  expect(f.app.store.submissionFence(f.id, next.operationId)).not.toBe(
    successorFence,
  );
  expect(JSON.stringify(detail)).not.toContain(next.claimToken);
  expect(JSON.stringify(detail)).not.toContain(
    parseFence(originalFence!).hash!,
  );
  expect(JSON.stringify(f.app.recovery(f.id, old.operationId))).not.toContain(
    parseFence(successorFence!).tokenHash!,
  );
  f.restart();
  expect(
    f.app.detail(f.id).deliveries.find((d) => d.id === old.operationId),
  ).toMatchObject({ status: "failed", supersededBy: next.operationId });
  expect(f.app.recovery(f.id, old.operationId)).toMatchObject({
    text: message.text,
    supersededBy: next.operationId,
  });
  expect(f.runtime.inputs).toHaveLength(0);
});

test("damaged or unavailable supersession projection leaves the failed delivery visible", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.send(
    f.id,
    message.text,
    old.operationId,
    undefined,
    undefined,
    true,
  );
  f.runtime.sendOverride = undefined;
  const next = await f.app.reserveRetry(f.id, old.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  const fence = f.app.store.submissionFence(f.id, old.operationId)!;
  const update = f.app.store.sqlite.query(
    "UPDATE submission_fences SET envelope_hash = ? WHERE session_id = ? AND operation_id = ?",
  );
  for (const bad of [
    fence + ":bad",
    fence.replace(/^v2:/, "v3:"),
    fence.replace(/:[a-f0-9]{64}:/, `:${"0".repeat(64)}:`),
  ]) {
    update.run(bad, f.id, old.operationId);
    expect(
      f.app.detail(f.id).deliveries.find((d) => d.id === old.operationId),
    ).toMatchObject({ status: "failed" });
    expect(
      f.app.detail(f.id).deliveries.find((d) => d.id === old.operationId),
    ).not.toHaveProperty("supersededBy");
  }
  update.run(fence, f.id, old.operationId);
  const load = f.app.store.submissionFencesFor;
  f.app.store.submissionFencesFor = () => {
    throw new Error("Synthetic projection failure");
  };
  try {
    expect(
      f.app.detail(f.id).deliveries.find((d) => d.id === old.operationId),
    ).not.toHaveProperty("supersededBy");
    expect(f.app.recovery(f.id, old.operationId)).toMatchObject({
      status: "failed",
      text: message.text,
    });
  } finally {
    f.app.store.submissionFencesFor = load;
  }
});

test("recovery pagination preserves all records and batches fence reads", async () => {
  const f = await fixture();
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  const ids: string[] = [];
  for (let i = 0; i < 103; i++) {
    const old = await f.app.reserveSubmission(f.id);
    ids.push(old.operationId);
    await f.app.send(
      f.id,
      `text ${i}`,
      old.operationId,
      undefined,
      undefined,
      true,
    );
  }
  f.runtime.sendOverride = undefined;
  const retry = await f.app.reserveRetry(f.id, ids[0]);
  if (retry.state !== "won") throw new Error("Expected winner");
  const load = f.app.store.submissionFencesFor.bind(f.app.store);
  const calls: string[][] = [];
  f.app.store.submissionFencesFor = (id, operations) => {
    calls.push(operations);
    return load(id, operations);
  };
  try {
    const recent = f.app.detail(f.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBe(100);
    expect(recent.recoveryCount).toBe(103);
    calls.length = 0;
    const page1 = f.app.recoveryPage(f.id);
    expect(calls).toHaveLength(1);
    expect(page1.deliveries).toHaveLength(100);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = f.app.recoveryPage(f.id, page1.nextCursor!);
    expect(calls).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const entries = [...page1.deliveries, ...page2.deliveries];
    expect(entries).toHaveLength(103);
    expect(new Set(entries.map((d) => d.id))).toEqual(new Set(ids));
    expect(entries.find((d) => d.id === ids[0])).toMatchObject({
      status: "failed",
      supersededBy: retry.operationId,
    });
  } finally {
    f.app.store.submissionFencesFor = load;
  }
});

test("question delivery projects the direct successor without changing pending question state", async () => {
  const { f, answers, old } = await failedQuestion();
  const next = await f.app.reserveRetry(f.id, old.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  expect(
    f.app.detail(f.id).deliveries.find((d) => d.id === old.operationId),
  ).toMatchObject({
    source: "question",
    status: "failed",
    supersededBy: next.operationId,
  });
  expect(f.app.recovery(f.id, old.operationId)).toMatchObject({
    answers,
    supersededBy: next.operationId,
  });
  expect(f.app.questionHistory(f.id)[0]).toMatchObject({
    state: "unanswered",
    answerOperation: { id: old.operationId, status: "failed" },
  });
  await f.app.answerBatch(
    f.id,
    answers,
    next.operationId,
    undefined,
    true,
    { source: "question", answers },
    next.claimToken,
  );
  expect(f.app.questionHistory(f.id)[0]).toMatchObject({
    state: "answered",
    answer: answers[0].answer,
  });
});

test("projection shows only the direct successor and drops it after a late original native confirmation", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.send(
    f.id,
    message.text,
    old.operationId,
    undefined,
    undefined,
    true,
  );
  const first = await f.app.reserveRetry(f.id, old.operationId);
  if (first.state !== "won") throw new Error("Expected winner");
  await f.app.send(
    f.id,
    message.text,
    first.operationId,
    undefined,
    undefined,
    true,
    message,
    first.claimToken,
  );
  f.runtime.sendOverride = undefined;
  const second = await f.app.reserveRetry(f.id, first.operationId);
  if (second.state !== "won") throw new Error("Expected winner");
  const deliveries = f.app.detail(f.id).deliveries;
  expect(deliveries.find((d) => d.id === old.operationId)).toMatchObject({
    supersededBy: first.operationId,
  });
  expect(deliveries.find((d) => d.id === first.operationId)).toMatchObject({
    supersededBy: second.operationId,
  });
  f.runtime.emit(f.id, {
    type: "item",
    turnId: f.app.detail(f.id).turnId ?? "late-turn",
    item: {
      type: "userMessage",
      id: "old-native",
      clientId: old.operationId,
      text: message.text,
    },
  });
  expect(
    f.app.detail(f.id).deliveries.find((d) => d.id === old.operationId),
  ).toMatchObject({ status: "sent" });
  expect(
    f.app.detail(f.id).deliveries.find((d) => d.id === old.operationId),
  ).not.toHaveProperty("supersededBy");
  expect(
    f.app
      .detail(f.id)
      .messages.some(
        (m) => m.id === "old-native" && m.clientId === old.operationId,
      ),
  ).toBe(true);
});

test("inspectRetry reads a no-delivery reservation edge without admitting or replaying", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id, "alice");
  expect(
    f.app.inspectRetry(f.id, old.operationId, message, "alice"),
  ).toBeNull();
  expect(f.app.lookup(f.id, old.operationId)).toBeNull();
  await f.app.finalizeSubmission(f.id, old.operationId, message, "alice");
  expect(
    f.app.inspectRetry(f.id, old.operationId, message, "alice"),
  ).toBeNull();
  const next = await f.app.reserveRetry(f.id, old.operationId, "alice");
  if (next.state !== "won") throw new Error("Expected winner");
  const before = f.app.store.sqlite
    .query(
      "SELECT operation_id,envelope_hash FROM submission_fences WHERE session_id=? ORDER BY operation_id",
    )
    .all(f.id);
  const result = f.app.inspectRetry(f.id, old.operationId, message, "alice");
  expect(result).toEqual({
    operationId: old.operationId,
    supersededBy: next.operationId,
  });
  expect(JSON.stringify(result)).not.toContain(next.claimToken);
  expect(f.app.lookup(f.id, old.operationId)).toBeNull();
  expect(f.app.inspectRetry(f.id, old.operationId, message, "bob")).toBeNull();
  expect(
    f.app.inspectRetry(
      f.id,
      old.operationId,
      { source: "user", text: "changed" },
      "alice",
    ),
  ).toBeNull();
  const other = await f.app.createOrc("alpha");
  expect(
    f.app.inspectRetry(other.id, old.operationId, message, "alice"),
  ).toBeNull();
  expect(
    f.app.inspectRetry(f.id, "legacy-not-found", message, "alice"),
  ).toBeNull();
  expect(
    f.app.store.sqlite
      .query(
        "SELECT operation_id,envelope_hash FROM submission_fences WHERE session_id=? ORDER BY operation_id",
      )
      .all(f.id),
  ).toEqual(before);
  expect(f.runtime.inputs).toHaveLength(0);
  f.restart();
  expect(f.app.inspectRetry(f.id, old.operationId, message, "alice")).toEqual(
    result,
  );
  expect(f.app.lookup(f.id, old.operationId)).toBeNull();
  expect(f.runtime.inputs).toHaveLength(0);
});

test("inspectRetry finds a previously deleted failed delivery and follows only one persisted edge", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.send(
    f.id,
    message.text,
    old.operationId,
    undefined,
    undefined,
    true,
  );
  await f.app.deleteFailedSubmission(f.id, old.operationId);
  expect(f.app.lookup(f.id, old.operationId)).toBeNull();
  const first = await f.app.reserveRetry(f.id, old.operationId);
  if (first.state !== "won") throw new Error("Expected winner");
  expect(f.app.inspectRetry(f.id, old.operationId, message)).toEqual({
    operationId: old.operationId,
    supersededBy: first.operationId,
  });
  await f.app.finalizeSubmission(
    f.id,
    first.operationId,
    message,
    undefined,
    message,
  );
  const second = await f.app.reserveRetry(f.id, first.operationId);
  if (second.state !== "won") throw new Error("Expected winner");
  expect(f.app.inspectRetry(f.id, old.operationId, message)).toEqual({
    operationId: old.operationId,
    supersededBy: first.operationId,
  });
  expect(f.app.inspectRetry(f.id, first.operationId, message)).toEqual({
    operationId: first.operationId,
    supersededBy: second.operationId,
  });
  expect(
    f.runtime.inputs.filter(
      (i) =>
        i.clientId === first.operationId || i.clientId === second.operationId,
    ),
  ).toHaveLength(0);
  f.restart();
  expect(f.app.inspectRetry(f.id, old.operationId, message)).toEqual({
    operationId: old.operationId,
    supersededBy: first.operationId,
  });
  expect(f.runtime.inputs).toHaveLength(0);
});

test("inspectRetry requires matching image references in the original envelope", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  const bytes = await sharp({
    create: { width: 5, height: 5, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const images = await f.app.uploadSubmissionImages(
    f.id,
    old.operationId,
    "hello",
    [new File([bytes], "picture.png")],
  );
  const envelope = { source: "user" as const, text: "hello", images };
  await f.app.finalizeSubmission(f.id, old.operationId, envelope);
  const next = await f.app.reserveRetry(f.id, old.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  expect(f.app.inspectRetry(f.id, old.operationId, message)).toBeNull();
  expect(
    f.app.inspectRetry(f.id, old.operationId, {
      ...envelope,
      images: [{ ...images[0], name: "other.png" }],
    }),
  ).toBeNull();
  expect(f.app.inspectRetry(f.id, old.operationId, envelope)).toEqual({
    operationId: old.operationId,
    supersededBy: next.operationId,
  });
  expect(f.runtime.inputs).toHaveLength(0);
});

test("inspectRetry fails closed on missing, damaged or mismatched child fences", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  await f.app.finalizeSubmission(f.id, old.operationId, message);
  const next = await f.app.reserveRetry(f.id, old.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  const child = f.app.store.submissionFence(f.id, next.operationId)!;
  const update = f.app.store.sqlite.query(
    "UPDATE submission_fences SET envelope_hash=? WHERE session_id=? AND operation_id=?",
  );
  for (const value of [
    child + ":bad",
    child.replace(/^v2:/, "v3:"),
    child.replace(/:[a-f0-9]{64}:/, `:${"0".repeat(64)}:`),
    child.replace(/:[A-Za-z0-9_-]+$/, ":b3RoZXI"),
  ]) {
    update.run(value, f.id, next.operationId);
    expect(f.app.inspectRetry(f.id, old.operationId, message)).toBeNull();
  }
  f.app.store.sqlite
    .query(
      "DELETE FROM submission_fences WHERE session_id=? AND operation_id=?",
    )
    .run(f.id, next.operationId);
  expect(f.app.inspectRetry(f.id, old.operationId, message)).toBeNull();
  f.app.store.sqlite
    .query(
      "INSERT INTO submission_fences(session_id,operation_id,envelope_hash) VALUES(?,?,?)",
    )
    .run(f.id, next.operationId, child);
  expect(f.app.inspectRetry(f.id, old.operationId, message)).toEqual({
    operationId: old.operationId,
    supersededBy: next.operationId,
  });
  expect(f.runtime.inputs).toHaveLength(0);
});

test("inspectRetry does not conceal a known late native original", async () => {
  const f = await fixture();
  const old = await f.app.reserveSubmission(f.id);
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await f.app.send(
    f.id,
    message.text,
    old.operationId,
    undefined,
    undefined,
    true,
  );
  const next = await f.app.reserveRetry(f.id, old.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  f.runtime.emit(f.id, {
    type: "item",
    turnId: f.app.detail(f.id).turnId ?? "late-turn",
    item: {
      type: "userMessage",
      id: "late-native",
      clientId: old.operationId,
      text: message.text,
    },
  });
  expect(f.app.lookup(f.id, old.operationId)).toMatchObject({
    state: "accepted",
  });
  expect(f.app.inspectRetry(f.id, old.operationId, message)).toBeNull();
  expect(
    f.runtime.inputs.filter((i) => i.clientId === next.operationId),
  ).toHaveLength(0);
});

test("inspectRetry verifies the complete question envelope without changing question state", async () => {
  const { f, answers, old } = await failedQuestion();
  const envelope = { source: "question" as const, answers };
  expect(f.app.inspectRetry(f.id, old.operationId, envelope)).toBeNull();
  const next = await f.app.reserveRetry(f.id, old.operationId);
  if (next.state !== "won") throw new Error("Expected winner");
  expect(f.app.inspectRetry(f.id, old.operationId, envelope)).toEqual({
    operationId: old.operationId,
    supersededBy: next.operationId,
  });
  expect(
    f.app.inspectRetry(f.id, old.operationId, {
      source: "question",
      answers: [{ ...answers[0], answer: "No" }],
    }),
  ).toBeNull();
  expect(f.app.questionHistory(f.id)[0]).toMatchObject({
    state: "unanswered",
    answerOperation: { id: old.operationId, status: "failed" },
  });
  expect(
    f.runtime.inputs.filter((i) => i.clientId === next.operationId),
  ).toHaveLength(0);
});
