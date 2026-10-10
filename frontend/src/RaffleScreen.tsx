import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  ProfileResponse,
  RaffleDrawResult,
  RaffleHistoryItem,
  RafflePool,
  drawRafflePool,
  fetchProfile,
  listRaffleHistory,
  listRafflePools,
} from './api';

export function RaffleScreen({ token, onProfileUpdate }: { token: string; onProfileUpdate: (profile: ProfileResponse) => void }) {
  const [pools, setPools] = useState<RafflePool[]>([]);
  const [history, setHistory] = useState<RaffleHistoryItem[]>([]);
  const [result, setResult] = useState<RaffleDrawResult | null>(null);
  const [message, setMessage] = useState('Loading raffle pools');
  const [isBusy, setIsBusy] = useState(false);

  const loadRaffle = useCallback(async () => {
    setIsBusy(true);
    try {
      const [nextPools, nextHistory] = await Promise.all([
        listRafflePools(),
        listRaffleHistory(token),
      ]);
      setPools(nextPools);
      setHistory(nextHistory.slice(0, 5));
      setMessage(nextPools.length === 0 ? 'No active raffle pools.' : 'Choose a pool to draw.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }, [token]);

  useEffect(() => {
    void loadRaffle();
  }, [loadRaffle]);

  const drawPool = useCallback(async (pool: RafflePool) => {
    setIsBusy(true);
    setMessage(`Drawing ${pool.title}`);

    try {
      const drawResult = await drawRafflePool(token, pool.id);
      const [profile, nextHistory, nextPools] = await Promise.all([
        fetchProfile(token),
        listRaffleHistory(token),
        listRafflePools(),
      ]);
      setResult(drawResult);
      setHistory(nextHistory.slice(0, 5));
      setPools(nextPools);
      onProfileUpdate(profile);
      setMessage('Draw complete.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }, [onProfileUpdate, token]);

  return (
    <>
      <section className="raffle-panel" aria-label="Raffle pools">
        <div className="raffle-heading">
          <div>
            <span>Raffle</span>
            <strong>Active pools</strong>
          </div>
          <button type="button" className="ghost-button" onClick={loadRaffle} disabled={isBusy}>Refresh</button>
        </div>
        <p className="walk-message">{message}</p>

        <div className="pool-list">
          {pools.map((pool) => (
            <article key={pool.id} className="pool-item">
              <div className="pool-title-row">
                <div>
                  <span>{pool.code}</span>
                  <strong>{pool.title}</strong>
                </div>
                <b>{pool.costErt} ERT</b>
              </div>
              {pool.description ? <p>{pool.description}</p> : null}
              <div className="reward-preview">
                {pool.rewards.length === 0 ? <span>No eligible rewards</span> : pool.rewards.map((reward) => (
                  <div key={reward.id}>
                    <span>{reward.title}</span>
                    <strong>{formatPercent(reward.probability)}</strong>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => drawPool(pool)} disabled={isBusy || pool.rewards.length === 0}>
                Draw
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="panel compact-panel">
        <div>
          <h2>Recent draws</h2>
          <p>{history.length === 0 ? 'No raffle draws yet.' : 'Latest raffle results.'}</p>
        </div>
        {history.length > 0 ? (
          <div className="recent-list">
            {history.map((item) => (
              <div key={item.draw.id}>
                <span>{formatDate(item.draw.createdAt)}</span>
                <strong>{item.userReward?.title ?? rewardTitleFromSnapshot(item.draw.rewardSnapshot)}</strong>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {result ? <ResultModal result={result} onClose={() => setResult(null)} /> : null}
    </>
  );
}
function ResultModal({ result, onClose }: { result: RaffleDrawResult; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Raffle result">
      <section className="result-modal">
        <span>Reward won</span>
        <h2>{result.userReward.title}</h2>
        <p>{rewardDescription(result)}</p>
        <div className="result-grid">
          <span>Cost</span>
          <strong>{result.draw.costErt} ERT</strong>
        </div>
        <button type="button" onClick={onClose}>Close</button>
      </section>
    </div>
  );
}

function rewardDescription(result: RaffleDrawResult) {
  if (result.userReward.type === 'ERT' && result.userReward.amount !== null) {
    return `${formatNumber(result.userReward.amount)} ERT was credited to your balance.`;
  }

  return `${result.userReward.type} reward added to your inventory.`;
}

function rewardTitleFromSnapshot(snapshot: Record<string, unknown>) {
  return typeof snapshot.title === 'string' ? snapshot.title : 'Reward';
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected raffle error';
}