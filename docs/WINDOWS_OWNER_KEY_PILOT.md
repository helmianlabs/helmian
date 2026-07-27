# Windows owner-key lifecycle

## Invariants

- A private owner key is generated only by an explicit interactive command.
- The normal local key is encrypted first with a distinct owner signing
  passphrase and AES-256-GCM, then wrapped with Windows DPAPI `CurrentUser`.
- The key directory and files are ACL-restricted to the current Windows user
  and `SYSTEM`.
- A recovery package is independently encrypted with scrypt and AES-256-GCM.
- Owner signing and recovery passphrases are distinct and read in hidden
  terminal prompts, never command arguments, environment variables,
  clipboards, Notepad, chat, databases, or source files.
- Private key plaintext moves only through in-memory process pipes/buffers and
  is never printed or exported.
- Only public enrollment JSON may be handed to the authenticated enrollment
  authority.
- Agents and MCP tools cannot enroll a trust root or answer the owner decision
  prompt.

## Explicit setup

No key has been generated merely by adding this tooling. When the owner is
ready, open a real interactive Windows terminal and choose:

- a stable identity provider ID;
- a stable subject ID;
- a public enrollment output path; and
- a recovery output path outside the repository, preferably offline removable
  storage.

For a one-user local Windows pilot, identify the Windows security authority
and account rather than a mutable display name, username, or email:

```powershell
$provider = "windows-local:$($env:COMPUTERNAME.ToLowerInvariant())"
$subject = "sid:$(([Security.Principal.WindowsIdentity]::GetCurrent().User.Value).ToLowerInvariant())"
```

Record those resolved, non-secret values with the enrollment ceremony. They
must match the public-key identity record exactly. If the computer is later
renamed, retain the original provider value for this key; use the authenticated
rotation process to establish a differently named identity.

Run:

```powershell
cd E:\Helmion
node .\bin\helmion.mjs owner-key init `
  --provider $provider `
  --subject $subject `
  --public-output C:\path\to\owner-key.public.json `
  --recovery-output F:\Helmion-Recovery\owner-key.recovery.json
```

The command separately prompts twice for:

- a 16+ character owner signing passphrase used only for high-risk approvals;
  and
- a different 16+ character recovery passphrase.

Neither is stored. DPAPI alone does not prove human presence to another
process running as the same Windows user, so the signing passphrase is required
after the owner reviews and approves an exact action.

The DPAPI key defaults to:

```text
%LOCALAPPDATA%\Helmion\owner-keys\
```

Custom local directories must be outside the workspace and use the dedicated
leaf name `owner-keys`. Existing files are never overwritten.

Success explicitly reports:

```text
private_key_exported: false
enrollment_performed: false
```

The public output contains only provider, subject, key ID, algorithm,
fingerprint, creation time, and Ed25519 public key.

## Inspect and public re-export

Neither command decrypts the private key:

```powershell
node .\bin\helmion.mjs owner-key inspect --key <local-key-path>
node .\bin\helmion.mjs owner-key export-public `
  --key <local-key-path> `
  --output C:\path\to\replacement-public.json
```

Public enrollment must still go through the separately authenticated
owner/admin authority. This CLI never writes it to Neon.

## Owner approval

A coordinator creates a JSON request containing:

```json
{
  "projectSlug": "project-a",
  "handoffId": "42",
  "operation": {
    "description": "Apply reviewed migration 003 to the development database",
    "migration": true,
    "pilotScope": "shared-development"
  },
  "guardState": {}
}
```

The owner runs:

```powershell
node .\bin\helmion.mjs owner-key approve `
  --key <local-key-path> `
  --request C:\path\to\request.json `
  --output "$env:LOCALAPPDATA\Helmion\confirmations\approval.owner-confirmation.json"
```

The output directory must be outside the repository and use the dedicated leaf
name `confirmations`. The command refuses redirected/noninteractive input. It
shows the plain-English action, risks, structured operation, handoff, and exact
hash, then accepts only `APPROVE` or `DECLINE`.

- `APPROVE` then requests the hidden owner signing passphrase, decrypts the key
  through both CurrentUser DPAPI and AES-GCM only in memory, signs a five-minute
  exact-action assertion, writes the ACL-protected assertion, and clears
  private/passphrase buffers.
- `DECLINE` writes nothing.
- Tier A work is rejected by this command because it should auto-run inside
  guardrails.
- A hard guard block is rejected because owner confirmation cannot bypass it.

## Recovery

The recovery file and passphrase must be stored separately. To restore after a
profile/machine loss:

```powershell
node .\bin\helmion.mjs owner-key restore `
  --recovery F:\Helmion-Recovery\owner-key.recovery.json
```

The command reads the passphrase without echo, authenticates the AES-GCM
package, asks for a new distinct owner signing passphrase, verifies that its
private key matches the public fingerprint, and re-wraps it with the new local
passphrase plus DPAPI for the current Windows user. It does not enroll or rotate
the database identity.

If both DPAPI material and recovery are lost, the key is unrecoverable. Revoke
its public identity record and perform a new authenticated setup.

## Rotation and revocation

1. Run a new explicit `owner-key init`.
2. Authenticate and enroll only the new public JSON.
3. Verify one test signature through the normal confirmation flow.
4. Revoke the old public key in the identity authority/database.
5. Retain the old encrypted recovery only for the approved retention period,
   then remove it through the owner's normal secure media process.

No agent command performs enrollment, revocation, or key-file deletion.
