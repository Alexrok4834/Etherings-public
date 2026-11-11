import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();
const routes = new Set(['/wallet/assets', '/wallet/balances', '/silver/inventory', '/m2e/today', '/ring/equipment']);
const labels = new Set(['m2e_db', 'm2e_capacity', 'm2e_owned_rings', 'm2e_eligibility', 'm2e_listing', 'auth', 'binding', 'inventory', 'listings', 'shared_wait', 'snapshot_check', 'snapshot_rebuild',
  'rpc.getGenesisHash', 'rpc.getAccountInfo', 'rpc.getMultipleAccounts', 'rpc.getTokenAccountsByOwner', 'rpc.getBalance']);

// Fixed labels only: never record arguments, identities, URLs or error messages.
export async function timeDisplay(label, read) {
  const trace = scope.getStore();
  if (!trace || trace.done || !labels.has(label)) return read();
  const started = performance.now();
  let failed = false;
  try { return await read(); }
  catch (error) { failed = true; throw error; }
  finally {
    if (!trace.done) {
      const metric = trace.stages[label] ??= { calls: 0, ms: 0, failures: 0 };
      metric.calls++;
      metric.ms += performance.now() - started;
      if (failed) metric.failures++;
    }
  }
}

export function displayTimingHandler(handler, { enabled = false,
  emit = record => console.info(JSON.stringify(record)), now = Date.now } = {}) {
  let windowStart = now(), emitted = 0;
  return function(request, response) {
    const route = request.url?.split('?')[0];
    if (!enabled || request.method !== 'GET' || !routes.has(route)) return handler(request, response);
    const current = now();
    if (current - windowStart >= 60_000 || current < windowStart) { windowStart = current; emitted = 0; }
    if (emitted >= 60) return handler(request, response);
    emitted++;
    const trace = { done: false, stages: Object.create(null) };
    const started = performance.now();
    const finish = () => {
      if (trace.done) return;
      trace.done = true;
      const stages = Object.fromEntries(Object.entries(trace.stages).map(([key, value]) =>
        [key, { ...value, ms: Math.round(value.ms * 10) / 10 }]));
      try { emit({ event: 'display_timing', route, status: response.statusCode,
        completed: response.writableFinished === true,
        ...(route === '/m2e/today' ? { displayOnly: new URL(request.url, 'http://localhost').searchParams.get('displayOnly') === 'true' } : {}),
        totalMs: Math.round((performance.now() - started) * 10) / 10, stages }); }
      catch { /* Diagnostics must never change the response. */ }
      response.removeListener('finish', finish);
      response.removeListener('close', finish);
    };
    response.once('finish', finish);
    response.once('close', finish);
    return scope.run(trace, () => handler(request, response));
  };
}
