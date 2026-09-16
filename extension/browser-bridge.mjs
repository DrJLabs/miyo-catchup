import { pageCollector } from './page-collector.mjs';
import { ProbeClientError } from './probe-client.mjs';

const RECORD = 't02_owned_document';
const OPENING = new WeakSet();

// These functions have no module closure: Chrome serializes the function.
function markDocument(marker) {
  if (location.origin !== 'https://chatgpt.com' || window !== window.top) return false;
  if (Object.hasOwn(globalThis, '__miyoT02Document')) return false;
  Object.defineProperty(globalThis, '__miyoT02Document', { value: marker });
  return true;
}
function checkDocument(marker) {
  return location.origin === 'https://chatgpt.com' && window === window.top
    && globalThis.__miyoT02Document === marker;
}

/**
 * Explicitly creates ONE inactive owned tab. No automatic startup or adoption
 * of existing tabs. Persistent ownership records block restart instead of
 * guessing whether a recycled tab number still belongs to this probe.
 * Call only after A2 authorization; tests inject a fully synthetic Chrome API.
 */
export async function openOwnedPage({ chromeApi, browserInstanceId,
  initialize, uuid = () => crypto.randomUUID(), timeoutMs = 30000 } = {}) {
  const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!validUuid.test(browserInstanceId) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 30000 || initialize?.operation !== 'initialize') {
    throw new ProbeClientError('invalid_probe_configuration');
  }
  if (OPENING.has(chromeApi)) throw new ProbeClientError('busy');
  OPENING.add(chromeApi);
  let previous;
  try { previous = await chromeApi.storage.local.get(RECORD); }
  catch { OPENING.delete(chromeApi); throw new ProbeClientError('qualification_required'); }
  if (Object.hasOwn(previous, RECORD)) throw new ProbeClientError('dispatch_uncertain');
  const marker = uuid();
  if (!validUuid.test(marker)) throw new ProbeClientError('invalid_probe_configuration');
  let tabId;
  let documentId;
  let lost = false;
  let calling = false;
  let settled = false;
  const record = { browser_instance_id: browserInstanceId, marker, state: 'opening' };
  // An interrupted creation must not let the next process create a second tab.
  await chromeApi.storage.local.set({ [RECORD]: record });
  const updated = (id, change) => {
    if (id === tabId && documentId && (change.status === 'loading' || change.url !== undefined)) lost = true;
  };
  const removed = (id) => { if (id === tabId) lost = true; };
  chromeApi.tabs.onUpdated.addListener(updated);
  chromeApi.tabs.onRemoved.addListener(removed);
  function detach() {
    chromeApi.tabs.onUpdated.removeListener(updated);
    chromeApi.tabs.onRemoved.removeListener(removed);
  }
  async function execute(func, args, bound = true) {
    if (lost) throw new ProbeClientError('document_lost');
    let timer;
    let results;
    try {
      results = await Promise.race([
        chromeApi.scripting.executeScript({
          target: bound ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
          world: 'MAIN', func, args,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => { lost = true; reject(new ProbeClientError('document_unavailable')); }, timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
    if (lost || !Array.isArray(results) || results.length !== 1 || results[0].frameId !== 0
      || typeof results[0].documentId !== 'string'
      || (bound && results[0].documentId !== documentId)) throw new ProbeClientError('document_lost');
    return results[0];
  }
  try {
    const tab = await chromeApi.tabs.create({ url: 'https://chatgpt.com/', active: false });
    if (!Number.isSafeInteger(tab.id) || tab.id < 0) throw new ProbeClientError('document_lost');
    tabId = tab.id;
    record.tab_id = tabId;
    await chromeApi.storage.local.set({ [RECORD]: { ...record } });
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chromeApi.tabs.onUpdated.removeListener(ready);
        chromeApi.tabs.onRemoved.removeListener(gone);
        if (error) reject(error); else resolve();
      };
      const ready = (id, change) => { if (id === tabId && change.status === 'complete') finish(); };
      const gone = (id) => { if (id === tabId) finish(new ProbeClientError('document_lost')); };
      const timer = setTimeout(() => finish(new ProbeClientError('document_unavailable')), timeoutMs);
      chromeApi.tabs.onUpdated.addListener(ready);
      chromeApi.tabs.onRemoved.addListener(gone);
      Promise.resolve(chromeApi.tabs.get(tabId)).then((current) => {
        if (current.status === 'complete') finish();
      }, () => finish(new ProbeClientError('document_lost')));
    });
    const marked = await execute(markDocument, [marker], false);
    if (marked.result !== true) throw new ProbeClientError('document_lost');
    documentId = marked.documentId;
    record.document_id = documentId;
    record.state = 'owned';
    await chromeApi.storage.local.set({ [RECORD]: { ...record } });
    const initial = await execute(pageCollector, [initialize]);
    if (initial.result?.ok !== true) throw new ProbeClientError('qualification_required');
    return {
      documentId,
      async call(command) {
        if (calling || settled) throw new ProbeClientError('probe_closed');
        calling = true;
        try {
          const checked = await execute(checkDocument, [marker]);
          if (checked.result !== true) { lost = true; throw new ProbeClientError('document_lost'); }
          return (await execute(pageCollector, [command])).result;
        } catch {
          lost = true;
          throw new ProbeClientError('document_lost');
        } finally { calling = false; }
      },
      async dispose() {
        if (settled) return;
        if (calling) throw new ProbeClientError('dispatch_uncertain');
        if (!lost) {
          try { await execute(pageCollector, [{ operation: 'abort' }]); } catch { lost = true; }
        }
        settled = true;
        detach();
        record.state = lost ? 'ownership_uncertain' : 'operator_cleanup_required';
        await chromeApi.storage.local.set({ [RECORD]: { ...record } });
        // Deliberately no tabs.remove: Chrome cannot close atomically by
        // documentId. The operator closes this qualification tab after checking
        // it. Navigation must never cause us to close a user's new document.
      },
    };
  } catch {
    detach();
    record.state = 'ownership_uncertain';
    await chromeApi.storage.local.set({ [RECORD]: { ...record } });
    throw new ProbeClientError('qualification_required');
  }
}
