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
AppVersion=1.0.2
AppPublisher=Helmian Labs
DefaultDirName={localappdata}\Programs\HelmianSpoke
DefaultGroupName=Helmian Spoke
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=Helmian-Spoke-Setup-1.0.2-win-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Helmian Spoke

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Pair the Helmian Spoke"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" pair"; WorkingDir: "{app}"; Comment: "Recovery only: pair this PC again if pairing did not finish during setup."

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
    'One passphrase, asked once, inside this install',
    'The spoke pairs with your Helmian account using your hands passphrase - the same one as the memory connector. It is used once, here, and never stored.');
  PairPage.Add('Hands passphrase:', True);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PairPage.ID then
  begin
    if Trim(PairPage.Values[0]) = '' then
    begin
      MsgBox('Please enter your hands passphrase to pair this PC. It is asked once, inside this install, and never stored.', mbError, MB_OK);
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
