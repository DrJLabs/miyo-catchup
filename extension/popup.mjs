const labels = new Map([
  ['unconfigured', 'Private qualification is not configured.'],
  ['ready', 'A reviewed private qualification is ready to start.'],
  ['setup_ready', 'A reviewed signed-in session inspection is ready to run.'],
  ['blocked', 'Qualification is blocked and requires operator review.'],
  ['starting', 'Starting the selected qualification probe…'],
  ['running', 'The selected qualification probe is running.'],
  ['probe_complete', 'The selected probe completed in private staging.'],
  ['setup_inspection_complete', 'The signed-in session inspection completed in private staging.'],
  ['failed', 'The selected probe failed with a recorded bounded result.'],
  ['uncertain', 'The last probe is uncertain and requires operator review.'],
]);
const diagnosticLabels = new Map([
  ['page_tab_failed', 'Startup stopped while creating the qualification tab.'],
  ['page_load_failed', 'Startup stopped while waiting for the qualification page to load.'],
  ['page_binding_failed', 'Startup could not bind the qualification page document.'],
  ['page_initialization_failed', 'Collector initialization failed; this saved result does not distinguish the cause.'],
  ['page_script_rejected', 'Chrome rejected the collector script call.'],
  ['page_script_timeout', 'Chrome did not finish the collector script call before the deadline.'],
  ['page_document_changed', 'The qualification page changed before startup finished.'],
  ['page_result_invalid', 'Chrome returned an unusable collector result.'],
  ['page_result_missing', 'Chrome returned no collector result.'],
  ['page_collector_rejected', 'The collector rejected its initialization command.'],
  ['page_collector_closed', 'The collector was already closed.'],
  ['page_context_unavailable', 'Page setup could not establish an unambiguous account context.'],
  ['page_storage_failed', 'Startup could not safely read or save local ownership evidence.'],
  ['legacy_before_tab_recorded', 'Saved milestone: no tab was recorded. The original startup error is unavailable.'],
  ['legacy_before_document_binding', 'Saved milestone: a tab was created, but no document was bound. The original startup error is unavailable.'],
  ['legacy_after_document_binding', 'Saved milestone: the page document was bound. The original startup error is unavailable.'],
]);
const statusNode = document.querySelector('#status');
const startNode = document.querySelector('#start');
const inspectNode = document.querySelector('#inspect-session');
const inspectBackgroundNode = document.querySelector('#inspect-background-session');
const diagnoseNode = document.querySelector('#diagnose-startup');
const checkNode = document.querySelector('#check-connection');
const connectionNode = document.querySelector('#connection-status');
const startupNode = document.querySelector('#startup-diagnostic-status');
const backgroundNode = document.querySelector('#background-status');
const connectionLabels = new Map([
  ['passed', 'Local connection check passed. Capture is still disabled.'],
  ['unavailable', 'Local connection is unavailable. Ask the operator to check the foreground receiver.'],
  ['incompatible', 'The local endpoint did not match the capture-disabled connection check.'],
  ['busy', 'Another local action is in progress.'],
  ['invalid_message', 'The local connection check was not accepted.'],
]);
let busy = false;
let canStart = false;
let canInspect = false;
let canInspectBackground = false;
let canDiagnose = false;
let startupRevision = 1;

const startupLabels = new Map([
  ['diagnostic_disabled', 'Startup diagnosis is disabled.'],
  ['configuration_required', 'Startup diagnosis needs an explicit private configuration.'],
  ['qualification_required', 'Startup diagnosis is unavailable until qualification is configured.'],
  ['prior_attempt_required', 'Startup diagnosis is locked until the prior attempt is reviewed.'],
  ['prior_diagnostic_required', 'Startup diagnosis is locked because the failed prior diagnostic requires review.'],
  ['page_tab_failed', 'Startup stopped while creating the qualification tab.'],
  ['page_load_failed', 'Startup stopped while waiting for the qualification page to load.'],
  ['page_binding_failed', 'Startup could not bind the qualification page document.'],
  ['page_initialization_failed', 'Collector initialization failed; this saved result does not distinguish the cause.'],
  ['page_script_rejected', 'Chrome rejected the collector script call.'],
  ['page_script_timeout', 'Chrome did not finish the collector script call before the deadline.'],
  ['page_document_changed', 'The qualification page changed before startup finished.'],
  ['page_result_invalid', 'Chrome returned an unusable collector result.'],
  ['page_result_missing', 'Chrome returned no collector result.'],
  ['page_collector_rejected', 'The collector rejected its initialization command.'],
  ['page_collector_closed', 'The collector was already closed.'],
  ['page_context_unavailable', 'Page setup could not establish an unambiguous account context.'],
  ['page_storage_failed', 'Startup could not safely read or save local ownership evidence.'],
  ['storage_unavailable', 'Startup diagnosis could not read local state safely.'],
  ['dispatch_uncertain', 'Startup diagnosis is uncertain and requires operator review.'],
  ['document_lost', 'Startup lost ownership of the qualification document.'],
  ['busy', 'Another local action is in progress.'],
  ['invalid_message', 'The startup diagnosis request was not accepted.'],
  ['none', 'Startup diagnosis is ready.'],
  ['startup_complete', 'Startup diagnosis passed initialization only. No session or conversation was fetched, and qualification remains locked.'],
]);
const startupStates = new Set(['disabled', 'ready', 'running', 'passed', 'blocked', 'uncertain']);
const backgroundStates = new Set(['unconfigured', 'ready', 'starting', 'running', 'blocked',
  'failed', 'uncertain', 'background_setup_inspection_complete']);
const backgroundLabels = new Map([
  ['disabled', 'Background session inspection is disabled.'],
  ['configuration_required', 'Background session inspection is not configured.'],
  ['qualification_required', 'Background session inspection is unavailable until qualification is configured.'],
  ['native_unavailable', 'Background session inspection could not reach the local worker.'],
  ['probe_failed', 'The background session inspection failed with a bounded result.'],
  ['dispatch_uncertain', 'Background session inspection is uncertain and requires operator review.'],
  ['document_lost', 'Background session inspection lost its execution context.'],
  ['storage_unavailable', 'Background session inspection could not read local state safely.'],
  ['invalid_message', 'The background session inspection request was not accepted.'],
  ['busy', 'Another local action is in progress.'],
  ['background_setup_inspection_complete', 'Background session inspection completed. One session request was made; no conversation was fetched.'],
]);

function startupText(state, reason, revision = 1) {
  if (state === 'ready') return revision === 2
    ? 'Startup diagnosis v2 is ready. Prior attempts stay locked.' : startupLabels.get('none');
  if (state === 'running') return 'Startup diagnosis is running. A normal site load may occur; no collector fetch is issued.';
  if (state === 'passed') return startupLabels.get('startup_complete');
  if (state === 'disabled') return startupLabels.get('diagnostic_disabled');
  if (state === 'uncertain') return startupLabels.get(reason) ?? startupLabels.get('dispatch_uncertain');
  return startupLabels.get(reason) ?? 'Startup diagnosis is blocked and requires operator review.';
}

function controls() {
  startNode.disabled = busy || !canStart;
  if (inspectNode) inspectNode.disabled = busy || !canInspect;
  if (inspectBackgroundNode) inspectBackgroundNode.disabled = busy || !canInspectBackground;
  if (diagnoseNode) diagnoseNode.disabled = busy || !canDiagnose;
  checkNode.disabled = busy;
}

function render(value) {
  const safe = value && typeof value === 'object' ? value : { state: 'uncertain', can_start: false };
  const state = labels.has(safe.state) ? safe.state : 'uncertain';
  statusNode.textContent = safe.scope === 'setup-inspection' && state === 'ready'
    ? labels.get('setup_ready') : labels.get(state);
  if (state === 'blocked') {
    const diagnostic = diagnosticLabels.get(safe.diagnostic_code) ?? diagnosticLabels.get(safe.reason_code);
    if (diagnostic) statusNode.textContent = `${diagnostic} This attempt remains locked; do not retry.`;
  }
  canStart = safe.state === 'ready' && safe.can_start === true;
  canInspect = safe.state === 'ready' && safe.can_inspect === true && safe.scope === 'setup-inspection';
  controls();
}

async function message(value) {
  try {
    const result = await chrome.runtime.sendMessage(value);
    render(result);
  } catch {
    render({ state: 'uncertain', can_start: false });
  }
}

function renderStartup(value) {
  const safe = value && typeof value === 'object' ? value : {};
  let state = startupStates.has(safe.state) ? safe.state : 'uncertain';
  let reason = typeof safe.reason_code === 'string' ? safe.reason_code : 'dispatch_uncertain';
  const legacyRevision = safe.revision === undefined;
  const revision = safe.revision === 2 ? 2 : 1;
  const validRevision = legacyRevision || safe.revision === 2;
  // The state/reason pair is a closed UI contract. A permissive combination
  // must not make a forged ready response actionable or hide a mismatch.
  const compatible = (state === 'ready' && reason === 'none')
    || (state === 'passed' && reason === 'startup_complete')
    || (state === 'disabled' && reason === 'diagnostic_disabled')
    || (state === 'running')
    || (state === 'blocked')
    || (state === 'uncertain');
  if (!validRevision || !compatible) { state = 'uncertain'; reason = 'dispatch_uncertain'; }
  startupRevision = validRevision ? revision : 1;
  if (diagnoseNode) diagnoseNode.textContent = startupRevision === 2
    ? 'Diagnose startup v2 (no fetch)' : 'Diagnose startup (no fetch)';
  if (startupNode) startupNode.textContent = startupText(state, reason, startupRevision);
  canDiagnose = state === 'ready' && safe.can_run === true;
  controls();
}

async function startupMessage(value) {
  try {
    const result = await chrome.runtime.sendMessage(value);
    if (result?.type !== 'startup_diagnostic') throw new Error('invalid_startup_reply');
    renderStartup(result);
  } catch {
    renderStartup({ type: 'startup_diagnostic', state: 'uncertain', reason_code: 'dispatch_uncertain', can_run: false });
  }
}

function renderBackground(value) {
  const safe = value && typeof value === 'object' ? value : {};
  let state = backgroundStates.has(safe.state) ? safe.state : 'blocked';
  let reason = typeof safe.reason_code === 'string' ? safe.reason_code : 'qualification_required';
  const exactReady = state === 'ready' && safe.scope === 'background-setup-inspection'
    && safe.can_inspect_background === true;
  const complete = state === 'background_setup_inspection_complete'
    && reason === 'background_setup_inspection_complete';
  if (state === 'ready' && !exactReady) {
    state = 'blocked';
    reason = 'qualification_required';
  }
  if (complete) {
    if (backgroundNode) backgroundNode.textContent = backgroundLabels.get('background_setup_inspection_complete');
    canInspectBackground = false;
    controls();
    return;
  }
  if (state === 'starting' || state === 'running') {
    if (backgroundNode) backgroundNode.textContent = 'Background session inspection is running. It makes one authenticated session request; no conversation will be fetched.';
    canInspectBackground = false;
    controls();
    return;
  }
  if (state === 'ready') {
    if (backgroundNode) backgroundNode.textContent = 'Background session inspection is ready. It will make one authenticated session request; no conversation will be fetched.';
    canInspectBackground = true;
  } else {
    if (backgroundNode) backgroundNode.textContent = backgroundLabels.get(reason)
      ?? 'Background session inspection is unavailable and requires operator review.';
    canInspectBackground = false;
  }
  controls();
}

async function backgroundMessage(value) {
  try {
    const result = await chrome.runtime.sendMessage(value);
    renderBackground(result);
  } catch {
    renderBackground({ state: 'uncertain', reason_code: 'dispatch_uncertain' });
  }
}

startNode.addEventListener('click', (event) => {
  if (!event.isTrusted || busy || !canStart) return;
  busy = true;
  controls();
  void message({ type: 'start', user_gesture: true }).finally(() => { busy = false; controls(); });
});
if (inspectNode) inspectNode.addEventListener('click', (event) => {
  if (!event.isTrusted || busy || !canInspect) return;
  busy = true;
  controls();
  void message({ type: 'inspect_session', user_gesture: true }).finally(() => { busy = false; controls(); });
});
if (inspectBackgroundNode) inspectBackgroundNode.addEventListener('click', (event) => {
  if (!event.isTrusted || busy || !canInspectBackground) return;
  busy = true;
  controls();
  void backgroundMessage({ type: 'inspect_background_session', user_gesture: true })
    .finally(() => { busy = false; controls(); });
});
if (diagnoseNode) diagnoseNode.addEventListener('click', (event) => {
  if (!event.isTrusted || busy || !canDiagnose) return;
  busy = true;
  controls();
  void startupMessage({ type: 'diagnose_startup', user_gesture: true })
    .finally(() => { busy = false; controls(); });
});
checkNode.addEventListener('click', (event) => {
  if (!event.isTrusted || busy) return;
  busy = true;
  controls();
  connectionNode.textContent = 'Checking the local connection…';
  void (async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'check_connection', user_gesture: true });
      connectionNode.textContent = result?.type === 'connection_check' && connectionLabels.has(result.state)
        ? connectionLabels.get(result.state) : connectionLabels.get('incompatible');
    } catch {
      connectionNode.textContent = connectionLabels.get('unavailable');
    } finally {
      busy = false;
      controls();
    }
  })();
});
void message({ type: 'status' });
void backgroundMessage({ type: 'background_status' });
void startupMessage({ type: 'startup_status' });
