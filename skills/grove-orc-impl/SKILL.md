---
name: grove-orc-impl
description: Implement a spec issue with category-owned work, self-review, and approval-gated delivery.
---

# Orchestrate implementation

Follow the captured task division as a default and the user’s explicit assignments. One Implementation Worker handles its assigned work. Each owner performs its tests and deterministic review fixes. Orc investigates goals, constraints, current state and approach before dispatch; frame irreducible technical unknowns as bounded evidence tasks with question, goal, evidence and limits. One repository/spec uses one PR; mixed work proceeds serially in a shared checkout, preserving each other's changes. Orc owns integration, review, judgement, PR delivery and merge approval. Deployment is outside this workflow unless requested. One-off ops without a PR receives Orc self-review and independent review on user request; execution still requires specific authorization.

Use the execution host's `flickgrove` MCP tools for Worker lifecycle. Discover their current schemas before use. The application supplies Worker model, reasoning effort and service tier; skills do not select them. Implementation delegation uses Grove MCP; independent review uses reviewer_start/list/read/send/close. When Worker-owned work exists, this workflow requires an Orc session with `worker_start`, `worker_list`, `worker_read`, `worker_send` and `worker_close`. If unavailable, report the missing capability rather than starting a different agent runtime.

## 1. Prepare

1. Follow the [issue tracker instructions](../grove-to-spec/ISSUE-TRACKER.md). Read the identified spec issue, its inline tickets and each linked ticket body. Use the spec directly when it has no tickets. Report an unreadable spec or linked ticket as a blocker. Read repository and host-local instructions.
2. Resolve the registered Organon alias in the Orc's execution environment. Confirm the checkout selected for this run matches the spec. To use an existing linked worktree, verify its root and project with `og project resolve-worktree <absolute-root>` on that device.
3. Inspect tracked and untracked changes. Record pre-existing dirty paths and their initial diff; preserve them. Documentation-only changes, including `CONTEXT.md`, do not block the checkout. Assess other changes for implementation overlap.
4. Order tickets using the checklist, linked ticket status and `Blocked by:` references. Confirm prerequisites are complete before starting dependent work. Use the spec's acceptance criteria directly when it has no tickets. Record the starting branch and `HEAD` as the fixed review point.
5. For changed rendered UI, establish the applicable visual and interaction requirements and gather Orc-owned verification evidence.

Use the registered checkout by default. If isolation is necessary and authorized, prepare a linked worktree through the repository's Git tooling and record its ownership and cleanup responsibility. It uses the existing project registration. Work in the selected checkout, with one branch and serial ownership. Preserve pre-existing edits and ask about overlap only when it cannot be resolved within scope.

## 2. Implement and dispatch

Orc implements and verifies its own categories. For one-off ops with no PR, self-review the work and evidence, then report the outcome without entering the PR workflow. If the assignment has no Worker-owned work but produces a PR, proceed directly to review. Otherwise choose a serial order and dispatch the Worker for its bounded category. If Orc work must follow Worker work, require a progress report and a pause in repository edits at the handoff; Orc integrates its work, then directs the same Worker to finish its assignment.

Call `worker_start` once with the canonical `project` alias, a useful `title`, the spec reference in `spec`, and the complete bootstrap in `message`. If the selected checkout is linked, pass its absolute root in `worktree`. Startup includes dispatch; no separate prompt is needed. Retain the returned Worker ID and confirmed delivery/state. Inspect `worker_list` and `worker_read` after an error or unknown result before creating or sending anything again; an uncertain response may already have created a Worker or delivered a task. Recover the same Worker when possible.

The bootstrap names the spec URL, assigned inline work and linked ticket URLs and states:

- this is the sole Implementation Worker; it owns the assigned Worker category in dependency order, including its documentation, tests and deterministic review fixes; identify Orc-owned work and the serial handoff;
- it is not alone in the codebase, must preserve others' edits and adapt to concurrent changes;
- the pre-existing dirty paths and which are in scope for commits;
- the selected checkout path, branch, fixed starting commit and one-PR boundary;
- live services, deployments, credentials, paid providers and external messages remain untouched unless explicitly in scope;
- it follows repository implementation instructions, keeps `.scratch` untracked, updates assigned checklist items or ticket issue statuses through the configured tracker, verifies observable behavior, commits scoped Conventional Commits and writes `.scratch/<feature>/implementation-report.md`; Orc owns PR creation and updates;
- the relevant acceptance criteria, known technical uncertainties and bounded evidence tasks;
- it uses `worker_report` for progress, blockers and completion. Completion starts `IMPL_COMPLETE`, identifies the spec, current commit and absolute report path, and is sent once its assigned work is implemented and verified. A blocker starts `IMPL_BLOCKED` with evidence and the decision required. It reports to Orc and leaves agent lifecycle to Orc.

`worker_report` routes to the owning Orc without waiting for Orc readiness. A final answer or idle state alone is not the completion handoff. On uncertain report delivery, inspect the retained conversation/delivery evidence before explicitly retrying or reconciling; do not replay mutations blindly.

After confirmed dispatch, end the Orc turn; reports and delegated questions reactivate it. Use `worker_list`/`worker_read` for requested status or specific recovery, not polling while implementation runs. A progress report does not trigger acceptance review.

When requirements change, update the spec issue and affected tickets first, then send a compact delta with `worker_send` to the same Worker. It steers a busy Worker and starts a new turn when idle. For delegated async questions, include only the explicit `questionIds` being answered; ordinary instructions do not resolve questions. Ask the user only for decisions Orc cannot make from the authorized scope and evidence.

## 3. Review and fixes

After all owners have implemented and verified their scope (and `IMPL_COMPLETE` when a Worker was used):

1. Commit Orc-owned scoped changes before resolving the initial full commit ID for review. Respect serial handoffs and stage only ready Orc-owned work; do not commit another owner's unready changes. Substantively self-review the entire diff from the fixed starting point against the spec and every acceptance criterion, inspect owner-supplied verification evidence, omissions and unnecessary complexity. Resolve deterministic issues with the relevant owner, commit the resulting Orc-owned repairs, and resolve and self-review the new HEAD; do not substitute a report check for this review.
2. Follow the Orc's captured review policy and the user's task-specific direction. When independent review is needed, use `grove-code-review` for independent Standards and Spec assessments against the fixed point, covering the whole PR and cross-category contracts. Reviewer models, reasoning and customizable prompts come from the execution Peer runtime configuration; fixed role/owner/report/close rules remain application-owned. Reviewers only read the diff, full spec and existing evidence; they never run tests, builds or browsers. Missing evidence goes to its owner. For changed UI, inspect Orc's visual and interaction evidence before acceptance; missing evidence stays unverified.
3. Route deterministic findings to their category owner. Orc fixes and commits its own scoped repairs; consolidate Worker findings into one `worker_send` to the same Worker. Coordinate serially, preserve other owners' unready work, and obtain updated evidence. After all repairs are committed, resolve the new full HEAD for re-review.
4. Bring unresolved judgement calls about external consumers, retained data, compatibility, migration, cutover or product behavior to the user with the smallest supported recommendation.
5. When independent review is needed, use `grove-review-again` to reopen only stale conclusions until no merge blocker or unresolved judgement remains.

Retain reviewer IDs and conclusions until review is settled; each category owner implements its fixes.

## 4. PR, merge, and cleanup

A completed run includes one PR and approval-gated merge unless the user limited scope.

For a linked checkout, use its absolute root with `og push --worktree` and as the `worktree` selector for typed PR calls. Run the approved merge from outside the feature directory. Orga can remove that directory and its ignored files after merge, so preserve needed evidence elsewhere before submitting.

1. Push the self-reviewed commit with `og` before creating or updating the PR; use typed Organon `og` tools to find or create it. Verify the PR head is the self-reviewed commit and its title and description state final behavior and verification. Include the spec issue URL in the description and update it when scope or evidence changes.
2. Submit merge through the current typed `og` operation and follow its returned policy, `next_action` and `completion`. Continue already authorized actions without requesting the same approval again. Pending required approval ends the turn; rejection or terminal failure follows the current policy. Merging does not deploy: run and verify a documented deploy step only when deployment is in the authorized scope.
3. After an executed merge, set the spec issue's `Status:` to `implemented` and verify stored content. After the PR merge is confirmed, close its run-owned Worker and settled Reviewers when no further assignments are needed; a user may explicitly request earlier closure. Pending or unconfirmed merge is not a reason to close PR-related members. Request closure with `worker_close` or `reviewer_close`; existing lifecycle guards apply, and `closing=true` is accepted asynchronous closure. `closed=true` confirms closure; `closing=true` is an accepted durable request that waits for current work, questions and reports. Continue answering existing questions; do not send new tasks after requesting closure.
4. Recover report/question/delivery guards before cleanup. Use `confirmInterrupted` only after inspecting an interrupted Worker with no observed active turn and explicitly acknowledging its unknown outcome. Preserve useful evidence and any isolated checkout until safe cleanup. Orc tree closure belongs to the user; Worker closure does not establish task completion.

Preserve blocked or failed Workers until evidence is recovered or the user chooses to discard them.

The final report records the starting and reviewed commits, execution host/project and Worker IDs, ticket or acceptance-criterion/commit coverage, verification, review iterations, judgement calls, changed-LOC variance, PR URL, merge and closure status, and remaining blockers.

Follow the captured task division and the user’s explicit assignments. Each owner handles its tests and fixes. Independent target-bound review belongs to Reviewer; bounded evidence investigation belongs to Researcher under `grove-research`. Researchers do not replace review axes or implement fixes. Use Grove collaboration tools; native collaboration is disabled in managed sessions.
