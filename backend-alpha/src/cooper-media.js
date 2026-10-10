import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { COOPER_VISUAL_CODES } from './cooper-generation.js';

const VERSION = 'copper-visual-v1';
const ROOT = new URL('../../android/app/src/main/res/drawable-nodpi/', import.meta.url);
const MAX_BYTES = 3_000_000;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function createCooperMedia(read = readFile) {
  let catalog;
  async function entries() {
    if (catalog) return catalog;
    const images = {};
    for (const code of COOPER_VISUAL_CODES) {
      const bytes = await read(fileURLToPath(new URL(`${code}_transparent.png`, ROOT)));
      if (bytes.length < 33 || bytes.length > MAX_BYTES ||
          !bytes.subarray(0, 8).equals(PNG) || bytes.toString('ascii', 12, 16) !== 'IHDR')
        throw new Error('Invalid Cooper media source');
      images[code] = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    catalog = images;
    return images;
  }
  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = request.url ?? '';
    const image = /^\/media\/cooper\/copper-visual-v1\/([a-z_]+)\.png$/.exec(path);
    if (path !== '/media/cooper/catalog' && (!image || !COOPER_VISUAL_CODES.includes(image[1]))) {
      response.writeHead(404).end();
      return;
    }
    try {
      const all = await entries();
      if (path === '/media/cooper/catalog') {
        const images = Object.fromEntries(COOPER_VISUAL_CODES.map(code => [code, {
          path: `/media/cooper/${VERSION}/${code}.png`, sha256: all[code].sha256,
        }]));
        const body = Buffer.from(JSON.stringify({ version: VERSION, images }));
        response.writeHead(200, { 'content-type': 'application/json',
          'content-length': body.length, 'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff' });
        response.end(request.method === 'HEAD' ? undefined : body);
        return;
      }
      const { bytes, sha256 } = all[image[1]];
      response.writeHead(200, { 'content-type': 'image/png',
        'content-length': bytes.length, etag: `"${sha256}"`,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(503).end();
    }
  };
}
