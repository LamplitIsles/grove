---
name: grove-prepare-impl
description: Turn an agreed discussion into an implementation-ready spec, then hand it to grove-orc-impl for implementation and one PR.
---

Run only after product decisions are settled; do not restart discovery.

1. Read and follow `grove-to-spec` completely to publish an implementation-ready issue, including documentation and agent guidance acceptance.
2. Read existing tickets when present. Create tickets through `grove-to-tickets` only when the user explicitly requests them. A spec without tickets is a complete assignment.
3. Read `grove-orc-impl` completely. Follow the captured task division and the user’s explicit assignments; one Worker handles its assigned implementation. Each owner handles its tests and fixes. Use one branch and one PR per repository, serially coordinating mixed work.

For multiple repositories use one spec and PR per repository, with at most one Worker when its category is needed. Link cross-repository contracts in each spec and finish blocking contracts before dependent acceptance. No implementation delegation through native agents. Model and reasoning configuration belongs to Grove.
