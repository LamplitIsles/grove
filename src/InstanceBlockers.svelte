<script lang="ts">
  import type { InstanceBlockerReason, InstanceStatus } from "./contracts";
  import { ChevronDown } from "@lucide/svelte";
  import * as m from "./paraglide/messages";

  let { sessions, instanceReasons }: Pick<InstanceStatus, "sessions" | "instanceReasons"> = $props();

  const labels: Record<InstanceBlockerReason, () => string> = {
    working: m.instance_working,
    stopping: m.instance_stopping,
    session_error: m.instance_session_error,
    unverified: m.instance_unverified,
    turn: m.instance_turn,
    stop_pending: m.instance_stop_pending,
    stop_unknown: m.instance_stop_unknown,
    retrying: m.instance_retrying,
    close_requested: m.instance_close_requested,
    follow_up_inspection: m.instance_follow_up_inspection,
    delivery_waiting: m.instance_delivery_waiting,
    delivery_queued: m.instance_delivery_queued,
    delivery_sending: m.instance_delivery_sending,
    delivery_uncertain: m.instance_delivery_uncertain,
    delivery_failed: m.instance_delivery_failed,
    opening: m.instance_opening,
    queue: m.instance_queue,
    tree_action: m.instance_tree_action,
    tree_closing: m.instance_tree_closing,
    child_closing: m.instance_child_closing,
    maintenance: m.instance_maintenance,
    creating: m.instance_creating,
    disposed: m.instance_disposed,
    write_failure: m.instance_write_failure,
  };
  const roles = { orc: m.orc, worker: m.worker, reviewer: m.instance_reviewer, researcher: m.instance_researcher };
  const describe = (reasons: InstanceBlockerReason[]) => [...new Set(reasons.map(reason => labels[reason]()))].join(" · ");
</script>

<div class="instance-blockers" aria-label={m.instance_blockers()}>
  {#if sessions.length}
    <ul>
      {#each sessions as session (session.id)}
        <li>
          <details class="instance-blocker-title"><summary><strong>{session.title}</strong><span>{roles[session.role]()}</span><ChevronDown size={14} aria-hidden="true" /></summary></details>
          <div class="instance-blocker-reasons">{describe(session.reasons)}</div>
        </li>
      {/each}
    </ul>
  {/if}
  {#if instanceReasons.length}<p class="instance-blocker-reasons">{describe(instanceReasons)}</p>{/if}
</div>
