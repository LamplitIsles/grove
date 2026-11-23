---
name: grove-to-tickets
description: Break a spec or agreed plan into implementation tickets in the configured issue tracker.
---

# To Tickets

When the user requests tickets, break a plan, spec, or conversation into **tickets** — tracer-bullet vertical outcomes, each declaring the tickets that **block** it. When the source is a spec, every ticket belongs to that spec's single PR; tickets are execution units on one feature branch, not PR boundaries.

Follow the [issue tracker instructions](../grove-to-spec/ISSUE-TRACKER.md) when reading or publishing tickets.

## Process

### 1. Gather context

Read the full spec issue body if the conversation or user identifies one. For a plan or conversation without a spec issue, use the agreed context.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Prefactor only when it directly unlocks the requested slice. Fold it into that ticket when feasible rather than creating preparatory architecture work.

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice delivers a narrow, complete outcome across the layers it actually needs, with corresponding verification
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any necessary prefactoring is the minimum needed to unlock a requested slice
- Record category ownership and any serial handoffs within a mixed slice: follow the captured task division and the user’s explicit assignments. Each owner handles its tests and review fixes.

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately. Do not add a blocking edge merely to force a comfortable execution order: independent tickets should remain on the same frontier. Orc manages the frontier and coordinates the owners serially on the shared checkout, preserving their changes.

Treat the current repository — monorepo or otherwise — as the default atomic change boundary. For a cross-cutting mechanical edit, prefer one ticket or independently green end-to-end slices. Introduce temporary old/new forms only when there is evidence of an external consumer or a real multi-deployment boundary that cannot change atomically.

### 4. Finalize the breakdown

Choose the granularity and blocking edges yourself from the vertical-slice rules. Do not ask the user to approve, merge, or split routine ticket boundaries. Ask only when an unresolved product decision changes what the tickets deliver; otherwise proceed directly to publication.

### 5. Publish the tickets

Add same-PR slices that one owner can work through in sequence as checkboxes under `## Tickets` in the spec issue. Use a separate issue when a slice needs independent assignment, discussion, progress tracking or a linkable dependency. Create standalone tickets in dependency order and add their issue links under `## Tickets`. If there is no spec issue, publish the requested tickets as standalone issues with no `Spec:` line. Keep all tickets for one spec on the same feature branch for one PR.

Orc coordinates the **frontier**: any ticket whose blockers are all done. For mixed tickets, sequence the category owners and their handoffs without turning those handoffs into artificial ticket dependencies. For a purely linear chain that means top to bottom.

<ticket-template>

Issue title: <Ticket title>

Repository: <repository identifier>
Feature: <slug>
Spec: #<parent issue number, or full URL for another repository>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list.

**Ownership and handoffs:** applicable Orc and Worker categories and their serial handoffs; each owner verifies and fixes its work.

Blocked by: #<prerequisite issue number, or full URL for another repository>. Omit when there are no blockers.

Status: ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</ticket-template>

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.
