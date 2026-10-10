import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAlphaServer } from '../src/server.js';

test('versioned Cooper catalog serves exact existing PNGs without arbitrary paths', async () => {
  const server = createAlphaServer({});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const catalogResponse = await fetch(base + '/media/cooper/catalog');
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.version, 'copper-visual-v1');
    assert.equal(Object.keys(catalog.images).length, 9);
    for (const [code, entry] of Object.entries(catalog.images)) {
      assert.equal(entry.path, `/media/cooper/copper-visual-v1/${code}.png`);
      const response = await fetch(base + entry.path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
      const head = await fetch(base + entry.path, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(bytes.length));
    }
    assert.equal((await fetch(base + '/media/cooper/copper-visual-v1/unknown.png')).status, 404);
    assert.equal((await fetch(base + '/media/cooper/catalog?url=https://evil.test')).status, 404);
    const wrongMethod = await fetch(base + '/media/cooper/catalog', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
