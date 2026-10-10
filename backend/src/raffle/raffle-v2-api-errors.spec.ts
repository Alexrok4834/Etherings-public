import assert from 'node:assert/strict';
import { BadRequestException, HttpException } from '@nestjs/common';
import { describe, it } from 'node:test';
import { RaffleV2ApiContractError } from './raffle-v2-api-contract';
import { toRaffleV2HttpException } from './raffle-v2-api-errors';
import { RaffleV2DrawCoreError, RaffleV2DrawCoreFailure } from './raffle-v2-draw-core.service';
import { RaffleV2FulfillmentError, RaffleV2FulfillmentFailure } from './raffle-v2-fulfillment.service';
import { RaffleV2SelectionError, RaffleV2SelectionFailure } from './raffle-v2-integer-selection.service';

describe('Raffle v2 HTTP error boundary', () => {
  it('maps every frozen player failure to its stable status and code', () => {
    const cases: Array<[unknown, number, string]> = [
      [new RaffleV2ApiContractError('REQUEST'), 400, 'RAFFLE_REQUEST_INVALID'],
      [new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidRequest), 400, 'RAFFLE_REQUEST_INVALID'],
      [new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.Unavailable), 404, 'RAFFLE_UNAVAILABLE'],
      [new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.ConfigurationStale), 409, 'RAFFLE_CONFIGURATION_STALE'],
      [new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.IdempotencyConflict), 409, 'RAFFLE_IDEMPOTENCY_CONFLICT'],
      [new RaffleV2FulfillmentError(RaffleV2FulfillmentFailure.InsufficientBalance), 409, 'RAFFLE_INSUFFICIENT_ERT'],
      [new RaffleV2FulfillmentError(RaffleV2FulfillmentFailure.DailyLimitReached), 409, 'RAFFLE_DAILY_LIMIT_REACHED'],
      [new RaffleV2FulfillmentError(RaffleV2FulfillmentFailure.NoEligibleReward), 409, 'RAFFLE_NO_ELIGIBLE_REWARD'],
      [new RaffleV2SelectionError(RaffleV2SelectionFailure.NoEligibleReward), 409, 'RAFFLE_NO_ELIGIBLE_REWARD'],
    ];
    for (const [error, status, code] of cases) assertHttp(error, status, code);
  });

  it('maps internal, RNG, owner, and unknown failures to the non-disclosing write-unavailable contract', () => {
    for (const error of [
      new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.InvalidState),
      new RaffleV2DrawCoreError(RaffleV2DrawCoreFailure.OwnerNotFound),
      new RaffleV2FulfillmentError(RaffleV2FulfillmentFailure.InvalidState),
      new RaffleV2SelectionError(RaffleV2SelectionFailure.InvalidRandomTicket),
      new RaffleV2ApiContractError('STATE'),
      new Error('database secret'),
    ]) assertHttp(error, 503, 'RAFFLE_WRITE_UNAVAILABLE');
  });

  it('preserves an existing transport exception', () => {
    const existing = new BadRequestException('existing');
    assert.equal(toRaffleV2HttpException(existing), existing);
  });
});

function assertHttp(error: unknown, status: number, code: string) {
  const mapped = toRaffleV2HttpException(error);
  assert.equal(mapped instanceof HttpException, true);
  assert.equal(mapped.getStatus(), status);
  assert.equal((mapped.getResponse() as { code?: string }).code, code);
}
