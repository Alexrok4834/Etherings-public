import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createIpfsMedia } from './ipfs-media.js';
import { createCooperMedia } from './cooper-media.js';

const ROUTES = { '/auth/register': 'register', '/auth/resend': 'resend', '/auth/verify': 'verify', '/auth/login': 'login' };
const ADMIN_PAGE = readFileSync(new URL('./admin-ui/index.html', import.meta.url));
const ADMIN_SCRIPT = readFileSync(new URL('./admin-ui/admin.js', import.meta.url));
const ADMIN_STYLE = readFileSync(new URL('./admin-ui/admin.css', import.meta.url));

export function createAlphaServer(auth, wallet, eru = null, silver = null,
  silverOpening = null, silverCandidateIntent = null, walletAssets = null,
  starterCooper = null, media = createIpfsMedia(), equipment = null,
  m2eStepSync = null, m2eProfile = null, adminErtCredit = null,
  cooperPointAllocation = null, cooperLevelUp = null, cooperEru = null,
  silverProgression = null, silverAllocation = null, draw = null,
  cooperMedia = createCooperMedia(), cooperBreeding = null,
  marketplace = null, silverDirectTransfer = null, operationalStats = null,
  adminEruTransfer = null, adminDashboard = null, adminCooperGrant = null,
  adminBoxGrant = null) {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/admin') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff' });
      response.end(ADMIN_PAGE);
      return;
    }
    if (request.method === 'GET' && (request.url === '/admin/admin.js' ||
        request.url === '/admin/admin.css')) {
      const script = request.url.endsWith('.js');
      response.writeHead(200, { 'content-type': script ?
        'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(script ? ADMIN_SCRIPT : ADMIN_STYLE);
      return;
    }
    if (request.url?.startsWith('/media/ipfs/')) {
      await media(request, response);
      return;
    }
    if (request.url?.startsWith('/media/cooper/')) {
      await cooperMedia(request, response);
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const cooperAllocationRing = /^\/me\/rings\/([0-9a-f-]+)\/attribute-points\/allocate$/i
      .exec(path)?.[1] ?? null;
    const cooperLevelMatch = /^\/me\/rings\/([0-9a-f-]+)\/level-up(\/preview)?$/i
      .exec(path);
    const cooperEruPrepareRing = /^\/me\/rings\/([0-9a-f-]+)\/level-up\/eru\/prepare$/i
      .exec(path)?.[1] ?? null;
    const cooperEruAction = /^\/me\/cooper\/eru\/(review|refresh|submit|status)$/
      .exec(path)?.[1] ?? null;
    const cooperBreedingRing = /^\/me\/rings\/([0-9a-f-]+)\/breeding\/(preview|prepare)$/i
      .exec(path);
    const cooperBreedingAction = /^\/me\/cooper\/breeding\/(review|refresh|submit|status)$/
      .exec(path)?.[1] ?? null;
    const silverProgressionMint = /^\/me\/silver\/([1-9A-HJ-NP-Za-km-z]{32,44})\/progression\/prepare$/
      .exec(path)?.[1] ?? null;
    const silverProgressionAction = /^\/me\/silver\/progression\/(review|refresh|submit|status)$/
      .exec(path)?.[1] ?? null;
    const silverAllocationAction = /^\/me\/silver\/points\/(review|refresh|submit|status)$/
      .exec(path)?.[1] ?? null;
    const marketListing = /^\/me\/marketplace\/listing\/([1-9A-HJ-NP-Za-km-z]{32,44})$/
      .exec(path)?.[1] ?? null;
    const marketAction = /^\/me\/marketplace\/(review|refresh|submit|status)$/
      .exec(path)?.[1] ?? null;
    const directTransferAction = /^\/me\/silver\/transfer\/(review|refresh|submit|status)$/
      .exec(path)?.[1] ?? null;
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1];
    let result;
    try {
      if (request.method === 'POST' && (ROUTES[path] ||
          path === '/auth/reauthenticate' || path === '/auth/change-password' ||
          path === '/auth/refresh' || path === '/auth/refresh-logout' ||
          (wallet && (path === '/wallet/challenge' || path === '/wallet/bind')) ||
          (eru && (path === '/eru/intent' || path === '/eru/submit' ||
            path === '/eru/reconcile')) ||
          (silver && path === '/silver/first-entry') ||
          (starterCooper && silver && path === '/starter/claim') ||
          (equipment && path === '/ring/equipment/equip') ||
          (m2eStepSync && path === '/step-sync/batches') ||
          (adminErtCredit && path === '/admin/ert/credit') ||
          (adminCooperGrant && path === '/admin/cooper/grant') ||
          (adminBoxGrant && path === '/admin/box/grants') ||
          (adminEruTransfer && path === '/admin/eru/transfers') ||
          (draw && (path === '/raffle/v2/draw' ||
            path === '/admin/raffle/v2/configuration/draft' ||
            path === '/admin/raffle/v2/configuration/activate')) ||
          (cooperPointAllocation && cooperAllocationRing) ||
          (cooperLevelUp && cooperLevelMatch) ||
          (cooperEru && (cooperEruPrepareRing || cooperEruAction)) ||
          (cooperBreeding && (cooperBreedingRing || cooperBreedingAction)) ||
          (silverProgression && (silverProgressionMint || silverProgressionAction)) ||
          (silverAllocation && silverAllocationAction) ||
          (marketplace && marketAction) ||
          (silverDirectTransfer && directTransferAction) ||
          (silverOpening && path === '/silver/opening/preflight') ||
          (silverCandidateIntent && (path === '/silver/opening/candidate-intent' ||
            path === '/silver/opening/submit' || path === '/silver/opening/reconcile')))) {
        let raw = '';
        for await (const chunk of request) {
          raw += chunk;
          if (raw.length > 16_384) { response.writeHead(413).end(); return; }
        }
        let body;
        try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { response.writeHead(400).end(); return; }
        if (ROUTES[path]) result = await auth[ROUTES[path]](body);
        else if (path === '/auth/refresh') result = await auth.refresh(body);
        else if (path === '/auth/refresh-logout') result = await auth.refreshLogout(body);
        else if (path === '/auth/reauthenticate') result = await auth.reauthenticate(token, body);
        else if (path === '/auth/change-password') result = await auth.changePassword(token, body);
        else if (path === '/wallet/challenge') result = await wallet.issue(token, body);
        else if (path === '/wallet/bind') result = await wallet.bind(token, body);
        else if (path === '/eru/intent') result = await eru.issue(token, body);
        else if (path === '/eru/submit') result = await eru.submit(token, body);
        else if (path === '/silver/first-entry') result = await silver.reserve(token);
        else if (path === '/starter/claim') {
          const copper = await starterCooper.claim(token);
          if (copper.status !== 200) result = copper;
          else if (!copper.body.walletBound) result = { status: 200,
            body: { ring: copper.body.ring, rings: copper.body.rings,
              silver: { status: 'awaiting_wallet' } } };
          else {
            const box = await silver.reserve(token);
            result = box.status === 200 ? { status: 200,
              body: { ring: copper.body.ring, rings: copper.body.rings,
                silver: box.body } } : box;
          }
        }
        else if (path === '/silver/opening/preflight') result = await silverOpening.preflight(token, body);
        else if (path === '/ring/equipment/equip') result = await equipment.equip(token, body);
        else if (path === '/step-sync/batches') result = await m2eStepSync.receive(token, body);
        else if (path === '/admin/ert/credit') result = await adminErtCredit.credit(token, body);
        else if (path === '/admin/cooper/grant') result = await adminCooperGrant.grant(token, body);
        else if (path === '/admin/box/grants') result = await adminBoxGrant.create(token, body);
        else if (path === '/admin/eru/transfers') result = await adminEruTransfer.create(token, body);
        else if (path === '/raffle/v2/draw') result = await draw.submit(token, body);
        else if (path === '/admin/raffle/v2/configuration/draft')
          result = await draw.createDraft(token, body);
        else if (path === '/admin/raffle/v2/configuration/activate')
          result = await draw.activate(token, body);
        else if (cooperAllocationRing) result = await cooperPointAllocation.allocate(
          token, cooperAllocationRing, body);
        else if (cooperLevelMatch) result = cooperLevelMatch[2] ?
          await cooperLevelUp.preview(token, cooperLevelMatch[1], body) :
          await cooperLevelUp.levelUp(token, cooperLevelMatch[1], body);
        else if (cooperEruPrepareRing) result = await cooperEru.prepare(
          token, cooperEruPrepareRing, body);
        else if (cooperEruAction) result = await cooperEru[cooperEruAction](token, body);
        else if (cooperBreedingRing) result = await cooperBreeding[
          cooperBreedingRing[2]](token, cooperBreedingRing[1], body);
        else if (cooperBreedingAction) result = await cooperBreeding[
          cooperBreedingAction](token, body);
        else if (silverProgressionMint) result = await silverProgression.prepare(
          token, silverProgressionMint, body);
        else if (silverProgressionAction) result = await silverProgression[
          silverProgressionAction](token, body);
        else if (silverAllocationAction) result = await silverAllocation[
          silverAllocationAction](token, body);
        else if (marketAction) result = await marketplace[marketAction](token, body);
        else if (directTransferAction) result = await silverDirectTransfer[
          directTransferAction](token, body);
        else if (path === '/silver/opening/candidate-intent') result = await silverCandidateIntent.issue(token, body);
        else if (path === '/silver/opening/submit') result = await silverCandidateIntent.submit(token, body);
        else if (path === '/silver/opening/reconcile') result = await silverCandidateIntent.reconcile(token, body);
        else result = await eru.reconcile(token, body);
      } else if (request.method === 'GET' && path === '/auth/me') {
        result = await auth.me(token);
      } else if (request.method === 'GET' && path === '/admin/operational-stats' && operationalStats) {
        result = await operationalStats.read(token);
      } else if (request.method === 'GET' && path === '/admin/overview' && adminDashboard) {
        result = await adminDashboard.overview(token);
      } else if (request.method === 'GET' && path === '/admin/users' && adminDashboard) {
        result = await adminDashboard.users(token, url.searchParams.get('search') ?? '');
      } else if (request.method === 'GET' && /^\/admin\/users\/[0-9a-f-]+$/.test(path) &&
          adminDashboard) {
        result = await adminDashboard.user(token, path.slice('/admin/users/'.length));
      } else if (request.method === 'GET' && path === '/admin/eru/transfers' && adminEruTransfer) {
        result = await adminEruTransfer.list(token);
      } else if (request.method === 'GET' && path === '/admin/eru/budget' && adminEruTransfer) {
        result = await adminEruTransfer.budget(token);
      } else if (request.method === 'GET' && path === '/admin/box/grants' && adminBoxGrant) {
        result = await adminBoxGrant.list(token);
      } else if (request.method === 'GET' && /^\/admin\/eru\/transfers\/[0-9a-f-]+$/.test(path) &&
          adminEruTransfer) {
        result = await adminEruTransfer.get(token, path.slice('/admin/eru/transfers/'.length));
      } else if (request.method === 'GET' && marketListing && marketplace) {
        result = await marketplace.listing(token, marketListing);
      } else if (request.method === 'GET' && path === '/me/marketplace/listings' && marketplace) {
        result = await marketplace.listings(token);
      } else if (request.method === 'POST' && path === '/auth/logout') {
        result = await auth.logout(token);
      } else if (request.method === 'GET' && path === '/wallet' && wallet) {
        result = await wallet.current(token);
      } else if (request.method === 'GET' && path === '/wallet/assets' && walletAssets) {
        result = await walletAssets.read(token);
      } else if (request.method === 'GET' && path === '/eru/history' && eru) {
        result = await eru.history(token);
      } else if (request.method === 'GET' && path === '/silver/inventory' && silver) {
        result = await silver.inventory(token);
      } else if (request.method === 'GET' && path === '/starter/inventory' && starterCooper) {
        result = await starterCooper.inventory(token);
      } else if (request.method === 'GET' && path === '/ring/equipment' && equipment) {
        result = await equipment.current(token);
      } else if (request.method === 'GET' && path === '/m2e/today' && m2eProfile) {
        result = await m2eProfile.today(token, url.searchParams);
      } else if (request.method === 'GET' && path === '/m2e/activity' && m2eProfile) {
        result = await m2eProfile.history(token, url.searchParams);
      } else if (request.method === 'GET' && path === '/raffle/v2/draw' && draw) {
        result = await draw.current(token);
      } else if (request.method === 'GET' && path === '/admin/raffle/v2/configurations' && draw) {
        result = await draw.adminConfigurations(token);
      } else if (request.method === 'GET' && path === '/raffle/v2/history' && draw) {
        result = await draw.history(token);
      } else { result = { status: 404, body: { message: 'Not found.' } }; }
    } catch (error) {
      if (path === '/me/cooper/eru/review') {
        const locations = [...String(error.stack ?? '').matchAll(
          /\/src\/(cooper-eru-(?:candidate-reader|issuance|attestation|intent)\.js):(\d+):\d+/g)];
        const location = locations.find(([, , line]) => line !== '12') ?? locations[0];
        const code = /^[A-Z0-9_]{2,40}$/.test(error.code ?? '') ? error.code : 'none';
        console.error('Cooper ERU review failed', error.name, code,
          location ? `${location[1]}:${location[2]}` : 'unknown location');
      }
      if (path === '/me/marketplace/submit') {
        const location = String(error.stack ?? '').match(
          /\/src\/(silver-marketplace-(?:flow|read|intent)\.js):(\d+):\d+/);
        const code = /^[A-Z0-9_]{2,40}$/.test(error.code ?? '') ? error.code : 'none';
        console.error('Marketplace submit failed', error.name, code,
          location ? `${location[1]}:${location[2]}` : 'unknown location');
      }
      if (path === '/silver/opening/submit') {
        const location = String(error.stack ?? '').match(
          /\/src\/(silver-(?:opening-candidate|opening-intent|chain)\.js):(\d+):\d+/);
        const code = /^[A-Z0-9_]{2,40}$/.test(error.code ?? '') ? error.code : 'none';
        console.error('Silver opening submit failed', error.name, code,
          location ? `${location[1]}:${location[2]}` : 'unknown location');
      }
      result = marketAction && request.method === 'POST' &&
          error?.code === 'MARKETPLACE_LISTING_COOLDOWN' &&
          /^(0|[1-9][0-9]*)$/.test(error?.cooldownUntilUnixSeconds ?? '') ?
        { status: 409, body: { code: 'MARKETPLACE_LISTING_COOLDOWN',
          cooldownUntilUnixSeconds: error.cooldownUntilUnixSeconds } } :
        { status: 503, body: { message: 'Service unavailable.' } };
    }
    response.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(result.body === null ? '' : JSON.stringify(result.body));
  });
}
