# Overleaf LaTeX

**Create, edit, and compile LaTeX in your Overleaf account from ChatGPT, Codex, or an MCP client.**

[![CI](https://github.com/MarcoDotIO/overleaf-latex/actions/workflows/ci.yml/badge.svg)](https://github.com/MarcoDotIO/overleaf-latex/actions/workflows/ci.yml)
[![Plugin Security Scan](https://github.com/MarcoDotIO/overleaf-latex/actions/workflows/plugin-security.yml/badge.svg)](https://github.com/MarcoDotIO/overleaf-latex/actions/workflows/plugin-security.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-287A38)](https://modelcontextprotocol.io/)

Bring a document from a prompt to a compiled PDF while keeping the project in Overleaf. This repository includes thirteen MCP tools, a local login helper, and a Codex plugin with an `$overleaf` workflow skill.

> Create an Overleaf project named “Research Notes”. Write a complete LaTeX article explaining Monte Carlo estimation, with an equation and a worked example. Compile it, fix any errors, and return the project link and PDF.

[Quick start](#quick-start) · [Connect your assistant](#connect-your-assistant) · [Tools](#tools) · [Documentation](#documentation)

## What it can do

- **Work with real projects:** find existing projects or create a new one in your account.
- **Apply bounded edits:** patch existing source with version and hash checks, a strict baseline compile, and a compile after the changes.
- **Organize documents:** create folders and source files for multi-file projects.
- **Recover failed edits:** save private checkpoints and conditionally restore confirmed writes when compilation fails.
- **Read current outputs:** inspect log windows and retrieve a PDF only while its successful compile still matches the checked source.
- **Use Google sign-in:** authenticate yourself in a browser; the plugin retains only the Overleaf session.

This is an independent, single-user integration for **www.overleaf.com**, built with reference to the [Overleaf source](https://github.com/overleaf/overleaf). It is not affiliated with Overleaf and uses internal web and real-time interfaces rather than an official public API.

## Quick start

You need **Node.js 22+**, npm, an Overleaf account, and Chrome or Playwright Chromium.

```sh
git clone https://github.com/MarcoDotIO/overleaf-latex.git
cd overleaf-latex
npm ci
npm run build
npm run login
```

Complete **Log in with Google** in the browser opened by the helper, including any verification. No Google OAuth client ID, client secret, or password is needed by the plugin. The helper uses a temporary browser profile and does not read your normal browser profile or saved passwords.

Confirm the saved session:

```sh
npm run login -- --check
```

If no supported browser is installed, run `npx playwright install chromium` and retry. If Google rejects the helper browser, follow the [local cookie import procedure](docs/chatgpt-setup.md#when-google-rejects-the-helper-browser).

## Connect your assistant

### Local MCP clients and Codex

Add the following to your client's MCP configuration, replacing the server path with the absolute path to your checkout:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/overleaf-latex/dist/server.js"]
    }
  }
}
```

For a Codex plugin installation, this repository includes [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), [`.mcp.json`](.mcp.json), and the [Overleaf skill](skills/overleaf/SKILL.md). Once the local plugin is installed in a compatible client, start a new task and invoke `$overleaf`. A plain MCP connection exposes the tools; it does not install the skill.

The default transport is **stdio**. Clients that require local Streamable HTTP can use `npm run http`, which listens at `http://127.0.0.1:3333/mcp`. This listener is for trusted local clients and must not be exposed as a public endpoint.

### ChatGPT in the browser

Follow the [ChatGPT connection guide](docs/chatgpt-setup.md) to connect through **OpenAI Secure MCP Tunnel**:

```text
ChatGPT → Secure MCP Tunnel → local MCP server → Overleaf
```

This requires ChatGPT developer-mode access, a tunnel associated with your ChatGPT workspace, and a tunnel runtime API key. Keep the tunnel client running and your computer awake while using the connection. The tunnel starts the stdio server directly; the local HTTP listener is not needed.

Building and signing in locally does not create the ChatGPT connection. This repository provides a personal integration, not a published ChatGPT marketplace listing.

## Tools

| Tool | Purpose |
| --- | --- |
| `overleaf_list_projects` | Find projects available to your account. |
| `overleaf_create_project` | Create a project and return its ID and link. |
| `overleaf_get_project` | Inspect project settings and the file/folder tree. |
| `overleaf_read_document` | Read source text, its version, and SHA-256 hash. |
| `overleaf_write_document` | Initialize an empty document using its current version. |
| `overleaf_edit_project` | Apply bounded patches, compile before/after, and recover failed edits when safe. |
| `overleaf_recover_edit` | Retry conditional recovery from a saved checkpoint, including after restart. |
| `overleaf_read_checkpoint` | List recent project checkpoints, inspect recovery state, and read original source windows. |
| `overleaf_create_document` | Create an empty source document in a project folder. |
| `overleaf_create_folder` | Add a folder to a project. |
| `overleaf_compile_project` | Compile strictly and record the checked source versions and output descriptors. |
| `overleaf_read_compile_log` | Read log byte windows and bounded diagnostics. |
| `overleaf_read_output` | Retrieve a current verified PDF, up to 5 MB, or a log window. |

Use MCP discovery for the exact argument schemas and identifiers returned by the tools. To edit existing source, read it and pass its `version` and `hash` as `expected_version` and `expected_hash` to `overleaf_edit_project`. Each exact-match patch must identify one nonoverlapping occurrence in the original text. If a conflict occurs, read again and reconcile the change. After an interrupted write or creation request, inspect current state before retrying.

One checked edit changes **1–5 files**, with **1–20 patches per file**. The per-file budget is the smaller of 10,000 code units and 25% of the original file, with a 200-code-unit floor; the whole batch allows 20,000. Deleted plus inserted text counts toward the budget, including matching context. These are UTF-16 code units. The plugin checks all text sources in projects of at most **100 text files and 8 MiB of UTF-8 source**, including shared preambles. A larger task needs several independently checked passes; there is no cap on the number of calls an agent can make.

A failed baseline compile applies no edits. A failure after writing triggers conditional restoration from the checkpoint. Only confirmed writes whose current text and version still match the plugin's write are restored. Uncertain outcomes and collaborator changes return `recovery_required` for reconciliation. This is not an atomic project transaction: external collaborators are not locked, binary dependency contents are not verified, and a successful compile does not establish scientific or visual correctness. See [edit and recovery details](docs/architecture.md#checked-edits-and-recovery).

PDFs are returned as MCP embedded resources, not public download URLs. Display and download controls depend on the client; larger PDFs can be opened in the signed-in Overleaf editor.

## Sessions and boundaries

The login helper saves the Overleaf session outside the repository at `~/.config/overleaf-latex/session.json`, using owner-only permissions. Set `OVERLEAF_SESSION_FILE` to use another private location, and pass the same setting to both login and server processes.

Edit checkpoints contain original affected source and recovery state. They persist outside the repository at `~/.config/overleaf-latex/checkpoints` with private directory/file permissions. Set `OVERLEAF_CHECKPOINT_DIR` to another private directory and retain it across server restarts if recovery is needed. Checkpoints are local source backups and are not distributed with the plugin.

- **Keep credentials local.** Treat the session file as an account credential. Never commit it or paste cookies, passwords, session files, or tunnel runtime keys into a chat.
- **Use one trusted account owner.** The server acts with the connected account's access. It is not a multi-user service or an OAuth authorization server for other users.
- **Expect compatibility changes.** Overleaf can change its internal hosted interfaces independently of this integration or its public source repository.
- **Check the result.** Updating source, compiling successfully, and retrieving a PDF are separate steps. Inspect the compilation status and log before claiming a finished document.

Run `npm run login` again when the session expires. To delete the plugin's saved local session:

```sh
npm run login -- --logout
```

This removes the local session file without revoking other Overleaf browser sessions. Stop the MCP server and tunnel when disconnecting the integration.

## Development and verification

```sh
npm run check
```

This runs TypeScript checks, the automated test suite, and a production build. New regression coverage exercises bounded patches, baseline failure, conditional recovery, collaborator changes, log pagination, and stale PDF rejection. See the [evaluation guide](docs/evaluation.md) for evidence and remaining acceptance checks.

The [September 18 hosted verification](docs/evaluation.md#verified-on-september-18-2026) exercised the original nine-tool version and produced a visually checked one-page PDF. The [September 24 edit-safety review](docs/edit-safety-review.md) also describes the original behavior, before these fixes. Neither record establishes hosted validation of the new thirteen-tool workflow. The new [local 51-page regression](docs/evaluation.md#local-long-paper-regression-september-24-2026) passed with real strict TeX compilation, the actual plugin/MCP, and simulated Overleaf transport: a chapter edit compiled, a broken shared macro was restored automatically, and recovery compiled successfully. Run `npm run check:latex` with Tectonic available to reproduce it.

To run your own live check against your account:

```sh
npm run live-check -- --create
```

This creates and edits a real test project. See the [evaluation guide](docs/evaluation.md) for saved receipts, resuming a run, and the complete acceptance checklist.

### Upgrade an existing installation

Version **0.2.0** changes `overleaf_write_document` to initialization only; clients editing existing content must use `overleaf_edit_project`. After updating the checkout, run `npm ci` and `npm run build`. Restart the MCP server or tunnel, refresh the ChatGPT connection's tools, and confirm that discovery lists thirteen tools, including `overleaf_edit_project`. For a packaged Codex plugin, update or reinstall the package containing the new build and skill, then start a new task. A running process or previously cached tool schema does not pick up rebuilt files automatically.

## Documentation

| Guide | Contents |
| --- | --- |
| [ChatGPT setup](docs/chatgpt-setup.md) | Google sign-in, Secure MCP Tunnel, connection setup, and troubleshooting. |
| [Architecture](docs/architecture.md) | Authentication, transport, document protocols, and compatibility details. |
| [Security policy](SECURITY.md) | Private vulnerability reporting, supported revisions, and authorization boundaries. |
| [Evaluation](docs/evaluation.md) | Verification evidence and repeatable local and live checks. |
| [Overleaf skill](skills/overleaf/SKILL.md) | The bundled workflow for creating, editing, compiling, and delivering documents. |

For bugs and feature requests, [open an issue](https://github.com/MarcoDotIO/overleaf-latex/issues) with reproduction steps and redacted error details. Keep session files and private document contents out of reports.
