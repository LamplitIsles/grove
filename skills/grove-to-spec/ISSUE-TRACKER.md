# Issue tracker

Use Organon's issue tools with the registered project alias to find, read, create and edit spec and ticket issues. Organon resolves the project's issue tracker. If an operation is unavailable, report the blocker and retain the draft.

- **Resolve.** Use the full issue URL across sessions, in PR descriptions and in reviewer targets. Read `#123` through the registered project. For a supplied URL, confirm it matches the issue returned by Organon.
- **Read.** Fetch the full issue body and its canonical URL. Use the body for requirements and workflow status. Use comments as context. Record any newly agreed requirement in the body before relying on it for implementation or review.
- **Write.** Preserve unrelated body content and read back the affected issue to confirm the change. If the outcome is unknown, inspect the issue or search the project for the intended creation before deciding how to recover.
- **Status.** `Status:` in the issue body records workflow progress. Set the spec to `implemented` after confirming its PR merged.

Ticket membership and blockers are Markdown references. Use `Spec: #123` for membership and `Blocked by: #124` for actual prerequisites. Mark a linked ticket `Status: implemented` when its slice is complete and verified. Mark completed inline work in the parent issue's checklist.
