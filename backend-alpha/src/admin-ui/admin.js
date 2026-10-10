let accessToken = null;
let usersRequest = 0;
const pending = new Map();
function stableOperation(form, values) {
  const fingerprint = JSON.stringify(values);
  const prior = pending.get(form);
  if (prior?.fingerprint === fingerprint) return prior.id;
  const id = crypto.randomUUID();
  pending.set(form, { fingerprint, id });
  return id;
}
const $ = id => document.getElementById(id);
const notice = message => { $('notice').textContent = message; };

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401) signOut();
    throw new Error(data?.code || data?.message || `HTTP ${response.status}`);
  }
  return data;
}
const ertFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
function displayErt(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? ertFormatter.format(amount) : value;
}
function item(container, title, value, exactValue = null) {
  const div = document.createElement('div');
  div.className = 'metric';
  const strong = document.createElement('strong'); strong.textContent = value ?? '—';
  if (exactValue !== null) strong.title = String(exactValue);
  const small = document.createElement('small'); small.textContent = title;
  div.append(strong, small); container.append(div);
}
function line(container, text, action, label) {
  const div = document.createElement('div'); div.className = 'item';
  div.append(document.createTextNode(text));
  if (action) {
    const button = document.createElement('button');
    button.textContent = label; button.addEventListener('click', action);
    div.append(button);
  }
  container.append(div);
}
function show(panel) {
  document.querySelectorAll('.panel').forEach(node => { node.hidden = node.id !== panel; });
  document.querySelectorAll('[data-panel]').forEach(node => {
    node.classList.toggle('selected', node.dataset.panel === panel);
  });
  if (panel === 'overview') void loadOverview();
  if (panel === 'users') void loadUsers();
  if (panel === 'draw') void loadDraw();
  if (panel === 'grants') void loadEru();
  if (panel === 'grants') void loadBoxes();
}
function signOut() {
  const token = accessToken;
  accessToken = null;
  usersRequest++;
  $('user-results').replaceChildren();
  $('user-detail').replaceChildren();
  $('user-status').textContent = '';
  pending.clear();
  $('workspace').hidden = true; $('login').hidden = false; $('logout').hidden = true;
  if (token) void fetch('/auth/logout', { method: 'POST',
    headers: { authorization: `Bearer ${token}` } });
}
async function loadOverview() {
  try {
    const stats = await request('/admin/overview');
    let operations;
    try { operations = await request('/admin/operational-stats'); }
    catch (error) { operations = { unavailable: error.message }; }
    const grid = $('overview-grid'); grid.replaceChildren();
    item(grid, 'Registered accounts', stats.accounts.registered);
    item(grid, 'Verified accounts', stats.accounts.verified);
    item(grid, 'Bound wallets', stats.wallets.bound);
    item(grid, 'Movement participants', stats.movement.participants);
    item(grid, 'Accepted steps', stats.movement.accepted_steps);
    item(grid, 'ERT earned from movement',
      displayErt(stats.movement.earned_ert), stats.movement.earned_ert);
    item(grid, 'ERT credited, all sources',
      displayErt(stats.economy.credited_ert), stats.economy.credited_ert);
    item(grid, 'ERT spent, all sources',
      displayErt(stats.economy.spent_ert), stats.economy.spent_ert);
    item(grid, 'Draw attempts', stats.draw.attempts);
    item(grid, 'Cooper Rings issued', stats.cooper.rings);
    item(grid, 'First-entry Boxes', stats.boxes.first_entry);
    item(grid, 'Draw Boxes', stats.boxes.draw);
    item(grid, 'Breeding Boxes', stats.boxes.breeding);
    if (stats.adminBoxEnabled) item(grid, 'Admin Boxes', stats.adminBoxCount.confirmed);
    item(grid, 'Opened Boxes', stats.openings.finalized);
    item(grid, 'Marketplace submissions', stats.marketplace.submissions);
    item(grid, 'Silver transfers submitted', stats.transfers.submissions);
    item(grid, 'Cooper level events', stats.progression.cooper_level_events);
    item(grid, 'Silver progression operations', stats.progression.silver_progression_operations);
    item(grid, 'Breeding settlements', stats.progression.breeding_settlements);
    item(grid, 'Admin ERT credits', stats.supportGrants.ert_credits);
    $('eru-form').hidden = !stats.adminEruEnabled;
    $('refresh-eru').hidden = !stats.adminEruEnabled;
    $('box-controls').hidden = !stats.adminBoxEnabled;
    $('cooper-controls').hidden = !stats.adminCooperEnabled;
    $('operations').textContent = JSON.stringify({
      drawRewards: stats.drawRewards, adminEru: stats.adminEru,
      adminBoxes: stats.adminBoxes,
      marketplaceActions: stats.marketplaceActions,
      progression: stats.progression,
      operations: operations.operations, canonicalEru: operations.canonicalEru,
      unavailable: operations.unavailable,
    }, null, 2);
    notice('Overview updated.');
  } catch (error) { notice(error.message); }
}
async function loadUsers() {
  if (!accessToken || $('users').hidden) return;
  const requestId = ++usersRequest;
  const target = $('user-results');
  $('user-status').textContent = 'Updating users…';
  try {
    const search = encodeURIComponent($('user-search').value.trim());
    const data = await request(`/admin/users?search=${search}`, { cache: 'no-store' });
    if (requestId !== usersRequest || !accessToken) return;
    target.replaceChildren();
    for (const user of data.users) line(target,
      `${user.email} · ${user.verified ? 'verified' : 'unverified'} · ${user.acceptedSteps} steps`,
      () => selectUser(user.id), 'Details');
    if (!data.users.length) line(target, 'No matching users.');
    $('user-status').textContent = `${data.users.length} users · Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    if (requestId !== usersRequest) return;
    target.replaceChildren();
    $('user-status').textContent = `Users unavailable: ${error.message}`;
  }
}
async function selectUser(id) {
  try {
    const user = await request(`/admin/users/${id}`);
    $('ert-account').value = user.id;
    $('cooper-account').value = user.id;
    $('box-account').value = user.id;
    const detail = $('user-detail'); detail.replaceChildren();
    line(detail, `${user.email} · ${user.id}`);
    line(detail, `Wallet: ${user.walletAddress || 'not bound'}`);
    line(detail, `ERT available: ${user.ert.available} · Steps: ${user.movement.accepted_steps} · Draws: ${user.draw.attempts}`);
    notice('Account selected for ERT grant.');
  } catch (error) { notice(error.message); }
}
async function loadDraw() {
  try {
    const [data, stats] = await Promise.all([
      request('/admin/raffle/v2/configurations'), request('/admin/overview'),
    ]);
    const spins = BigInt(stats.draw.attempts);
    const wins = new Map(stats.drawRewards.map(row => [row.type, BigInt(row.count)]));
    const grid = $('draw-statistics'); grid.replaceChildren();
    item(grid, 'Total spins', spins.toString());
    for (const [type, label] of [
      ['ERT', 'ERT'], ['ERU', 'ERU'],
      ['COPPER_RING', 'Cooper Rings'], ['SILVER_BOX', 'Silver Boxes'],
    ]) {
      const count = wins.get(type) ?? 0n;
      const hundredths = spins ? (count * 10_000n + spins / 2n) / spins : 0n;
      const percent = `${hundredths / 100n},${String(hundredths % 100n).padStart(2, '0')}`;
      item(grid, `${label} · ${percent}% of spins`, count.toString());
    }
    const target = $('draw-configurations'); target.replaceChildren();
    for (const config of data.configurations) {
      const weights = Object.entries(config.weights).map(([type, weight]) => `${type} ${weight}`).join(' · ');
      line(target, `${config.status} · ${config.configurationVersion} · ${weights}`,
        config.status === 'DRAFT' ? () => activateDraw(config.configurationVersion) : null,
        'Activate');
    }
  } catch (error) { notice(error.message); }
}
async function activateDraw(configurationVersion) {
  if (!confirm('Activate this Draw configuration? The current version will close.')) return;
  try {
    await request('/admin/raffle/v2/configuration/activate', { method: 'POST',
      body: JSON.stringify({ configurationVersion }) });
    notice('Draw configuration activated.'); await loadDraw();
  } catch (error) { notice(error.message); }
}
async function loadEru() {
  try {
    if ($('eru-form').hidden) return;
    const [data, budget] = await Promise.all([
      request('/admin/eru/transfers'), request('/admin/eru/budget')]);
    $('eru-budget').textContent =
      `Delegated budget remaining: ${BigInt(budget.remainingBaseUnits) / 1_000_000_000n} ERU`;
    const target = $('eru-transfers'); target.replaceChildren();
    for (const transfer of data.transfers) {
      const whole = BigInt(transfer.amountBaseUnits) / 1_000_000_000n;
      const fraction = (BigInt(transfer.amountBaseUnits) % 1_000_000_000n)
        .toString().padStart(9, '0').replace(/0+$/, '');
      line(target, `${transfer.state} · ${whole}${fraction ? '.' + fraction : ''} ERU · ` +
        `${transfer.walletAddress} · ${transfer.operationId}`);
    }
  } catch (error) { notice(error.message); }
}
async function loadBoxes() {
  if ($('box-controls').hidden) return;
  try {
    const data = await request('/admin/box/grants');
    const target = $('box-grants'); target.replaceChildren();
    for (const grant of data.grants) line(target,
      `${grant.state} · ${grant.accountId} · ${grant.mintAddress || 'awaiting confirmation'} · ${grant.operationId}`);
  } catch (error) { notice(error.message); }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const data = await request('/auth/login', { method: 'POST',
      body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    accessToken = data.accessToken; $('password').value = '';
    await request('/admin/overview');
    $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    show('overview'); notice('Signed in.');
  } catch (error) { accessToken = null; notice(error.message); }
});
$('logout').addEventListener('click', signOut);
document.querySelectorAll('[data-panel]').forEach(node =>
  node.addEventListener('click', () => show(node.dataset.panel)));
$('refresh-overview').addEventListener('click', loadOverview);
$('refresh-eru').addEventListener('click', loadEru);
$('refresh-boxes').addEventListener('click', loadBoxes);
$('user-search-form').addEventListener('submit', event => { event.preventDefault(); void loadUsers(); });
$('refresh-users').addEventListener('click', loadUsers);
setInterval(() => {
  if (!document.hidden && !$('users').hidden && accessToken) void loadUsers();
}, 30_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('users').hidden && accessToken) void loadUsers();
});
$('draw-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = {
    dailyAttemptLimit: Number($('draw-limit').value), weights: {
      ERT: Number($('draw-ert').value), ERU: Number($('draw-eru').value),
      COPPER_RING: Number($('draw-cooper').value), SILVER_BOX: Number($('draw-box').value),
    } };
  const body = { configurationVersion: stableOperation('draw', values), ...values };
  try {
    await request('/admin/raffle/v2/configuration/draft', { method: 'POST', body: JSON.stringify(body) });
    notice('Draw draft saved.'); await loadDraw();
  } catch (error) { notice(error.message); }
});
$('ert-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = { targetAccountId: $('ert-account').value,
    amountExact: $('ert-amount').value.trim(), reason: $('ert-reason').value.trim() };
  try {
    await request('/admin/ert/credit', { method: 'POST', body: JSON.stringify({
      idempotencyKey: stableOperation('ert', values), ...values,
    }) });
    notice('ERT credited.');
  } catch (error) { notice(error.message); }
});
$('cooper-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!confirm('Grant one Cooper Ring to the selected account?')) return;
  const values = { targetAccountId: $('cooper-account').value,
    reason: $('cooper-reason').value.trim() };
  try {
    const result = await request('/admin/cooper/grant', { method: 'POST',
      body: JSON.stringify({ idempotencyKey: stableOperation('cooper', values),
        ...values }) });
    notice(`Cooper Ring granted: ${result.ringId}`);
  } catch (error) { notice(error.message); }
});
$('box-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!confirm('Issue one Silver Box to the selected Alpha account?')) return;
  const values = { targetAccountId: $('box-account').value,
    reason: $('box-reason').value.trim() };
  try {
    const result = await request('/admin/box/grants', { method: 'POST',
      body: JSON.stringify({ idempotencyKey: stableOperation('box', values), ...values }) });
    notice(`Box grant ${result.operationId}: ${result.state}.`);
    await loadBoxes();
  } catch (error) { notice(error.message); }
});
$('eru-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!confirm('Send this ERU amount to the entered Devnet address?')) return;
  const values = { walletAddress: $('eru-wallet').value.trim(),
    amountExact: $('eru-amount').value.trim(), reason: $('eru-reason').value.trim() };
  try {
    const result = await request('/admin/eru/transfers', { method: 'POST', body: JSON.stringify({
      idempotencyKey: stableOperation('eru', values), ...values,
    }) });
    notice(`Transfer ${result.operationId} recorded. Check its status before retrying.`);
    await loadEru();
  } catch (error) { notice(error.message); }
});
