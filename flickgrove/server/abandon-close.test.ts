import { afterEach, expect, test } from "bun:test";
import { abandonFixture } from "./abandon-close-fixture";
import { HostService } from "./hosts";
import { invoke } from "./chord-methods";
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
async function fixture() {
  const f = await abandonFixture();
  cleanup.push(f.cleanup);
  return f;
}

for (const status of ["waiting", "failed", "uncertain"] as const) {
  test(`abandoning a direct unknown cannot close past a ${status} follow-up`, async () => {
    const f = await fixture();
    f.reload((a) => {
      a.deliveries.push({
        ...a.deliveries[0],
        id: "follow-up",
        mode: "follow_up",
        status,
      });
    });
    expect(f.app.detail(f.target.id).followUpCount).toBe(1);
    await expect(f.app.closeTree(f.target.id)).rejects.toThrow();
    await expect(f.app.abandonCloseCandidate(f.target.id)).rejects.toThrow();
    await expect(
      f.app.closeTree(f.target.id, ["original-unknown", "follow-up"]),
    ).rejects.toThrow();
    expect(f.app.lookupFollowUp(f.target.id, "follow-up")?.status).toBe(status);
  });
}

test("ordinary close stays blocked; explicit original IDs close without resume or a receipt across reload", async () => {
  const f = await fixture();
  f.reload(); // Old stopped/error thread with no cached handle, including missing rollout.
  f.runtime.open = async () => {
    throw new Error("Must not resume to close");
  };
  await expect(f.app.closeTree(f.target.id)).rejects.toThrow("unconfirmed");
  expect(await f.app.abandonCloseCandidate(f.target.id)).toEqual({
    closed: false,
    unknownOperationIds: ["original-unknown"],
  });
  await f.app.closeTree(f.target.id, ["original-unknown"]);
  expect(f.app.snapshot().agents.map((a) => a.id)).toEqual([f.other.id]);
  expect(f.app.lookup(f.target.id, "original-unknown")).toBeNull();
  const stored = f.stored().agents.find((a) => a.id === f.target.id)!;
  expect(stored.closed).toBe(true);
  expect(stored.deliveries[0]).toMatchObject({
    id: "original-unknown",
    status: "uncertain",
    source: "user",
  });
  f.reload();
  expect(await f.app.abandonCloseCandidate(f.target.id)).toEqual({
    closed: true,
    unknownOperationIds: [],
  });
  expect(f.app.lookup(f.target.id, "original-unknown")).toBeNull();
  expect(f.runtime.inputs).toHaveLength(1);
});

test("owning Peer and typed close payload protect scope and reject general force", async () => {
  const f = await fixture();
  const service = new HostService(f.app, {
    directory: f.directory,
    origin: () => "http://127.0.0.1",
  });
  await expect(
    invoke(service, "closeTree", {
      id: `other-peer:${f.target.id}`,
      abandonUnknownOperationIds: ["original-unknown"],
    }),
  ).rejects.toThrow("another Peer");
  await expect(
    invoke(service, "closeTree", {
      id: `${service.identity.id}:${f.target.id}`,
      force: true,
    }),
  ).rejects.toThrow();
  await expect(
    f.app.closeTree(f.other.id, ["original-unknown"]),
  ).rejects.toThrow("No unconfirmed");
  for (const ids of [[], ["wrong"], ["original-unknown", "original-unknown"]])
    await expect(f.app.closeTree(f.target.id, ids)).rejects.toThrow("changed");
  expect(f.app.snapshot().agents).toHaveLength(2);
});

for (const guard of [
  "other-source",
  "children",
  "question",
  "extra-unknown",
  "sent",
  "outside-window",
] as const) {
  test(`explicit abandonment revalidates ${guard} against the complete authority`, async () => {
    const f = await fixture();
    f.reload((a, agents) => {
      if (guard === "sent") a.deliveries[0].status = guard;
      if (guard === "other-source") a.deliveries[0].source = "question";
      if (guard === "children")
        agents.push({
          ...structuredClone(a),
          id: "child",
          token: "fixture-child",
          threadId: "fixture-child-thread",
          role: "worker",
          ownerId: a.id,
          deliveries: [],
        });
      if (guard === "question")
        a.questions.push({
          id: "q",
          at: Date.now(),
          itemId: "q-item",
          index: 0,
          title: "Question",
          text: "Answer?",
          options: [],
          state: "unanswered",
        });
      if (guard === "extra-unknown" || guard === "outside-window") {
        a.deliveries.push({ ...a.deliveries[0], id: "new-unknown" });
        if (guard === "outside-window")
          for (let i = 0; i < 140; i++)
            a.deliveries.push({
              ...a.deliveries[0],
              id: `later-${i}`,
              status: "failed",
            });
      }
    });
    if (guard === "outside-window") {
      expect(
        f.app
          .detail(f.target.id)
          .deliveries.some((d) => d.status === "uncertain"),
      ).toBe(false);
      expect(
        (await f.app.abandonCloseCandidate(f.target.id)).unknownOperationIds,
      ).toEqual(["original-unknown", "new-unknown"]);
    }
    await expect(
      f.app.closeTree(f.target.id, ["original-unknown"]),
    ).rejects.toThrow();
    expect(f.stored().agents.find((a) => a.id === f.target.id)!.closed).toBe(
      false,
    );
  });
}

test("cached native release failure preserves facts; retry releases only that handle", async () => {
  const f = await fixture();
  f.runtime.closeOverride = async () => {
    throw new Error("fixture release failed");
  };
  await expect(
    f.app.closeTree(f.target.id, ["original-unknown"]),
  ).rejects.toThrow("fixture release failed");
  expect(f.app.lookup(f.target.id, "original-unknown")).toBeNull();
  expect(f.app.snapshot().agents).toHaveLength(2);
  let releases = 0;
  f.runtime.closeOverride = async () => {
    releases++;
  };
  await f.app.closeTree(f.target.id, ["original-unknown"]);
  expect(releases).toBe(1);
  expect(f.runtime.inputs).toHaveLength(1);
});

test("late native acceptance during release prevents abandoned close and keeps its actual receipt", async () => {
  const f = await fixture();
  f.runtime.closeOverride = async () =>
    f.runtime.emit(f.target.id, {
      type: "item",
      turnId: "late",
      item: {
        type: "userMessage",
        id: "native-original",
        clientId: "original-unknown",
        text: "Original unknown input",
      },
    });
  await expect(
    f.app.closeTree(f.target.id, ["original-unknown"]),
  ).rejects.toThrow("No unconfirmed");
  expect(f.app.lookup(f.target.id, "original-unknown")?.state).toBe("accepted");
  expect(f.stored().agents.find((a) => a.id === f.target.id)!.closed).toBe(
    false,
  );
});

for (const state of ["working", "stopping", "error"] as const) {
  test(`live ${state} turn independently guards abandonment`, async () => {
    const f = await fixture();
    f.runtime.emit(f.target.id, { type: "working", turnId: "live-turn" });
    if (state === "stopping") await f.app.stop(f.target.id, "live-turn");
    if (state === "error")
      f.runtime.emit(f.target.id, {
        type: "error",
        turnId: "live-turn",
        error: "fixture terminal error",
        willRetry: false,
      });
    await expect(
      f.app.closeTree(f.target.id, ["original-unknown"]),
    ).rejects.toThrow();
    expect(f.app.snapshot().agents).toHaveLength(2);
  });
}

test("in-flight sending/queued operations cannot be bypassed and their new unknown IDs invalidate confirmation", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  f.runtime.sendOverride = async () => {
    started.resolve();
    return gate.promise;
  };
  const send = f.app.send(f.target.id, "New input", "new-inflight");
  await started.promise;
  let closed = false;
  const close = f.app.closeTree(f.target.id, ["original-unknown"]);
  void close.then(
    () => {
      closed = true;
    },
    () => {},
  );
  await Bun.sleep(20);
  expect(closed).toBe(false);
  expect(
    f
      .stored()
      .agents.find((a) => a.id === f.target.id)!
      .deliveries.at(-1)!.status,
  ).toBe("sending");
  gate.reject(new Error("fixture unknown send"));
  await send;
  await expect(close).rejects.toThrow("changed");
  expect(f.app.lookup(f.target.id, "new-inflight")).toBeNull();
});

test("reservation is blocked from abandonment enqueue through failed validation", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  f.runtime.sendOverride = async () => {
    entered.resolve();
    return gate.promise;
  };
  const sending = f.app.send(f.target.id, "New input", "held");
  await entered.promise;
  const closing = f.app.closeTree(f.target.id, ["original-unknown"]);
  try {
    await expect(f.app.reserveSubmission(f.target.id)).rejects.toThrow(
      "Tree is closing",
    );
    await expect(
      f.app.closeTree(f.target.id, ["original-unknown"]),
    ).rejects.toThrow("Tree is closing");
    await expect(f.app.reserveSubmission(f.target.id)).rejects.toThrow(
      "Tree is closing",
    );
    gate.reject(new Error("fixture unknown"));
    await sending;
    await expect(closing).rejects.toThrow("changed");
    const reservation = await f.app.reserveSubmission(f.target.id);
    expect(reservation.operationId).toStartWith("grove-v1-");
    expect(
      f.runtime.inputs.filter((input) => input.clientId === "held"),
    ).toHaveLength(1);
  } finally {
    gate.reject(new Error("cleanup"));
    await sending;
    await closing.catch(() => {});
  }
});

test("reservation remains blocked during abandonment release; failure unlocks it across restart", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.runtime.closeOverride = async () => {
    entered.resolve();
    await gate.promise;
    throw new Error("fixture release failed");
  };
  const closing = f.app.closeTree(f.target.id, ["original-unknown"]);
  try {
    await entered.promise;
    await expect(f.app.reserveSubmission(f.target.id)).rejects.toThrow(
      "Tree is closing",
    );
    await expect(
      f.app.closeTree(f.target.id, ["original-unknown"]),
    ).rejects.toThrow("Tree is closing");
    await expect(f.app.reserveSubmission(f.target.id)).rejects.toThrow(
      "Tree is closing",
    );
    gate.resolve();
    await expect(closing).rejects.toThrow("fixture release failed");
    const { operationId } = await f.app.reserveSubmission(f.target.id);
    f.reload();
    expect(
      await f.app.finalizeSubmission(f.target.id, operationId, {
        source: "user",
        text: "never sent",
      }),
    ).toMatchObject({ state: "rejected" });
    expect(f.runtime.inputs).toHaveLength(1);
  } finally {
    gate.resolve();
    await closing.catch(() => {});
  }
});

test("successful abandonment never allows a reservation during release or after close", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.runtime.closeOverride = async () => {
    entered.resolve();
    await gate.promise;
  };
  const closing = f.app.closeTree(f.target.id, ["original-unknown"]);
  try {
    await entered.promise;
    await expect(f.app.reserveSubmission(f.target.id)).rejects.toThrow(
      "Tree is closing",
    );
    gate.resolve();
    await closing;
    await expect(f.app.reserveSubmission(f.target.id)).rejects.toThrow(
      "Session not found",
    );
    expect(
      f.stored().agents.find((agent) => agent.id === f.target.id)?.closed,
    ).toBe(true);
    expect(f.runtime.inputs).toHaveLength(1);
  } finally {
    gate.resolve();
    await closing.catch(() => {});
  }
});
