import type { Workspace } from "./workspace";
import { ManagerNotStarted, type InstanceManager } from "./instance-manager";

type Confirmation = { confirmBusy: true; instanceId: string };
export class InstanceControls {
  readonly id = crypto.randomUUID();
  constructor(
    private readonly workspace: Workspace,
    readonly version: string | null,
    private readonly manager: InstanceManager,
  ) {}
  async status(): Promise<import("../src/contracts").InstanceStatus> {
    const restartAvailable = await this.manager.available();
    const { busy, canConfirmBusy, sessions, instanceReasons } =
      this.workspace.instanceActivity();
    return {
      id: this.id,
      version: this.version,
      busy,
      canConfirmBusy,
      restartAvailable,
      sessions,
      instanceReasons,
    };
  }
  private confirmed(confirmation?: Confirmation) {
    if (confirmation && confirmation.instanceId !== this.id)
      throw new Error("Instance changed; refresh before confirming");
    return confirmation?.confirmBusy === true;
  }
  reload(confirmation?: Confirmation) {
    return this.workspace.reloadMcp(this.confirmed(confirmation));
  }
  async restart(
    confirmation?: Confirmation,
  ): Promise<import("../src/contracts").InstanceRestartResult> {
    this.workspace.beginMaintenance(this.confirmed(confirmation));
    try {
      if (!(await this.manager.available())) {
        this.workspace.endMaintenance();
        return { status: "unavailable" as const };
      }
    } catch {
      this.workspace.endMaintenance();
      return { status: "unavailable" as const };
    }
    try {
      this.workspace.assertMaintenanceHealthy();
    } catch (error) {
      this.workspace.endMaintenance();
      throw error;
    }
    try {
      await this.manager.request();
    } catch (error) {
      if (error instanceof ManagerNotStarted) {
        this.workspace.endMaintenance();
        return { status: "unavailable" as const };
      }
      // The request may already have crossed the manager seam.
    }
    // Keep the barrier until process exit: a manager request's outcome is unknown.
    return { status: "unknown" as const };
  }
}
