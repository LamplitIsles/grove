import type { Agent } from "./contracts";

/** Presentation only. Admission and lifecycle guards retain their own evidence. */
export function executionStatus(
  agent: Pick<Agent, "state" | "stop" | "workUnconfirmed" | "currentExecution">,
): Agent["state"] {
  if (agent.state === "stopping" && agent.stop?.status === "pending") return "stopping";
  if (agent.currentExecution) return agent.currentExecution.state;
  return agent.state === "working" || agent.workUnconfirmed
    ? "working"
    : agent.state;
}
