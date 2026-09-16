# Installation boundary

`native-host-launcher.mjs` renders a shell launcher that pins absolute Node,
entry-module and private-configuration paths and forwards Chrome's caller origin.
It only returns text: it does not install, register, spawn, or overwrite anything.
No installer exists or runs as a package lifecycle hook.

The target `src/native-host-entry.mjs` accepts exactly the pinned configuration
path and Chrome origin, requires Node 22.23.2, and connects only to the configured
private Unix socket. Its local JSON configuration has exactly `version` (1),
`extension_id` (32 lowercase letters a–p), and `socket_path` (canonical absolute
path). Configuration is bounded to 16 KiB, owner-only 0600 in a 0700 directory,
with full ancestor/type/link checks; there is no home-path fallback or wire path
override. This is transport configuration, not capture or identity approval.

Pairing still requires a reviewed, immutable release, validated executable/source
ownership, the exact extension ID, and the qualified foreground receiver. A
rendered launcher is not a registered host or a successful Chrome proof.

For the narrower local connection check, the foreground entry is
`src/connection-check-entry.mjs` with one explicit native-host configuration path.
It runs only from a reviewed private snapshot, reuses the existing configuration
shape, holds a verified OS lock, and expires after ten minutes. It serves only
global `get_status`; it cannot replace the qualified session/body receiver.
The native bridge never starts this endpoint. Private registration/readback and
the operator's local-status check evidence are tracked in the canonical checkpoint, not
implied by this source or an automated installation hook.

Changes must target only owned release/unit/registration paths and preserve
existing Miyo Capture, log maintenance and private recovery state. Follow the
[installation and rollback contract](../docs/implementation-plan.md).
