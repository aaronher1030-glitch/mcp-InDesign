#define MyAppName "InDesignAaronV1.1"
#define MyAppExeName "InDesignAaronV1.1.exe"
#define MyAppGroupName "InDesignAaronV1.1"
#define InstalledCcxName "com.ads.indesign-bridge_ID.ccx"
#define InstalledInDesignPathFile "indesign-path.txt"
#define OwnedDesktopFallbacks "owned-desktop-fallbacks.txt"

; The release build supplies these values with ISCC /D switches. Defaults keep
; the source convenient to inspect without embedding build-machine artifacts.
#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif
#ifndef SeaExe
  #define SeaExe "InDesignAaronV1.1.exe"
#endif
#ifndef CcxPath
  #define CcxPath "com.ads.indesign-bridge_ID.ccx"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist\installer"
#endif

[Setup]
AppId={#MyAppName}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher=lucdesign
AppPublisherURL=https://github.com/lucdesign/indesign-mcp-server
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
DefaultDirName={localappdata}\Programs\InDesignAaronV1.1
DefaultGroupName={#MyAppGroupName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=no
UsePreviousAppDir=yes
UsePreviousGroup=yes
UsePreviousTasks=no
OutputDir={#OutputDir}
OutputBaseFilename=InDesignAaronV1.1-{#AppVersion}-windows-setup-unsigned
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#SeaExe}"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion
Source: "{#CcxPath}"; DestDir: "{app}"; DestName: "{#InstalledCcxName}"; Flags: ignoreversion
Source: "START-HERE.txt"; DestDir: "{app}"; Flags: ignoreversion
; Task 5 writes the generated portable client configuration beside the setup.
Source: "{#OutputDir}\mcp-config.json"; DestDir: "{app}"; DestName: "mcp-config.json"; Flags: ignoreversion

[Icons]
Name: "{group}\InDesign Copilot"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--bridge"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\Check Installation"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--doctor"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"; IconFilename: "{uninstallexe}"
Name: "{userdesktop}\InDesign Copilot.lnk"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--bridge"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Check: WizardIsTaskSelected('desktopicon')
Name: "{userstartup}\InDesignAaron Bridge.lnk"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--bridge"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Flags: runminimized

[Tasks]
Name: "desktopicon"; Description: "Create a Desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "launchcopilot"; Description: "Start InDesign Copilot after setup"; GroupDescription: "After installation:"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\plugin"

[Code]
var
  InDesignExe: String;
  ServerResult: Integer;
  PluginResult: Integer;
  McpResult: Integer;
  ConfigWriteResult: Integer;
  BridgeResult: Integer;
  InDesignResult: Integer;
  RemoveUxpResult: Integer;
  RemoveClientsResult: Integer;
  PluginNeedsFallback: Boolean;
  DesktopFallbackPath: String;
  InDesignPathWriteResult: Integer;

function RunApp(Parameters: string): Integer;
var
  ResultCode: Integer;
begin
  if not Exec(ExpandConstant('{app}\{#MyAppExeName}'), Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
    ResultCode := 1;
  Log('InDesignAaron ' + Parameters + ' => ' + IntToStr(ResultCode));
  Result := ResultCode;
end;

function FileMajorVersion(const FileName: String): Integer;
var
  Major: Word;
  Minor: Word;
  Revision: Word;
  Build: Word;
begin
  Result := 0;
  if FileExists(FileName) and
    GetVersionComponents(FileName, Major, Minor, Revision, Build) then
    Result := Major;
end;

procedure ConsiderInDesign(Candidate: String; var BestPath: String;
  var BestVersion: Integer);
var
  MajorVersion: Integer;
begin
  Candidate := RemoveQuotes(Candidate);
  if Candidate = '' then
    exit;
  MajorVersion := FileMajorVersion(Candidate);
  if (MajorVersion >= 18) and (MajorVersion > BestVersion) then
  begin
    BestPath := Candidate;
    BestVersion := MajorVersion;
  end;
end;

procedure ConsiderRegistryPath(RootKey: Integer; const ExeName: String;
  var BestPath: String; var BestVersion: Integer);
var
  Candidate: String;
begin
  if RegQueryStringValue(RootKey,
    'Software\Microsoft\Windows\CurrentVersion\App Paths\' + ExeName, '', Candidate) then
    ConsiderInDesign(Candidate, BestPath, BestVersion);
end;

procedure SearchAdobeFolders(const Root: String; var BestPath: String;
  var BestVersion: Integer);
var
  FindRec: TFindRec;
  Candidate: String;
begin
  if Root = '' then
    exit;
  if FindFirst(AddBackslash(Root) + 'Adobe\Adobe InDesign *', FindRec) then
  begin
    try
      repeat
        if FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then
        begin
          Candidate := AddBackslash(Root) + 'Adobe\' + FindRec.Name + '\InDesign.exe';
          ConsiderInDesign(Candidate, BestPath, BestVersion);
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function DetectInDesign: String;
var
  BestPath: String;
  BestVersion: Integer;
begin
  BestPath := '';
  BestVersion := 0;

  ConsiderRegistryPath(HKLM64, 'InDesign.exe', BestPath, BestVersion);
  ConsiderRegistryPath(HKLM32, 'InDesign.exe', BestPath, BestVersion);
  ConsiderRegistryPath(HKCU64, 'InDesign.exe', BestPath, BestVersion);
  ConsiderRegistryPath(HKCU32, 'InDesign.exe', BestPath, BestVersion);

  SearchAdobeFolders(ExpandConstant('{pf64}'), BestPath, BestVersion);
  SearchAdobeFolders(ExpandConstant('{pf}'), BestPath, BestVersion);
  SearchAdobeFolders(ExpandConstant('{pf32}'), BestPath, BestVersion);
  SearchAdobeFolders(ExpandConstant('{localappdata}\Programs'), BestPath, BestVersion);

  Result := BestPath;
end;

function InitializeSetup(): Boolean;
begin
  Result := False;
  ServerResult := -1;
  PluginResult := -1;
  McpResult := -1;
  ConfigWriteResult := -1;
  BridgeResult := -1;
  InDesignResult := -1;
  RemoveUxpResult := -1;
  RemoveClientsResult := -1;
  PluginNeedsFallback := False;
  DesktopFallbackPath := '';
  InDesignPathWriteResult := -1;

  if not IsWin64 then
  begin
    MsgBox('This setup requires 64-bit Windows 10 or 11 (x64).',
      mbError, MB_OK);
    exit;
  end;

  InDesignExe := DetectInDesign;
  if InDesignExe = '' then
  begin
    MsgBox('Adobe InDesign 18.0 (2023) or newer was not found.' + #13#10#13#10 +
      'Install or update InDesign first. If it is already installed, launch it once ' +
      'so Creative Cloud finishes registration, then run this setup again.' + #13#10#13#10 +
      'No application files have been copied.', mbError, MB_OK);
    exit;
  end;

  Result := True;
end;

function StartInDesign: Integer;
var
  ResultCode: Integer;
begin
  if Exec(InDesignExe, '', '', SW_SHOWNORMAL, ewNoWait, ResultCode) then
    Result := 0
  else
    Result := 1;
  Log('Launch InDesign ' + InDesignExe + ' => ' + IntToStr(Result));
end;

function StartBridge: Integer;
var
  ResultCode: Integer;
begin
  if Exec(ExpandConstant('{app}\{#MyAppExeName}'), '--bridge',
    ExpandConstant('{app}'), sw_showminnoactive, ewNoWait, ResultCode) then
    Result := 0
  else
    Result := 1;
  Log('Launch InDesignAaron bridge => ' + IntToStr(Result));
end;

function JsonEscape(const Value: String): String;
var
  I: Integer;
  C: Char;
begin
  Result := '';
  for I := 1 to Length(Value) do
  begin
    C := Value[I];
    if C = '\' then
      Result := Result + '\\'
    else if C = '"' then
      Result := Result + '\"'
    else
      Result := Result + C;
  end;
end;

function GeneratePortableConfig: Integer;
var
  ConfigLines: TArrayOfString;
begin
  // Rewrite the bundled template with the real per-user destination so a setup
  // built on another machine never ships that builder's absolute path.
  SetLength(ConfigLines, 9);
  ConfigLines[0] := '{';
  ConfigLines[1] := '  "mcpServers": {';
  ConfigLines[2] := '    "indesign": {';
  ConfigLines[3] := '      "command": "' +
    JsonEscape(ExpandConstant('{app}\{#MyAppExeName}')) + '",';
  ConfigLines[4] := '      "args": []';
  ConfigLines[5] := '    }';
  ConfigLines[6] := '  }';
  ConfigLines[7] := '}';
  ConfigLines[8] := '';
  if SaveStringsToUTF8FileWithoutBOM(ExpandConstant('{app}\mcp-config.json'),
    ConfigLines, False) then
    Result := 0
  else
    Result := 1;
  Log('Generate per-user mcp-config.json => ' + IntToStr(Result));
end;

procedure SaveDetectedInDesignPath;
var
  ConfigLines: TArrayOfString;
begin
  // The packaged --doctor command prefers this exact path, including installs
  // on drives and folders that source/default discovery does not scan.
  SetLength(ConfigLines, 2);
  ConfigLines[0] := InDesignExe;
  ConfigLines[1] := '';
  if SaveStringsToUTF8FileWithoutBOM(
    ExpandConstant('{app}\{#InstalledInDesignPathFile}'), ConfigLines, False) then
    InDesignPathWriteResult := 0
  else
    InDesignPathWriteResult := 1;
  Log('Save detected InDesign path => ' + IntToStr(InDesignPathWriteResult));
end;

function FileSHA256(const FileName: String; var Hash: String): Boolean;
begin
  Result := False;
  Hash := '';
  if not FileExists(FileName) then
    exit;
  try
    Hash := GetSHA256OfFile(FileName);
    Result := Hash <> '';
  except
    Hash := '';
  end;
end;

function RecordOwnedDesktopFallback(const DesktopPath: String): Boolean;
var
  Hash: String;
  OwnershipLines: TArrayOfString;
begin
  Result := False;
  if not FileSHA256(DesktopPath, Hash) then
    exit;
  SetLength(OwnershipLines, 2);
  OwnershipLines[0] := DesktopPath;
  OwnershipLines[1] := Hash;
  Result := SaveStringsToUTF8FileWithoutBOM(
    ExpandConstant('{app}\{#OwnedDesktopFallbacks}'), OwnershipLines, True);
end;

function IsOwnedDesktopFallbackPath(const OwnedPath: String): Boolean;
var
  DesktopPrefix: String;
  FileName: String;
begin
  DesktopPrefix := AddBackslash(ExpandConstant('{userdesktop}'));
  FileName := ExtractFileName(OwnedPath);
  Result := (OwnedPath <> '') and
    (CompareText(ExtractFilePath(OwnedPath), DesktopPrefix) = 0) and
    (CompareText(Copy(FileName, 1, Length('Install InDesign Copilot')),
      'Install InDesign Copilot') = 0) and
    (CompareText(ExtractFileExt(FileName), '.ccx') = 0);
end;

procedure RemoveOwnedDesktopFallbacks;
var
  OwnershipLines: TArrayOfString;
  Index: Integer;
  ManifestPath: String;
  OwnedPath: String;
  ExpectedHash: String;
  ActualHash: String;
begin
  ManifestPath := ExpandConstant('{app}\{#OwnedDesktopFallbacks}');
  if not FileExists(ManifestPath) then
    exit;
  if not LoadStringsFromFile(ManifestPath, OwnershipLines) then
  begin
    Log('Could not read owned Desktop fallback records; preserving Desktop files');
    exit;
  end;

  Index := 0;
  while Index <= Length(OwnershipLines) - 2 do
  begin
    OwnedPath := OwnershipLines[Index];
    ExpectedHash := OwnershipLines[Index + 1];
    if not IsOwnedDesktopFallbackPath(OwnedPath) then
      Log('Ignoring invalid owned Desktop fallback path: ' + OwnedPath)
    else if not FileExists(OwnedPath) then
      Log('Owned Desktop fallback is already absent: ' + OwnedPath)
    else if FileSHA256(OwnedPath, ActualHash) and
      (CompareText(ExpectedHash, ActualHash) = 0) then
    begin
      if DeleteFile(OwnedPath) then
        Log('Removed owned Desktop fallback: ' + OwnedPath)
      else
        Log('Could not remove owned Desktop fallback: ' + OwnedPath);
    end
    else
      Log('Preserving modified or unverifiable Desktop file: ' + OwnedPath);
    Index := Index + 2;
  end;
  if not DeleteFile(ManifestPath) then
    Log('Could not remove owned Desktop fallback records');
end;

procedure InstallComponents;
var
  CcxFile: String;
  DesktopCcx: String;
  FallbackIndex: Integer;
begin
  SaveDetectedInDesignPath;
  ServerResult := RunApp('--install-plugin');

  CcxFile := ExpandConstant('{app}\{#InstalledCcxName}');
  PluginResult := RunApp('--install-uxp "' + CcxFile + '"');
  PluginNeedsFallback := False;
  DesktopFallbackPath := '';
  if PluginResult = 3 then
  begin
    PluginNeedsFallback := True;
    Log('UPIA requested the one-click CCX fallback');
  end
  else if PluginResult <> 0 then
  begin
    PluginNeedsFallback := True;
    Log('UPIA installation failed; using the one-click CCX fallback');
  end;

  if PluginNeedsFallback then
  begin
    DesktopCcx := ExpandConstant('{userdesktop}\Install InDesign Copilot.ccx');
    FallbackIndex := 2;
    while FileExists(DesktopCcx) do
    begin
      DesktopCcx := ExpandConstant('{userdesktop}\Install InDesign Copilot-' +
        IntToStr(FallbackIndex) + '.ccx');
      FallbackIndex := FallbackIndex + 1;
    end;
    if CopyFile(CcxFile, DesktopCcx, False) then
    begin
      if RecordOwnedDesktopFallback(DesktopCcx) then
      begin
        DesktopFallbackPath := DesktopCcx;
        Log('Copied and recorded owned plugin fallback to ' + DesktopCcx);
      end
      else
      begin
        DeleteFile(DesktopCcx);
        PluginResult := 1;
        Log('Could not record plugin fallback ownership; removed the new copy');
      end;
    end
    else
    begin
      PluginResult := 1;
      Log('Could not copy plugin fallback to ' + DesktopCcx);
    end;
  end;

  // A malformed or conflicting client config must not block installation.
  ConfigWriteResult := GeneratePortableConfig;
  McpResult := RunApp('--configure-clients');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    InstallComponents;

    if WizardIsTaskSelected('launchcopilot') then
    begin
      InDesignResult := StartInDesign;
      BridgeResult := StartBridge;
    end;
  end;
end;

procedure ReportFinished;
var
  Report: String;
begin
  if ServerResult = 0 then
    Report := 'Server: Installed; plugin files staged successfully.'
  else
    Report := 'Server: Installed; --install-plugin returned ' + IntToStr(ServerResult) +
      '. Run Check Installation for diagnostics.';

  if PluginResult = 0 then
    Report := Report + #13#10 + 'Plugin: Installed through Adobe UPIA.'
  else if DesktopFallbackPath <> '' then
    Report := Report + #13#10 + 'Plugin: Needs one click. Double-click ' + DesktopFallbackPath +
      ' and accept the Adobe trust prompt.'
  else
    Report := Report + #13#10 + 'Plugin: Needs one click. Open ' +
      ExpandConstant('{app}\{#InstalledCcxName}') + ' manually and accept the Adobe trust prompt.';

  if ConfigWriteResult <> 0 then
    Report := Report + #13#10 + 'MCP configuration: Client command exit ' + IntToStr(McpResult) +
      '; the portable config could not be refreshed for this user. Do not use the bundled copy at ' +
      ExpandConstant('{app}\mcp-config.json') + ' until its command path is corrected.'
  else if McpResult = 0 then
    Report := Report + #13#10 + 'MCP configuration: Completed for detected clients. Portable config: ' +
      ExpandConstant('{app}\mcp-config.json')
  else
    Report := Report + #13#10 + 'MCP configuration: Needs attention (exit ' + IntToStr(McpResult) +
      '). Use the generated config at ' + ExpandConstant('{app}\mcp-config.json') +
      ' and restart Claude, Cursor, or Qoder.';

  if not WizardIsTaskSelected('launchcopilot') then
    Report := Report + #13#10 + 'Bridge: Not started; use the Start Menu shortcut when needed.'
  else if BridgeResult = 0 then
    Report := Report + #13#10 + 'Bridge: Launch requested successfully.'
  else
    Report := Report + #13#10 + 'Bridge: Launch failed. Run Check Installation, then try again.';

  if WizardIsTaskSelected('launchcopilot') and (InDesignResult <> 0) then
    Report := Report + #13#10 + 'InDesign launch failed; setup will continue. Launch InDesign manually.';

  if InDesignPathWriteResult <> 0 then
    Report := Report + #13#10 + 'InDesign path: Could not save the detected executable path; ' +
      'Check Installation will use default discovery instead.';

  MsgBox(Report + #13#10#13#10 + 'See START-HERE.txt in the installation folder for next steps.',
    mbInformation, MB_OK);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    ReportFinished;
end;

procedure RemoveComponents;
begin
  RemoveOwnedDesktopFallbacks;
  RemoveUxpResult := RunApp('--remove-uxp "' +
    ExpandConstant('{app}\{#InstalledCcxName}') + '"');
  if RemoveUxpResult <> 0 then
    MsgBox('Automatic plugin removal was unavailable or failed (exit ' +
      IntToStr(RemoveUxpResult) + ').' + #13#10#13#10 +
      'If InDesign Copilot is listed, open Creative Cloud, go to Plugins > Manage Plugins, ' +
      'select InDesign Copilot, and remove it. Restart InDesign afterward.',
      mbError, MB_OK);

  // The SEA removes only an indesign entry whose command matches this install;
  // unrelated MCP servers and timestamped backups are preserved.
  RemoveClientsResult := RunApp('--remove-clients');
  if RemoveClientsResult <> 0 then
    MsgBox('Some MCP client entries need manual review (exit ' +
      IntToStr(RemoveClientsResult) + ').' + #13#10 +
      'Remove only the indesign entry that points to ' + ExpandConstant('{app}\{#MyAppExeName}') +
      ', then restart Claude, Cursor, or Qoder.', mbCriticalError, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveComponents;
end;

function InitializeUninstall(): Boolean;
begin
  // CloseApplications=yes and RestartApplications=no use Windows Restart Manager
  // for files locked inside {app}. There is deliberately no process-name kill.
  Result := True;
end;
