import { serialize } from 'node:v8';

// One display request only. Never pass this client to step settlement or writes.
export async function withM2eDisplayRpc(source, read, { timeoutMs = 29_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Display read timed out')), timeoutMs);
  const cache = new Map();
  let bytes = 0;
  let queue = [];
  const allowed = new Set(['getGenesisHash', 'getAccountInfo', 'getMultipleAccounts',
    'getTokenAccountsByOwner', 'getSlot', 'getBlockTime']);
  const keyOf = (method, args) => method + serialize(args).toString('base64');
  const optionsSafe = options => options?.commitment === 'finalized' &&
    ['base64', 'jsonParsed'].includes(options.encoding) &&
    Object.keys(options).every(key => ['commitment', 'encoding'].includes(key));
  async function send(method, args) {
    controller.signal.throwIfAborted();
    return source[method](...args).send({ abortSignal: controller.signal });
  }
  function remember(key, value) {
    if (cache.has(key) || cache.size >= 256) return;
    const size = serialize(value).byteLength;
    if (size > 512 * 1024 || bytes + size > 8 * 1024 * 1024) return;
    bytes += size;
    cache.set(key, structuredClone(value));
  }
  async function flush() {
    const batch = queue; queue = [];
    const groups = new Map();
    for (const item of batch) {
      const key = keyOf('options', [item.args[1]]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const group of groups.values()) for (let start = 0; start < group.length; start += 100) {
      const chunk = group.slice(start, start + 100);
      try {
        const result = await send('getMultipleAccounts', [chunk.map(x => x.args[0]), chunk[0].args[1]]);
        if (!Array.isArray(result.value) || result.value.length !== chunk.length || !result.context)
          throw new Error('Incomplete display accounts');
        chunk.forEach((item, i) => item.resolve({ context: result.context, value: result.value[i] }));
      } catch (error) { chunk.forEach(item => item.reject(error)); }
    }
  }
  const pending = new Map();
  const rpc = new Proxy(Object.create(null), { get(_, method) {
    if (method === 'then' || typeof method !== 'string') return undefined;
    return (...args) => ({ async send() {
      controller.signal.throwIfAborted();
      if (!allowed.has(method)) throw new Error('Unsupported M2E display RPC');
      const memo = method === 'getGenesisHash' ||
        (['getAccountInfo', 'getMultipleAccounts'].includes(method) && optionsSafe(args[1])) ||
        (method === 'getTokenAccountsByOwner' && optionsSafe(args[2]));
      const key = keyOf(method, args);
      if (memo && cache.has(key)) return structuredClone(cache.get(key));
      if (memo && pending.has(key)) return structuredClone(await pending.get(key));
      const task = method === 'getAccountInfo' && optionsSafe(args[1])
        ? new Promise((resolve, reject) => { queue.push({ args, resolve, reject }); if (queue.length === 1) queueMicrotask(flush); })
        : send(method, args);
      if (memo && pending.size < 256) pending.set(key, task);
      try {
        const result = await task;
        if (method === 'getMultipleAccounts' && optionsSafe(args[1])) {
          if (!Array.isArray(result.value) || result.value.length !== args[0].length || !result.context)
            throw new Error('Incomplete display accounts');
          args[0].forEach((account, i) => remember(keyOf('getAccountInfo', [account, args[1]]),
            { context: result.context, value: result.value[i] }));
        }
        if (memo) remember(key, result);
        return structuredClone(result);
      } finally { if (pending.get(key) === task) pending.delete(key); }
    } });
  } });
  try { return await read(rpc); }
  finally { clearTimeout(timer); controller.abort(); cache.clear(); pending.clear(); }
}
