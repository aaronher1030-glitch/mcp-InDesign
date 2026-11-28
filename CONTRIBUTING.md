# Contributing to InDesignAaronV1.1

This guide covers the Windows/UXP implementation, portable skill runtime, SEA
build, per-user installer, and signed release pipeline. The production plugin
runs inside Adobe InDesign through UXP; the legacy AppleScript/macOS workflow is
not the current architecture.

## Prerequisites

- Git.
- Node.js 20 or newer for source development, tests, and bundle-only builds.
- Node.js 24 or newer on Windows x64 for SEA executable, installer, and release
  builds. The installer pipeline rejects other platforms, architectures, and
  older Node versions.
- Adobe InDesign 2023 (18.0) or newer for live plugin testing only. The automated
  tests and MCP smoke test do not require InDesign.
- Adobe UXP Developer Tool for the manual plugin-loading workflow only. End
  users do not need it.
- Inno Setup 7 for installer builds. The pipeline finds `ISCC.exe` on `PATH` or
  in standard per-user/per-machine Inno Setup 7 folders; set
  `INNO_SETUP_ISCC` to an explicit compiler path when needed.
- Windows SDK SignTool and either a code-signing certificate or Azure Artifact
  Signing setup for `build:release` only.

The Adobe UXP CLI is pinned to `@adobe/uxp-devtools-cli@1.2.0` in
`devDependencies`. UXP developer tooling is a build-time dependency and is not
shipped to end users.

## Clean dependency setup

From the repository root, run:

```powershell
npm ci --ignore-scripts
npm run prepackage:uxp
```

Do not replace this with an ordinary `npm install` or script-enabled `npm ci`.
Adobe UXP CLI 1.2.0 has consumer lifecycle defects: its helper install script
requires `tar`, which Adobe declares only as a helper dev dependency, and its
CLI postinstall references the non-dependent `@adobe/uxp-devtools-app` package.
The project pins `tar@7.5.24` as a dev-only helper prerequisite and supplies the
`prepackage:uxp` lifecycle script to run Adobe's native helper setup explicitly.
`npm run package:uxp` runs that prep step automatically before packaging.

## Development workflow

Run the source MCP server or bridge with:

```powershell
npm start
npm run bridge
npm run dev
```

`npm run dev` enables the Node inspector. `npm run build:bundle` creates
`build/indesign-aaron.cjs` without building a SEA executable.

For the manual executable/UXP Developer Tool flow:

1. Run `npm run build` on Windows x64 with Node 24+.
2. Run `..\InDesignAaronV1.1.exe --install-plugin` to stage the embedded plugin
   sources next to the executable.
3. In Adobe UXP Developer Tool, add the staged `plugin/manifest.json` and load
   it.
4. Run `..\InDesignAaronV1.1.exe --bridge`, then open InDesign **Window →
   Plugins → InDesign Copilot**.
5. Use `..\InDesignAaronV1.1.exe --doctor` to inspect InDesign discovery, bridge
   status, and the reported plugin connection.

For an external MCP client, merge only the `mcpServers.indesign` entry printed
by `..\InDesignAaronV1.1.exe --print-config` into the client's existing config.
Preserve unrelated servers and top-level settings. The source configuration
helper and installer use the same ownership rule: an `indesign` entry pointing
at another executable is not overwritten.

`--selftest` is an explicit live check: it waits for the plugin, inspects the
open document, and renders a page. Use it only with InDesign and a disposable
document. It is not part of `npm test` or `npm run smoke`, and passing those
commands is not evidence of live InDesign compatibility.

## Project layout

```text
src/
  index.js                 CLI entry point and MCP/bridge mode selection
  core/                    MCP server, tool dispatch, UXP executor, live self-test
  handlers/                low-level InDesign handlers
  types/                   tool names, descriptions, and input schemas
  install/                 MCP config merging, InDesign discovery, UPIA operations
  skills/                  catalog, plan schema, inspector, journal, backup, runtime
  quality/                 structural checks, renderer, visual review, verifier
  chat/                    Copilot model adapters and tool loop
  assets/                  tracked generated embedded skill/plugin modules
bridge/server.js           HTTP and WebSocket relay
plugin/                    UXP Copilot panel source
skills/                    portable skill Markdown and manifest
scripts/                   embed, SEA, package, smoke, installer, and signing scripts
installer/                 Inno Setup source and installed START-HERE.txt
tests/                     node:test unit and source-contract suites
docs/                      user and MCP-client instructions
```

## Coding and safety conventions

- Source modules use ES modules and modern JavaScript. Keep public functions
  documented and preserve existing tool names and schemas unless a change
  explicitly requires a breaking update.
- Use Node's built-in test runner. Add focused regression tests for behavior and
  source-contract tests for installer wiring.
- Invoke external tools with argument arrays rather than shell command strings.
  Fail closed on unsupported inputs, missing artifacts, and ambiguous output.
- Never call `execute_indesign_code` inside the skill workflow. Do not delete,
  close, print, package, export, or save the original document automatically.
- Preserve MCP client ownership: merge only the managed server entry, refuse an
  entry owned by another executable, and keep timestamped backups of changed
  files.
- Use UPIA for production `.ccx` installation/removal. Do not copy into Adobe's
  plugin database directly.
- Keep installer operations per user. Do not add administrator requirements,
  machine-wide process-name termination, or unconditional deletion of Desktop
  files. The fallback manifest permits removal only of unchanged files that
  setup created and recorded.
- Do not log or attach raw SignTool command arguments, output, environment, or
  child-process errors during signing; they can contain credentials.

After changing `plugin/` or `skills/`, run `npm run build` (or `npm run embed`)
to regenerate the tracked `src/assets/embedded*.js` modules. Review and commit
those generated source modules with the underlying change.

## Tests and local builds

Run the standard verification sequence:

```powershell
npm test
npm run build
npm run smoke
npm run package:uxp
npm run build:installer
```

- `npm test` runs the registered unit and source-contract suites. Two UPIA CLI
  fallback-exit tests are skipped on Windows because they exercise the
  off-Windows branch.
- `npm run build` embeds assets, bundles the CommonJS server, and uses Node's
  `--build-sea` support to create `..\InDesignAaronV1.1.exe`. It requires Node
  24+.
- `npm run smoke` performs an MCP stdio handshake against
  `build/indesign-aaron.cjs`. Pass another executable or bundle with
  `npm run smoke -- <path>`.
- `npm run package:uxp` creates
  `dist/uxp/com.ads.indesign-bridge_ID.ccx` through Adobe's pinned packaging
  implementation. It prefers the official CLI and uses Adobe's offline package
  command only after an affirmative UXP Developer Service connection or
  availability failure. Missing, stale, failed, partial, or ambiguous package
  results are rejected.
- `npm run build:installer` creates an explicitly unsigned local setup. It
  rebuilds the SEA, smoke-tests that SEA, packages the `.ccx`, generates portable
  MCP config, compiles with Inno Setup in temporary staging, and publishes only
  after compilation succeeds.

For dependency review, run both commands and record their actual results rather
than assuming the lockfile is clean:

```powershell
npm audit --omit=dev
npm audit
git diff --check
```

## Installer behavior to preserve

The Inno Setup script installs per user under
`%LOCALAPPDATA%\Programs\InDesignAaronV1.1`. It requires x64-compatible Windows
10/11 and detects InDesign 18.0 (2023) or newer before copying application
files. Ask users to launch InDesign once if Creative Cloud registration is
incomplete.

Setup runs the SEA's `--install-plugin`, `--install-uxp`, and
`--configure-clients` modes. A missing or failed UPIA installation is not
reported as success: setup creates an exclusively copied, numbered Desktop
`.ccx` fallback and records its path and SHA-256. The user must open that `.ccx`
and accept Adobe's trust prompt before the plugin is installed.

Client-configuration failures do not abort installation. The finish report
points to the generated portable `mcp-config.json` when it is safe to use.
Uninstall runs `--remove-uxp` and `--remove-clients`, preserves unrelated MCP
entries, removes only unchanged recorded Desktop fallbacks, and directs users to
Creative Cloud **Plugins → Manage Plugins** if UPIA removal fails.

## Signed release builds

`npm run build:release` runs the same pipeline in release mode. Before any npm
build or release publication, it validates the platform, Node version, selected
signing provider, SignTool path, and every provider-specific input. It then:

1. Builds the SEA executable.
2. Signs and verifies the SEA in release mode.
3. Smoke-tests the SEA and packages the `.ccx`. The `.ccx` itself is not
   Authenticode-signed.
4. Compiles Inno Setup output in a private temporary staging directory.
5. Signs and verifies the staged setup executable.
6. Copies the verified setup and portable config to `dist/installer` and prints
   a JSON summary with artifact paths, sizes, SHA-256 hashes, and signed flags.

Any signing or verification failure rejects the build, removes temporary
staging, and prevents publication of a new release-labeled setup. An older
artifact already in `dist/installer` is not proof that the current build passed;
use the current run's summary and hashes.

The release setup filename is
`InDesignAaronV1.1-<version>-windows-setup-signed.exe`. The unsigned development
filename is `InDesignAaronV1.1-<version>-windows-setup-unsigned.exe`.

### Signing provider selection

The CLI accepts only `certificate` or `azure`. Provider selection is resolved
in this order:

1. `--provider=<provider>`
2. `--provider <provider>`
3. `SIGNING_PROVIDER`
4. `CODE_SIGN_PROVIDER`
5. `certificate` when none is set

For example:

```powershell
npm run build:release -- --provider azure
```

An unknown provider or missing required input fails preflight. Exported callers
can also pass the internal `mode` option to `buildInstaller`; it takes precedence
over CLI/environment selection.

### Required environment variables

Environment-variable lookup is case-insensitive. Path variables must reference
existing files; required non-path values must be nonempty.

| Variable | Provider | Requirement |
|---|---|---|
| `SIGNTOOL_PATH` | Both | Required path to `signtool.exe`. |
| `CODE_SIGN_CERT_PATH` | Certificate | Required path to the signing certificate file. |
| `CODE_SIGN_CERT_PASSWORD` | Certificate | Required certificate password. |
| `CODE_SIGN_TIMESTAMP_URL` | Certificate | Optional RFC 3161 timestamp URL; defaults to `http://timestamp.digicert.com`. |
| `AZURE_SIGN_DLIB_PATH` | Azure | Required path to the Azure Artifact Signing SignTool DLL. |
| `AZURE_ARTIFACT_SIGNING_ENDPOINT` | Azure | Required artifact-signing endpoint. |
| `AZURE_ARTIFACT_SIGNING_ACCOUNT` | Azure | Required code-signing account name. |
| `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE` | Azure | Required certificate-profile name. |
| `INNO_SETUP_ISCC` | Installer builds | Optional explicit path to Inno Setup 7 `ISCC.exe`; not a signing credential. |

Azure authentication is delegated to the SignTool DLL's
`DefaultAzureCredential` integration. The scripts do not invent or require
Azure client-secret, tenant, or client-ID environment variables. Configure the
credential through the approved Azure Identity mechanism for the build worker.

### Timestamping and verification

Both providers sign with SHA-256 (`/fd sha256`), request an RFC 3161 timestamp
(`/tr`), and use SHA-256 for the timestamp digest (`/td sha256`). Certificate
signing uses DigiCert by default or `CODE_SIGN_TIMESTAMP_URL`. Azure signing
uses the fixed `http://timestamp.acs.microsoft.com` endpoint.

After each file is signed, the pipeline runs `signtool verify /pa /tw`. A
nonzero result, signal, or returned process error fails the release. SignTool
stdout/stderr and raw child-process diagnostics are not forwarded because they
may expose secrets.

### Secret handling

- Inject signing values through the CI/provider secret store. Never put real
  credentials in source, documentation, issue comments, command output, or Git
  history.
- Do not print the process environment or signing command lines. The certificate
  password is passed to SignTool as an argument by the implementation but is
  deliberately omitted from logs and sanitized errors.
- Azure DMDF metadata is written to a private temporary directory, contains only
  endpoint/account/profile values, and is removed after success or failure.
  POSIX mode bits are applied where supported; on Windows the private per-user
  temporary directory is not a substitute for a full ACL review.
- Store certificates and keys outside the repository. The ignore patterns are a
  safety net, not secret storage.

## Generated artifacts and publication

The following are intentionally excluded from Git:

- `build/` and in-repository `.exe` outputs; the SEA output
  `../InDesignAaronV1.1.exe` is outside the repository
- `dist/uxp/*.ccx`
- `dist/installer/`, including setup executables and generated `mcp-config.json`
- `.exe`, `.ccx`, `.pfx`, `.p12`, `.p7b`, `.p7c`, `.cer`, `.crt`, `.pem`, and
  `.key` outputs

Publish only a setup produced by a successful `build:release` run, after
recording its path, byte size, SHA-256, signature status, and timestamp/verify
result. Treat the standalone SEA and `.ccx` as supporting build artifacts. Do
not describe a build as publicly signed, clean-profile UPIA-validated, or live
InDesign-validated without direct evidence from that environment.

## Pull requests

Before submitting a change:

1. Add or update focused tests and run the relevant suites.
2. Run `npm test`, `npm run build`, and `npm run smoke`.
3. Run `npm run package:uxp` and `npm run build:installer` when changing plugin,
   packaging, installer, or release behavior.
4. Run both audit commands for dependency changes and report any findings.
5. Update README, MCP-client instructions, and this guide when behavior changes.
6. Run `git diff --check` and confirm no generated binaries, installer outputs,
   credentials, or local reports are staged.
7. Use the repository issue tracker for bugs, feature requests, and release
   discussion.

Contributions are licensed under the repository's MIT license.
