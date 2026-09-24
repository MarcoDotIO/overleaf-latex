# Edit scope and compile recovery review

**Historical audit of the original release, before the fixes for [issue #1](https://github.com/MarcoDotIO/overleaf-latex/issues/1).**

Reviewed September 24, 2026, in response to feedback about long papers, custom macros, and shared preambles.

**Finding:** The installed plugin supports careful, versioned source editing, but does not enforce small edits or automatically recover a project after a broken edit. A long multi-file paper can work through the tools; robust unattended editing of one is not established.

The current checkout is `e9b6eb1a53e9610a5e55a0059aedbf3de7e37e67`. Its `src/` and compiled `dist/` match installed plugin `0.1.0+codex.20260918164435` byte for byte. This review did not modify product code or access an Overleaf account. All new edit experiments use generated documents and synthetic transport responses. Evidence is saved under `artifacts/edit-safety-review-2026-09-24/`, which is Git-ignored.

## How much can change in one pass?

One `overleaf_write_document` call accepts the **entire replacement text of one file**, including an empty string. It is not a section or line-range patch. The MCP schema allows up to 1,000,000 UTF-16 code units; the adapter additionally limits text to 2 MiB of UTF-8. The optional HTTP transport has a separate 2,000,000-byte serialized-request limit, including JSON overhead. These are size limits, not limits on the amount changed.

There is no maximum changed percentage, protected preamble, allowed-range contract, or aggregate write limit per agent turn. One turn can issue several calls against different files. Reads return the whole file without pagination. A shared `.tex` preamble or `.sty` file receives the same treatment as a chapter.

References: [write tool](../src/tools.ts#L73), [content validation](../src/overleaf-client.ts#L269), [whole-file read](../src/overleaf-client.ts#L161), [HTTP bound](../src/http.ts#L28).

The transport trims a common prefix and suffix and replaces everything between them. It does not produce multiple narrow diff hunks. In a generated 346,994-character macro-bearing document:

| Edit | Deleted characters | Inserted characters |
| --- | ---: | ---: |
| One local sentence change | 8 | 7 |
| Two short changes near opposite ends | 346,913 | 346,911 |
| Replace content with an empty string | 346,994 | 0 |

The empty replacement was accepted with `applied: true` and `concurrentChanges: false` by the actual adapter against the synthetic document store. The two-change case preserved intended visible text, but the submitted operation spanned almost the entire file. These are reproducible demonstrations of the write contract, not incidents involving a user's paper. [Operation builder](../src/overleaf-client.ts#L218); local receipt: `scope-receipt.json`.

## What protects existing work?

The adapter rereads the target file, requires `expected_version`, rejects a stale version before submission, waits for persistence acknowledgement, and reads the result back. It reports unexpected resulting text through `concurrentChanges`. Uncertain writes are not automatically replayed.

Those checks are useful, but cover the target file's text and version. They do not validate LaTeX, track versions of its dependencies, or lock a group of chapter/preamble changes together. There is no transaction across writes and compilation. A correct version permits a semantically invalid macro edit. Concurrent changes after the initial check still involve Overleaf's collaborative transformation; stale-version rejection does not establish project-wide isolation. [Write implementation](../src/overleaf-client.ts#L75), [per-call connection](../src/overleaf-client.ts#L178).

The plugin does not analyze macro definitions or resolve a dependency graph from `\input` and `\include`. The skill instructs the agent to preserve content, distinguish root documents from included fragments, and reconcile conflicts. That guidance helps an agent use the tools; it is not enforced structural protection. [Skill](../skills/overleaf/SKILL.md#L10).

## What happens when compilation fails?

1. A write has already persisted before compilation is requested. `write_document` does not call the compiler.
2. The agent separately calls `compile_project`. The adapter submits one request, with a 180-second request timeout and file/line errors requested.
3. A valid compile response with `status: "failure"` is returned as structured tool data. It does not set MCP `isError`; the caller must inspect the status.
4. The agent can retrieve the log and issue another versioned edit. The skill instructs it to fix errors caused by its authorized changes and recompile.
5. There is no automatic snapshot, rollback, repair loop, or required baseline compile. If the agent stops, disconnects, misreads the status, or cannot fix the error, the broken source remains saved.

References: [compile adapter](../src/overleaf-client.ts#L128), [tool result/error handling](../src/tools.ts#L26), [compile tool](../src/tools.ts#L89), [recovery guidance](../skills/overleaf/SKILL.md#L18).

The default is `stop_on_first_error: false`. Overleaf documents that its continue-on-error mode can generate a PDF despite LaTeX errors, including incorrect rendering. A PDF existing is therefore insufficient evidence of a clean compile. [Official Overleaf explanation](https://docs.overleaf.com/troubleshooting-and-support/stop-on-first-error).

Diagnostics are returned as whole log text, with no error extraction or pagination. Both logs and PDFs have a 5,000,000-byte tool limit; oversized outputs fail rather than yielding a useful partial result. The output reader validates same-project build URLs and a PDF signature, but does not bind artifacts to current source versions or a successful latest compilation. A synthetic probe confirmed it will read an explicitly supplied older cached PDF after a failed compile. That establishes a missing freshness check, not that the hosted service returned an old PDF during this review. [Output tool](../src/tools.ts#L95), [URL validation](../src/overleaf-client.ts#L239).

## What was tested?

`npm run check` passed: TypeScript checks, all **62 existing tests**, and the production build. Existing tests primarily verify protocol behavior with fixtures. The recorded hosted acceptance check is a successful **one-page** project with an included source file; failed-compile recovery and collaborator scenarios are explicitly listed as future/manual checks. [Existing validation record](evaluation.md#verified-on-september-18-2026).

Three new, local probes exercise the actual plugin:

| Probe | Result | Boundary |
| --- | --- | --- |
| Write scope | Local edits, broad two-position changes, and full erasure behave as described above. | Synthetic document store; actual operation builder and adapter. |
| Compile contract | No implicit compile or rollback; failure status and log are exposed; an explicitly requested old PDF remains readable. | Actual client and MCP server; synthetic compile/network responses. |
| Long paper | Baseline, scoped edit, deliberate shared-macro failure, and explicit repair completed. | Actual MCP/server/client, synthetic Overleaf transport, real local Tectonic 0.17.0 compilation. |

The long-paper fixture has **14 files**, **12 chapter fragments**, a shared preamble, three custom commands, equations, and cross-references. Approximately 88,000 source characters produce a **51-page PDF**. The results were:

- Baseline: compile succeeded, 51-page readable PDF.
- One chapter sentence changed: compile succeeded; every other source file remained byte-identical.
- A shared macro was renamed while its chapter uses remained: the write succeeded, then compilation failed with `Undefined control sequence`.
- After failure: the log was retrievable and the invalid preamble remained saved. There was no automatic repair or restore.
- Explicit restoration using a fresh document version: compile succeeded again, producing a 51-page PDF.

The Tectonic run is strict and does not emulate Overleaf's default continue-on-error mode. This deterministic harness does not measure how often an LLM chooses a correct edit or successfully diagnoses an error. It also does not test live collaboration, hosted compiler settings, custom publisher classes, external bibliography tooling, or a real research manuscript. Those claims remain unverified.

Local evidence: `receipt.json`, `pdf-check.json`, `compile-contract-receipt.json`, and `scope-receipt.json`. Reproduction from the project root:

```sh
npm run check
node artifacts/edit-safety-review-2026-09-24/scope-probe.mjs
node --import tsx artifacts/edit-safety-review-2026-09-24/compile-contract-probe.mts
AUDIT_TECTONIC=/absolute/path/to/tectonic node artifacts/edit-safety-review-2026-09-24/long-paper-probe.mjs
```

The long-paper probe requires Tectonic and its LaTeX resources; its first compilation may download resources. The experiment compiler was downloaded from the [official Tectonic release](https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0) into `/tmp/overleaf-compile-audit-toolchain/`, without a system installation.

## Recommendations from the pre-fix audit

1. Add versioned, exact-match or range-based patches with declared file scope, bounded changed text, and explicit detection of accidental truncation. Preserve unchanged gaps between distant edits instead of submitting one broad replacement.
2. Add a checked edit workflow: compile the correct root before editing, record affected source versions and hashes, apply a small batch, compile with stop-on-first-error enabled, and return structured diagnostics. Inspect the shared preamble and relevant dependencies when editing macro uses.
3. Support bounded recovery from the agent's own edits. Restore a saved version only after verifying that the current file still matches the agent's edit; otherwise stop and return a reconciliation diff so collaborators' changes survive. Multiple-file recovery must report partial outcomes instead of claiming atomic rollback.
4. Associate output descriptors with the compile result and tested source versions; distinguish a last-known-good PDF from the current result. Add chunked diagnostic retrieval for large logs.
5. Run a disposable hosted long-paper acceptance test covering a broken shared macro, recovery, and a collaborator edit before claiming unattended robustness. Separately evaluate the agent's actual edit/repair behavior over representative tasks.

This is the historical pre-fix audit. Issue #1 implements bounded patches, checked compilation, persistent recovery checkpoints, conditional restoration, and output freshness checks. See [architecture](architecture.md) and [current validation](evaluation.md) for the resulting behavior and remaining limits.
