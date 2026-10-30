; Helmian Spoke — standalone installer.
; One Setup file: installs the spoke, asks the pairing passphrase once on its
; own page (used inside the install, never stored), pairs, pins the Executive
; Guard key, and sets the spoke to start at sign-in. No Helmian app needed.
; The workflow stages the spoke tree into .\stage before compiling:
;   stage\node.exe, stage\bin\hands-spoke.mjs, stage\src\hands\*.mjs,
;   stage\hands-mcp\src\shared\protocol.mjs, stage\package.json,
;   stage\install-pair.mjs

[Setup]
AppId={{EEE4DDE3-DB3E-453E-B88D-0C9146ECA332}
AppName=Helmian Spoke
AppVersion=1.0.3
AppPublisher=Helmian Labs
DefaultDirName={localappdata}\Programs\HelmianSpoke
DefaultGroupName=Helmian Spoke
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=Helmian-Spoke-Setup-1.0.3-win-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Helmian Spoke

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Pair the Helmian Spoke"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" pair"; WorkingDir: "{app}"; Comment: "Recovery only: pair this PC again if pairing did not finish during setup."

Name: "{group}\Sign in to Claude (your plan)"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" login claude"; WorkingDir: "{app}"
Name: "{group}\Sign in to ChatGPT (your plan)"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" login chatgpt"; WorkingDir: "{app}"
Name: "{group}\Sign in to Gemini (your Google account)"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" login gemini"; WorkingDir: "{app}"
Name: "{group}\Sign in to SuperGrok (your plan)"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" login grok"; WorkingDir: "{app}"

[UninstallRun]
Filename: "schtasks.exe"; Parameters: "/Delete /TN HelmianSpoke /F"; Flags: runhidden; RunOnceId: "DelSpokeTask"

[UninstallDelete]
Type: files; Name: "{userappdata}\Helmian\hands-spoke.json"
Type: files; Name: "{userappdata}\Helmian\spoke-install-status.json"

[Code]
var
  PairPage: TInputQueryWizardPage;

function SetEnvironmentVariable(lpName, lpValue: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

procedure InitializeWizard;
begin
  PairPage := CreateInputQueryPage(wpWelcome,
    'Pair this PC',
    'Paste the pairing code from helmian.cloud',
    'In Helmian, open Settings and press "Set up this PC". Paste the 8-letter code it shows (it works once, for 10 minutes). Owners can type the hands passphrase instead. It is used once, here, and never stored.');
  PairPage.Add('Pairing code (or hands passphrase):', False);
  { Setup.exe /PAIRCODE=ABCD-EFGH fills it in for you. }
  PairPage.Values[0] := ExpandConstant('{param:PAIRCODE|}');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PairPage.ID then
  begin
    if Trim(PairPage.Values[0]) = '' then
    begin
      MsgBox('Please paste the pairing code from helmian.cloud (Settings, Set up this PC), or your hands passphrase. It is used once, inside this install, and never stored.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    SetEnvironmentVariable('HELMIAN_HANDS_PASSPHRASE', PairPage.Values[0]);
    SetEnvironmentVariable('HELMIAN_SPOKE_ROOTS', ExpandConstant('{userprofile}'));
    Exec(ExpandConstant('{app}\node.exe'), ExpandConstant('"{app}\install-pair.mjs"'),
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  S: AnsiString;
begin
  if CurPageID = wpFinished then
  begin
    if LoadStringFromFile(ExpandConstant('{userappdata}\Helmian\spoke-install-status.json'), S)
      and (Pos('"paired": true', String(S)) > 0) then
      WizardForm.FinishedLabel.Caption :=
        'Your Helmian Spoke is installed and paired. It starts by itself each time you sign in to Windows.'
    else
      WizardForm.FinishedLabel.Caption :=
        'The spoke is installed, but pairing did not finish. Open "Pair the Helmian Spoke" from the Start menu to try once more.';
  end;
end;
