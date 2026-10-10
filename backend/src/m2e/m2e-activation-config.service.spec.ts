import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { M2eActivationConfigService } from './m2e-activation-config.service';

class FakeConfigService {
  constructor(private readonly values: Record<string, string | undefined> = {}) {}

  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

const CANARY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CANARY_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const START_DATE = '2026-08-31';

function service(values: Record<string, string | undefined> = {}) {
  return new M2eActivationConfigService(new FakeConfigService(values) as never);
}

describe('M2eActivationConfigService', () => {
  it('defaults to inactive and lets global false dominate any allowlist value', () => {
    assert.equal(service().isEarningEnabledForUser(CANARY_A, START_DATE), false);
    assert.equal(service({
      M2E_EARNING_ENABLED: 'false',
      M2E_EARNING_SCOPE: 'GLOBAL',
      M2E_GLOBAL_START_DATE: 'not-a-date',
      M2E_CANARY_USER_IDS: 'not-a-uuid',
    }).isEarningEnabledForUser(CANARY_A, START_DATE), false);
  });

  it('activates only listed owners when the global gate is true', () => {
    const activation = service({
      M2E_EARNING_ENABLED: 'true',
      M2E_EARNING_SCOPE: 'CANARY',
      M2E_CANARY_USER_IDS: `${CANARY_A},${CANARY_B}`,
    });
    assert.equal(activation.isEarningEnabledForUser(CANARY_A, '2026-08-30'), true);
    assert.equal(activation.isEarningEnabledForUser(CANARY_B, START_DATE), true);
    assert.equal(activation.isEarningEnabledForUser('cccccccc-0000-4000-8000-000000000003', START_DATE), false);
    assert.equal(activation.isEarningEnabledForUser(CANARY_A.toUpperCase(), START_DATE), false);
  });

  it('accepts only the exact global true/false literals', () => {
    for (const invalid of ['TRUE', '1', 'yes', '', ' true ']) {
      assert.throws(
        () => service({ M2E_EARNING_ENABLED: invalid, M2E_CANARY_USER_IDS: CANARY_A }),
        /must be exactly true or false/,
      );
    }
  });

  it('activates every owner only in explicit GLOBAL scope', () => {
    const activation = service({
      M2E_EARNING_ENABLED: 'true',
      M2E_EARNING_SCOPE: 'GLOBAL',
      M2E_GLOBAL_START_DATE: START_DATE,
      M2E_CANARY_USER_IDS: '',
    });
    assert.equal(activation.isEarningEnabledForUser(CANARY_A, '2026-08-30'), false);
    assert.equal(activation.isEarningEnabledForUser(CANARY_B, START_DATE), true);
    assert.equal(activation.isEarningEnabledForUser('cccccccc-0000-4000-8000-000000000003', '2026-09-01'), true);
  });

  it('requires an explicit activation scope when earning is enabled', () => {
    for (const invalid of [undefined, '', 'canary', 'global', 'ALL', ' GLOBAL ']) {
      assert.throws(
        () => service({
          M2E_EARNING_ENABLED: 'true',
          M2E_EARNING_SCOPE: invalid,
          M2E_CANARY_USER_IDS: CANARY_A,
        }),
        /M2E_EARNING_SCOPE/,
      );
    }
  });

  it('rejects a canary allowlist in GLOBAL scope', () => {
    assert.throws(
      () => service({
        M2E_EARNING_ENABLED: 'true',
        M2E_EARNING_SCOPE: 'GLOBAL',
        M2E_GLOBAL_START_DATE: START_DATE,
        M2E_CANARY_USER_IDS: CANARY_A,
      }),
      /must be empty/,
    );
  });

  it('requires a valid canonical start date only in GLOBAL scope', () => {
    for (const invalid of [undefined, '', '2026-8-31', '2026-02-30', '31-08-2026', ' 2026-08-31']) {
      assert.throws(
        () => service({
          M2E_EARNING_ENABLED: 'true',
          M2E_EARNING_SCOPE: 'GLOBAL',
          M2E_GLOBAL_START_DATE: invalid,
          M2E_CANARY_USER_IDS: '',
        }),
        /M2E_GLOBAL_START_DATE/,
      );
    }
    assert.throws(
      () => service({
        M2E_EARNING_ENABLED: 'true',
        M2E_EARNING_SCOPE: 'CANARY',
        M2E_GLOBAL_START_DATE: START_DATE,
        M2E_CANARY_USER_IDS: CANARY_A,
      }),
      /must be empty/,
    );
  });

  it('fails startup when an active allowlist is missing, empty, or malformed', () => {
    for (const invalid of [
      undefined,
      '',
      ' ',
      ` ${CANARY_A}`,
      `${CANARY_A} `,
      `${CANARY_A},`,
      `${CANARY_A}, ${CANARY_B}`,
      CANARY_A.toUpperCase(),
      'not-a-uuid',
    ]) {
      assert.throws(
        () => service({
          M2E_EARNING_ENABLED: 'true',
          M2E_EARNING_SCOPE: 'CANARY',
          M2E_CANARY_USER_IDS: invalid,
        }),
        /M2E_CANARY_USER_IDS/,
      );
    }
  });

  it('fails startup when an active allowlist contains duplicate owners', () => {
    assert.throws(
      () => service({
        M2E_EARNING_ENABLED: 'true',
        M2E_EARNING_SCOPE: 'CANARY',
        M2E_CANARY_USER_IDS: `${CANARY_A},${CANARY_A}`,
      }),
      /must not contain duplicate UUIDs/,
    );
  });
});
