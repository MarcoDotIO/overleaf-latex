# Connect your Overleaf account to ChatGPT

This setup keeps the authenticated MCP server on your computer and connects ChatGPT through OpenAI's Secure MCP Tunnel. It is intended for a private developer-mode connection. Secure MCP Tunnel is not a public plugin submission or distribution endpoint. The current official steps are in [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## 1. Sign in to Overleaf locally

From the `overleaf-latex` directory:

```sh
npm ci
npm run build
npm run login
```

Use **Log in with Google** and complete the sign-in yourself. The helper retains only cookies for Overleaf, discarding Google cookies and browser local storage. No Google developer project, client ID, client secret, or password-based Overleaf login is needed.

The helper tries installed Chrome first, then Playwright Chromium. If neither is available, run `npx playwright install chromium` and retry. It uses a temporary profile and removes that profile afterward; it does not read your normal browser's saved passwords or profile.

Confirm that the session works:

```sh
npm run login -- --check
```

The default saved session is `~/.config/overleaf-latex/session.json`. Its directory must be owner-only (`700`), and its file must be owner-only (`600`). An alternative `OVERLEAF_SESSION_FILE` must be supplied consistently to login and server processes. Never include a session file in the plugin package or a support report.

### When Google rejects the helper browser

Use your normal browser, already signed in to your Overleaf account:

1. Open `https://www.overleaf.com/project`.
2. Open that browser's developer tools and its **Network** panel, then reload the page.
3. Select the request to `www.overleaf.com/project` and find its **Cookie** request header. Copy only that single header value into a private local text file. Do not copy the entire request, response, or browser profile.
4. Protect the file and import it locally:

   ```sh
   chmod 600 /absolute/path/to/overleaf-cookie.txt
   npm run login -- --import-cookie-file /absolute/path/to/overleaf-cookie.txt
   npm run login -- --check
   ```

5. Delete the temporary cookie file once the import succeeds, and clear the clipboard if it contains the header.

The import accepts a single `Cookie` header line (with or without `Cookie:`), including the `overleaf.sid` cookie. It does not accept a Netscape cookie export or a JSON browser export. Keep the header on your computer; do not send it to the assistant or use a third-party cookie-export site.

## 2. Create an OpenAI tunnel

Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). Select the personal Platform organization that belongs to the account you intend to use. Create a tunnel and associate it with the target ChatGPT workspace. Record the `tunnel_id` and obtain the runtime API key for the tunnel client.

Tunnel permissions and ChatGPT developer-mode access are separate. Creating a tunnel requires Tunnels **Read** and **Manage**; running it or selecting it in ChatGPT requires **Read** and **Use**. If the settings page reports missing permissions, resolve that in the selected Platform organization. Associating a Platform organization alone does not automatically associate another ChatGPT workspace.

Download `tunnel-client` using the link in Platform tunnel settings or the [latest official release](https://github.com/openai/tunnel-client/releases/latest). Make its executable available on your shell's `PATH` and inspect its current quickstart:

```sh
tunnel-client help quickstart
```

Provide the runtime key in the local process environment as `CONTROL_PLANE_API_KEY`. Use a local secret manager or an interactive hidden prompt instead of typing the key into a command that your shell history will save. Do not paste the key into ChatGPT, add it to `.mcp.json`, or commit it.

## 3. Start the stdio tunnel

Replace the example tunnel ID and absolute server path with your values:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile overleaf-local \
  --tunnel-id tunnel_REPLACE_WITH_YOUR_ID \
  --mcp-command "node /absolute/path/to/overleaf-latex/dist/server.js"

tunnel-client doctor --profile overleaf-local --explain
tunnel-client run --profile overleaf-local
```

The command follows the official named local stdio profile procedure. Use an absolute path to `node` too if it is not on the tunnel process's `PATH`. Ensure the tunnel process runs as the same local user who signed in to Overleaf and inherits any `OVERLEAF_SESSION_FILE` override. If the installation path contains spaces, quote that path inside the command string as required by your installed tunnel client; `tunnel-client help quickstart` documents its current command parsing.

Keep the final command running. The tunnel starts the MCP process and uses outbound HTTPS to OpenAI; no inbound port, public MCP URL, or public copy of your session file is needed. The computer must remain awake and connected for requests to succeed. Check the tunnel client's local health/readiness surfaces or rerun `doctor` if discovery fails.

## 4. Add the connection in ChatGPT

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**. Availability depends on account and workspace policy.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins) and select the plus button.
3. Name the connection **Overleaf LaTeX** and describe it as your personal Overleaf project editor and compiler.
4. Under **Connection**, select **Tunnel**, then choose your tunnel or enter its `tunnel_id`.
5. Create the connection and inspect the discovered `overleaf_*` tools.
6. Start a new conversation and enable the connection from the tools menu.

The server has a local Overleaf browser session, not an OAuth authorization server for ChatGPT. The private OpenAI tunnel provides the transport boundary for this single-user setup. Limit access to that tunnel to the account/workspace intended to control your Overleaf account. Do not advertise this as a shared service for other users.

Try a read first:

> List my Overleaf projects.

Then try a complete write workflow:

> Create an Overleaf project named “ChatGPT connection test”. Write a small complete LaTeX article with a title, one equation, and a references section. Compile it and return its Overleaf link and PDF.

The MCP connection can expose tools directly. A bundled skill is separately installed as part of a compatible plugin package; creating the tunnel connection alone does not imply that ChatGPT imported the local skill files.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| No saved session or redirected to login | Run `npm run login`, then `npm run login -- --check`. |
| Google rejects the helper browser | Use the local cookie import procedure above. |
| Tunnel not listed | Check the ChatGPT workspace association and Tunnels Read/Use permissions. |
| ChatGPT cannot discover tools | Keep `tunnel-client run` active; run `doctor`; check the absolute Node/server paths and build output. |
| Tools changed after rebuilding | Restart the server/tunnel, open the ChatGPT connection, select **Refresh**, and start a new conversation. |
| Document version conflict | Read the document again, reconcile the change, and write with the new version. |
| Write timed out | Read the document and inspect its version before retrying; the earlier write may have applied. |
| Compilation failed | Read the compile log and fix source or project configuration before requesting a PDF. |
| Hosted response/protocol changed | Capture a redacted error and compare with the reference monorepo; avoid retrying mutations blindly. |

To disconnect, stop the tunnel/server and remove the connection from ChatGPT. `npm run login -- --logout` deletes the saved local Overleaf session without signing other browsers out.
