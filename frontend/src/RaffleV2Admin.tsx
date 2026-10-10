import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AdminRaffleV2Configuration,
  AdminRaffleV2DrawPage,
  AdminRaffleV2Overview,
  AdminRaffleV2Preview,
  AdminReward,
  ApiError,
  activateAdminRaffleV2Draft,
  createAdminRaffleV2Draft,
  createAdminRaffleV2Reward,
  getAdminRaffleV2,
  listAdminRaffleV2Draws,
  listAdminRewards,
  previewAdminRaffleV2Draft,
  replaceAdminRaffleV2Outcomes,
  setAdminRaffleV2Availability,
  updateAdminRaffleV2Draft,
} from './api';

type OutcomeEdit = { rewardId: string; weight: string };

export function RaffleV2Admin({ token }: { token: string }) {
  const [overview, setOverview] = useState<AdminRaffleV2Overview | null>(null);
  const [draws, setDraws] = useState<AdminRaffleV2DrawPage | null>(null);
  const [catalog, setCatalog] = useState<AdminReward[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [title, setTitle] = useState('Daily Draw');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('5');
  const [attempts, setAttempts] = useState('5');
  const [outcomes, setOutcomes] = useState<OutcomeEdit[]>([]);
  const [preview, setPreview] = useState<AdminRaffleV2Preview | null>(null);
  const [reason, setReason] = useState('Scheduled Raffle v2 configuration change');
  const [rewardCode, setRewardCode] = useState('');
  const [rewardTitle, setRewardTitle] = useState('');
  const [rewardType, setRewardType] = useState<'ERT' | 'ERU' | 'COPPER_RING'>('ERT');
  const [rewardAmount, setRewardAmount] = useState('5');
  const [message, setMessage] = useState('Loading Raffle v2');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [nextOverview, nextDraws, nextCatalog] = await Promise.all([
        getAdminRaffleV2(token), listAdminRaffleV2Draws(token), listAdminRewards(token),
      ]);
      setOverview(nextOverview);
      setDraws(nextDraws);
      setCatalog(nextCatalog.filter((reward) => reward.isActive));
      const nextId = selectedId && nextOverview.configurations.some((item) => item.id === selectedId)
        ? selectedId
        : nextOverview.configurations.find((item) => item.status === 'DRAFT')?.id
          ?? nextOverview.configurations.find((item) => item.status === 'ACTIVE')?.id
          ?? '';
      setSelectedId(nextId);
      setMessage('Raffle v2 state refreshed');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [selectedId, token]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(
    () => overview?.configurations.find((item) => item.id === selectedId) ?? null,
    [overview, selectedId],
  );
  const active = overview?.configurations.find((item) => item.status === 'ACTIVE') ?? null;

  useEffect(() => {
    if (!selected) return;
    setTitle(selected.title);
    setDescription(selected.description ?? '');
    setCost(selected.cost.amountExact);
    setAttempts(String(selected.dailyUserAttemptLimit));
    setOutcomes(selected.rewards.map((item) => ({ rewardId: item.rewardId, weight: item.weight })));
    setPreview(null);
  }, [selected]);

  const run = useCallback(async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      setMessage(success);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const createDraft = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const created = await createAdminRaffleV2Draft(token, draftInput(title, description, cost, attempts));
      setSelectedId(String(created.id));
    }, 'Draft created');
  };

  const saveDraft = () => selected && void run(
    () => updateAdminRaffleV2Draft(token, selected.id, draftInput(title, description, cost, attempts)),
    'Draft economics saved',
  );

  const saveOutcomes = () => selected && void run(
    () => replaceAdminRaffleV2Outcomes(token, selected.id, outcomes.map((item) => ({
      rewardId: item.rewardId, weight: Number(item.weight),
    }))),
    'Draft outcomes saved',
  );

  const validate = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await previewAdminRaffleV2Draft(token, selected.id);
      setPreview(result);
      setMessage(result.valid ? 'Draft is valid' : 'Draft has blocking validation errors');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const activate = () => {
    if (!selected || selected.status !== 'DRAFT' || !preview?.valid) return;
    if (!window.confirm(`Activate ${selected.title}? The current version will become immutable history.`)) return;
    void run(() => activateAdminRaffleV2Draft(token, selected.id, {
      expectedActiveConfigurationVersion: active?.id ?? null,
      reason,
      idempotencyKey: crypto.randomUUID(),
    }), 'Draft activated atomically');
  };

  const toggleAvailability = () => {
    const available = overview?.machine?.available;
    if (available === undefined || !reason.trim()) return;
    const action = available ? 'pause' : 'resume';
    if (!window.confirm(`${available ? 'Pause' : 'Resume'} Draw availability?`)) return;
    void run(() => setAdminRaffleV2Availability(token, action, {
      expectedAvailable: available,
      reason,
      idempotencyKey: crypto.randomUUID(),
    }), `Draw ${available ? 'paused' : 'resumed'}`);
  };

  const createReward = (event: FormEvent) => {
    event.preventDefault();
    void run(() => createAdminRaffleV2Reward(token, {
      code: rewardCode.trim(), title: rewardTitle.trim(), description: null, type: rewardType,
      amountExact: rewardType === 'COPPER_RING' ? null : rewardAmount.trim(), imageUrl: null,
      stockTotal: null, stockRemaining: null, perUserLimit: null, dailyGlobalLimit: null,
    }), 'Reward added to the Raffle v2 catalog');
  };

  return (
    <section className="panel raffle-v2-admin" aria-label="Raffle v2 management">
      <header className="raffle-v2-toolbar">
        <div><span className="admin-kicker">Singleton Draw</span><h2>Raffle v2</h2><p>{message}</p></div>
        <div className="panel-actions">
          <button type="button" className="ghost-button" onClick={() => void load()} disabled={busy}>Refresh</button>
          <button type="button" className={overview?.machine?.available ? 'danger-button' : ''} onClick={toggleAvailability} disabled={busy || !overview?.machine}>
            {overview?.machine?.available ? 'Pause Draw' : 'Resume Draw'}
          </button>
        </div>
      </header>

      <div className="raffle-v2-status" aria-label="Machine status">
        <span>Availability <strong>{overview?.machine?.available ? 'AVAILABLE' : 'PAUSED'}</strong></span>
        <span>Active version <strong>{shortId(active?.id)}</strong></span>
        <span>Versions <strong>{overview?.configurations.length ?? 0}</strong></span>
      </div>

      <div className="raffle-v2-layout">
        <aside className="version-list" aria-label="Configuration versions">
          <div className="admin-form-heading"><div><span>Immutable history</span><strong>Versions</strong></div></div>
          {overview?.configurations.map((item) => (
            <button type="button" key={item.id} className={selectedId === item.id ? 'selected' : ''} onClick={() => setSelectedId(item.id)}>
              <span>{item.status}</span><strong>{item.title}</strong><small>{shortId(item.id)} · {item.cost.amountDisplay} ERT · {item.dailyUserAttemptLimit}/day</small>
            </button>
          ))}
        </aside>

        <div className="raffle-v2-editor">
          <form className="admin-form" onSubmit={createDraft}>
            <div className="admin-form-heading"><div><span>{selected?.status ?? 'NEW'}</span><strong>Configuration economics</strong></div></div>
            <div className="form-grid-two">
              <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              <label>Entry price, exact ERT<input value={cost} inputMode="decimal" onChange={(event) => setCost(event.target.value)} /></label>
              <label>Attempts per UTC day<input value={attempts} inputMode="numeric" onChange={(event) => setAttempts(event.target.value)} /></label>
              <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            </div>
            <div className="panel-actions">
              <button type="submit" disabled={busy}>Create new draft</button>
              <button type="button" className="secondary-button" onClick={saveDraft} disabled={busy || selected?.status !== 'DRAFT'}>Save economics</button>
            </div>
          </form>

          <div className="admin-form">
            <div className="admin-form-heading"><div><span>Ordered integer weights</span><strong>Outcomes</strong></div></div>
            <div className="outcome-editor">
              {outcomes.map((item, index) => (
                <div key={`${item.rewardId}-${index}`}>
                  <span>{index + 1}</span>
                  <select value={item.rewardId} onChange={(event) => setOutcomes(replaceAt(outcomes, index, { ...item, rewardId: event.target.value }))} disabled={selected?.status !== 'DRAFT'}>
                    <option value="">Select reward</option>
                    {catalog.map((reward) => <option key={reward.id} value={reward.id}>{reward.code} · {reward.title}</option>)}
                  </select>
                  <input aria-label={`Outcome ${index + 1} weight`} value={item.weight} inputMode="numeric" onChange={(event) => setOutcomes(replaceAt(outcomes, index, { ...item, weight: event.target.value }))} disabled={selected?.status !== 'DRAFT'} />
                  <button type="button" title="Move up" onClick={() => setOutcomes(move(outcomes, index, -1))} disabled={index === 0 || selected?.status !== 'DRAFT'}>↑</button>
                  <button type="button" title="Move down" onClick={() => setOutcomes(move(outcomes, index, 1))} disabled={index === outcomes.length - 1 || selected?.status !== 'DRAFT'}>↓</button>
                  <button type="button" title="Remove" onClick={() => setOutcomes(outcomes.filter((_, itemIndex) => itemIndex !== index))} disabled={selected?.status !== 'DRAFT'}>×</button>
                </div>
              ))}
            </div>
            <div className="panel-actions">
              <button type="button" className="ghost-button" onClick={() => setOutcomes([...outcomes, { rewardId: catalog[0]?.id ?? '', weight: '1' }])} disabled={selected?.status !== 'DRAFT'}>Add outcome</button>
              <button type="button" onClick={saveOutcomes} disabled={busy || selected?.status !== 'DRAFT' || outcomes.length === 0}>Save outcomes</button>
            </div>
          </div>

          <div className="admin-form">
            <div className="admin-form-heading"><div><span>Canonical backend rules</span><strong>Validate and activate</strong></div></div>
            <label>Audit reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            <div className="panel-actions">
              <button type="button" className="secondary-button" onClick={() => void validate()} disabled={busy || selected?.status !== 'DRAFT'}>Validate / preview</button>
              <button type="button" onClick={activate} disabled={busy || !preview?.valid || selected?.status !== 'DRAFT'}>Activate version</button>
            </div>
            {preview && <Preview result={preview} />}
          </div>
        </div>
      </div>

      <details className="admin-form raffle-v2-catalog">
        <summary>Reward catalog · add supported fulfillment</summary>
        <form className="form-grid-two" onSubmit={createReward}>
          <label>Code<input value={rewardCode} onChange={(event) => setRewardCode(event.target.value)} /></label>
          <label>Title<input value={rewardTitle} onChange={(event) => setRewardTitle(event.target.value)} /></label>
          <label>Fulfillment<select value={rewardType} onChange={(event) => setRewardType(event.target.value as typeof rewardType)}><option>ERT</option><option>ERU</option><option>COPPER_RING</option></select></label>
          <label>Exact amount<input value={rewardAmount} disabled={rewardType === 'COPPER_RING'} onChange={(event) => setRewardAmount(event.target.value)} /></label>
          <button type="submit" disabled={busy || !rewardCode.trim() || !rewardTitle.trim()}>Add catalog reward</button>
        </form>
      </details>

      <RaffleV2Evidence page={draws} />
    </section>
  );
}

function Preview({ result }: { result: AdminRaffleV2Preview }) {
  return <div className="preview-result" aria-label="Draft economic preview">
    <strong>{result.valid ? 'VALID' : 'INVALID'} · total weight {result.totalWeight}</strong>
    {result.issues.length === 0 ? <span>No issues</span> : result.issues.map((issue) => <span key={`${issue.code}-${issue.message}`} className={issue.severity === 'ERROR' ? 'state-error' : 'state-muted'}>{issue.severity}: {issue.message}</span>)}
    <details><summary>Exact economic evidence</summary><pre>{JSON.stringify(result.economy, null, 2)}</pre></details>
  </div>;
}

function RaffleV2Evidence({ page }: { page: AdminRaffleV2DrawPage | null }) {
  return <div className="admin-table-wrap raffle-v2-evidence"><table className="admin-table"><caption>Raffle v2 immutable draw evidence</caption><thead><tr><th>Completed</th><th>Operation</th><th>Configuration</th><th>Selection evidence</th><th>Fulfillment</th></tr></thead><tbody>
    {page?.items.map((item) => <tr key={item.id}><td>{formatDate(item.completedAt ?? item.createdAt)}</td><td><strong>{shortId(item.operationKey)}</strong><span>{String(item.id)}</span></td><td>{shortId(item.configurationVersion ?? item.configurationId)}</td><td><code>{JSON.stringify({ ticket: item.ticket, totalWeight: item.totalWeight, reward: item.rewardSnapshot })}</code></td><td><code>{JSON.stringify(item.fulfillment ?? item.responseSnapshot ?? {})}</code></td></tr>)}
    {!page?.items.length && <tr><td colSpan={5}>No Raffle v2 draws recorded.</td></tr>}
  </tbody></table></div>;
}

function draftInput(title: string, description: string, cost: string, attempts: string) {
  return { title: title.trim(), description: description.trim() || null, costErtExact: cost.trim(), dailyUserAttemptLimit: Number(attempts) };
}

function replaceAt<T>(items: T[], index: number, value: T) { return items.map((item, itemIndex) => itemIndex === index ? value : item); }
function move<T>(items: T[], index: number, delta: number) { const target = index + delta; if (target < 0 || target >= items.length) return items; const copy = [...items]; [copy[index], copy[target]] = [copy[target], copy[index]]; return copy; }
function shortId(value: unknown) { const text = typeof value === 'string' ? value : ''; return text ? `${text.slice(0, 8)}…` : 'none'; }
function formatDate(value: unknown) { return typeof value === 'string' ? new Date(value).toLocaleString() : 'pending'; }
function errorMessage(error: unknown) { return error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Raffle v2 request failed'; }

export async function createCatalogRewardForRaffleV2(token: string, input: Record<string, unknown>) {
  return createAdminRaffleV2Reward(token, input);
}
