# Helmian Spoke — privacy in plain words

The Helmian Spoke is a small helper that runs on your own PC. Installing it
lets your Helmian account work with this PC and with an Android phone plugged
into it — for example reading the phone's system log (logcat) so problems in
an app can be found and fixed.

What it does:

- It connects outward to Helmian on its own. Nothing on your PC opens a port
  or listens for incoming connections.
- It runs a fixed list of built-in commands, plus one free-text PowerShell
  command type. A free-text command never runs on its own: every one needs a
  human approval through Executive Guard, approved for that exact text, and
  the spoke re-checks that approval on this PC before it runs. (Corrected
  2026-11-26: this line used to say the spoke had no free shell, which
  stopped being true when the free-text command was added on 2026-10-31.)
- Reading is limited to the folders you allow. Files that look like secrets
  (password files, keys, credential stores) are always refused.
- Anything that changes something — on the PC or the phone — needs a human
  approval through Executive Guard first, and the spoke checks that approval
  on this PC before it acts.
- The pairing code or passphrase you type during setup is used once, inside
  the install, and is never stored.
- The spoke starts when you sign in to Windows. Uninstalling it removes the
  sign-in task and the pairing file.

The spoke's code is open: it ships from the public Helmian repository
(github.com/helmianlabs/helmian), and this installer is built from that
repository by its release workflow.
