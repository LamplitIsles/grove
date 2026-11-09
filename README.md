# FlickGrove

**A persistent workspace for collaborating with coding agents, from a first question to reviewed changes.**

FlickGrove, or Grove, brings an Orc and its Workers, Reviewers and Researchers into a shared browser workspace. Follow their conversations, answer questions and review results while work continues on the instance after you close the browser. Grove keeps session trees and can reconnect you to their history; it does not turn an uncertain submission into a new attempt automatically.

Start an Orc on a registered project, describe the work, and use the conversation to guide it. The Orc can delegate implementation, gather evidence and request independent review. You remain involved in decisions and approvals. Grove supports Codex and a local Pi SDK runtime; their accounts, models and capabilities are configured separately.

## Before you start

You need a checkout of this repository and:

- [Bun](https://bun.com/docs/installation), with the repository's `bun@1.3.14` package manager version.
- [Organon](https://github.com/tta-lab/organon) `og` on `PATH` for project discovery. Its README documents Homebrew, source and release installation; source search through `og mcp` also needs `rg` (ripgrep). A project must be registered in Organon to appear in Grove.
- For Codex sessions, a compatible [Codex CLI](https://github.com/openai/codex) on `PATH`, signed in on the machine running Grove, and access to the chosen models. Grove launches its own app-server. Alternatively, Pi uses the SDK installed with the repository and an existing Pi provider configuration and credentials; see [Codex and Pi sessions](flickgrove/README.md#codex-and-pi-sessions).
- A browser and authenticator capable of WebAuthn with user verification. Local loopback works for first use; remote access requires a secure HTTPS origin and appropriate hosting. Use the same origin for sign-in and server configuration.

Some workflows depend on separately configured services: for example, spec and research workflows use FlickNote MCP, and forge operations need Organon's forge access. These are not provisioned by Grove. Configure an accessible FlickNote MCP server in your agent runtime before using workflows that need notes; this repository does not supply a FlickNote installation or setup guide, so obtain those from your service operator. The shipped skills describe their workflow requirements. Model availability and provider access also depend on your account.

## Start locally

From the repository root, install dependencies, build the browser assets and start the server:

```sh
bun install
bun run --cwd flickgrove build
bun run --cwd flickgrove start
```

Leave the server running. It listens on `127.0.0.1:4318` by default, with origin `http://localhost:4318` and state in `~/.local/share/flickgrove`. In a second terminal, from the same checkout and OS account, create the first-user setup code:

```sh
bun run --cwd flickgrove start --auth bootstrap
```

Open **http://localhost:4318**, enter the code and a nickname, then register a passkey using your authenticator's user verification. The setup code is single-use and expires after ten minutes. If you set `--origin`, `--port` or `--state` on the server, supply the **same values** to the bootstrap command and open that exact origin. Passkeys are scoped to an RP ID, and authentication checks the configured origin; a passkey created for a different RP ID does not automatically work after a hostname change. Keep the code private.

### Choose a project and start a session

Grove discovers active projects by running `og project list --json` on the execution machine. To create and register a new checkout from a supported repository URL, use Organon's documented URL clone, substituting your own repository:

```sh
og clone https://github.com/OWNER/REPOSITORY.git
og project list
```

Organon chooses a path under `~/code/projects/<owner>/<repo>` and registers an alias; `og clone --reference` does **not** register a project. Check [Organon's documentation](https://github.com/tta-lab/organon) for supported remotes, forge authentication and its registry. This procedure creates a checkout; it does not register an arbitrary existing directory. Private repositories and forge writes require the appropriate access and configuration.

In Grove, select **New session** (the plus button), search for and select the registered project, choose a backend and model, and select **New session**. Describe the task in the Orc conversation and send it. The backend must have usable credentials and the selected model must be available. If the project list is empty, check `og project list` under the same OS account and environment as Grove. With multiple execution environments configured, select the environment before the project; remote execution has additional [requirements](flickgrove/README.md#project-execution-environments).

## Working in Grove

Reopen a session from the sidebar to read progress, send follow-up instructions or answer an Orc's questions. Workers and other members appear under the Orc; their reports and questions return to the owner. You can attach images, use skill search and preview supported local files from conversations. Closing the browser does not stop an executing session. If a delivery has an unknown outcome, inspect its state before deciding what to do; Grove does not automatically resend it.

The shipped collaboration pattern provides a default task division, captured when an Orc is created and adjustable by the user for a particular task:

| Role       | Responsibility                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orc        | Investigates, plans, coordinates and owns the overall result. By default it handles user and developer experience, schema and migrations, one-off operations, and prompts/agent instructions.         |
| Worker     | By default handles other implementation in a shared checkout, including its verification and fixes. Mixed work is coordinated serially with the Orc.                                                |
| Reviewer   | Independently examines the specified change and existing evidence against Standards or Spec, including a high-risk Spec profile. Reviewers report findings to the Orc; they do not run verification. |
| Researcher | Investigates a bounded question and reports evidence and uncertainty. The Orc synthesizes the result and decides what to recommend.                                                                  |

The task division is editable in the instance's `prompts/role-division.md`; changes affect new Orcs, while existing sessions keep their prior division. The implementation workflow calls for Orc self-review and independent whole-PR review before merge, with user approval where applicable. Codex Orc and Worker threads run with full access in their selected environment; Codex Reviewers and Researchers use a native read-only sandbox. The shipped workflow is guidance for agents, not a guarantee that an external forge or service is configured.

### Workflow skills

The Orc composer offers **Discuss**, **Implement**, **Review**, **Re-review**, **Research** and **Diagnose** shortcuts. They insert a skill invocation into the draft; you still choose when to send it. Other shipped [`grove-` skills](flickgrove/skills/) cover domain modeling, grilling, creating and self-reviewing specs, breaking work into tickets, and implementation from a ready spec. Skill search provides access to available skills and their descriptions. Skills may require external tools such as FlickNote; install and configure those separately.

## Sharing and recovery

All signed-in users have equal authority over the shared session trees, including inviting others. In Settings under Users, a signed-in user can create a single-use, ten-minute invitation; share it privately. Each invitee chooses a nickname and registers a verified passkey. A signed-in user can add another passkey without replacing existing ones.

If a user loses all passkeys, the host can list users and create a recovery code for the intended stable user ID, again using the server's origin and state:

```sh
bun run --cwd flickgrove start --auth users
bun run --cwd flickgrove start --auth recovery --user USER_ID
```

Replace `USER_ID` with the ID returned by the first command. Successful recovery revokes the target user's credentials and sessions present in the recovery transaction and closes their existing connections; other users are unaffected. An in-flight passkey addition can complete after recovery. See [Users and passkeys](flickgrove/README.md#users-and-passkeys) for the limitation, HTTPS example and security details.

The state directory contains the workspace database, authentication records, secret, media and agent state. Keep it private and back up the database and `auth-secret` together; losing the secret invalidates browser sessions. Native runtime histories and Pi state have their own storage locations, described in the [product reference](flickgrove/README.md). For remote access, configure an HTTPS origin and serving arrangement you trust; a loopback URL on the server is not a remote-access setup.

## Configuration

On server startup, Grove initializes missing files under `~/.config/flickgrove/`: `config.toml`, adjacent `prompts/` and `member-presets/`. Use `--config PATH` to select another configuration file. Existing files and customizations are preserved; relative prompt paths resolve from the config directory. The Orc, Reviewer and Researcher role prompts are configured in `config.toml`; Worker, Reviewer and Researcher models come from the instance’s current member preset, chosen in Settings and editable as TOML files. The Orc’s model and effort are application settings in the new-session/settings UI, not skill arguments.

The repository's [config template](flickgrove/templates/config.toml) and [prompt templates](flickgrove/templates/prompts/) show the shipped Orc, Researcher, Standards, Spec and high-risk Spec defaults. They are starting points, not live replacements for an existing instance's files. New Orcs capture their prompt; new Reviewers and Researchers capture their prompt and the current member preset's model. Existing sessions, restoration and re-review retain their snapshots, so editing a template or runtime file does not rewrite an existing agent's instructions. See [Managed workflows, Reviewers and Researchers](flickgrove/README.md#managed-workflows-reviewers-and-researchers) for validation and customization details.

For operational details, remote execution, state, development and runtime limitations, see the [FlickGrove product reference](flickgrove/README.md).
