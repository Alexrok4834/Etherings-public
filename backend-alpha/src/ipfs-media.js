const MAX_BYTES = 3_000_000;
const MAX_ENTRIES = 32;
const UPSTREAM = 'https://gateway.pinata.cloud/ipfs/';
const MEDIA_PATH = /^\/media\/ipfs\/(bafy[a-z2-7]{55})((?:\/[A-Za-z0-9_-]{1,80}(?:\.[A-Za-z0-9_-]{1,12})?){0,3})$/;

function validCid(cid) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const letter of cid.slice(1)) {
    value = (value << 5) | alphabet.indexOf(letter);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return bytes.length === 36 && bits === 2 && value === 0 &&
    bytes[0] === 1 && bytes[1] === 0x70 && bytes[2] === 0x12 && bytes[3] === 32;
}

function validPng(bytes) {
  return bytes.length >= 33 && bytes.subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR';
}

export function createIpfsMedia(fetchUpstream = fetch) {
  const cache = new Map();
  const inFlight = new Map();

  async function load(path) {
    if (cache.has(path)) {
      const bytes = cache.get(path);
      cache.delete(path);
      cache.set(path, bytes);
      return bytes;
    }
    if (inFlight.has(path)) return inFlight.get(path);
    const pending = (async () => {
      const response = await fetchUpstream(UPSTREAM + path, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 200 ||
          response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png' ||
          Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) return null;
      const parts = [];
      let length = 0;
      for await (const part of response.body) {
        length += part.length;
        if (length > MAX_BYTES) return null;
        parts.push(part);
      }
      const bytes = Buffer.concat(parts, length);
      if (!validPng(bytes)) return null;
      cache.set(path, bytes);
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
      return bytes;
    })();
    inFlight.set(path, pending);
    try { return await pending; }
    finally { inFlight.delete(path); }
  }

  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const match = MEDIA_PATH.exec(request.url ?? '');
    if (!match || !validCid(match[1])) {
      response.writeHead(400).end();
      return;
    }
    try {
      const bytes = await load(match[1] + match[2]);
      if (!bytes) { response.writeHead(502).end(); return; }
      response.writeHead(200, {
        'content-type': 'image/png', 'content-length': bytes.length,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(502).end();
    }
  };
}
