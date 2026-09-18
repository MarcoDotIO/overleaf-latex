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

Writes require `expected_version` from a preceding read. The client supports the reference code's ShareJS and history-OT document modes and waits for the applicable edit event before reporting success. A subsequent read can report concurrent changes. Version checks protect against stale replacements; they do not eliminate simultaneous collaborative edits. Callers must reread and reconcile conflicts instead of treating a whole-document replacement as an unconditional update.

Creation and writes can have an uncertain outcome after a connection failure. Inspect current state before retrying an operation that may already have succeeded. There is no cross-tool transaction: adding a document and then editing its contents are separate operations.

Compilation returns status and output descriptors. The output reader uses those descriptors to retrieve a log or PDF, with a 5 MB tool limit. PDFs are returned as MCP embedded resources, and logs as text; display and attachment handling depend on the client. Larger outputs can be opened in the signed-in Overleaf editor. The server does not publish documents or create public download links.

## Reference source and hosted compatibility

The [Overleaf monorepo](https://github.com/overleaf/overleaf) is implementation reference material. It is not bundled or deployed by this plugin. Review the web routes, project/editor controllers, frontend socket code, and real-time/document-updater services when maintaining compatibility.

The hosted Overleaf service can differ from this checkout and can change its internal interfaces. A build, passing local fixture tests, or matching a monorepo route is not evidence that a live account operation succeeded. The [evaluation checklist](evaluation.md) separates local checks from actual account and ChatGPT acceptance.

## Scope

The initial tools cover listing and creating projects, inspecting project trees, reading and updating source documents, creating folders/documents, compiling, and reading outputs. They do not provide account management, sharing permissions, collaborator administration, billing operations, project deletion, or general binary-asset uploads.

Session expiry, Overleaf service limits, project permissions, compilation limits, and changes to the hosted protocol remain possible failure causes. Return an actionable error and preserve the actual operation outcome when known; do not treat every service error as an authentication failure.
