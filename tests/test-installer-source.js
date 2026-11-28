import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE_URL = new URL('../installer/indesign-aaron.iss', import.meta.url);
const START_HERE_URL = new URL('../installer/START-HERE.txt', import.meta.url);
const PACKAGE_URL = new URL('../package.json', import.meta.url);

function installerSource() {
  return readFileSync(SOURCE_URL, 'utf8')
    .replaceAll('{#MyAppExeName}', 'InDesignAaronV1.1.exe')
    .replaceAll('{#MyAppName}', 'InDesignAaronV1.1')
    .replaceAll('{#InstalledCcxName}', 'com.ads.indesign-bridge_ID.ccx');
}

function pascalRoutine(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `missing Pascal routine: ${declaration}`);
  const remainder = source.slice(start + declaration.length);
  const nextRoutine = remainder.search(/\r?\n(?:function|procedure)\s+\w+/);
  return source.slice(start, nextRoutine === -1 ? undefined : start + declaration.length + nextRoutine);
}

function section(source, name, nextName) {
  const start = source.indexOf(`[${name}]`);
  assert.notEqual(start, -1, `missing section: ${name}`);
  const end = source.indexOf(`[${nextName}]`, start);
  assert.notEqual(end, -1, `missing section: ${nextName}`);
  return source.slice(start, end);
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

  const packageJson = JSON.parse(readFileSync(PACKAGE_URL, 'utf8'));
  assert.match(packageJson.scripts.test, /(?:^|\s)tests\/test-installer-source\.js(?:\s|$)/);
});

test('installer shortcuts and startup task invoke their intended runtime modes', () => {
  const source = installerSource();
  const icons = section(source, 'Icons', 'Tasks').split(/\r?\n/);
  const desktopShortcut = icons.find((line) => line.includes('{userdesktop}'));
  const startupShortcut = icons.find((line) => line.includes('{userstartup}'));
  const doctorShortcut = icons.find((line) => line.includes('Check Installation'));

  assert.ok(desktopShortcut, 'Desktop shortcut is missing');
  assert.match(desktopShortcut, /Check:\s*WizardIsTaskSelected\('desktopicon'\)/);
  assert.match(desktopShortcut, /Filename:\s*"\{app\}\\InDesignAaronV1\.1\.exe"/);
  assert.ok(startupShortcut, 'Startup shortcut is missing');
  assert.match(startupShortcut, /Filename:\s*"\{app\}\\InDesignAaronV1\.1\.exe"/);
  assert.match(startupShortcut, /Parameters:\s*"--bridge"/);
  assert.match(startupShortcut, /Flags:\s*runminimized/);
  assert.ok(doctorShortcut, 'Check Installation shortcut is missing');
  assert.match(doctorShortcut, /Filename:\s*"\{app\}\\InDesignAaronV1\.1\.exe"/);
  assert.match(doctorShortcut, /Parameters:\s*"--doctor"/);
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
  const initializeSetup = pascalRoutine(source, 'function InitializeSetup(): Boolean;');
  const generateConfig = pascalRoutine(source, 'function GeneratePortableConfig: Integer;');
  const saveInDesignPath = pascalRoutine(source, 'procedure SaveDetectedInDesignPath;');
  const installComponents = pascalRoutine(source, 'procedure InstallComponents;');

  assert.match(source, /GetVersionComponents\(/);
  assert.match(source, /MajorVersion\s*>=\s*18/);
  assert.match(source, /Adobe InDesign 18\.0 \(2023\) or newer/);
  assert.doesNotMatch(source, /Adobe InDesign 18\.0 \(2022\)/);
  assert.match(initializeSetup, /InDesignExe\s*:=\s*DetectInDesign;/);
  assert.match(source, /#define InstalledInDesignPathFile\s+"indesign-path\.txt"/);
  assert.match(saveInDesignPath, /ConfigLines\[0\]\s*:=\s*InDesignExe;/);
  assert.match(saveInDesignPath, /SaveStringsToUTF8FileWithoutBOM\([\s\S]*?InstalledInDesignPathFile/);
  assert.match(installComponents, /SaveDetectedInDesignPath;/);
  assert.match(source, /--install-plugin/);
  assert.match(source, /--install-uxp/);
  assert.match(source, /--configure-clients/);
  assert.match(generateConfig, /JsonEscape\(ExpandConstant\('\{app\}\\InDesignAaronV1\.1\.exe'\)\)/);
  assert.match(source, /SaveStringsToUTF8FileWithoutBOM\(/);
  assert.match(source, /mcpServers/);
  assert.match(source, /Install InDesign Copilot\.ccx/);
  assert.match(installComponents, /if\s+PluginResult\s*=\s*3\s+then/);
  assert.match(installComponents, /else\s+if\s+PluginResult\s*<>\s*0\s+then\s*begin\s*PluginNeedsFallback\s*:=\s*True;/);
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

test('installer owns only uniquely named Desktop fallbacks and validates them before uninstall', () => {
  const source = installerSource();
  const installComponents = pascalRoutine(source, 'procedure InstallComponents;');
  const removeComponents = pascalRoutine(source, 'procedure RemoveComponents;');
  const recordOwnership = pascalRoutine(source, 'function RecordOwnedDesktopFallback(');
  const removeOwnedFallbacks = pascalRoutine(source, 'procedure RemoveOwnedDesktopFallbacks;');
  const validateOwnedPath = pascalRoutine(source, 'function IsOwnedDesktopFallbackPath(');
  const fileHash = pascalRoutine(source, 'function FileSHA256(');

  assert.match(source, /#define OwnedDesktopFallbacks\s+"[^"]+"/);
  assert.match(installComponents, /while\s+FileExists\(DesktopCcx\)\s+do\s*begin/);
  assert.match(installComponents, /DesktopCcx\s*:=[\s\S]*?Install InDesign Copilot-[\s\S]*?IntToStr\(/);
  assert.match(installComponents, /CopyFile\(CcxFile,\s*DesktopCcx,\s*False\)/);
  assert.match(recordOwnership, /FileSHA256\(DesktopPath,\s*Hash\)/);
  assert.match(fileHash, /GetSHA256OfFile\(FileName\)/);
  assert.match(recordOwnership, /SaveStringsToUTF8FileWithoutBOM\([^;]*OwnedDesktopFallbacks[^;]*True\)/);
  assert.match(installComponents, /if\s+RecordOwnedDesktopFallback\(DesktopCcx\)\s+then\s*begin\s*DesktopFallbackPath\s*:=\s*DesktopCcx;[\s\S]*?else\s*begin\s*DeleteFile\(DesktopCcx\);/);
  assert.match(removeComponents, /RemoveOwnedDesktopFallbacks;/);
  assert.match(removeOwnedFallbacks, /LoadStringsFromFile\([^;]*ManifestPath/);
  assert.match(validateOwnedPath, /CompareText\(ExtractFilePath\(OwnedPath\),\s*DesktopPrefix\)\s*=\s*0/);
  assert.match(removeOwnedFallbacks, /CompareText\(ExpectedHash,\s*ActualHash\)\s*=\s*0[\s\S]*?DeleteFile\(OwnedPath\)/);
  assert.doesNotMatch(section(source, 'UninstallDelete', 'Code'), /\{userdesktop\}/);
});

test('START-HERE covers plugin, credentials, client restart, portable config, and fallback', () => {
  const text = readFileSync(START_HERE_URL, 'utf8');

  assert.match(text, /Adobe InDesign 2023 \(18\.0\) or newer/);
  assert.doesNotMatch(text, /Adobe InDesign 2022/);
  assert.match(text, /Window\s*→\s*Plugins\s*→\s*InDesign Copilot/);
  assert.match(text, /model/i);
  assert.match(text, /API key/i);
  assert.match(text, /API keys are not saved/i);
  assert.match(text, /bridge token is a bearer credential/i);
  assert.match(text, /Claude/);
  assert.match(text, /Cursor/);
  assert.match(text, /Qoder/);
  assert.match(text, /mcp-config\.json/);
  assert.match(text, /Install InDesign Copilot\*?\.ccx/);
  assert.match(text, /SmartScreen/i);
  assert.match(text, /Adobe trust prompt/i);
});
