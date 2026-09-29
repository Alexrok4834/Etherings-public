import { createServer } from 'node:http';

const ROUTES = { '/auth/register': 'register', '/auth/resend': 'resend', '/auth/verify': 'verify', '/auth/login': 'login' };

export function createAlphaServer(auth, wallet, eru = null, silver = null) {
  return createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1];
    let result;
    try {
      if (request.method === 'POST' && (ROUTES[path] ||
          (wallet && (path === '/wallet/challenge' || path === '/wallet/bind')) ||
          (eru && (path === '/eru/intent' || path === '/eru/submit' ||
            path === '/eru/reconcile')) ||
          (silver && path === '/silver/first-entry'))) {
        let raw = '';
        for await (const chunk of request) {
          raw += chunk;
          if (raw.length > 16_384) { response.writeHead(413).end(); return; }
        }
        let body;
        try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { response.writeHead(400).end(); return; }
        if (ROUTES[path]) result = await auth[ROUTES[path]](body);
        else if (path === '/wallet/challenge') result = await wallet.issue(token, body);
        else if (path === '/wallet/bind') result = await wallet.bind(token, body);
        else if (path === '/eru/intent') result = await eru.issue(token, body);
        else if (path === '/eru/submit') result = await eru.submit(token, body);
        else if (path === '/silver/first-entry') result = await silver.reserve(token);
        else result = await eru.reconcile(token, body);
      } else if (request.method === 'GET' && path === '/auth/me') {
        result = await auth.me(token);
      } else if (request.method === 'POST' && path === '/auth/logout') {
        result = await auth.logout(token);
      } else if (request.method === 'GET' && path === '/wallet' && wallet) {
        result = await wallet.current(token);
      } else if (request.method === 'GET' && path === '/silver/inventory' && silver) {
        result = await silver.inventory(token);
      } else { result = { status: 404, body: { message: 'Not found.' } }; }
    } catch {
      result = { status: 503, body: { message: 'Service unavailable.' } };
    }
    response.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(result.body === null ? '' : JSON.stringify(result.body));
  });
}
