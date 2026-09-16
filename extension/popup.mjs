const labels = new Map([
  ['unconfigured', 'Private qualification is not configured.'],
  ['ready', 'A reviewed private qualification is ready to start.'],
  ['setup_ready', 'A reviewed signed-in session inspection is ready to run.'],
  ['blocked', 'Qualification is blocked until a reviewed adapter is configured.'],
  ['starting', 'Starting the selected qualification probe…'],
  ['running', 'The selected qualification probe is running.'],
  ['probe_complete', 'The selected probe completed in private staging.'],
  ['setup_inspection_complete', 'The signed-in session inspection completed in private staging.'],
  ['failed', 'The selected probe failed with a recorded bounded result.'],
  ['uncertain', 'The last probe is uncertain and requires operator review.'],
]);
const statusNode = document.querySelector('#status');
const startNode = document.querySelector('#start');
const inspectNode = document.querySelector('#inspect-session');
const checkNode = document.querySelector('#check-connection');
const connectionNode = document.querySelector('#connection-status');
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

function controls() {
  startNode.disabled = busy || !canStart;
  if (inspectNode) inspectNode.disabled = busy || !canInspect;
  checkNode.disabled = busy;
}

function render(value) {
  const safe = value && typeof value === 'object' ? value : { state: 'uncertain', can_start: false };
  const state = labels.has(safe.state) ? safe.state : 'uncertain';
  statusNode.textContent = safe.scope === 'setup-inspection' && state === 'ready'
    ? labels.get('setup_ready') : labels.get(state);
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
