// This module is deliberately public-safe. A private qualification package may
// replace `setupConfig` with a reviewed, operator-approved configuration and
// explicitly enable the separately approved startup-only diagnostic;
// identifiers and account bindings must never be committed here.
export const SETUP_ADAPTER_ID = 'chatgpt-setup-2026-09-16';
export const SETUP_CONTRACT_FINGERPRINT =
  'f3b380f89c3413a8e9f88d4dd988786adb91893d5d796cd835f3aa5066a5e64a';
export const BACKGROUND_SETUP_ADAPTER_ID = 'chatgpt-background-setup-2026-09-16';
export const BACKGROUND_SETUP_CONTRACT_FINGERPRINT =
  'eadb4f000ea3729d63581afb54fdc7a5d1dcf1855902ecd95a9a5b255047664d';

// The public package has no configured account, context, conversation, or
// browser instance. Keeping this undefined also leaves capture disabled.
export const setupConfig = undefined;
export const backgroundSetupConfig = undefined;
export const startupDiagnosticEnabled = false;
export const startupDiagnosticRevision = 1;

// The setup adapter is narrowly allow-listed. It can only be selected by a
// setup-inspection config; the controller rejects this entry for body probes.
export const setupReviewedAdapters = new Map([[SETUP_ADAPTER_ID, {
  reviewed: true,
  adapter_id: SETUP_ADAPTER_ID,
  contract_fingerprint: SETUP_CONTRACT_FINGERPRINT,
  scope: 'setup-inspection',
}], [BACKGROUND_SETUP_ADAPTER_ID, {
  reviewed: true,
  adapter_id: BACKGROUND_SETUP_ADAPTER_ID,
  contract_fingerprint: BACKGROUND_SETUP_CONTRACT_FINGERPRINT,
  scope: 'background-setup-inspection',
}]]);
