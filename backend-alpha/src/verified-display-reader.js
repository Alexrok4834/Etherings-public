import { timeDisplay } from './display-timing.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';

// For a dedicated DISPLAY reader only. Auth, DB projections, balances, listing
// checks and operation preflights remain outside this memo. A hit always reads
// the actual finalized dependencies again; elapsed time alone never permits reuse.
const METHODS = new Set(['listOwnedAssets', 'readFinalized', 'readRingForIssuance',
  'readOpeningInventory', 'readBoxMedia']);
const MAX_ENTRIES = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_DEPENDENCIES = 256;
const RETAIN_MS = 5 * 60_000;
const slotOf = response => {
  const slot = response?.context?.slot;
  if (typeof slot === 'bigint' && slot >= 0n) return slot;
  if (Number.isSafeInteger(slot) && slot >= 0) return BigInt(slot);
  throw new Error('Invalid finalized display context');
};
const accountOptions = options => options?.commitment === 'finalized' &&
  ['base64', 'jsonParsed'].includes(options.encoding) &&
  Object.keys(options).every(key => ['commitment', 'encoding'].includes(key));

export function createVerifiedDisplayReader({ rpc, createReader, now = Date.now }) {
  const scope = new AsyncLocalStorage();
  const entries = new Map();
  let retainedBytes = 0;
  const remove = key => {
    const entry = entries.get(key);
    if (entry) retainedBytes -= entry.bytes;
    entries.delete(key);
  };
  function remember(map, key, value, trace) {
    if (map.has(key) && !isDeepStrictEqual(map.get(key), value)) trace.safe = false;
    else map.set(key, structuredClone(value));
    if (trace.accounts.size + trace.queries.size > MAX_DEPENDENCIES) trace.safe = false;
  }
  function record(trace, method, args, response) {
    if (method === 'getGenesisHash') {
      if (typeof response !== 'string' || (trace.genesis && trace.genesis !== response))
        trace.safe = false;
      trace.genesis = response;
      return;
    }
    const slot = slotOf(response);
    if (slot > trace.slot) trace.slot = slot;
    if (method === 'getAccountInfo' && accountOptions(args[1])) {
      if (response.value === undefined) throw new Error('Missing account');
      remember(trace.accounts, JSON.stringify([args[0], args[1].encoding]), response.value, trace);
    } else if (method === 'getMultipleAccounts' && accountOptions(args[1])) {
      if (!Array.isArray(response.value) || response.value.length !== args[0].length)
        throw new Error('Incomplete accounts');
      args[0].forEach((key, index) => remember(trace.accounts,
        JSON.stringify([key, args[1].encoding]), response.value[index], trace));
    } else if (method === 'getTokenAccountsByOwner' &&
        args[2]?.commitment === 'finalized' && args[2]?.encoding === 'jsonParsed' &&
        Object.keys(args[2]).every(key => ['commitment', 'encoding'].includes(key))) {
      if (!Array.isArray(response.value)) throw new Error('Incomplete owner discovery');
      remember(trace.queries, JSON.stringify(args), response.value, trace);
    } else trace.safe = false; // New/unsupported RPC semantics cannot silently become cached.
  }
  const recordingRpc = new Proxy(Object.create(null), {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      return (...args) => ({ async send(...options) {
        const trace = scope.getStore();
        try {
          const response = await rpc[method](...args).send(...options);
          if (trace) {
            try { record(trace, method, args, response); }
            catch { trace.safe = false; }
          }
          return response;
        } catch (error) {
          if (trace) trace.safe = false; // Includes errors swallowed by legacy readers.
          throw error;
        }
      } });
    },
  });
  const reader = createReader(recordingRpc);

  async function unchanged(entry) {
    // Same RPC instance/provider and chain pin. Provider errors propagate, never
    // return old data. Scoped RPC's AbortSignal also applies to these requests.
    if (await rpc.getGenesisHash().send() !== entry.trace.genesis)
      throw new Error('Display reader cluster mismatch');
    let minContextSlot = entry.trace.slot;
    for (const [query, previous] of entry.trace.queries) {
      const args = JSON.parse(query);
      args[2] = { ...args[2], minContextSlot };
      const response = await rpc.getTokenAccountsByOwner(...args).send();
      const slot = slotOf(response);
      if (slot < minContextSlot || !Array.isArray(response.value))
        throw new Error('Incomplete finalized owner discovery');
      if (!isDeepStrictEqual(response.value, previous)) return false;
      minContextSlot = slot;
    }
    // Parsed mint reads and byte-exact program-state reads are different
    // dependencies. Preserve both encodings, even for the same address.
    for (const encoding of ['base64', 'jsonParsed']) {
      const accounts = [...entry.trace.accounts].map(([key, value]) => [JSON.parse(key), value])
        .filter(([[, format]]) => format === encoding);
      for (let offset = 0; offset < accounts.length; offset += 100) {
        const batch = accounts.slice(offset, offset + 100);
        const response = await rpc.getMultipleAccounts(batch.map(([[key]]) => key),
          { commitment: 'finalized', encoding, minContextSlot }).send();
        const slot = slotOf(response);
        if (slot < minContextSlot || !Array.isArray(response.value) ||
            response.value.length !== batch.length)
          throw new Error('Incomplete finalized display accounts');
        if (batch.some(([, previous], index) =>
          !isDeepStrictEqual(previous, response.value[index]))) return false;
        minContextSlot = slot;
      }
    }
    if (minContextSlot > entry.trace.slot) entry.trace.slot = minContextSlot;
    return true;
  }

  return new Proxy(reader, {
    get(target, method) {
      if (!METHODS.has(method)) return typeof target[method] === 'function'
        ? target[method].bind(target) : target[method];
      return async (...args) => {
        // Keys contain chain/program/wallet and the full provenance arguments.
        // Internal snapshot markers must never be serialized as external keys.
        if (args.some(arg => arg?.snapshot)) return target[method](...args);
        const key = method + ':' + serialize(args).toString('base64');
        const entry = entries.get(key);
        if (entry) {
          try {
            const age = now() - entry.at;
            if (age >= 0 && age < RETAIN_MS && await timeDisplay('snapshot_check', () => unchanged(entry)))
              return structuredClone(entry.value);
          } catch (error) { remove(key); throw error; }
          remove(key);
        }
        const trace = { safe: true, genesis: null, slot: 0n,
          accounts: new Map(), queries: new Map() };
        // Call with original reader as this: nested validations are captured as
        // one dependency set rather than recursively reusing other entries.
        const value = await timeDisplay('snapshot_rebuild', () => scope.run(trace, () => target[method](...args)));
        if (trace.safe && trace.genesis && trace.accounts.size + trace.queries.size > 0) {
          const copy = structuredClone(value);
          const bytes = serialize({ key, trace, value: copy }).byteLength;
          if (bytes <= MAX_ENTRY_BYTES &&
              (!entries.has(key) || entries.get(key).trace.slot <= trace.slot)) {
            remove(key);
            while (entries.size >= MAX_ENTRIES || retainedBytes + bytes > MAX_BYTES)
              remove(entries.keys().next().value);
            entries.set(key, { trace, value: copy, bytes, at: now() });
            retainedBytes += bytes;
          }
        }
        return value;
      };
    },
  });
}
