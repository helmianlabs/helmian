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
AppVersion=1.0.10
AppPublisher=Helmian Labs
DefaultDirName={localappdata}\Programs\HelmianSpoke
DefaultGroupName=Helmian Spoke
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=Helmian-Spoke-Setup-1.0.10-win-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Helmian Spoke
LicenseFile=..\LICENSE
InfoBeforeFile=..\PRIVACY.md

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Pair the Helmian Spoke"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" pair"; WorkingDir: "{app}"; Comment: "Recovery only: pair this PC again if pairing did not finish during setup."

Name: "{group}\Sign in to Claude (your plan)"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" login claude"; WorkingDir: "{app}"
Name: "{group}\Sign in to ChatGPT (your plan)"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" login chatgpt"; WorkingDir: "{app}"
Name: "{group}\Sign in to Gemini (your Google account)"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" login gemini"; WorkingDir: "{app}"
Name: "{group}\Sign in to SuperGrok (your plan)"; Filename: "{app}\node.exe"; Parameters: """{app}\bin\hands-spoke.mjs"" login grok"; WorkingDir: "{app}"

[UninstallRun]
Filename: "schtasks.exe"; Parameters: "/End /TN HelmianSpoke"; Flags: runhidden; RunOnceId: "EndSpokeTask"
Filename: "schtasks.exe"; Parameters: "/Delete /TN HelmianSpoke /F"; Flags: runhidden; RunOnceId: "DelSpokeTask"

[UninstallDelete]
Type: files; Name: "{userappdata}\Helmian\hands-spoke.json"
Type: files; Name: "{userappdata}\Helmian\spoke-install-status.json"
Type: files; Name: "{userappdata}\Helmian\spoke-heartbeat.json"
Type: files; Name: "{app}\register-spoke-task.ps1"

[Code]
var
  PairPage: TInputQueryWizardPage;
  RetryButton: TNewButton;

function SetEnvironmentVariable(lpName, lpValue: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function IsUpgrade(): Boolean;
begin
  Result := FileExists(ExpandConstant('{userappdata}\Helmian\hands-spoke.json'));
end;

{ Stop the running spoke (scheduled task and any node process running
  hands-spoke.mjs, wherever it was started from) so the new files are the
  ones that run. Only the spoke is stopped; other node processes are left alone. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN HelmianSpoke', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $_.CommandLine -like ''*hands-spoke.mjs*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { Legacy spokes: older builds registered tasks under other names (e.g.
    "Helmian Spoke" running helmian-spoke.exe from Downloads). Stop and
    unregister those tasks and kill helmian-spoke.exe from any path so only the
    new spoke answers for this PC. The old exe file itself is left in place. }
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -Command "Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -ne ''HelmianSpoke'' -and ($_.TaskName -match ''^Helmian[ _-]?(Spoke|Bridge)'' -or ($_.Actions | Where-Object { $_.Execute -like ''*helmian-spoke.exe*'' })) } | ForEach-Object { Stop-ScheduledTask -InputObject $_ -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -Confirm:$false -ErrorAction SilentlyContinue }; Get-Process -Name helmian-spoke -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1500);
  Result := '';
end;

procedure InitializeWizard;
begin
  PairPage := CreateInputQueryPage(wpWelcome,
    'Pair this PC',
    'Paste the pairing code from helmian.cloud',
    'In Helmian, open Settings and press "Set up this PC". Paste the 8-letter code it shows (it works once, for 10 minutes). Owners can type the hands passphrase instead. It is used once, here, and never stored. Already paired? Leave it blank to keep your current pairing.');
  PairPage.Add('Pairing code (or hands passphrase):', False);
  { Setup.exe /PAIRCODE=ABCD-EFGH fills it in for you. }
  PairPage.Values[0] := ExpandConstant('{param:PAIRCODE|}');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PairPage.ID then
  begin
    if (Trim(PairPage.Values[0]) = '') and not IsUpgrade() then
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
    SetEnvironmentVariable('HELMIAN_SPOKE_ROOTS', ExpandConstant('{%USERPROFILE}'));
    Exec(ExpandConstant('{app}\node.exe'), ExpandConstant('"{app}\install-pair.mjs"'),
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
    { install-pair registers the hidden task, starts it, and checks it is running and connected. }
    SetEnvironmentVariable('HELMIAN_HANDS_PASSPHRASE', '');
  end;
end;

{ Uninstall: stop any running spoke so its files can be removed. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $_.CommandLine -like ''*hands-spoke.mjs*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

{ Status file checks, plain text (no JSON parser in Inno). }
function StatusHas(const S, Key: String): Boolean;
begin
  Result := (Pos('"' + Key + '": true', S) > 0);
end;

function StatusError(const S: String): String;
var
  P: Integer;
  T: String;
begin
  Result := 'reason unknown';
  P := Pos('"error": "', S);
  if P > 0 then
  begin
    T := Copy(S, P + 10, 400);
    P := Pos('"', T);
    if P > 0 then Result := Copy(T, 1, P - 1);
  end;
end;

procedure ShowSpokeStatus;
var
  A: AnsiString;
  S: String;
  Ok: Boolean;
begin
  Ok := False;
  if LoadStringFromFile(ExpandConstant('{userappdata}\Helmian\spoke-install-status.json'), A) then
  begin
    S := String(A);
    if not StatusHas(S, 'paired') then
      WizardForm.FinishedLabel.Caption :=
        'The spoke is installed, but pairing did not finish. Open "Pair the Helmian Spoke" from the Start menu with a new code from helmian.cloud, then press Try again.'
    else if StatusHas(S, 'running') and StatusHas(S, 'connected') then
    begin
      Ok := True;
      WizardForm.FinishedLabel.Caption :=
        'All set. Helmian Spoke is installed, paired, running in the background and connected. You will not see a window. It keeps running and starts by itself whenever you sign in to Windows. No restart needed.';
    end
    else
      WizardForm.FinishedLabel.Caption :=
        'Helmian Spoke is installed and paired, but it is NOT running yet (' + StatusError(S) + ').' + #13#10#13#10 +
        'Press Try again. If it still fails, send the file %APPDATA%\Helmian\spoke-install.log to Helmian support.';
  end
  else
    WizardForm.FinishedLabel.Caption := 'Setup could not confirm the spoke started. Press Try again.';
  RetryButton.Visible := not Ok;
  RetryButton.Enabled := True;
  RetryButton.Caption := 'Try again';
end;

procedure RetryButtonClick(Sender: TObject);
var
  ResultCode: Integer;
begin
  RetryButton.Enabled := False;
  RetryButton.Caption := 'Starting...';
  WizardForm.FinishedLabel.Caption := 'Starting Helmian Spoke and checking it can reach Helmian. This can take up to a minute...';
  WizardForm.Refresh;
  SetEnvironmentVariable('HELMIAN_HANDS_PASSPHRASE', '');
  SetEnvironmentVariable('HELMIAN_SPOKE_ROOTS', ExpandConstant('{%USERPROFILE}'));
  Exec(ExpandConstant('{app}\node.exe'), ExpandConstant('"{app}\install-pair.mjs"'),
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  ShowSpokeStatus;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    if RetryButton = nil then
    begin
      RetryButton := TNewButton.Create(WizardForm);
      RetryButton.Parent := WizardForm.FinishedPage;
      RetryButton.Left := WizardForm.FinishedLabel.Left;
      RetryButton.Top := WizardForm.FinishedLabel.Top + ScaleY(150);
      RetryButton.Width := ScaleX(120);
      RetryButton.Height := WizardForm.NextButton.Height;
      RetryButton.OnClick := @RetryButtonClick;
    end;
    WizardForm.FinishedLabel.AutoSize := False;
    WizardForm.FinishedLabel.Height := ScaleY(140);
    ShowSpokeStatus;
  end;
end;
