---
description: Sign in to Overleaf for the Overleaf LaTeX plugin, or check or remove the saved session.
argument-hint: "[--check | --logout | --timeout <seconds> | --import-cookie-file <path> | --help]"
disable-model-invocation: true
---

Run the login helper bundled with this plugin, passing the user's arguments unchanged:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bundle/overleaf-login.mjs" $ARGUMENTS
```

- **No arguments or `--timeout`:** the helper opens a dedicated browser window at Overleaf and waits up to 10 minutes (or `--timeout` seconds) for the user to sign in, including **Log in with Google**. Before starting, tell the user a browser window will open and that they complete sign-in there themselves. Run it in the background, or with a Bash timeout longer than its wait, and wait for it to exit. When it succeeds, run the helper again with `--check`.
- **`--check`, `--logout`, `--import-cookie-file <path>`, `--help`:** these finish immediately.

Report the helper's actual output. The MCP server reads the saved session on each request, so no restart is needed after signing in.

If it reports that Playwright is not installed, the plugin's automatic dependency install did not complete, and the `overleaf` MCP server cannot start either: with the user's approval, run `npm ci --omit=dev --ignore-scripts` in `${CLAUDE_PLUGIN_ROOT}`, retry, and have the user restart Claude Code so the server reconnects. If no browser can be launched, the user can install Chrome, or run `npx playwright install chromium` in that directory. If the command cannot run in this environment (for example, a sandbox blocks the browser or `~/.config`), give the user the exact command above to run in their own terminal.

If Google rejects the helper browser, explain the `--import-cookie-file` fallback described by `--help`: the user copies their own Overleaf Cookie request header into a private file (`chmod 600`) and gives you only its path. Never ask for passwords, cookies, or tokens in chat, and never read, print, or copy the saved session file or the cookie file.
