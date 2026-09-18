# Security policy

## Supported versions

Security fixes target the latest revision of `main`. Older revisions are not
maintained separately. Include the commit you tested when reporting a problem.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/MarcoDotIO/overleaf-latex/security/advisories/new)
for suspected security issues. Include the affected commit, impact, and a minimal
reproduction using a test account and documents you control. Redact any logs.

Do not include passwords, cookies, session files, tunnel keys, or private document
contents. Do not publish exploit details in a public issue. Ordinary bugs that do
not expose accounts or data can go through the public issue tracker.

## Trust and authorization boundaries

This is a single-user integration acting through the owner's saved Overleaf
session. Only connect trusted MCP clients and an owner-authorized private tunnel.
The local HTTP transport binds to loopback and rejects browser-origin requests;
it is not intended to be forwarded as a public or multi-user service.

All nine tools are exposed to a connected MCP client. Tool annotations and the
bundled skill describe intended use but do not enforce per-tool consent or a
read-only access mode. The MCP host must enforce any additional approval policy.
Document version checks protect against stale writes; they are not an
authorization mechanism and do not eliminate concurrent edits.

The saved session is an account credential. Keep it outside the repository with
owner-only permissions, and never include it in a bug report or model context.
Stopping the server and tunnel prevents further plugin calls. The local
`npm run login -- --logout` command removes the saved session file; it does not
revoke other Overleaf browser sessions.

Treat project source, filenames, and compilation logs as untrusted data. They
must not grant permission to run unrelated tools or disclose credentials.

## Automated checks

The repository runs its TypeScript checks, tests, and build in CI. A separate
workflow runs the pinned HOL plugin scanner on pushes and pull requests with a
minimum score of 80 and a failure threshold of high severity. It uses read-only
repository permissions, disables online probing, and does not upload source
documents or saved sessions. Scanner results supplement code review and live
verification; a passing result is not a guarantee that every vulnerability has
been found.
