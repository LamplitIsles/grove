import type { Workspace } from "./workspace";
import { ManagerNotStarted, type InstanceManager } from "./instance-manager";

export class InstanceControls {
  readonly id = crypto.randomUUID();
  constructor(
    private readonly workspace: Workspace,
    readonly version: string | null,
    private readonly manager: InstanceManager,
  ) {}
  async status(): Promise<import("../src/contracts").InstanceStatus> {
    const restartAvailable = await this.manager.available();
    const { busy, sessions, instanceReasons } =
      this.workspace.instanceActivity();
    return {
      id: this.id,
      version: this.version,
      busy,
      restartAvailable,
      sessions,
      instanceReasons,
    };
  }
  reload() {
    return this.workspace.reloadMcp();
  }
  async restart(): Promise<import("../src/contracts").InstanceRestartResult> {
    this.workspace.beginRestart();
    try {
      if (!(await this.manager.available())) {
        this.workspace.cancelRestart();
        return { status: "unavailable" as const };
      }
    } catch {
      this.workspace.cancelRestart();
      return { status: "unavailable" as const };
    }
    try {
      await this.manager.request();
    } catch (error) {
      if (error instanceof ManagerNotStarted) {
        this.workspace.cancelRestart();
        return { status: "unavailable" as const };
      }
      // The request may already have crossed the manager seam.
    }
    // Keep the barrier until process exit: a manager request's outcome is unknown.
    return { status: "unknown" as const };
  }
}
