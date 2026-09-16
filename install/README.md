# Installation boundary

Reserved for explicit versioned installation, extension/native-host pairing and
uninstall helpers. No installer exists or runs as a package lifecycle hook.

Changes must target only owned release/unit/registration paths and preserve
existing Miyo Capture, log maintenance and private recovery state. Follow the
[installation and rollback contract](../docs/implementation-plan.md).
