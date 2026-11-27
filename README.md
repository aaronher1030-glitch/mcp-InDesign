# InDesignAaronV1.1

An InDesign MCP server, portable skill runtime and in-app Copilot panel in one
Windows executable. It drives a live Adobe InDesign document through a UXP
plugin: inspect the layout, move and resize objects, edit text and styles, view
rendered pages, and verify every change — with reviewable plans and rollback.

Built on [theloniuser/indesign-uxp-server](https://github.com/theloniuser/indesign-uxp-server),
which forked [zachshallbetter/indesign-mcp-server](https://github.com/zachshallbetter/indesign-mcp-server)
(the AppleScript original) and moved execution inside InDesign via UXP.

## Demo

Simulated walkthrough of the included Copilot UI and safety workflow—not a live
InDesign recording. The editable source is in
[docs/assets/demo.html](docs/assets/demo.html).

![InDesign Copilot inspecting, planning, applying, and verifying a precise layout edit](docs/assets/indesign-copilot-demo.gif)

[Watch the 28-second MP4](docs/assets/indesign-copilot-demo.mp4).

`InDesignAaronV1.1.exe` is the whole product:

- **MCP stdio server** — 136 low-level tools + 7 high-level skill tools for any
  MCP client (Claude Desktop, Cursor, Windsurf, custom clients).
- **Copilot bridge** — HTTP `127.0.0.1:3000` and WebSocket `127.0.0.1:3001`
  for the InDesign panel.
- **Portable skill catalog** — six skills with risk policy, approval,
  verification and rollback.
- **Direct view** — `preview_layout` renders pages to PNG and opens them in the
  system viewer so you can see the layout without leaving the chat.
- **Self-installing plugin** — `--install-plugin` writes the UXP plugin next to
  the executable.

The same binary is both server and bridge, so there is no second process to
start and no Node installation required on the target machine.

---

## Requirements

- Windows 10/11 (the built executable is `win-x64`).
- Adobe InDesign 2022 (18.0) or newer with UXP plugin support.
  InDesign 2024 was detected and used on the machine this was built on.
- Adobe UXP Developer Tool, to load the plugin once.

## Quick start

1. Put `InDesignAaronV1.1.exe` anywhere, for example
   `C:\Users\you\Apps\InDesignAaronV1.1\`.
2. Install the plugin:

   ```powershell
   .\InDesignAaronV1.1.exe --install-plugin
   ```

   This writes `plugin\manifest.json`, `plugin\index.html` and `plugin\index.js`
   next to the executable.
3. Open the UXP Developer Tool → **Add Plugin** → choose that `manifest.json` →
   **Load**.
4. Start the bridge:

   ```powershell
   .\InDesignAaronV1.1.exe --bridge
   ```

   Leave that window open. Open InDesign → **Window → Plugins → InDesign Copilot**.
   The panel connects to the bridge on its own within a few seconds; its header
   then says **Connected**.
5. In the panel click **Model**, pick OpenAI-compatible or Anthropic, enter the
   model id and API key, then **Save**. The key is held in memory for the active
   chat session, is sent only to the base URL you enter, and is not persisted.
6. Ask for a change, for example *"Move the headline down 8 mm and keep it
   inside the margins."* The panel inspects the layout first, then edits it and
   shows the result.

Check the installation at any time:

```powershell
.\InDesignAaronV1.1.exe --doctor
.\InDesignAaronV1.1.exe --print-config
```

To prove the whole chain works with InDesign open, run the live self test. It
waits for the plugin to connect (60 seconds by default), then inspects the open
document and renders one page in the system image viewer:

```powershell
.\InDesignAaronV1.1.exe --selftest
.\InDesignAaronV1.1.exe --selftest --timeout 120
```

It exits with code 0 and prints the inspection id and the preview PNG paths when
both steps succeed, and with code 1 with a `SELFTEST_TIMEOUT` / `SELFTEST_FAILED`
reason when they do not.

## Use from an MCP client

`--print-config` prints the exact block. For Claude Desktop
(`%APPDATA%\Claude\claude_desktop_config.json`) or Cursor:

```json
{
  "mcpServers": {
    "indesign": {
      "command": "C:\\path\\to\\InDesignAaronV1.1.exe"
    }
  }
}
```

The client starts the executable without a terminal, so it runs in MCP mode and
also starts the bridge in-process. Only one process may own ports 3000/3001; if
you already ran `--bridge`, the server reuses it.

When started with no arguments from a terminal, the executable prints help and
runs as a bridge.

## MCP surface

### High-level skill tools

| Tool | Purpose |
|---|---|
| `inspect_layout` | Read-only snapshot: document, pages, items, styles, colors, layers, validation, fingerprint |
| `plan_edit` | Validate and version a structured edit plan; classify risk |
| `apply_edit_plan` | Revalidate, back up if high risk, apply, auto-rollback on failure |
| `verify_layout` | Structural checks plus optional visual review |
| `rollback_edit` | Reverse the journal or restore the guarded backup |
| `preview_layout` | Direct view: render pages to PNG and open the first one |
| `list_skills` | Show the skill catalog and allowed tools |

### Skills

`safe-layout-edit`, `text-typography-edit`, `align-distribute`,
`image-reframe`, `style-consistency`, `multi-page-consistency`.

Each is exposed as an MCP prompt (`indesign.safe_layout_edit`, …), as a
resource (`indesign://skills/<id>`), and as an Agent Skill in `skills/*.md`.
Skills forbid `execute_indesign_code`, `close_document`, `print_book` and
`package_document`, and each one lists exactly which low-level tools it may use.

### Low-level tools

143 tools in total: documents, pages, spreads, master spreads, text and tables,
styles, colors, graphics, layers, page items, groups, books, export and
utilities. The MCP client sees the same names as before this release.

## Workflow and safety

1. **Inspect** — `inspect_layout` returns `inspectionId` and a document
   fingerprint.
2. **Plan** — the model authors `targets` (pageIndex, itemIndex, before-state)
   and `steps` (tool + arguments). The server validates, normalizes and versions
   the plan and infers target fingerprints. A different plan version voids an
   approval.
3. **Classify** — low risk means one page, at most five existing targets, and
   only reversible allowlisted steps. Everything else is high risk and returns
   `approval_required`. The panel shows an approval card with the summary and
   affected pages. External MCP clients call `apply_edit_plan` with the same
   `planId` and `expectedVersion`; the server requests explicit human approval
   through MCP elicitation and authorizes the exact version server-side. Models
   cannot self-approve, and clients without elicitation support cannot apply
   high-risk plans.
4. **Apply** — the document is re-inspected immediately before execution; any
   change since inspection aborts with `STALE_PLAN`. High-risk plans first copy
   the saved `.indd` into the session artifact folder (a saved document is
   required).
5. **Verify** — structural checks always run and detect unexpected additions,
   removals, renames, overset text, out-of-bounds content, missing links/fonts
   and duplicate styles. Visual review is optional; without it the result is
   `structurally_checked_only`, never a full pass.
6. **Rollback** — low-risk plans replay inverse journal steps in reverse;
   high-risk plans restore the backup, and only if the document has not changed
   since the plan was applied (`ROLLBACK_CONFLICT` otherwise).

The original document is never saved automatically. API keys are sent only to
the model endpoint you configured and are never written to plans, artifacts or
logs.

### Optional bridge token

Set `BRIDGE_TOKEN` before starting to require
`Authorization: Bearer <token>` on `/execute`, `/chat` and `/status`:

```powershell
$env:BRIDGE_TOKEN = "a-long-random-string"
.\InDesignAaronV1.1.exe --bridge
```

Enter the same token in the panel's **Model** section. Without it the bridge is
open to any local process, which is fine on a single-user machine but not on a
shared one.

## Build from source

Requires Node.js 20+ to run from source and Node.js 24+ to build the executable,
plus the dependencies in `package.json`.

```powershell
npm install
npm test                # 200+ automated tests, no InDesign required
npm run build           # embeds assets, bundles, builds ..\InDesignAaronV1.1.exe
npm run smoke           # MCP stdio handshake against the bundle
```

`npm start` runs the source server; `npm run bridge` runs the bridge alone.
The bundle is `build/indesign-aaron.cjs`; the executable is produced with
Node's SEA (`--build-sea`) from that bundle, so no external packer is needed.

### Layout

```
src/core/            MCP server, tool dispatch, UXP executor
src/handlers/        ~136 low-level InDesign handlers
src/skills/          catalog, plan schema, inspector, journal, backup, runtime, protocol
src/quality/         structural checks, page renderer, visual review, verifier
src/chat/            Copilot model adapters and tool loop
src/assets/          generated embedded skills and plugin files
bridge/server.js     HTTP + WebSocket relay (importable and standalone)
plugin/              Adobe UXP panel (chat, approval card, settings)
skills/              portable skill catalog (*.md + manifest.json)
scripts/             embed-assets, build-exe, smoke-mcp
tests/               node --test suites
```

## Troubleshooting

- **Panel says "Bridge off"** — start `InDesignAaronV1.1.exe --bridge`; the
  panel reconnects every 3 seconds.
- **"Plugin not connected"** — load the plugin in the UXP Developer Tool and
  open Window → Plugins → InDesign Copilot.
- **No document** — most tools need an open document; `create_document` is
  available if you want a new one.
- **High-risk plan needs a saved document** — save the `.indd` first so the
  backup can be made.
- **Ports busy** — stop the other bridge instance, or set `BRIDGE_TOKEN`
  consistently so both sides use the same configuration.
- **Visual review unavailable** — the configured model cannot accept images;
  the result is reported as structural-only.

## License

MIT. Original servers by zachshallbetter and theloniuser.
