# Forgejo npm snapshots

Pushes to `main` build and verify `@lamplitisles/flickgrove`, then publish it to
the LamplitIsles Forgejo npm registry. A snapshot version is the base package
version followed by `-snapshot.g` and the complete source commit SHA. Publication
does not install, restart, or deploy Grove.

The npm package root contains `server/main.ts`, `dist`, `drizzle`, `skills`,
`templates`, and the runtime helpers and dependencies. Start the installed
package with Bun as `bun <prefix>/node_modules/@lamplitisles/flickgrove/server/main.ts`
and pass the existing service arguments. State and configuration are controlled
by the existing CLI flags and environment, independently of the package root.

Resolve an exact version from the registry's package metadata and verify its
`dist.integrity` against the downloaded tarball before installing. Install the
verified local tarball with npmjs as the dependency registry, `--ignore-scripts`
and `--legacy-peer-deps`. The latter avoids npm peer-resolution backtracking for
the current Better Auth dependency graph. Do not send Forgejo credentials to
npmjs. If an install or publication has an unknown outcome, inspect its recorded
state and registry metadata before retrying.

The Woodpecker repository must be active and have the `forgejo_packages_token`
secret available to main-push workflows. The token is exposed only to the
publish step. A failed or uncertain publish is not automatically replayed;
an existing snapshot is accepted only with matching integrity and the expected
latest tag. Publishing an older commit cannot move latest backwards.
