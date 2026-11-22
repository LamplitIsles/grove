# Operating FlickGrove

Configure and operate a Grove instance. For prerequisites and first startup, see the [root README](../README.md).

## Users and passkeys

FlickGrove uses equal shared users. Everyone who can sign in can read and operate the same session trees and invite another user. Before the first sign-in, the host creates a ten-minute, single-use setup code using the same `--state`, `--origin` and `--port` as the server. With defaults, run `bun run start --auth bootstrap`. For a configured HTTPS instance, for example:

```sh
bun run start --origin https://grove.example --state /path/to/state --auth bootstrap
```

Open that exact HTTPS origin (localhost is also supported), enter the code and a nickname, and register a passkey. Passkeys are scoped to an RP ID, and authentication checks the configured origin; an existing passkey for a different RP ID does not automatically work after a hostname change. An authenticated user can create an invitation in Settings; it expires after ten minutes and is consumed only by a successful registration. The code grants access, so share it privately. A signed-in user can register another passkey. Sign-in and registration require local user verification by the authenticator.

If a user loses every passkey, the host lists stable user IDs and issues a recovery code for the intended user:

```sh
bun run start --origin https://grove.example --state /path/to/state --auth users
bun run start --origin https://grove.example --state /path/to/state --auth recovery --user USER_ID
```

A successful recovery revokes the target user's credentials and sessions present in the recovery transaction and closes their existing connections; failed or expired attempts leave existing access intact. An authenticated add-passkey request that has already passed session checks can finish after recovery commits, leaving a credential that can still authenticate. Other users are unaffected. Use an existing signed-in session to add a passkey without replacing the others. Keep the state directory private: it contains the workspace SQLite database, authentication records and `auth-secret`, along with existing media and agent state. Back up the database and secret together; losing the secret invalidates existing browser sessions. The service makes the state directory private and restricts the database and secret files.

The browser session and same-origin checks protect HTTP reads, images, voice and WebSocket operations. The local agent MCP bridge continues to use its separate per-agent bearer token and does not represent a human. A message author comes from the verified browser session attached to the original persisted operation; old and external messages without a matching identity have no author. Participant activity is recorded per user and tree only after native admission, independent of agent activity. Unknown delivery outcomes retain the original operation identity and are never automatically resent.

### External MCP

In Settings → Account, generate an external MCP token and copy it when shown. Each user has at most one active token on this Grove instance; rotation or revocation invalidates that user's previous token immediately. If the token is lost, rotate it and update the clients. The instance stores only its verifier. The token represents the signed-in Grove user and is separate from managed Agents' internal collaboration credentials.

Connect a header-capable client to `https://<your-grove-origin>/external-mcp` using `Authorization: Bearer <token>`. Use HTTPS for remote access, for example through the instance's secured reverse proxy. For Codex, keep the token in the `GROVE_MCP_TOKEN` environment variable and configure the endpoint with `codex mcp add grove --url https://<your-grove-origin>/external-mcp --bearer-token-env-var GROVE_MCP_TOKEN`. OAuth is not provided in this version.

The external tools list open sessions, registered projects and built-in skills, read messages and pending questions, send or queue messages and answer questions in an Orc, and create an Orc for a registered project. `get_config_files` returns the same configuration locations and partial-resolution issues as Settings, without file contents. Session messages page backward and retain visible progress/result kinds where known; confirmed member reports are hidden from the Orc view. Reads and writes are subject to the existing user and session rules.

An oversized message may include `bodyRef` for `read_message_body`, which returns bounded chunks. A live body may be temporarily unavailable when it exceeds the shared in-memory limit; in that case `bodyUnavailable` is returned instead of an unreadable reference. A previously returned live reference can also expire when the message leaves the live window before it appears in native history.

Writes are single synchronous tool calls: send/answer acceptance confirms native admission, queue success confirms enqueue, and session creation returns the created session. None means the Orc has completed the work. If a response is lost or an outcome is unknown, inspect the session, messages, questions and deliveries before acting; Grove never automatically repeats the operation. Simultaneous similar operations may remain ambiguous.

## Project execution environments

Spec **#4424** keeps Grove, Codex App Server and agent sessions, FlickNote and FlickLog on the instance machine. An SSH Mac supplies checkout files, the compatible native `codex exec-server`, `og`, Git and `python3` (3.9 or newer) for bounded project/preview reads. It does not need a separate Grove or agent session. No deployment, device application installation, credentials synchronization or real n5pro→Mac connection is performed by this change.

Administrators add the matching stable ID to the instance configuration (`~/.config/flickgrove/config.toml`, or `--config PATH`):

```toml
[[project_environments]]
id = "mac"
name = "Mac"
ssh = "mac"
og = "/absolute/path/to/og"
```

In the **instance machine's** `$CODEX_HOME/environments.toml` (normally `~/.codex/environments.toml`), use this non-interactive SSH argument order. Replace only the SSH alias and executor path:

```toml
include_local = true
default = "local"

[[environments]]
id = "mac"
program = "ssh"
args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", "mac", "/absolute/path/to/codex exec-server --listen stdio"]
initialize_timeout_sec = 10
```

Both IDs and aliases must match. SSH aliases come from trusted administrator configuration. Existing host-key verification is mandatory: register the verified device key in a configured known-hosts file beforehand. Grove never accepts a new key, prompts for passwords or installs tools. It captures the effective SSH destination, native transport and public known-host keys as a non-secret digest in the existing Project snapshot. Changing the destination/key/transport refuses old-session execution and outstanding preview grants; restore the original configuration to continue the original tree. App Server captures its environment definitions at startup, so restart Grove after changing them before creating a session for the new configuration. Removing an environment retains saved conversations and attachments. No schema migration or cross-device session move occurs.

For an already running authenticated native WebSocket executor, an administrator can instead add this Grove entry:

```toml
[[project_environments]]
id = "shared"
name = "Shared executor"
transport = "wss"
og = "/absolute/path/to/og"
```

Add the same ID to the instance's `$CODEX_HOME/environments.toml`:

```toml
[[environments]]
id = "shared"
url = "wss://executor.example.invalid/"
auth_bearer_token = "REPLACE_WITH_PRIVATE_EXECUTOR_TOKEN"
```

Obtain the bearer through the executor operator's private channel. The file must be owned by the Grove user and inaccessible to group and other users (`chmod 600`); do not commit or share it. The URL must use verified WSS and cannot include credentials, query parameters or a fragment. Both Grove and Codex read this one token; it is excluded from project snapshots and command arguments. A token rotation retains the target identity; changing the URL, environment configuration or remote `og` path changes it and refuses existing execution and preview grants. Restart Grove after native configuration changes so its App Server and project reads agree. The remote executor needs Python 3.9+, Git, `og` and its own registered projects. The targeted Codex App Server and exec-server version is **0.165.0**; direct WSS execution and remote stdio MCP are experimental, and the WSS integration probe below must pass for a particular installation before relying on it. This change does not provision or operate the executor or its TLS proxy.

New session offers **Execution environment** before the existing searchable Project choice when more than one environment is configured. With only the instance machine, the additional choice is omitted. Project discovery runs that environment's `og project list --json`. Same aliases and path strings on different devices remain distinct. Every tree fixes its environment; Workers, Reviewers and Researchers may choose another registered project in that same environment. A Pi Orc setting or a Pi member preset is rejected before remote admission, without changing the backend. Change the Orc setting or select a Codex member preset.

An Orc may pass `worktree: "/absolute/linked/root"` with the required `project` alias to `worker_start` or `reviewer_start`. The root must be an existing linked worktree of that active registered project on the tree's original device. Grove stores its canonical directory in the existing project snapshot, so later work and relative report links use that directory; deleting it leaves history and eligible closure available. Grove does not create or remove worktrees. The device's `og` must support `project resolve-worktree` for this selector and previews outside existing project/session roots. Older versions continue to support ordinary registered-project use. Remote devices use the configured `og` executable; local reads use `og` on PATH.

Each new Codex thread and execution turn explicitly selects its saved environment. Original-thread recovery rechecks its captured target and uses the same binding for subsequent turns; steering keeps the already accepted native turn. Native environment lists after resume can include `local` as well as the saved executor; that list alone does not establish Grove ownership. Managed history uses the saved Project binding, and cursors cannot cross environments. A remote native history without Grove's original target snapshot cannot be assigned to a device or adopted for execution. In the existing environment/project picker, **Saved history** entries come from persisted Project snapshots, including closed trees and removed environments. When alias, environment, captured target and path match a current registration, the picker shows only that registration, with both New session and Find history available. An unbound local snapshot has the same local identity as an explicit local binding. Unmatched snapshots retain their separate Saved history entry and cannot create a new session. Their history lists, previews and full message bodies read the centralized native transcript without live SSH project discovery or writer admission. Saved entries keep separate target identities when an environment ID is retargeted; history cursors cannot cross those targets. New-session creation uses live registered projects; explicit resume and remote file previews still require the original execution target to be available. Device unavailability reports an error for the requested operation; it never switches devices, changes engines or resends unknown submissions. Browser→Grove connectivity remains separate from project-device connectivity.

`og mcp` runs through the selected native executor, with the same checkout and remote `og` executable used for discovery. Remote og is a required native MCP: startup failure refuses opening the thread. The Grove collaboration MCP explicitly runs in `local`, and its private token stays on the instance machine. Other MCP services keep their configured ownership; there is no “move all MCP” switch. User uploads and native message images retain instance storage ownership. Native image inputs are prepared by the centralized App Server rather than treating upload paths as Mac paths.

For a remote conversation, Composer searches **Grove instance skills**: enabled user/admin/system/plugin skills and shipped Grove workflows discovered by native `skills/list` from the instance Codex configuration root, excluding repository-scoped results. It never queries that API with a remote checkout path. Native execution still loads the remote project's AGENTS/skills, and explicit selection of a centralized skill loads its body through native host skill roots. This does not scan, copy or install remote project candidates. Local project skill discovery keeps its existing behavior.

HTML, Markdown, images and their relative resources use the existing conversation-authorized preview contract. A remote grant captures the environment/target digest and the device's canonical resource root. Every relative read rechecks the captured target, root and symlink containment, regular-file requirement and 20 MiB limit. Existing 15-minute TTL, read-only HTTP, CORS and HTML sandbox policies apply. Disconnects and changed targets fail closed, even when a same-named local file exists. There is no unauthenticated SSH file endpoint or general remote file browser.

When a file lies outside the usual roots, Grove can admit it through an enclosing linked worktree verified by the original device's `og` against its active project registrations. Existing source-file and document resource bounds still apply; failed verification grants no access.

Browser, WeChat developer tools and Blender remain fixed to the Mac independently of the project environment. Configure each device MCP separately on the instance machine, for example an administrator-owned SSH stdio command with `environment_id = "local"` that launches that tool's actual Mac executable. Retain its normal authentication and application permissions. FlickNote's loopback service, FlickLog's collection/query entry point and the Grove bridge remain centralized. This PR does not configure those applications or verify real FlickLog hooks or production deployment.

Verification uses the existing Workspace/FakeRuntime, strict wire, preview HTTP and isolated browser fixtures. From the repository root:

```sh
bun test server/project-environments.test.ts
bun run test:browser --config tests/environments.config.ts
TEST_CODEX_BINARY=/absolute/path/to/codex bun tests/native-environments.probe.ts
```

The opt-in native probe uses real App Server/stdio executor processes, test-owned HOME/CODEX_HOME, two temporary checkouts and a scripted loopback provider. It verifies actual shell files, og MCP checkout/HOME, centralized/shipped skill bodies, remote project instructions, local-token exclusion, process restart and missing-environment refusal. It makes no real model calls or SSH connections and removes only its owned fixture. It has been exercised with Codex **0.163.0** and client **0.2.1**. Native environment and MCP APIs are experimental; see [App Server](https://learn.chatgpt.com/docs/app-server) and [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Actual n5pro→Mac connectivity and device permissions remain deployment acceptance work.

The separate `tests/native_wss_test.py` probe uses a loopback TLS proxy, a fake provider, a test-owned registry and existing Codex and `og` executables to exercise WSS project reads and actual remote stdio MCP. Run it only in an isolated test environment after assessing the combined memory and temporary-storage budget; it must never use live homes, credentials or services. On a Linux host with user systemd scopes, `tests/wss-test-budget.py` supplies a 1 GiB memory limit and temporary-storage monitoring for the targeted WSS checks. Set up and approve the concrete test operation before running it.

## Independent connections and recovery

The browser reconnects to the same local instance and retains its last-known read-only cache. Disconnection disables writes until the connection recovers. Standard WebSocket Ping/Pong checks the browser connection; the browser also uses a lightweight identity probe because it has no Ping API. Business request deadlines reject individual requests without closing the socket. Quota and model queries do not act as heartbeats.

Reconnection verifies identity and obtains a fresh authoritative snapshot. Each browser/connection independently selects its visible detail. Closing an observation connection does not interrupt execution.

Each message or answer has an immutable operation ID and content envelope. The owning instance reserves a new ID before submission; a lost reservation response does not authorize using that ID. The draft and attachments remain available until reservation succeeds. Public receipts are **accepted** (native start/steer confirmation) or **rejected** (definitely not received). Lookup returns `null` for processing, unknown native admission or absence; null is never rejection or permission to replay. A reserved ID can be finalized against its full original envelope before admission, preventing a delayed request from sending it. Reservations are bound to the human and conversation and persist with the session; unused reservations have no automatic expiry.

If opening or resuming the original native thread fails before an input is sent, the rejected message remains visible with the actual error. An explicit **Retry** can reserve a single successor using the original text and attachments. For example, an older unsaved empty thread may have no native rollout to resume. Grove does not replace that thread or pretend it accepted the input. Failures after a native send attempt remain unknown unless receipt or matching native input proves an outcome; previously uncertain submissions are not reclassified or replayed. Unsupported history reads remain separate, actionable reading errors.

## Message attachment storage

Spec #6126 streams each raw attachment to the current instance after a manifest binds it to an original human, conversation and operation. Proxies must admit PUT bodies up to 100,000,000 bytes on `/api/attachments/` and preserve browser origin and Peer identity headers. Ordinary files are limited to local execution. Keep the Peer’s private `attachments/` and `media/` directories with the workspace on backup. Unbound preparation expires after 24 hours. Referenced files and images are retained with the original operation. Downloads use existing authenticated same-origin conversation access. Chord carries attachment references within its existing frame limit.

The HEIC decoder runs on the Peer. Keep the Bun dependencies with the application when packaging the server. Installations use the existing SQLite migrator for the added delivery file-reference column. Native Codex and Pi receive the compatible image through their existing image input. Ordinary files are passed as local paths at the native boundary, while the original user text remains visible in Grove.

## Native runtime ownership

Each execution host lazily starts **one Grove-owned managed Codex app-server** for all of its Orc/Worker handles, history/model/skill/usage catalog reads and title threads. Concurrent opens share the same connecting client. Grove uses the existing explicit executable path, environment and bootstrap; it does not attach to, start or manage a system daemon.

Thread start captures each agent’s model/effort/service tier alongside cwd, role instructions and private MCP token. Resume keeps the native thread’s saved model/effort/service tier; Grove reconciles its display cache at startup and when selecting detail. Native notifications are filtered by thread ID. Native synchronous requests without an owned thread are rejected; Grove’s async question/MCP flow remains the supported interaction and no approval/tool consumption is fabricated. Stop targets only its observed thread/turn. Closing an agent aborts its title task and unsubscribes only its native thread, leaving Codex’s native unload lifecycle and other threads intact. Tree/report/question closure guards and native writer locks remain in force.

A successful native resume establishes the execution handle with any cursor returned by native; a missing cursor does not require a history probe before sending. Authorized history reads synchronize their own content and cursors separately, retaining errors and Retry without tearing down a successfully resumed handle.

A shared process disconnect affects its open agents together. They show interrupted/unknown results; the next explicit operation reconnects the managed client and resumes the original thread. Unknown submitted inputs are not replayed. Closing a browser releases only observation. Shutting down Grove closes its managed client. Isolated tests observe one process for two concurrent agents plus catalog/title work, versus the previous per-agent processes and separate catalog process. This is process-count evidence; no measured memory or CPU saving is claimed.

## Codex and Pi sessions

Spec **#4298** adds independent execution-backend selection. New session and Settings choose the Orc's Codex/Pi backend and model; the instance's current member preset chooses Worker, Reviewer and Researcher models. Pi selection includes its provider; provider, model and backend remain separate identities even when names match. Existing sessions keep their backend. A model change applies to the next new run; the current run retains its captured selection. Missing models, credentials, disabled image reading (`images.blockImages`) or unsupported images fail explicitly without switching engines or dropping attachments.

Pi tool reads and submitted images use Durable's public Photon processor, with the selected model's image width/height/base64-byte limits and SDK defaults for unspecified limits. Grove retains prepared images and fingerprints original input before model-dependent preparation; a failed preparation rejects the whole input. The adapter uses the documented in-process mode because the public processor has no disposal API: no image worker or idle timer survives Stop/close, while Photon's shared WASM memory remains allocated for the server process lifetime.

Spec **#4331** replaces the Pi executor with `@earendil-works/pi-durable` **1.3.0**, with pi-ai, pi-codemode and pi-mcp fixed at **1.3.0**. The coding-agent package remains for its public ModelRuntime, SettingsManager and resource discovery APIs. The normal root `bun install` installs them; no global installation or account setup is performed by Grove. Its official ModelRuntime reads `auth.json`, `models.json` and `models-store.json`; SettingsManager reads `settings.json` from the standard Pi agent directory (normally `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`). One host option selects another existing directory:

```sh
bun run start --pi-agent-dir /path/to/pi/agent
```

This sets the process-local Pi resource directory used by the fixed Durable MCP adapter. Grove does not copy account material into SQLite or the browser, run login flows, or resolve credential shell commands while listing models. Custom compatible providers come from the official model configuration. OAuth access and refresh use the official credential store and its file locks; that SDK's auth writes do not promise temporary-file/rename atomic replacement. This is separate from Grove's atomic SQLite migrations and delivery transactions.

Reviewer/Researcher prompts remain in the existing TOML and prompt files; their models come from the current member preset. For a Pi entry, use provider/model IDs that already appear in your Pi catalogue and an effort that model supports (`off` for a non-reasoning model). Each new member captures backend/provider/model/effort plus its responsibility text, and restore uses that captured configuration rather than the current preset. Orc model selection belongs to application preferences, never skill/tool arguments.

Pi preserves project AGENTS and skills, including Grove's shipped skills, and the SDK's local coding tools. Passive skill discovery reads installed managed npm packages under `agentDir/npm/node_modules`, installed git/local packages, and configured project/user skills using the official resolver's skip policy and package filters. It neither installs missing/mismatched packages nor launches npm/git discovery. Legacy global npm/pnpm package locations are not searched by passive reads; execution retains Pi's official resource discovery and installation behavior. Grove's fixed role instructions remain authoritative. Arbitrary execution extensions, including another native subagent entry point, are not loaded automatically.

### Member model presets

Spec **#5537** gives one local instance a current **member model preset**: the backend, provider, model and reasoning effort for a new Worker, each of the three Reviewer axes and a new Researcher. Every member creation reads that preset, so an already existing Orc also uses a newly selected preset; created members, running turns and re-reviews keep their captured configuration, and the Orc keeps its own new-session/settings choice. Switching a preset therefore changes only later members.

Presets live as one TOML file per preset in `member-presets/` beside `config.toml` (normally `~/.config/flickgrove/member-presets/`). The file name without `.toml` is the stable preset ID; `name` is the displayed name. Both must be unique. Every file describes all five members:

```toml
name = "DI only"

[worker]
backend = "pi"
provider = "deepinfra"
model = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
reasoning_effort = "high"

[reviewers.standards]
backend = "pi"
provider = "deepinfra"
model = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
reasoning_effort = "high"

[reviewers.spec]
backend = "pi"
provider = "deepinfra"
model = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
reasoning_effort = "high"

[reviewers.high_risk_spec]
backend = "pi"
provider = "deepinfra"
model = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
reasoning_effort = "xhigh"

[researcher]
backend = "pi"
provider = "deepinfra"
model = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
reasoning_effort = "high"
```

`backend` is required; a Pi entry requires `provider` and a Codex entry must not set one. Reviewer tables are limited to `standards`, `spec` and `high_risk_spec`. Initialization writes three editable examples only when those files are missing and never overwrites an existing file: `di-only` (Pi/DeepInfra `deepseek-ai/DeepSeek-V4.1-Flash-1017`, high; high-risk Spec xhigh), `ds-only` (Pi/DeepSeek `deepseek-flash`, high — that model has no xhigh) and `codex-only` (Worker and high-risk Spec gpt-6.1-terra/xhigh; Researcher, Standards and Spec gpt-6-luna/high). A Pi provider/model ID or effort that another machine does not offer is reported when a member is created; edit the file there.

The directory is re-read on every access, so added, edited and deleted files appear without restarting the instance. One unreadable file never hides the others: the list reports its own error. The current selection is shared by the whole instance and persisted in workspace SQLite; without a saved selection the shipped `codex-only` preset applies. A saved selection that is deleted, corrupted or assigns an unavailable model is reported and refuses member creation — it never silently falls back to another preset. Member creation validates the resolved model against the existing catalogue and backend before starting anything, and the tree's Fast policy still follows each model's capability.

Authenticated clients use `GET /member-presets` for the list and current selection and `PUT /member-presets` with `{"preset":"<id>"}` to change it; only non-secret configuration crosses this boundary. The response is `{ "presets": [{ "id", "name", "error"? }], "current": "<id>", "currentError"?: "..." }`, where `error` and `currentError` are actionable messages rather than a fallback. The write validates the selected file first, and concurrent selections resolve to the last completed server write. Only the Orc detail keeps a Model/Reasoning effort control; a Worker detail shows its actual model without offering that edit. No deployment, live configuration change or real model request is part of this feature.

### Configuration files

Spec **#5554** lets a client show where this instance's configuration lives. The authenticated read-only `GET /config-files` returns `{ "files": [{ "source": "grove" | "pi" | "codex", "name", "path", "description" }], "issues": [] }`, using the same login, origin, `X-Grove-Peer` instance identity and `no-store` semantics as `/member-presets`. Every `path` is absolute on the instance's execution host: a relative `--config`, member preset directory, Pi agent directory or `CODEX_HOME` is resolved against the Grove process directory, which is where the runtimes read it. A `path` is a determined location; it does not promise the file exists, and no entry is stat'ed or existence-checked. Resolving the Grove entries reads `config.toml` and enumerates the member preset files, but no file content is returned, and credential files are never read. `issues` holds short messages for a source that could not resolve its own locations, while every other source stays listed. It is never a directory scan, a file-path parameter or an editor.

The `grove` entries are `config.toml`, the conventional `prompts/role-division.md` task-division file, the Orc, Researcher and Reviewer prompt paths resolved from `config.toml`, and one entry per member preset discovered in the presets directory. The `pi` entries are `settings.json`, `models.json`, `mcp.json` and `auth.json` in the Pi agent directory (normally `~/.pi/agent`, following `PI_CODING_AGENT_DIR` and `--pi-agent-dir`). The `codex` entries are `config.toml`, `environments.toml` and `auth.json` in `CODEX_HOME` (normally `~/.codex`). Credential files appear as path and purpose only; their contents, values and any other file content never cross this boundary. Project-level Pi MCP configuration is not listed because one instance has no single reliably determined trusted project file. A user copies a path and its purpose into a request to the agent; the catalog itself sends and changes nothing and implies no deployment or restart.

### Built-in web and documentation tools

All Grove roles have `web_fetch_structured`, `web_links`, `web_docs_resolve`, and `web_docs_fetch` in Codex and Pi sessions. `web_fetch_structured` accepts `url`, optional `mode` (`auto`, `full`, or `tree`) and `section_id` for navigating long pages. `web_links` accepts `url` and optional `limit` (1–100). Both use HTTP by default and can access addresses reachable from the Grove machine, including localhost and private networks. They follow the upstream HTTP redirect behavior. Use `render: "browser"` and an explicit integer `waitMs` from 0 to 30000 for a client-rendered page; HTTP does not accept `waitMs` and there is no automatic browser fallback. Browser rendering requires a separately installed `agent-browser` and browser runtime. Each render uses its own session and temporary configuration, restricted to the public target host, its subdomains and the upstream CDN allowlist, and closes the session afterward. Browser rendering rejects private or reserved target addresses. It does not use a user's browser profile.

`web_docs_resolve` accepts `query`; `web_docs_fetch` accepts `library_id` and optional `topic` and `tokens`. Context7 works anonymously when no key is set. An optional key is shared by all users and agents in this Grove instance; it is stored as the private `context7-api-key` file beside the active configuration file, not in SQLite or agent configuration. It is plaintext on disk, protected by file permissions, and read again for each documentation request. Settings show only whether it is configured and allow replacement or deletion. The tools use the copied Guion Web implementation ([source and license](../server/vendor/guion-web/UPSTREAM.md)). Their JSON results preserve upstream fields; renderer capability failures expose their code and safe details as the Grove tool error message.

Tool catalogs are captured when the native session is initialized. Existing sessions may need to be reopened or restored to discover newly added tools; changing the Context7 key does not require that. These tools are separate from Pi's DeepSeek tools below.

### DeepSeek search and fetch

Pi sessions include `web_search` and `web_fetch` from the vendored `pi-deepseek-search` 1.2.2 implementation ([source and license](../server/vendor/pi-deepseek-search/UPSTREAM.md)). They are available regardless of the selected model and do not depend on an installed Pi plugin. Grove excludes this npm package from its Pi resource discovery, so a missing configured copy is not installed; other third-party extensions remain disabled. MCP tools keep their `mcp__<server>__` names and cannot replace these tools.

The tools resolve the DeepSeek key through Pi's ModelRegistry first, then `DEEPSEEK_API_KEY` or `ANTHROPIC_AUTH_TOKEN` as upstream does. A missing key fails the tool call, not the session. The default backend uses DeepSeek's standalone Search and Fetch APIs; `DEEPSEEK_SEARCH_BACKEND=server` uses an additional DeepSeek model request for search (`DEEPSEEK_SEARCH_MODEL`, default `deepseek-flash`), while fetch remains standalone. These requests can incur provider charges. Query/domain validation, retries, result formatting and errors follow the vendored version; terminal-only renderers are omitted, and credentials echoed in provider output are redacted. Stop and session close cancel in-flight calls, and interrupted calls are not replayed automatically. Changes to the installed Pi plugin do not update the vendored version.

### Official codemode and MCP

Executing Pi sessions install Durable's official codemode and tool_search factories, with the official CodemodeSandbox and CodingTools/NodeExecutionEnv. Codemode and search are available with no MCP configuration. The fixed MCP extension uses official pi-mcp discovery, stdio/Streamable HTTP transports, cancellation, close, and reconnect; it is not a general coding-agent extension host. A dropped connection or expired Streamable HTTP session is re-established. An expired session is retried once because the server rejected the call before running it; a call that may have run is reported instead of replayed. A connection attempt retries briefly on a transient HTTP or network failure, and a server that stays unreachable is reported in the MCP status section until it reconnects.

Configure servers in the agent directory's `mcp.json` or a trusted project's `.pi/mcp.json`. Project entries replace matching global entries; entries containing only enabled/exposure/toolExposure override those global settings. Disabled servers do not connect. Command/args/cwd/env, static HTTP headers, environment/command credential values, timeout, exact/pattern toolExposure and direct/deferred/codemode/hidden exposure are supported. Direct tools are initially declared, deferred tools load through official tool_search, codemode tools are callable only through scripts, and hidden tools are unreachable. `list_mcp_resources` and `read_mcp_resource` use the same authorized connections.

**MCP OAuth is deferred.** Explicit OAuth/provider-auth configuration or an OAuth challenge reports a sanitized unavailable state; configure static authentication headers/token or a server without authentication. The adapter does not read/write `mcp-auth.json`, refresh MCP tokens or start login/callback flows. Other usable servers remain connected. This exclusion does not affect model OAuth, which stays with ModelRuntime. MCP URLs, headers and environment values stay private; handshake and call failures are sanitized and uncertain mutations are not retried automatically.

Cold native history uses public storage queries over a readonly SQLite attachment, with an exact released-schema check. Only SDK migration-version metadata is initialized in memory; native files are neither migrated nor copied. History listing reads each session’s metadata and first entry; selected history reads bounded entry pages. Missing, outdated or mismatched native schemas fail explicitly. Active writers use WAL; graceful release checkpoints and switches its own database to rollback journaling so cold reads create no WAL sidecars. A reader never repairs missing WAL sidecars. Authorized startup acquires the writer lease and performs native recovery independently of history reads; a failed journal transition fails release and cannot confirm business Close.

Conversation messages expose optional `kind: "progress" | "result"`; absence means unknown. Codex maps the native `commentary` and `final_answer` phases, without guessing a missing phase. For Pi, a result requires a visible native input whose completed submission points to the assistant entry, and a completed generation whose result points to that same entry. The saved model response must have no tool call and an SDK answer stop reason (`stop`, `length`, or `toolUse`). A Pi assistant entry containing a tool call is progress, including when that tool round terminates or hands off. Other uncertain responses remain unclassified: a completed generation alone can also hand off through a yield hook. A tool call in a separate entry is not associated by adjacency. Classification reads only the current bounded native page or recent live view; if the corresponding input is outside it, the answer remains visible but unclassified. No history is replayed or migrated to fill gaps.

This mapping follows pi-durable 1.3.0 `dist/harness/generation.js`: `classify` starts a tool round only for `toolUse` with calls; `answer` commits the generation result and settled input together, but can hand off at `onYield`; `finishToolRound` may settle inputs at the tool-calling entry on terminate or handoff. Isolated fake-provider coverage in `server/pi-conversation.test.ts` exercises the actual SDK and its stored entries; `server/message-kind.test.ts` covers missing and conflicting evidence.

Grove role tools always call `Workspace.tool` with the current session's private token, including calls from codemode. Configured `flickgrove` MCP servers are excluded so they cannot replace that identity. Native subagents and arbitrary coding-agent extensions are not installed. Stop cancels the agent's native scope and releases its MCP connections; subsequent work reconnects them. Shutdown and failed startup release watches, environment processes, sandbox, clients, native storage and writer lock.

### Reading, continuation and capabilities

Pi automatically continues already accepted native work after service restart and when a closed Pi Orc is explicitly reopened from history. Grove waiting follow-ups remain paused until Continue. Startup restores Grove role/owner/configuration, installs its tools, acquires the native snapshot/watch, reconciles original request IDs, then resumes Durable. It never resubmits unknown input to discover whether it was accepted. Browser reconnect, detail selection and history reads do not submit input or start another executor; background recovery remains independent of the browser. Codex keeps its existing explicit recovery behavior.

New authenticated human inputs carry the delivery-time nickname and original submission time to the model. Codex uses untrusted additional context; Pi persists a separate user content part with the input. Grove's live and history views retain the original message and attachments. Unattributed and agent inputs are not assigned a human author.

Each Pi agent owns one native SQLite store under `agentDir/grove-durable/` and a writer lock. Durable's public portable SQLite storage runs over a serialized Bun adapter because Bun lacks `node:sqlite`. Native storage is separate from Grove business SQLite; their commits are not one transaction. Native request IDs, submission IDs, entry IDs and immutable envelope fingerprints associate accepted inputs with Grove operations. Busy steering is durably accepted while queued, before model consumption. Terminal task/submission facts establish completion; an intermediate assistant entry does not.

Stop targets the observed agent's native run and queued scope. Accepted inputs withdrawn by Stop remain accepted and display their later cancellation result; Grove does not resend them. Ordinary shutdown checkpoints unfinished work for restart. Business Close refuses known active work and releases resources before committing closure; explicit confirmation can retain unanswered questions, reports and unknowns. Closed members do not automatically resume. A memory-only native database snapshot supports bounded read-only history/body/image pages without opening a Harness, extensions or a missing database. Both backends retain their qualified identities and per-item clientId association for member deliveries. Shipped Codex migrations remain unchanged, and this replacement adds no domain migration or old Pi JSONL conversion.

Settings used by execution are the captured backend/provider/model/effort, effective `images.blockImages`, AGENTS/skills/resource trust and package filters, default coding-tool selection, shell path/prefix, steering/follow-up modes, retry/provider transport/timeouts and compaction thresholds. Model/effort changes affect the next run; the current run keeps its native agent selection. Thinking budgets are passed through ModelRuntime. TUI-only settings and unrelated third-party extension behavior do not create additional execution paths.

Fast remains a tree preference and affects only supporting members/models. Pi currently keeps the default tier, while a Codex member can still use Fast. Codex weekly usage is shown only for Codex surfaces and is never presented as Pi usage. Pi image capability follows the selected model; native image history remains readable. No cross-backend quota or billing aggregation is provided.

Verification uses real SDK sessions with local fake streaming providers, test-owned homes/auth/configuration and temporary tools/projects. Run from the repository root:

```sh
bun test server/pi-deepseek-search.test.ts server/pi-durable.test.ts server/pi-recovery.test.ts server/pi-mcp.test.ts server/pi-native.test.ts server/pi-boundaries.test.ts server/pi-skills.test.ts server/mixed-runtime.test.ts
bun run build
bunx playwright test -c tests/mixed.config.ts
# On machines without the Playwright Chrome channel:
CHROMIUM_PATH=/path/to/chromium bunx playwright test -c tests/mixed.config.ts
```

The native tests execute official codemode, MCP exposure/resource/HTTP/static-auth calls and cancellation; model OAuth refresh locking uses fake tokens. They exercise both mixed-tree directions and every managed Pi role, accepted queued recovery, Stop and passive history. Browser fixtures use the real Pi SDK with a local fake model. They do not use installed credentials, real OAuth login or paid model turns; deployment, live migration and service restart are separate operations.

## Workspace storage

`server/schema.ts` defines the typed SQLite schema using Drizzle ORM's Bun adapter. Five core business tables separate session identity and current state (`sessions`), captured prompts/profile/default settings (`session_config`), immutable operation envelopes and current outcomes (`deliveries`), original questions and confirmed answers (`questions`), and ordered per-operation question/answer associations (`delivery_questions`). Operation IDs are scoped to the receiving session. Original array order is stored independently of timestamps. Association identity is `(session_id, operation_id, position)`: repeated question IDs in one legal delegated envelope retain their original sequence. A NULL associated answer falls back to the operation's original text; an explicit empty string remains empty.

Small JSON objects have named TypeScript contracts: project alias/name/path snapshots, current execution settings, durable recovery guards, current role task, diagnostics, captured configuration, and report target snapshots. Current Reviewer targets can change; earlier report targets remain captured. Private MCP tokens stay durable and are omitted from public projections. Delivery rows retain only file IDs, names and byte counts; original files are private to the Peer under its workspace `attachments` directory, while prepared images remain under `media`. Native transcripts remain under their existing authority. User-handoff candidates and handoff/final-failure notification identities remain instance-local memory and are projected in snapshots; they are not a durable notification ledger. Workspace/reading revisions, cursors, online timing, branch projections and message bodies are not persisted in this database.

Attachment preparation freezes the message text, operation mode, ordered kinds, names and declared byte sizes before streaming each body to private storage. A completed manifest yields bounded image and file references; it does not admit the message. Direct sends use their reserved identity; follow-ups use their existing queue identity. Admission rechecks the owner, session, execution environment and exact prepared set. A rejected direct operation can reuse its original references through the authorized successor; an unknown operation is inspected under its original identity. Startup and later preparations remove unreferenced stages older than 24 hours; a durable delivery or a matching finalized submission fence retains the referenced bytes. Originals are downloaded through the authenticated same-origin session and are never sent over Chord. HEIF input is decoded by a server-only libheif WASM worker, with image size checks before pixel allocation and a bounded decode time; the prepared image uses a native-supported format.

The existing per-delivery context JSON can also retain the original attempt's steer target and an observed terminal event. This evidence describes the targeted turn only; it does not confirm input admission or an external operation's outcome. Old deliveries without the evidence remain unconfirmed. It is stored with the operation row rather than as a growing session-level ledger; no SQL migration is needed.

Uncertain follow-ups are inspected in the background using their original operation ID, with per-session serialization and bounded backoff. The check never opens an execution session: Pi can inspect its native storage without a handle, while Codex waits for an existing session connection. Native evidence can update Grove's stored confirmation and idle boundary; absence or an unavailable inspection remains unknown and never resends the input. For local Codex, a paused queue remains paused until Continue, even after inspection confirms an earlier admission; a directly sent message runs without unpausing it. At restart, waiting local Codex follow-ups remain paused and idle sessions reconnect on selection or another operation. For Pi and remote sessions, the existing automatic confirmation behavior remains unchanged. Some native records may never provide enough evidence to settle.

A queue-full or stopping refusal is recorded against the original follow-up ID before it is returned, so a delayed request cannot enqueue the same input after the queue changes or the instance restarts. Storage failure or an unconfirmed native outcome remains unknown.

During orderly shutdown Grove asks the native server to interrupt observed local Codex turns in parallel, and waits at most 4.5 seconds for their terminal events before closing the server. Only an observed terminal event establishes that turn's result; an acknowledgement, connection loss, timeout, or a fresh server's idle view does not. Previously unknown admissions and external side effects keep their existing recovery evidence. Unconfirmed turns from an earlier restart cannot be retroactively proven stopped by this shutdown procedure.

For local Codex follow-up inspection, an `interrupted` status reconstructed from native history alone does not establish that the original execution stopped: a new app-server may project an unfinished rollout as interrupted when it has no live turn. The original operation can still be confirmed as admitted by its native client ID, while its execution outcome remains unconfirmed.

Authentication tables hold users, credentials, sessions, verification challenges and hashed one-use codes. Delivery rows hold an optional authenticated author and admission time; `tree_user_activity` retains the latest confirmed admission per tree and user. An Orc's nullable `last_activity_at` records observed activity for its whole tree and supports the recent activity navigation. Existing rows stay null until new activity; member closure does not erase their owner's latest time.

Before accepting requests, startup runs the committed `drizzle/` SQL with Drizzle's Bun migrator. Its `__drizzle_migrations` log is the sole schema version record. The first migration creates the tables, converts the previous single-row JSON using SQLite JSON functions, and removes `workspace` in the same transaction as its success record. Failure rolls back business data and the success record and refuses startup; the old data remains available for a repaired retry. An empty migration log table may remain after failure because Drizzle creates that container before BEGIN. Unknown migration hashes/timestamps refuse startup. There is no dynamic schema diff, dual write, or old-version reader. Interrupted turns and unconfirmed admissions reconcile without automatically resending input or replaying native work.

From the repository root, edit `server/schema.ts`, run `bunx drizzle-kit generate --name=<change>`, and review the generated SQL and snapshot before committing. Run the same command again to check that the schema produces no additional migration. Keep one-time data conversion SQL in its explicit reviewed migration. Normal queries use the typed SQL builder; raw SQL is limited to migration/startup metadata and test diagnostics. The application runs from this checkout (`bun server/main.ts`); ship the `drizzle/` directory beside the server source when packaging it.

Only open aggregates load at startup. Closed histories load by identity/thread on demand and rejoin active memory only after explicit restoration. The existing mutable Workspace observes durable entity changes in place and queues only those session/config/delivery/question rows for its next transaction. A message event trims only its own memory window (100 items / 256 KiB); it does not diff, serialize or rewrite cold history or the active operation ledger. Admission persists before native send; confirmation and its question answers commit together before publication. A failed write prevents admission/publication. Active aggregate reads then fail closed so uncommitted in-memory confirmations cannot escape through detail/recovery/question APIs; detached committed cold history remains readable. Delayed title callbacks require the same current aggregate and native handle before changing durable state.

Browsers retain their device reading cache. Opening without reading content shows the existing conversation spinner until native history succeeds; failure or a 15-second read timeout ends loading and offers Retry. Existing reading remains visible across empty server-memory publications, reconnects, failed reads and reload. A successful empty native conversation settles normally. Reconnection advances the reading entry’s in-memory generation independently of server revision reuse. In-flight responses/errors from the preceding generation cannot publish content or a synchronized revision; once they settle the current generation fetches again. Native item/client identities merge arrivals and prevent duplicate report cards. Failed submission deletion/retry checks native history as well as the durable journal, so memory eviction cannot weaken acceptance guards. History preview performs reads without resuming a native writer.

Validation uses test-owned SQLite databases, homes/configuration, FakeRuntime, strict native wire and isolated Peer/Chord/browser fixtures. `bun test server/workspace-store.test.ts` exercises the real Bun migrator, complete durable roundtrips, rollback/refusal, cold-row isolation, long ledgers and admission failure. The isolated scale comparison and HTML review are local scratch artifacts, not deployed data. These measurements establish removal of the cumulative save overhead; they do not establish the sole cause of the original Mac disconnection or verify live deployment.
