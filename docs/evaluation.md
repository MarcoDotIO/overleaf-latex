# Verification and live acceptance

## Verified on September 18, 2026

The local MCP server was exercised against the account owner's Google-backed session on `www.overleaf.com`. All nine tools completed a real workflow: list projects, create a test project, inspect its tree, create a folder and an included `.tex` file, read and update both documents, compile, and retrieve the compilation log and PDF. The one-page PDF was rendered and visually inspected successfully.

The private test project used `sharejs-text-ot` document mode. History OT is covered by protocol fixtures and source review, not by this particular hosted project. Account-specific project identifiers, receipts, logs, and PDFs are kept locally under the Git-ignored `artifacts/` directory and are not distributed with this repository.

The reference checkout was `e039ad26c5bf5422eb57b89fc7e57c75055e631d`. The live run confirmed that the hosted socket handshake rotates a `GCLB` routing cookie; the implementation carries that cookie into the WebSocket upgrade and has a regression test for it.

This verifies the built server through the actual MCP stdio transport. A browser ChatGPT Secure MCP Tunnel connection is a separate setup step and was not configured during this run. The remaining manual scenarios below are a maintenance checklist, not claims of completed checks.

To repeat the saved test project workflow:

```sh
npm run build
npm run live-check -- --resume
```

For a first run in a new checkout, use `--create` instead. This deliberately creates and edits a real test project. The receipt saves identifiers after each completed creation so retries can reuse the project; inspect Overleaf before retrying if a creation response was lost.

Run local checks first:

```sh
npm run check
```

Record the command result and commit being tested. Local tests can verify argument handling, protocol messages, session handling, and MCP behavior with controlled fixtures. They do not prove Google sign-in, current Overleaf hosted compatibility, or ChatGPT installation.

## Local MCP discovery

Connect a local MCP client or [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) to the built stdio server:

```sh
npx @modelcontextprotocol/inspector@latest
```

Use `node` as the command and the absolute `dist/server.js` path as the argument. Confirm that all documented tools are discoverable, reads and writes have appropriate metadata, malformed inputs fail usefully, and missing authentication reports the local login command without printing credentials. The optional loopback HTTP transport is `http://127.0.0.1:3333/mcp` after `npm run http`.

## Live Overleaf acceptance

Use a dedicated test project that the account owner has authorized the integration to create and edit. Keep the project link for review. Do not run these mutation checks against an unrelated existing document.

| Check | Evidence to record |
| --- | --- |
| Sign in with Google and run the session check | Successful session check; no cookie/token values in the record. |
| List projects | Expected account projects appear, or the correct empty result appears. |
| Create a test project | Returned project ID/link opens in the same account's browser. |
| Inspect the project | Root folder and document IDs agree with the editor. |
| Read, write, then read source | Text matches the intended content and the version advances. |
| Write with an old version | The stale write fails without silently replacing newer text. |
| Create a folder and source document | Both appear in the project tree and can be read. |
| Compile a valid root document | Compile succeeds and a PDF output is returned. |
| Read PDF output | PDF resource is nonempty and opens in a supporting client. |
| Compile invalid LaTeX | Failure is reported and the log contains useful diagnostics. |
| Correct the source and recompile | Final compile succeeds and the newest PDF is readable. |
| Browser collaborator edits between reads/writes | Conflict or concurrent change is surfaced and current source is preserved. |

For a write that times out or loses its connection, read the current source before any retry. Record the uncertain outcome accurately. Do not force a conflict test by overwriting someone else's work.

## ChatGPT acceptance

With the local tunnel running and the connection enabled in ChatGPT, try these prompts:

| Prompt | Expected workflow |
| --- | --- |
| “List my Overleaf projects.” | Lists projects through `overleaf_list_projects`. |
| “Create a project called Connection Test with a short article, one equation, and a bibliography section. Compile it and give me the PDF.” | Creates project, inspects/reads source, writes valid LaTeX, compiles, and reads PDF output. |
| “Add a methods section to that article and recompile.” | Reuses the identified project, reads the latest source/version, preserves existing content, writes, and compiles. |
| “Show me the compile log for that project.” | Compiles or uses a known compile output descriptor, then reads the log. |
| “Explain how to type a subscript in LaTeX.” | Can answer directly without an account operation. |
| “Delete my Overleaf account.” | States that account deletion is unsupported; does not misuse another tool. |

Record selected tools, nonsecret arguments, result summaries, confirmation behavior, and any failures. Distinguish **source updated**, **compile succeeded**, **PDF retrieved**, and **PDF displayed**; these are separate observations. A link to an existing project alone does not establish a successful edit or compile.

After changing tool metadata or rebuilding, restart the server/tunnel and refresh the ChatGPT connection before repeating affected checks. Test the `$overleaf` skill separately in the client where the full plugin package is installed; an MCP connection alone does not load local skill files.

No live acceptance result should be inferred from this checklist. Record actual results from the environment where the integration is used.
