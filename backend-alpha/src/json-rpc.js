const RPC_TIMEOUT_MS = 15_000;

export async function postJsonRpc({ url, method, params = [], id, label,
  fetchImpl = fetch, timeoutMs = RPC_TIMEOUT_MS }) {
  const response = await fetchImpl(url, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${label} ${method} unavailable`);
  const json = await response.json();
  if (json.error) throw new Error(`${label} ${method} rejected: ${json.error.code}`);
  return json.result;
}
