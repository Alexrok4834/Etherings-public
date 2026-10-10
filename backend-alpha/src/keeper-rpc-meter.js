import { AsyncLocalStorage } from 'node:async_hooks';

// Temporary, opt-in measurement of the keeper process's actual HTTP RPC requests.
// The request body is inspected only for the JSON-RPC method and is never retained.
export function installKeeperRpcMeter({ rpcUrl, fetchImpl = globalThis.fetch }) {
  if (!rpcUrl || typeof fetchImpl !== 'function')
    throw new Error('Keeper RPC meter configuration missing');

  const previousFetch = globalThis.fetch;
  const phase = new AsyncLocalStorage();
  let counts = new Map();
  const record = (method, outcome) => {
    const key = `${phase.getStore() ?? 'setup'}|${method}|${outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const methods = body => {
    try {
      const payload = JSON.parse(body);
      const entries = Array.isArray(payload) ? payload : [payload];
      return entries.map(entry => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(entry?.method ?? '')
        ? entry.method : 'unknown');
    } catch {
      return ['unknown'];
    }
  };
  const wrappedFetch = async (input, init) => {
    if (String(input) !== rpcUrl) return fetchImpl(input, init);
    const calledMethods = methods(init?.body);
    try {
      const response = await fetchImpl(input, init);
      for (const method of calledMethods) record(method, String(response.status));
      return response;
    } catch (error) {
      for (const method of calledMethods) record(method, 'network-error');
      throw error;
    }
  };
  globalThis.fetch = wrappedFetch;

  return {
    measure(name, task) { return phase.run(name, task); },
    snapshotAndReset() {
      const snapshot = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
      counts = new Map();
      return snapshot;
    },
    uninstall() {
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = previousFetch;
    },
  };
}
