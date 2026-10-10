import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, RaffleHistoryItem, UserReward, listRaffleHistory } from './api';

export function RewardsScreen({ token }: { token: string }) {
  const [history, setHistory] = useState<RaffleHistoryItem[]>([]);
  const [message, setMessage] = useState('Loading inventory');
  const [isBusy, setIsBusy] = useState(false);

  const loadRewards = useCallback(async () => {
    setIsBusy(true);
    try {
      const nextHistory = await listRaffleHistory(token);
      setHistory(nextHistory);
      setMessage(nextHistory.some((item) => item.userReward) ? 'Inventory loaded.' : 'No rewards yet.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }, [token]);

  useEffect(() => {
    void loadRewards();
  }, [loadRewards]);

  const rewards = useMemo(() => history.map((item) => item.userReward).filter((reward): reward is UserReward => Boolean(reward)), [history]);
  const counts = useMemo(() => countRewards(rewards), [rewards]);

  return (
    <>
      <section className="rewards-panel" aria-label="Rewards inventory">
        <div className="raffle-heading">
          <div>
            <span>Rewards</span>
            <strong>Inventory</strong>
          </div>
          <button type="button" className="ghost-button" onClick={loadRewards} disabled={isBusy}>Refresh</button>
        </div>
        <p className="walk-message">{message}</p>

        <div className="reward-counters" aria-label="Reward counters">
          <article><span>ERT prizes</span><strong>{counts.ERT}</strong></article>
          <article><span>ERU prizes</span><strong>{counts.ERU}</strong></article>
          <article><span>Badges</span><strong>{counts.BADGE}</strong></article>
          <article><span>Items</span><strong>{counts.ITEM + counts.NFT_PLACEHOLDER}</strong></article>
        </div>
      </section>

      <section className="panel compact-panel">
        <div>
          <h2>Collected rewards</h2>
          <p>{rewards.length === 0 ? 'Win raffle rewards to fill this inventory.' : 'Latest rewards from raffle draws.'}</p>
        </div>
        {rewards.length > 0 ? (
          <div className="inventory-list">
            {rewards.map((reward) => (
              <article key={reward.id}>
                <div>
                  <span>{reward.type}</span>
                  <strong>{reward.title}</strong>
                </div>
                <b>{currencyRewardLabel(reward)}</b>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}

function countRewards(rewards: UserReward[]) {
  return rewards.reduce<Record<UserReward['type'], number>>((acc, reward) => {
    acc[reward.type] += 1;
    return acc;
  }, {
    ERT: 0,
    ERU: 0,
    BADGE: 0,
    ITEM: 0,
    NFT_PLACEHOLDER: 0,
  });
}

function currencyRewardLabel(reward: UserReward) {
  if (reward.type === 'ERT' || reward.type === 'ERU') {
    return `${reward.amountDisplay ?? reward.amountExact ?? reward.amount ?? '-'} ${reward.type}`;
  }
  return rewardLabel(reward.type);
}

function rewardLabel(type: UserReward['type']) {
  if (type === 'NFT_PLACEHOLDER') return 'NFT';
  return type;
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected rewards error';
}
