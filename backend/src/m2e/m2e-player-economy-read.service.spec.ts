import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { M2ePlayerEconomyReadService } from './m2e-player-economy-read.service';

class FakeDataSource {
  rows: unknown[][] = [];
  calls: Array<{ sql: string; parameters: unknown[] }> = [];

  async query(sql: string, parameters: unknown[]) {
    this.calls.push({ sql, parameters });
    return this.rows.shift() ?? [];
  }
}

const config = {
  getConfig: () => ({
    version: 'move-to-earn-balance-v1',
    baseSteps: 5000,
    extraStepsPerRing: 1000,
    baseErtPer1000Steps: '0.871',
    comfortCurveK: 20,
  }),
};

describe('M2ePlayerEconomyReadService', () => {
  it('returns exact strings, two-decimal displays, and the frozen profile cap', async () => {
    const dataSource = new FakeDataSource();
    dataSource.rows.push([{
      ertBalance: '6.532500000000000000',
      lifetimeEarnedErt: '11.792600000000000000',
      lifetimeSpentErt: '1.005000000000000000',
      earnedErtToday: '0.130650000000000000',
      dailyStepCap: 6000,
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
    }]);
    const service = new M2ePlayerEconomyReadService(dataSource as never, config as never);

    assert.deepEqual(await service.getProfile('user-1', '2026-08-21'), {
      ertBalance: { exact: '6.5325', display: '6.53' },
      lifetimeEarnedErt: { exact: '11.7926', display: '11.79' },
      lifetimeSpentErt: { exact: '1.005', display: '1.01' },
      earnedErtToday: { exact: '0.13065', display: '0.13' },
      dailyStepCap: 6000,
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
    });
    assert.deepEqual(dataSource.calls[0].parameters, [
      'user-1', '2026-08-21', 5000, 'move-to-earn-earning-v1', 'move-to-earn-balance-v1',
    ]);
  });

  it('maps exact activity values by date with snapshot-specific caps', async () => {
    const dataSource = new FakeDataSource();
    dataSource.rows.push([
      {
        date: '2026-08-21', earnedErt: '6.532500000000000000', dailyStepCap: 5000,
        rulesVersion: 'move-to-earn-earning-v1', balanceConfigVersion: 'move-to-earn-balance-v1',
      },
      {
        date: '2026-08-20', earnedErt: '2.000000000000000000', dailyStepCap: 6000,
        rulesVersion: 'move-to-earn-earning-v1', balanceConfigVersion: 'move-to-earn-balance-v1',
      },
    ]);
    const service = new M2ePlayerEconomyReadService(dataSource as never, config as never);

    const result = await service.getActivity('user-1', '2026-08-20', '2026-08-21');
    assert.deepEqual(result.get('2026-08-21'), {
      date: '2026-08-21',
      earnedErt: { exact: '6.5325', display: '6.53' },
      dailyStepCap: 5000,
      rulesVersion: 'move-to-earn-earning-v1',
      balanceConfigVersion: 'move-to-earn-balance-v1',
    });
    assert.deepEqual(result.get('2026-08-20')?.earnedErt, { exact: '2', display: '2.00' });
  });

  it('fails closed when the initialized balance row is missing', async () => {
    const service = new M2ePlayerEconomyReadService(new FakeDataSource() as never, config as never);
    await assert.rejects(() => service.getProfile('user-1', '2026-08-21'), /balance is unavailable/);
  });
});
