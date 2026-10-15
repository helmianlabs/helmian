; Inno Setup script for the Helmian Windows installer.
; Built by .github/workflows/desktop-release.yml from the publish.ps1 output folder.
; Per-user install (no admin prompt). Pass /DAppVersion=x.y.z /DSourceDir=<publish folder>.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\artifacts\Helmion-Pilot-win-x64-self-contained"
#endif

[Setup]
AppId={{6B0E5C7E-6F5B-4C6B-9C7D-2E3B8E1F4A10}
AppName=Helmian
AppVersion={#AppVersion}
AppPublisher=Helmian Labs
AppPublisherURL=https://helmian.cloud
DefaultDirName={localappdata}\Programs\Helmian
DefaultGroupName=Helmian
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputBaseFilename=Helmian-Setup-{#AppVersion}-win-x64
OutputDir=..\..\artifacts\installer
SetupIconFile=..\Helmion.Desktop\Assets\Helmion.ico
UninstallDisplayIcon={app}\Helmian.exe
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
WizardStyle=modern

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Helmian"; Filename: "{app}\Helmian.exe"
Name: "{userdesktop}\Helmian"; Filename: "{app}\Helmian.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\Helmian.exe"; Description: "Launch Helmian"; Flags: nowait postinstall skipifsilent
