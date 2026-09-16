import { createProbeController } from './probe-controller.mjs';
import { setupConfig, backgroundSetupConfig, setupReviewedAdapters, startupDiagnosticEnabled,
  startupDiagnosticRevision, backgroundSelectedConfig, backgroundSelectedReviewedAdapters } from './qualification-config.mjs';

// Service-worker startup only installs a message handler. It never creates a
// native port, tab, alarm, or probe. There is no alarm listener in T02.
export function installBackground(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.onMessage?.addListener) throw new Error('chrome_runtime_unavailable');
  const controller = createProbeController({ chromeApi, config: setupConfig,
    reviewedAdapters: setupReviewedAdapters, startupDiagnosticEnabled, startupDiagnosticRevision });
  const backgroundController = createProbeController({ chromeApi, config: backgroundSetupConfig,
    reviewedAdapters: setupReviewedAdapters, backgroundOnly: true });
  const selectedController = createProbeController({ chromeApi, config: backgroundSelectedConfig,
    reviewedAdapters: backgroundSelectedReviewedAdapters, selectedOnly: true });
  const listener = (message, sender, sendResponse) => {
    const target = ['selected_status', 'fetch_selected_conversation'].includes(message?.type)
      ? selectedController : ['background_status', 'inspect_background_session'].includes(message?.type)
      ? backgroundController : controller;
    target.handleMessage(message, sender).then(sendResponse, () => sendResponse({
      state: 'uncertain', reason_code: 'storage_unavailable', can_start: false,
      configured: false, qualification_ready: false,
    }));
    return true;
  };
  chromeApi.runtime.onMessage.addListener(listener);
  return { controller, backgroundController, selectedController, listener };
}

if (globalThis.chrome?.runtime?.onMessage?.addListener) installBackground(globalThis.chrome);
