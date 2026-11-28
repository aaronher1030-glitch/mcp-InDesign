import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE_URL = new URL('../installer/indesign-aaron.iss', import.meta.url);
const START_HERE_URL = new URL('../installer/START-HERE.txt', import.meta.url);

function installerSource() {
  return readFileSync(SOURCE_URL, 'utf8')
    .replaceAll('{#MyAppExeName}', 'InDesignAaronV1.1.exe')
    .replaceAll('{#MyAppName}', 'InDesignAaronV1.1')
    .replaceAll('{#InstalledCcxName}', 'com.ads.indesign-bridge_ID.ccx');
}

test('installer source enforces per-user x64 deployment and build inputs', () => {
  const source = installerSource();

  assert.match(source, /ArchitecturesAllowed=x64compatible/);
  assert.match(source, /ArchitecturesInstallIn64BitMode=x64compatible/);
  assert.match(source, /PrivilegesRequired=lowest/);
  assert.match(source, /DefaultDirName=\{localappdata\}\\Programs\\InDesignAaronV1\.1/);
  assert.match(source, /UsePreviousTasks=no/);
  assert.match(source, /DisableProgramGroupPage=yes/);
  assert.match(source, /CloseApplications=yes/);
  assert.match(source, /RestartApplications=no/);
  assert.doesNotMatch(source, /PrivilegesRequired=admin/);
  assert.match(source, /#define AppVersion/);
  assert.match(source, /#define SeaExe/);
  assert.match(source, /#define CcxPath/);
  assert.match(source, /#define OutputDir/);
});

test('installer source installs the real payload and creates required shortcuts and tasks', () => {
  const source = installerSource();

  assert.match(source, /Source:\s*"\{#SeaExe\}";\s*DestDir:\s*"\{app\}";/);
  assert.match(source, /Source:\s*"\{#CcxPath\}";\s*DestDir:\s*"\{app\}";/);
  assert.match(source, /Source:\s*"START-HERE\.txt";\s*DestDir:\s*"\{app\}";/);
  assert.match(source, /Source:\s*"[^"]*mcp-config\.json";\s*DestDir:\s*"\{app\}";/);
  assert.match(source, /Name:\s*"[^"]*\\InDesign Copilot"/);
  assert.match(source, /Name:\s*"[^"]*\\Check Installation"/);
  assert.match(source, /Name:\s*"[^"]*\\Uninstall InDesignAaronV1\.1"/);
  assert.match(source, /Name:\s*"\{userdesktop\}\\InDesign Copilot\.lnk"/);
  assert.match(source, /Name:\s*"[^"]*\\InDesignAaron Bridge\.lnk"/);
  assert.match(source, /Filename:\s*"\{app\}\\InDesignAaronV1\.1\.exe"/);
  assert.match(source, /Parameters:\s*"--bridge"/);
  assert.match(source, /sw_showminnoactive/);
  const startupShortcut = source.split(/\r?\n/).find((line) => line.includes('{userstartup}'));
  assert.ok(startupShortcut);
  assert.match(startupShortcut, /Flags:\s*runminimized/);
  assert.match(source, /Name:\s*"desktopicon"/);
  assert.match(source, /Name:\s*"launchcopilot"/);
  assert.match(source, /Description:\s*"Start InDesign Copilot after setup"/);
  const launchTask = source.split(/\r?\n/).find((line) => line.includes('Name: "launchcopilot"'));
  assert.ok(launchTask);
  assert.doesNotMatch(launchTask, /Flags:\s*unchecked/);
});

test('installer source has explicit SEA, fallback, completion, and safe uninstall actions', () => {
  const source = installerSource();

  assert.match(source, /GetVersionComponents\(/);
  assert.match(source, /MajorVersion\s*>=\s*18/);
  assert.match(source, /--install-plugin/);
  assert.match(source, /--install-uxp/);
  assert.match(source, /--configure-clients/);
  assert.match(source, /SaveStringsToUTF8FileWithoutBOM\(/);
  assert.match(source, /mcpServers/);
  assert.match(source, /Install InDesign Copilot\.ccx/);
  assert.match(source, /PluginNeedsFallback\s*:=\s*True/);
  assert.match(source, /PluginResult\s*=\s*3/);
  assert.match(source, /CopyFile\(/);
  assert.match(source, /--remove-uxp/);
  assert.match(source, /--remove-clients/);
  assert.match(source, /Manage Plugins/);
  assert.match(source, /CurPageChanged\([^)]*\)/);
  assert.match(source, /CurPageID\s*=\s*wpFinished/);
  assert.match(source, /Server:/);
  assert.match(source, /Plugin:/);
  assert.match(source, /MCP configuration:/);
  assert.match(source, /Bridge:/);
  assert.doesNotMatch(source, /\btaskkill\b|\bTerminateProcess\b/i);
});

test('START-HERE covers plugin, credentials, client restart, portable config, and fallback', () => {
  const text = readFileSync(START_HERE_URL, 'utf8');

  assert.match(text, /Window\s*→\s*Plugins\s*→\s*InDesign Copilot/);
  assert.match(text, /model/i);
  assert.match(text, /API key/i);
  assert.match(text, /API keys are not saved/i);
  assert.match(text, /Claude/);
  assert.match(text, /Cursor/);
  assert.match(text, /Qoder/);
  assert.match(text, /mcp-config\.json/);
  assert.match(text, /Install InDesign Copilot\.ccx/);
  assert.match(text, /SmartScreen/i);
  assert.match(text, /Adobe trust prompt/i);
});
