import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AdminRaffleDraw,
  AdminReward,
  ApiError,
  ProfileResponse,
  apiConfig,
  listAdminRaffleDraws,
  listAdminRewards,
} from './api';
import { RaffleV2Admin } from './RaffleV2Admin';

type AdminAppProps = {
  token: string;
  profile: ProfileResponse;
  onRetry: () => void;
  onLogout: () => void;
  initialSection?: AdminSection;
};

type AdminSection = 'Dashboard' | 'Draw' | 'Rewards' | 'Legacy audit';

const adminSections: AdminSection[] = ['Dashboard', 'Draw', 'Rewards', 'Legacy audit'];

export function AdminApp({ token, profile, onRetry, onLogout, initialSection = 'Dashboard' }: AdminAppProps) {
  const [section, setSection] = useState<AdminSection>(initialSection);

  if (!profile.user.isAdmin) {
    return (
      <section className="panel admin-guard" aria-label="Admin access denied">
        <span className="admin-kicker">Admin</span>
        <h2>Admin access required</h2>
        <p>Signed in as {userLabel(profile)}. This account is not allowed to use Etherings admin tools.</p>
        <div className="connection-meta"><span>API</span><strong>{apiConfig.baseUrl}</strong></div>
        <div className="panel-actions">
          <button type="button" onClick={() => window.location.assign('/')}>Player app</button>
          <button type="button" className="secondary-button" onClick={onRetry}>Refresh</button>
          <button type="button" className="ghost-button" onClick={onLogout}>Logout</button>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="admin-panel" aria-label="Admin dashboard shell">
        <div className="admin-heading">
          <div>
            <span>Admin</span>
            <strong>Operations dashboard</strong>
          </div>
          <button type="button" className="ghost-button" onClick={onLogout}>Logout</button>
        </div>

        <nav className="admin-tabs" aria-label="Admin sections">
          {adminSections.map((item) => (
            <button key={item} type="button" className={section === item ? 'active' : ''} onClick={() => setSection(item)}>{item}</button>
          ))}
        </nav>
      </section>

      {section === 'Draw' ? <RaffleV2Admin token={token} /> : section === 'Rewards' ? <RewardsManagement token={token} /> : section === 'Legacy audit' ? <DrawAuditPanel token={token} /> : <DashboardPanel profile={profile} />}
    </>
  );
}

function DashboardPanel({ profile }: { profile: ProfileResponse }) {
  return (
    <>
      <section className="summary-grid admin-summary" aria-label="Admin metrics">
        <article><span>Total users</span><strong>Pending API</strong></article>
        <article><span>Sessions today</span><strong>Pending API</strong></article>
        <article><span>ERT issued today</span><strong>Pending API</strong></article>
      </section>

      <section className="panel compact-panel">
        <div>
          <h2>Dashboard</h2>
          <p>Admin route and guard are active. Raffle v2 configuration is managed from Draw.</p>
        </div>
        <div className="connection-meta"><span>Signed in</span><strong>{userLabel(profile)}</strong></div>
      </section>
    </>
  );
}

function RewardsManagement({ token }: { token: string }) {
  const [rewards, setRewards] = useState<AdminReward[]>([]);
  const [message, setMessage] = useState('Loading rewards');
  const [isBusy, setIsBusy] = useState(false);

  const loadRewards = useCallback(async () => {
    setIsBusy(true);
    try {
      const nextRewards = await listAdminRewards(token);
      setRewards(nextRewards);
      setMessage(`${nextRewards.length} rewards loaded.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }, [token]);

  useEffect(() => {
    void loadRewards();
  }, [loadRewards]);

  return (
      <section className="admin-panel rewards-admin-panel" aria-label="Reward catalog">
        <div className="admin-heading">
          <div>
            <span>Rewards</span>
            <strong>Read-only catalog</strong>
          </div>
          <button type="button" className="ghost-button" onClick={loadRewards} disabled={isBusy}>Refresh</button>
        </div>
        <p className="walk-message">{message}</p>

          <div className="admin-table-wrap" aria-label="Reward list">
            <table className="admin-table">
              <thead>
                <tr><th>Code</th><th>Type</th><th>Amount</th><th>Stock</th><th>Status</th></tr>
              </thead>
              <tbody>
                {rewards.length === 0 ? <tr><td colSpan={5}>No rewards created yet.</td></tr> : null}
                {rewards.map((reward) => (
                  <tr key={reward.id}>
                    <td><strong>{reward.code}</strong><span>{reward.title}</span></td>
                    <td>{reward.type}</td>
                    <td>{reward.amountDisplay ?? reward.amountExact ?? reward.amount ?? '-'}</td>
                    <td>{stockLabel(reward)}</td>
                    <td><span className={reward.isActive ? 'state-good' : 'state-muted'}>{reward.isActive ? 'Active' : 'Disabled'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      </section>
  );
}

function DrawAuditPanel({ token }: { token: string }) {
  const [draws, setDraws] = useState<AdminRaffleDraw[]>([]);
  const [userFilter, setUserFilter] = useState('');
  const [poolFilter, setPoolFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [message, setMessage] = useState('Loading draw audit');
  const [isBusy, setIsBusy] = useState(false);

  const loadDraws = useCallback(async () => {
    setIsBusy(true);
    try {
      const nextDraws = await listAdminRaffleDraws(token);
      setDraws(nextDraws);
      setMessage(`${nextDraws.length} draw events loaded.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }, [token]);

  useEffect(() => {
    void loadDraws();
  }, [loadDraws]);

  const poolOptions = useMemo(() => uniquePools(draws), [draws]);
  const filteredDraws = useMemo(() => draws.filter((draw) => {
    const userNeedle = userFilter.trim().toLowerCase();
    const userMatch = !userNeedle || userAuditLabel(draw).toLowerCase().includes(userNeedle) || draw.userId.toLowerCase().includes(userNeedle);
    const poolMatch = !poolFilter || draw.poolId === poolFilter;
    const dateMatch = !dateFilter || draw.createdAt.slice(0, 10) === dateFilter;
    return userMatch && poolMatch && dateMatch;
  }), [dateFilter, draws, poolFilter, userFilter]);

  return (
    <section className="admin-panel audit-panel" aria-label="Draw audit">
      <div className="admin-heading">
        <div>
          <span>Audit</span>
          <strong>Draw audit</strong>
        </div>
        <button type="button" className="ghost-button" onClick={loadDraws} disabled={isBusy}>Refresh</button>
      </div>
      <p className="walk-message">{message}</p>

      <div className="audit-filters">
        <label>User<input value={userFilter} onChange={(event) => setUserFilter(event.target.value)} placeholder="username, Telegram ID, user id" /></label>
        <label>Pool<select value={poolFilter} onChange={(event) => setPoolFilter(event.target.value)}><option value="">All pools</option>{poolOptions.map((pool) => <option key={pool.id} value={pool.id}>{pool.label}</option>)}</select></label>
        <label>Date<input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></label>
      </div>

      <div className="summary-grid admin-summary" aria-label="Audit summary">
        <article><span>Shown draws</span><strong>{filteredDraws.length}</strong></article>
        <article><span>Total loaded</span><strong>{draws.length}</strong></article>
        <article><span>Filtered cost</span><strong>{filteredDraws.reduce((sum, draw) => sum + draw.costErt, 0)} ERT</strong></article>
      </div>

      <div className="admin-table-wrap" aria-label="Draw events">
        <table className="admin-table audit-table">
          <thead>
            <tr><th>Time</th><th>User</th><th>Pool</th><th>Reward</th><th>Cost</th><th>Roll</th></tr>
          </thead>
          <tbody>
            {filteredDraws.map((draw) => (
              <tr key={draw.id}>
                <td><strong>{formatDate(draw.createdAt)}</strong><span>{draw.id.slice(0, 8)}</span></td>
                <td><strong>{userAuditLabel(draw)}</strong><span>{draw.userId.slice(0, 8)}</span></td>
                <td><strong>{draw.pool?.code ?? draw.poolId.slice(0, 8)}</strong><span>{draw.pool?.title ?? 'Pool'}</span></td>
                <td><strong>{draw.reward?.code ?? rewardCodeFromSnapshot(draw.rewardSnapshot)}</strong><span>{draw.reward?.title ?? rewardTitleFromSnapshot(draw.rewardSnapshot)}</span></td>
                <td>{draw.costErt} ERT</td>
                <td>{draw.randomRoll.toFixed(6)}</td>
              </tr>
            ))}
            {filteredDraws.length === 0 ? <tr><td colSpan={6}>No draw events match the current filters.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function stockLabel(reward: AdminReward) {
  if (reward.stockRemaining === null && reward.stockTotal === null) return 'Unlimited';
  return `${reward.stockRemaining ?? '-'} / ${reward.stockTotal ?? '-'}`;
}

function uniquePools(draws: AdminRaffleDraw[]) {
  const pools = new Map<string, string>();
  for (const draw of draws) {
    pools.set(draw.poolId, `${draw.pool?.code ?? draw.poolId.slice(0, 8)} - ${draw.pool?.title ?? 'Pool'}`);
  }
  return Array.from(pools, ([id, label]) => ({ id, label }));
}

function userAuditLabel(draw: AdminRaffleDraw) {
  if (draw.user?.username) return `@${draw.user.username}`;
  if (draw.user?.telegramId) return `Telegram ${draw.user.telegramId}`;
  return draw.userId;
}

function rewardCodeFromSnapshot(snapshot: Record<string, unknown>) {
  return typeof snapshot.code === 'string' ? snapshot.code : 'Reward';
}

function rewardTitleFromSnapshot(snapshot: Record<string, unknown>) {
  return typeof snapshot.title === 'string' ? snapshot.title : 'Reward';
}
function userLabel(profile: ProfileResponse) {
  return profile.user.username ? `@${profile.user.username}` : `Telegram ID ${profile.user.telegramId}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
  if (error instanceof SyntaxError) return 'Metadata must be valid JSON.';
  if (error instanceof Error) return error.message;
  return 'Unexpected admin error';
}
