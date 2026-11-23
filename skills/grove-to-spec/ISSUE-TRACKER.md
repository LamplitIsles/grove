# Issue tracker

Use the issue tracker and authorized tools named in the deployment's global AGENTS.md. Apply its rules to the registered project, including its choice of repository when the checkout is a fork or mirror. Before a write, verify the target repository and its tracker. If the target or a required operation is unavailable, surface the blocker and retain the work already drafted.

- **Resolve.** Use the full issue URL across sessions, in PR descriptions and in reviewer targets. Resolve a bare `#123` in the selected issue repository and confirm it identifies an issue.
- **Read.** Fetch the full issue body and its canonical URL. Use the body for requirements and workflow status. Use comments as context. Record any newly agreed requirement in the body before relying on it for implementation or review.
- **Write.** Create or edit the issue through the configured tools. Preserve unrelated body content and read back the affected issue to confirm the change. If the outcome is unknown, inspect the issue or search the verified target for the intended creation before deciding how to recover.
- **Status.** `Status:` in the issue body records workflow progress. Apply any tracker close or label rules from AGENTS.md when supported. Set the spec to `implemented` after confirming its PR merged.

Ticket membership and blockers are Markdown references. Use `Spec: #123` for membership and `Blocked by: #124` for actual prerequisites. Use a full URL for a target outside the same issue repository. Mark a linked ticket `Status: implemented` when its slice is complete and verified. Mark completed inline work in the parent issue's checklist.
