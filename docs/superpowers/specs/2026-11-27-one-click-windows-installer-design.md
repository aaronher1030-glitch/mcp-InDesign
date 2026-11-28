# One-click Windows installer design

Date: 2026-11-27

## Goal

Give nontechnical Windows users a single installer launch that installs the
InDesignAaron server, registers the InDesign Copilot UXP panel, configures
supported MCP clients, and starts the bridge. Preserve the existing source and
portable executable workflows.

## Constraints

- Target Windows 10/11 x64 and Adobe InDesign 2023 (18.0) or newer. Validation
  will use the available InDesign 2024 (19.4) installation.
- Install per user under `%LOCALAPPDATA%\Programs\InDesignAaronV1.1`; do not
  require administrator rights for the application itself.
- Use Adobe's production `.ccx` package and Unified Plugin Installer Agent
  (UPIA). Do not copy files into Adobe's plugin database directory directly.
- Do not require UXP Developer Tool on an end-user machine.
- Preserve unrelated MCP servers and malformed-config recovery behavior.
- Never store model API keys in installer files or MCP configuration.
- A public release is signed and timestamped with a publicly trusted
  Authenticode certificate. Local development installers may be unsigned and
  must be named and reported as unsigned.
- Do not claim unattended installation: Windows UAC/SmartScreen and Adobe trust
  or permission prompts can still appear.

## Selected approach

Use Inno Setup for a per-user `Setup.exe`, with the existing Node SEA executable
and an Adobe `.ccx` package as payloads. Inno Setup calls a new
`--configure-clients` mode in the SEA executable to merge MCP configuration,
and calls UPIA when available. A single bundled helper implementation avoids
requiring Node.js or PowerShell on the target machine.

Alternatives considered:

| Approach | Strength | Reason not selected |
|---|---|---|
| WiX/MSI | Strong enterprise Group Policy support | More tooling and maintenance than a friend-scale distribution needs |
| Portable ZIP | No installer toolchain | Still requires manual plugin registration and MCP JSON editing |
| Inno Setup | Per-user install, uninstall, shortcuts, custom actions | Selected |

## Components

### 1. Production UXP package

Add a repeatable packaging script that invokes Adobe's UXP CLI:

```text
uxp plugin package --manifest <plugin directory> --apps ID --outputPath <staging>
```

The script locates the CLI from `UXP_CLI_PATH`, `PATH`, or the pinned local
development dependency. It fails if no `.ccx` is produced. When the official
CLI cannot connect to the UXP Developer Service, the pinned Adobe
`PluginPackageCommand.execute` implementation may run offline; this still uses
Adobe's manifest validation and archive implementation. Manual ZIP assembly is
not a supported fallback. UDT's **Package** action remains the documented
manual alternative for maintainers.

The plugin ID stays `com.ads.indesign-bridge` across updates. The ordinary
JavaScript/HTML/CSS package does not need package signing.

### 2. MCP client configuration mode

Add `--configure-clients` to the executable. It writes the same server entry to
all detected or explicitly requested targets:

- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`
- Cursor: `%USERPROFILE%\.cursor\mcp.json`
- Qoder: `%USERPROFILE%\.qoder\mcp.json`

The server key is `indesign`; the command is the absolute installed executable
path and `args` is empty. Each target is optional: missing client directories
are skipped, while `--all-clients` creates the three standard locations.

Configuration behavior:

1. Parse the existing file as UTF-8 JSON. JSONC is not accepted; an invalid file
   is left untouched and reported.
2. Require a top-level object. Create `mcpServers` only when absent or when it
   is an object; never replace a conflicting non-object value.
3. Preserve every unrelated top-level field and server entry.
4. Create a timestamped `.indesign-backup` sibling before the first change.
5. Write through a same-directory temporary file and atomically replace the
   destination.
6. Preserve idempotence: a second run with the same command performs no write.
7. Return a nonzero exit code if any requested target fails; report each target
   as `configured`, `unchanged`, `skipped`, or `failed`.
8. Support `--remove-clients` for uninstall. It removes only the `indesign`
   entry when its command exactly matches this executable, creates a backup,
   and leaves empty `mcpServers` objects intact.

### 3. Bridge startup

The installer creates a per-user Startup shortcut named
`InDesignAaron Bridge.lnk` that launches the installed executable with
`--bridge` minimized. It also launches the bridge after installation when the
user leaves **Start InDesign Copilot after setup** enabled.

The bridge's existing single-instance check remains authoritative. The
installer does not add a Windows service or scheduled task.

### 4. Inno Setup installer

New source lives in `installer/`:

- `indesign-aaron.iss` — per-user installation and uninstall workflow.
- `START-HERE.txt` — plain-language usage, model setup, and fallback steps.
- `finish.iss` or equivalent local include only if needed for reusable wizard
  code; otherwise keep all custom actions in the main script.

Install sequence:

1. Verify Windows x64 and InDesign 18.0+ through installed-application registry
   entries or the executable path. Explain how to launch InDesign once if host
   initialization may be missing.
2. Copy the SEA executable, `.ccx`, plugin sources, `START-HERE.txt`, and a
   ready-to-copy `mcp-config.json` into the install directory.
3. Run `--install-plugin` to retain the existing development fallback files.
4. Locate UPIA in the standard Creative Cloud directories. Run
   `UnifiedPluginInstallerAgent.exe /install "<ccx path>"` and wait for exit.
5. If UPIA is missing, cannot be launched, or returns failure, do not fail the
   whole installer: copy the `.ccx` to the user's Desktop as
   `Install InDesign Copilot.ccx`, mark the plugin step as **Needs one click**,
   and show the final instructions to double-click it and accept Adobe's trust
   prompt.
6. Run `--configure-clients` for detected clients; always generate the portable
   config file for clients not detected.
7. Create Start Menu and optional Desktop shortcuts plus the Startup shortcut.
8. Optionally launch InDesign and the bridge, then show a completion page with
   separate results for server, plugin, MCP clients, and bridge.

Uninstall sequence:

1. Stop only the bridge process whose executable path is inside this install
   directory. Never kill unrelated InDesign or MCP client processes.
2. Attempt UPIA `/remove` with the staged `.ccx`; if that fails, instruct the
   user to remove **InDesign Copilot** from Creative Cloud **Manage Plugins**.
3. Run `--remove-clients` to remove only matching server entries.
4. Remove the Startup, Desktop, and Start Menu shortcuts created by setup.
5. Remove application files through Inno's normal uninstall facility. Keep a
   timestamped backup of modified MCP JSON files.

## Signing and release pipeline

Add two distinct commands:

```text
npm run build:installer          # local unsigned test installer
npm run build:release            # signed and verified release; fails closed
```

`build:installer` performs preflight checks, builds the SEA executable, runs
its MCP smoke test, packages the `.ccx`, locates Inno Setup, and compiles an
installer whose filename contains `unsigned` unless signing was explicitly
completed.

`build:release` invokes the same pipeline and then `scripts/sign-release.mjs`.
The signing script supports either:

- a certificate file referenced by `CODE_SIGN_CERT_PATH` and
  `CODE_SIGN_CERT_PASSWORD`, or
- Azure Artifact Signing through an explicitly configured SignTool DLL,
  endpoint, account, and certificate profile.

It requires `SIGNTOOL_PATH`, signs the SEA executable and final `Setup.exe`
with SHA-256, adds an RFC 3161 timestamp, and verifies both with
`signtool verify /pa /tw`. It refuses to produce a release if any signature or
timestamp check fails. Credentials are read from the environment and are never
printed, stored in the repository, or committed.

The release artifact is the signed `Setup.exe`; the standalone SEA executable
and `.ccx` remain supporting artifacts. Git ignores all generated `.exe`,
`.ccx`, installer-output, and signing-material files.

## Failure handling

- Missing InDesign: stop before installation with a version-specific message.
- Missing UPIA: continue with the one-click `.ccx` fallback and a clear status.
- UPIA rejects the package: keep the `.ccx` fallback and surface the captured
  error without claiming success.
- Malformed MCP JSON: leave it untouched, preserve the generated config file,
  and show a warning with the file path.
- Existing `indesign` server owned by this installation: update it.
- Existing `indesign` server owned by another executable: do not overwrite it;
  use key `indesign-aaron` only with explicit `--server-name` input.
- Client running during configuration: write atomically and tell the user to
  restart the client.
- Bridge port already owned: reuse the existing bridge as the runtime does now.
- Signing unavailable: local unsigned build only; release build fails.

## Security boundaries

- Installer payloads are local files built from the checked-in plugin and
  server sources; the installer does not download or execute remote scripts.
- The MCP config writer accepts only local filesystem paths and this
  executable's absolute path.
- The uninstaller removes only configuration entries pointing to its own
  executable.
- Authenticode signing identifies the publisher but does not guarantee instant
  SmartScreen reputation. Documentation must say this explicitly.
- The existing bridge token, plan approval, stale-plan, backup, and rollback
  rules remain unchanged.

## Verification

Automated tests must cover:

- Claude, Cursor, and Qoder config creation and idempotence.
- Preservation of unrelated servers and top-level settings.
- Invalid JSON and conflicting `mcpServers` types fail without modification.
- Atomic writes and timestamped backups.
- Matching versus foreign `indesign` entries during removal.
- UPIA discovery and fallback decision logic through injectable filesystem and
  process boundaries.
- Installer preflight and release-signing fail-closed behavior without real
  credentials.
- Existing Node 20+ runtime suite, SEA build, MCP smoke test, and production
  dependency audit.

Manual Windows validation must cover:

1. Install on a clean Windows user profile with InDesign 2024 and UPIA present.
2. Verify Creative Cloud lists InDesign Copilot and the panel appears without
   UDT.
3. Verify Claude/Cursor/Qoder can start the SEA server and list 143 tools.
4. Verify the Startup shortcut restores the bridge after sign-out/restart.
5. Verify malformed and pre-existing MCP configuration recovery.
6. Verify the missing-UPIA `.ccx` fallback.
7. Verify uninstall removes shortcuts and only this installation's MCP entry.
8. Verify signed release signature and timestamp with Windows.

Live InDesign validation cannot be claimed until these manual steps are run on
a target Windows machine.

## Acceptance criteria

- A maintainer can build a per-user installer from source with documented
  commands.
- End users do not need Node.js, UXP Developer Tool, or manual JSON editing on
  the normal path.
- Missing UPIA degrades to one explicit `.ccx` installation click, not a broken
  installer.
- Public release builds cannot be emitted unsigned.
- Unrelated MCP configuration and documents are never overwritten.
- The generated executable is excluded from Git.

## Primary references

- Adobe UXP packaging:
  https://developer.adobe.com/uxp/guides/how-to/distribution/package/
- Adobe UXP installation and UPIA:
  https://developer.adobe.com/uxp/guides/how-to/distribution/install/
- InDesign direct `.ccx` distribution:
  https://developer.adobe.com/indesign/uxp/introduction/next-steps/distribution/distribution-options/
- Adobe UXP CLI packaging command:
  https://github.com/adobe-uxp/devtools-cli/blob/main/packages/uxp-devtools-cli/README.md
- Windows code-signing choices:
  https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- Azure Artifact Signing setup:
  https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Azure Artifact Signing timestamping:
  https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management
- Inno Setup download:
  https://jrsoftware.org/isdl.php
