# Architecture and compatibility

The integration is a Node.js 22 TypeScript MCP server. It serves stdio by default and supports Streamable HTTP on `127.0.0.1:3333/mcp` for local clients. ChatGPT uses a private Secure MCP Tunnel to reach the stdio process.

```text
ChatGPT developer-mode connection
    │ OpenAI Secure MCP Tunnel
    ▼
Local tunnel-client
    │ stdio
    ▼
Overleaf MCP server ─── private session file
    │ HTTPS + real-time document protocol
    ▼
https://www.overleaf.com
```

## Authentication boundaries

The account owner signs in interactively with Google through Overleaf. The local helper saves the resulting Overleaf cookies, not Google cookies, OAuth tokens, or browser local storage. The session file is kept outside the checkout, defaults to `~/.config/overleaf-latex/session.json`, and requires an owner-only file and directory.

The hosted origin is fixed to `https://www.overleaf.com`. Session cookies must not be sent to arbitrary URLs or copied into model-visible output. The cookie import fallback reads a single local request-header file instead of accepting secrets as MCP tool inputs.

The server represents one preauthenticated account. It does not implement per-user account linking or a public OAuth authorization service. Any client authorized to call its tools acts on that Overleaf account. For this personal setup, control access through the local machine and private OpenAI tunnel. Public, multi-user deployment would require a different authentication and session-isolation design.

## Project and document operations

Project discovery, creation, folder/document creation, and compilation follow Overleaf's authenticated web endpoints. Project inspection discovers identifiers and the document tree. Document text and versioned edits use the real-time protocol rather than inventing a REST endpoint for source replacement.

Reads return content, version, and a SHA-256 content hash. The public `overleaf_write_document` tool only initializes empty files at their expected version. Existing source goes through `overleaf_edit_project`; creating an example or blank project does not imply that its root file is empty. The client supports the reference code's ShareJS and history-OT document modes and waits for the applicable edit event before reporting success. A subsequent read can report concurrent changes.

Creation and writes can have an uncertain outcome after a connection failure. Inspect current state before retrying an operation that may already have succeeded. There is no cross-tool transaction: adding a document and then editing its contents are separate operations.

## Checked edits and recovery

`EditWorkflow` serializes operations for each project in one server process. The HTTP transport reuses that workflow across requests. This queue does not lock another MCP process, the Overleaf editor, or any external collaborator.

`overleaf_edit_project` accepts 1–5 distinct files with 1–20 exact-match patches per file. Every search refers to the original file, must occur exactly once, and must not overlap another patch. ShareJS and history-OT operations retain unchanged gaps between patches instead of deleting and reinserting those gaps.

The budget counts deleted plus inserted UTF-16 code units, including search context. A file permits `min(10000, max(200, floor(original_length * 0.25)))` code units, and a batch permits 20,000. Emptying a nonempty file is rejected. These are per-call bounds, not semantic section boundaries or a limit across an agent's entire task. A shared preamble remains editable within the same bounds; the plugin does not parse macros or mark source regions immutable.

The workflow proceeds as follows:

1. Read the project tree, selected root, and every text document. Check the requested versions/hashes and patch budgets. The supported project scope is at most 100 text files and 8 MiB of UTF-8 source.
2. Compile the unmodified root with stop-on-first-error enabled. Compare source versions/hashes and tree/settings before and after compilation. A failed baseline returns `baseline_failed` with `changes_applied: false`.
3. Recheck the initial snapshot and persist a private checkpoint before writing. The checkpoint stores each affected file's original source, version/hash, planned change, and recovery state.
4. Recheck the whole source snapshot before each write. Apply the patch, verify the returned text/version, and persist confirmation of the write. Recheck source after the batch and compile strictly again.
5. If the edit or compilation fails, attempt conditional restoration in reverse file order. Restore only a confirmed write whose current version and text still match the plugin's recorded result. Persist a pending restore before sending it so an interruption cannot trigger blind replay. Compile again and report each recovery outcome.

`success` means the checked edit and strict compile succeeded. `rolled_back` means every attempted change was restored and the recovery compile succeeded. `recovery_required` identifies an uncertain write, a preserved collaborator edit, an unverified restore, or unresolved compilation. Recovery is conditional per file and can be partial; it is not an atomic project rollback. The agent must inspect the current source and checkpoint before reconciling unresolved work.

Checkpoints persist at `~/.config/overleaf-latex/checkpoints`, or the private directory selected by `OVERLEAF_CHECKPOINT_DIR`. The server requires owner-only permissions and rejects a symlink at the checkpoint directory or file. Checkpoints contain private document source and remain on the host across restarts. Without a checkpoint ID, `overleaf_read_checkpoint` lists up to 20 recent checkpoints for the project, allowing discovery after a timeout or restart. With an ID, it returns state summaries and optional original-source windows of up to 20,000 UTF-16 code units; `overleaf_recover_edit` resumes conditional recovery using that ID. A checkpoint is scoped to its original project. It is not an Overleaf project-history snapshot or a backup of binary assets.

If the baseline already fails, the checked edit applies nothing. Diagnose the existing failure from its log and source. A suitable known checkpoint may support recovery; otherwise the existing source must be repaired in Overleaf before checked editing can resume. The initialization tool is not a repair override for existing files.

## Compilation and output freshness

The public compile tool and checked-edit workflow require stop-on-first-error. Each compile receipt includes a generated `compile_id`, the root, source versions/hashes, `source_verified`, status, output descriptors, and bounded diagnostics. A changed snapshot yields `source_changed` rather than success. Non-success compile/edit/recovery outcomes are also flagged with MCP `isError`.

Version checks cover all text documents, tree metadata, and compiler/root settings before and after compilation. Binary dependency contents are not read or verified. These checks detect observed changes but cannot establish an atomic compiler snapshot while external collaborators remain active. A successful receipt also does not prove layout quality, complete citation resolution, or correctness of the paper's claims.

Output URLs must come from a compile descriptor recorded for the same project by the current server process. PDF retrieval additionally requires the latest verified successful receipt and unchanged checked source both before and after download. A later edit or failed compile invalidates the previous PDF for this tool. Receipts are in memory, so compile again after restarting the server before requesting output. Durable recovery checkpoints are independent of these transient receipts.

`overleaf_read_compile_log` streams byte windows of 1–65,536 bytes, up to an accessible offset of 50 MiB. It skips the prefix without allocating the entire log, captures a window plus lookahead, and cancels the remaining stream. The first pages of oversized logs remain readable. `next_offset` continues the stream; `complete` and `total_bytes` are established only by actual EOF, not a Content-Length header. At the 50 MiB boundary, additional content produces a limit error rather than false completion. Diagnostics are best-effort, bounded to 20 errors and 20 warnings per window, and never override compilation status. Lines or UTF-8 characters may span windows.

PDFs are returned as MCP embedded resources with a 5,000,000-byte tool limit; `overleaf_read_output` routes `.log` URLs to the log-window reader. Display and attachment handling depend on the client. Larger PDFs can be opened in the signed-in Overleaf editor. The server does not publish documents or create public download links.

## Reference source and hosted compatibility

The [Overleaf monorepo](https://github.com/overleaf/overleaf) is implementation reference material. It is not bundled or deployed by this plugin. Review the web routes, project/editor controllers, frontend socket code, and real-time/document-updater services when maintaining compatibility.

The hosted Overleaf service can differ from this checkout and can change its internal interfaces. A build, passing local fixture tests, or matching a monorepo route is not evidence that a live account operation succeeded. The [evaluation checklist](evaluation.md) separates local checks from actual account and ChatGPT acceptance.

## Scope

The thirteen tools cover listing and creating projects, inspecting project trees, reading and initializing source, checked edits and recovery, creating folders/documents, compiling, and reading outputs. They do not provide account management, sharing permissions, collaborator administration, billing operations, project deletion, or general binary-asset uploads.

Session expiry, Overleaf service limits, project permissions, compilation limits, and changes to the hosted protocol remain possible failure causes. Return an actionable error and preserve the actual operation outcome when known; do not treat every service error as an authentication failure.
