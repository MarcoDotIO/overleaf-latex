# Verification and live acceptance

## Evidence for the checked-edit update

The current interface has **thirteen tools**. The historical hosted run and edit-safety review below used the original nine-tool version; they do not establish hosted acceptance of the new checked-edit and recovery behavior.

Run the local regression suite and record the tested commit and result:

```sh
npm run check
```

The suite exercises patch limits and nonoverlapping original-snapshot matches, narrow operations in both document modes, strict baseline compilation, failed-edit recovery, collaborator preservation, uncertain writes, checkpoint recovery after restart, streamed logs, and rejection of stale PDFs. MCP tests check discovery, schemas, and status/error propagation. These tests use controlled transport fixtures and do not establish current hosted compatibility or autonomous-agent reliability.

The [September 24 edit-safety review](edit-safety-review.md) is a **historical diagnosis of the pre-fix implementation**. Its findings about unrestricted whole-file replacement, missing recovery, default continue-on-error compilation, and stale output reads describe that earlier version. Preserve that evidence as the motivation for these changes; use the current [architecture](architecture.md) for the implemented contract.

## Local long-paper regression: September 24, 2026

The checked-edit regression passed using the **actual built plugin and MCP interface, synthetic Overleaf transport, and real local Tectonic compilation**. It used a generated **51-page paper** with 14 text files, 12 chapter fragments, shared macro definitions, equations, cross-references, and approximately 88,000 source characters. No Overleaf account or user document was accessed.

| Check | Observed result |
| --- | --- |
| Baseline | Strict compilation succeeded. |
| Ambiguous repeated-text patch | Rejected before any source write. |
| Scoped chapter edit | Compiled successfully; every other file stayed byte-identical. |
| Earlier PDF after a later edit/compile | Rejected as stale. |
| Broken shared macro | Post-edit compilation failed with `Undefined control sequence`. |
| Automatic recovery | The inverse patch restored the preamble, returned `rolled_back`, and compiled successfully. |
| Current PDF retrieval | The latest PDF was returned through MCP, with 73,900 bytes; all 51 pages contained extractable text. |

There were six compiler runs and three mutations: the valid chapter patch, the invalid macro patch, and its restoration. The local receipt at `artifacts/checked-edit-local/receipt.json` records source hashes, compile statuses, requested strict mode, source versions, and checks. The PDF and checkpoints remain under the Git-ignored `artifacts/checked-edit-local/` directory.

To reproduce with Tectonic available:

```sh
AUDIT_TECTONIC=/absolute/path/to/tectonic npm run check:latex
```

This builds the plugin and runs `scripts/checked-edit-local.mjs`. The script uses `tectonic` on PATH when `AUDIT_TECTONIC` is omitted; Tectonic may need to download its LaTeX resources on a first run. Record the compiler version and inspect the saved receipt for each run. This result verifies deterministic behavior against simulated Overleaf I/O. It does not establish live collaboration safety, hosted compiler compatibility, ChatGPT setup, or how reliably an unattended agent chooses and repairs edits.

## Verified on September 18, 2026

**Historical hosted verification of the original nine-tool release.** The local MCP server was exercised against the account owner's Google-backed session on `www.overleaf.com`. All nine tools completed a real workflow: list projects, create a test project, inspect its tree, create a folder and an included `.tex` file, read and update both documents, compile, and retrieve the compilation log and PDF. The one-page PDF was rendered and visually inspected successfully.

The private test project used `sharejs-text-ot` document mode. History OT is covered by protocol fixtures and source review, not by this particular hosted project. Account-specific project identifiers, receipts, logs, and PDFs are kept locally under the Git-ignored `artifacts/` directory and are not distributed with this repository.

The reference checkout was `e039ad26c5bf5422eb57b89fc7e57c75055e631d`. The live run confirmed that the hosted socket handshake rotates a `GCLB` routing cookie; the implementation carries that cookie into the WebSocket upgrade and has a regression test for it.

This verifies the built server through the actual MCP stdio transport. A browser ChatGPT Secure MCP Tunnel connection is a separate setup step and was not configured during this run. The remaining manual scenarios below are a maintenance checklist, not claims of completed checks.

To exercise the current live-check script using a saved test project:

```sh
npm run build
npm run live-check -- --resume
```

For a first run in a new checkout, use `--create` instead. This deliberately creates and edits a real test project. The receipt saves identifiers after each completed creation so retries can reuse the project; inspect Overleaf before retrying if a creation response was lost.

The script and saved receipts must be evaluated against the version being tested. A successful historical receipt does not replace a fresh checked-edit acceptance run. Local tests do not prove Google sign-in, current Overleaf hosted compatibility, or ChatGPT installation.

The updated live-check script creates two dedicated fixture files, `mcp-checked-main.tex` and `mcp-checked-preamble.tex`. It initializes empty files or requires existing content to match the fixture, uses a checked edit to deliberately break a macro, expects automatic recovery with `rolled_back`, and then compiles and retrieves the current PDF. **This updated hosted check has not been run as part of the September 24 fix.** Its presence is a reproducible acceptance procedure, not evidence of hosted success.

## Local MCP discovery

Connect a local MCP client or [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) to the built stdio server:

```sh
npx @modelcontextprotocol/inspector@latest
```

Use `node` as the command and the absolute `dist/server.js` path as the argument. Confirm that all **thirteen** documented tools are discoverable, including `overleaf_edit_project`, `overleaf_recover_edit`, `overleaf_read_checkpoint`, and `overleaf_read_compile_log`. Reads and writes should have appropriate metadata, malformed inputs should fail usefully, and missing authentication should report the local login command without printing credentials. The optional loopback HTTP transport is `http://127.0.0.1:3333/mcp` after `npm run http`.

## Live Overleaf acceptance

Use a dedicated test project that the account owner has authorized the integration to create and edit. Keep the project link for review. Do not run these mutation checks against an unrelated existing document.

| Check | Evidence to record |
| --- | --- |
| Sign in with Google and run the session check | Successful session check; no cookie/token values in the record. |
| List projects | Expected account projects appear, or the correct empty result appears. |
| Create a test project | Returned project ID/link opens in the same account's browser. |
| Inspect the project | Root folder and document IDs agree with the editor. |
| Initialize an empty document, then read it | Text matches, its version advances, and trying to initialize it again is rejected. |
| Read existing source and submit a checked patch | The read provides version/hash; baseline and post-edit compiles succeed; unrelated files remain unchanged. |
| Patch with an old version or hash | The stale edit fails without silently replacing newer text. |
| Submit ambiguous, overlapping, excessive, or clearing patches | Rejection occurs before source mutation. |
| Create a folder and source document | Both appear in the project tree and can be read. |
| Compile a valid root document | Compile succeeds and a PDF output is returned. |
| Read PDF output | PDF resource is nonempty and opens in a supporting client. |
| Start a checked edit against an already broken root | `baseline_failed`, no changes applied, and useful log diagnostics. |
| Break a shared macro through a bounded checked edit | The post-edit compile fails; confirmed unchanged writes are restored; recovery compiles successfully and returns `rolled_back`. |
| Read an earlier PDF after a later failed compile or changed source | The output is rejected as stale; a current successful compile is required. |
| Read a multi-page compile log | Byte offsets, `next_offset`, EOF completion, and bounded diagnostics remain consistent. |
| Restart after an interrupted edit | The checkpoint remains readable; recovery does not replay uncertain writes. |
| Browser collaborator edits during a failed edit/recovery | Collaborator source is preserved, partial outcomes are reported, and unresolved work returns `recovery_required`. |

For a write that times out or loses its connection, read the current source before any retry. Record the uncertain outcome accurately. Do not force a conflict test by overwriting someone else's work.

For `recovery_required`, save the checkpoint ID, per-file recovery status, current source versions/hashes, and final compile status. Read checkpoint originals in character windows and compare them to current source. Do not describe a partial recovery as an atomic rollback or remove a collaborator's changes to make the test pass. Binary dependency contents are outside source verification and should be identified separately when relevant to the tested project.

## ChatGPT acceptance

With the local tunnel running and the connection enabled in ChatGPT, try these prompts:

| Prompt | Expected workflow |
| --- | --- |
| “List my Overleaf projects.” | Lists projects through `overleaf_list_projects`. |
| “Create a project called Connection Test with a short article, one equation, and a bibliography section. Compile it and give me the PDF.” | Creates the project, inspects source, initializes only empty files or uses checked patches for template content, compiles strictly, and retrieves the current PDF. |
| “Add a methods section to that article and recompile.” | Reads source and dependencies, supplies current versions/hashes to a bounded checked edit, and inspects its compile result. |
| “Show me the compile log for that project.” | Compiles or uses a known compile descriptor, then follows log byte windows as needed. |
| “The last edit reports recovery_required. Show what remains unresolved.” | Reads the checkpoint and latest affected source, preserves collaborator changes, and explains the unresolved differences without blindly restoring or replaying writes. |
| “Explain how to type a subscript in LaTeX.” | Can answer directly without an account operation. |
| “Delete my Overleaf account.” | States that account deletion is unsupported; does not misuse another tool. |

Record selected tools, nonsecret arguments, result summaries, confirmation behavior, and any failures. Distinguish **source updated**, **compile succeeded**, **PDF retrieved**, and **PDF displayed**; these are separate observations. A link to an existing project alone does not establish a successful edit or compile.

After rebuilding, restart the server/tunnel, refresh the ChatGPT connection's tools, and confirm thirteen-tool discovery before repeating affected checks. Update or reinstall any packaged Codex copy and start a new task so its runtime and skill match the tested build. Test the `$overleaf` skill separately in the client where the full plugin package is installed; an MCP connection alone does not load local skill files.

No live acceptance result should be inferred from this checklist. Record actual results from the environment where the integration is used.
