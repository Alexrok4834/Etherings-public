// Routes an entire authenticated read response. Never use for transaction paths.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createSolanaRpc } from '@solana/kit';

const MODES = new Set(['primary', 'primary-failover', 'offload', 'offload-failover']);
export const READ_TOTAL_TIMEOUT_MS = 29_000;
export const READ_FIRST_ATTEMPT_TIMEOUT_MS = 12_000;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET']);

export function readRouteMode(value) {
  const mode = value ?? 'primary';
  if (!MODES.has(mode)) throw new Error('Invalid read-only RPC mode');
  return mode;
}

export function retryableRpcFailure(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === 'object' && !seen.has(current);
    current = current.cause) {
    seen.add(current);
    const status = Number(current.statusCode ?? current.status ??
      current.context?.statusCode ?? current.context?.status);
    if (status === 429 || (status >= 500 && status <= 599)) return true;
    if (status === 403) {
      const detail = String(current.context?.responseBody ?? current.context?.body ??
        current.response?.body ?? current.context?.message ?? current.message ?? '')
        .toLowerCase();
      return /(?:quota|monthly limit|compute unit|credits?)\s*(?:exceeded|exhausted|limit|used up|reached)/
        .test(detail) || /(?:exceeded|exhausted|reached)\s*(?:quota|monthly limit|compute unit|credits?)/
        .test(detail);
    }
    if (NETWORK_CODES.has(current.code)) return true;
  }
  return false;
}

export function createReadOnlyRpcScope() {
  return new AsyncLocalStorage();
}

// Each attempt gets its own Solana Kit client and AbortSignal. A stopped attempt
// cannot start more RPC calls, even if an unrelated DB read finishes later.
export function createScopedReadRpc(url, scope, createRpc = createSolanaRpc) {
  if (!url || typeof scope?.getStore !== 'function')
    throw new Error('Invalid scoped read RPC');
  return new Proxy(Object.create(null), {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      return (...args) => {
        const context = scope.getStore();
        if (!context) throw new Error('Read RPC outside bounded attempt');
        context.signal.throwIfAborted();
        let rpc = context.rpcClients.get(url);
        if (!rpc) {
          rpc = createRpc(url);
          context.rpcClients.set(url, rpc);
        }
        const request = rpc[method](...args);
        return { send(options = {}) {
          context.signal.throwIfAborted();
          return request.send({ ...options, abortSignal: context.signal });
        } };
      };
    },
  });
}

const timeoutError = () => Object.assign(new Error('Asset read provider timed out'),
  { code: 'ETIMEDOUT' });

async function boundedAttempt(scope, read, args, timeoutMs) {
  const controller = new AbortController();
  const context = { signal: controller.signal, rpcClients: new Map() };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([scope.run(context, () => read(...args)), deadline]);
  } catch (error) {
    // A sibling RPC from Promise.all must not remain active after one fails.
    if (!controller.signal.aborted) controller.abort(error);
    if (controller.signal.reason?.code === 'ETIMEDOUT') throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

export function createReadOnlyRpcRoute({ primary, alternative = null, mode = 'primary',
  scope = null, totalTimeoutMs = READ_TOTAL_TIMEOUT_MS,
  firstAttemptTimeoutMs = READ_FIRST_ATTEMPT_TIMEOUT_MS }) {
  mode = readRouteMode(mode);
  if (typeof primary !== 'function' || (mode !== 'primary' &&
      typeof alternative !== 'function')) throw new Error('Incomplete read-only RPC route');
  if (mode !== 'primary' && (typeof scope?.run !== 'function' ||
      !Number.isInteger(firstAttemptTimeoutMs) || firstAttemptTimeoutMs < 1 ||
      !Number.isInteger(totalTimeoutMs) || totalTimeoutMs <= firstAttemptTimeoutMs ||
      totalTimeoutMs > READ_TOTAL_TIMEOUT_MS))
    throw new Error('Invalid bounded read-only RPC route');
  const offload = mode.startsWith('offload');
  const failover = mode.endsWith('failover');
  return async (...args) => {
    const selected = offload ? alternative : primary;
    if (mode === 'primary') return selected(...args);
    const started = Date.now();
    try {
      return await boundedAttempt(scope, selected, args,
        failover ? firstAttemptTimeoutMs : totalTimeoutMs);
    } catch (error) {
      if (!failover || !retryableRpcFailure(error)) throw error;
      const other = offload ? primary : alternative;
      const remaining = totalTimeoutMs - (Date.now() - started);
      if (remaining <= 0)
        return { status: 503, body: { message: 'Asset data temporarily unavailable.' } };
      try {
        return await boundedAttempt(scope, other, args, remaining);
      } catch (secondError) {
        if (!retryableRpcFailure(secondError)) throw secondError;
        return { status: 503, body: { message: 'Asset data temporarily unavailable.' } };
      }
    }
  };
}
