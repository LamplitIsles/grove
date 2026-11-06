import { expect, test } from "bun:test";
import { executionStatus } from "../src/execution-status";

test("current execution display is separate from unresolved work evidence", () => {
  expect(executionStatus({ state: "error", workUnconfirmed: true })).toBe(
    "working",
  );
  expect(
    executionStatus({
      state: "error",
      workUnconfirmed: true,
      currentExecution: { state: "idle" },
    }),
  ).toBe("idle");
  expect(
    executionStatus({ state: "idle", currentExecution: { state: "working" } }),
  ).toBe("working");
  expect(executionStatus({ state: "stopping" })).toBe("stopping");
  expect(
    executionStatus({
      state: "stopping",
      workUnconfirmed: true,
      stop: { turnId: "turn", status: "pending" },
    }),
  ).toBe("stopping");
  expect(
    executionStatus({
      state: "stopping",
      workUnconfirmed: true,
      stop: { turnId: "turn", status: "pending" },
      currentExecution: { state: "working" },
    }),
  ).toBe("stopping");
});
