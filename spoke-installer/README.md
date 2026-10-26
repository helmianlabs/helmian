# Helmian Spoke — standalone installer

The spoke is a separate download from Helmian (Troy's design law): nobody
should have to install the Helmian app to run a spoke on a PC.

- `HelmianSpoke.iss` — Inno Setup script for the one-file customer install
  (`Helmian-Spoke-Setup-<version>-win-x64.exe`). It installs the spoke,
  asks the pairing passphrase once on its own page (used inside the
  install, never stored), and sets the spoke to start at sign-in.
- `install-pair.mjs` — the hidden helper the installer runs after copying
  files: pairs the PC, pins the Executive Guard public key, registers the
  sign-in task, starts the spoke, and writes the status file the
  installer's last page reads.

The release workflow (`.github/workflows/spoke-release.yml`) stages the
spoke tree into `stage/` (bundled `node.exe` v24.22.1 LTS, `bin/`,
`src/hands/`, `hands-mcp/src/shared/`, this folder's `install-pair.mjs`),
compiles the installer, and publishes it as its own GitHub release.
