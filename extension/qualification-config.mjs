// This module is deliberately public-safe. A private qualification package may
// replace only `setupConfig` with a reviewed, operator-approved configuration;
// identifiers and account bindings must never be committed here.
export const SETUP_ADAPTER_ID = 'chatgpt-setup-2026-09-16';
export const SETUP_CONTRACT_FINGERPRINT =
  'f3b380f89c3413a8e9f88d4dd988786adb91893d5d796cd835f3aa5066a5e64a';

// The public package has no configured account, context, conversation, or
// browser instance. Keeping this undefined also leaves capture disabled.
export const setupConfig = undefined;

// The setup adapter is narrowly allow-listed. It can only be selected by a
// setup-inspection config; the controller rejects this entry for body probes.
export const setupReviewedAdapters = new Map([[SETUP_ADAPTER_ID, {
  reviewed: true,
  adapter_id: SETUP_ADAPTER_ID,
  contract_fingerprint: SETUP_CONTRACT_FINGERPRINT,
  scope: 'setup-inspection',
}]]);
