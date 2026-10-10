import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createAlphaServer } from '../src/server.js';
import { createIpfsMedia } from '../src/ipfs-media.js';

const cid = 'bafybeidwdvv4dlp4oskjrhyfywmnprwbrgbxjmwmbemx7y5t2a6vap4zpq';
const png = Buffer.alloc(33);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write('IHDR', 12);

async function start(upstream) {
  const server = createAlphaServer({}, null, null, null, null, null, null, null,
    createIpfsMedia(upstream));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/media/ipfs/`;
}

test('only bounded CID PNG GET/HEAD reaches fixed upstream and success is cached', async () => {
  let calls = 0;
  const base = await start(async (url, options) => {
    calls++;
    assert.equal(url, `https://gateway.pinata.cloud/ipfs/${cid}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  for (const suffix of ['not-a-cid', `${cid}/%2Fetc`, `${cid}?url=https://example.com`]) {
    assert.equal((await fetch(base + suffix)).status, 400);
  }
  assert.equal((await fetch(base + cid, { method: 'POST' })).status, 405);
  assert.equal(calls, 0);
  const first = await fetch(base + cid);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png);
  const head = await fetch(base + cid, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(png.length));
  assert.equal(calls, 1);
});

test('upstream failures are not cached as media', async () => {
  let calls = 0;
  const base = await start(async () => {
    calls++;
    return calls === 1 ? new Response('denied', { status: 403 }) :
      new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  assert.equal((await fetch(base + cid)).status, 502);
  assert.equal((await fetch(base + cid)).status, 200);
  assert.equal(calls, 2);
});

test('safe PNG subpath is fixed to Pinata and oversized content is rejected', async () => {
  let calls = 0;
  const base = await start(async url => {
    calls++;
    assert.equal(url, `https://gateway.pinata.cloud/ipfs/${cid}/silver_box_closed.png`);
    return new Response(Buffer.alloc(3_000_001), {
      status: 200, headers: { 'content-type': 'image/png' },
    });
  });
  assert.equal((await fetch(base + cid + '/silver_box_closed.png')).status, 502);
  assert.equal((await fetch(base + cid + '/silver_box_closed.png')).status, 502);
  assert.equal(calls, 2);
});
