# ADR 0003: Issue tracker for Grove delivery

Grove uses Organon's issue tools for the registered project so specs, tickets and review requirements are reachable from the PR. Organon resolves the forge from the project's registered remote. The issue body is the authoritative spec for one PR, and the PR closes it on merge with `Closes #<spec issue number>`. Track same-PR slices as checklist items and create linked issues for slices that need independent tracking. Markdown issue references represent membership and prerequisites across forges.

Keep long-lived decisions in repository ADRs so they follow the code and branch. Keep decisions specific to a PR in its spec issue. Research findings continue to be archived in FlickNote.

This supersedes FlickNote ADR #2699 for new specs, tickets and ADRs. Existing records remain at their original locations.
