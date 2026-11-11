import { AsyncLocalStorage } from 'node:async_hooks';
import { withM2eDisplayRpc as withDisplayRpc } from './m2e-display-rpc.js';

// Keep verified snapshots between reads, but share raw reads only within one
// inventory request/provider. No operation or settlement service is exposed.
export function createBatchedDisplayInventory({ rpc, createService }) {
  const scope = new AsyncLocalStorage();
  const routed = new Proxy(Object.create(null), { get(_, method) {
    if (method === 'then' || typeof method !== 'string') return undefined;
    return (...args) => ({ send: (...options) => {
      const active = scope.getStore();
      if (!active) throw new Error('Inventory RPC outside display request');
      return active[method](...args).send(...options);
    } });
  } });
  const service = createService(routed);
  return { inventory: (...args) => withDisplayRpc(rpc,
    active => scope.run(active, () => service.inventory(...args))) };
}
