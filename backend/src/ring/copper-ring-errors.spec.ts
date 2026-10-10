import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TypeORMError } from 'typeorm';
import {
  CopperRingErrorCode,
  copperRingNotFound,
  copperRingReadUnavailable,
  copperRingStateConflict,
  withCopperRingReadContract,
} from './copper-ring-errors';

describe('Copper ring stable read errors', () => {
  it('defines stable status, message, error, and code payloads', () => {
    assertException(copperRingNotFound(), 404, 'Ring not found', 'Not Found', CopperRingErrorCode.NotFound);
    assertException(
      copperRingStateConflict(),
      409,
      'Ring state is inconsistent',
      'Conflict',
      CopperRingErrorCode.StateConflict,
    );
    assertException(
      copperRingReadUnavailable(),
      503,
      'Ring data is temporarily unavailable',
      'Service Unavailable',
      CopperRingErrorCode.ReadUnavailable,
    );
  });

  it('maps only TypeORM failures to unavailable and preserves unexpected defects', async () => {
    await assert.rejects(
      () => withCopperRingReadContract(async () => { throw new TypeORMError('connection detail'); }),
      (error) => (error as { getResponse?: () => unknown }).getResponse
        && ((error as { getResponse: () => { code?: string } }).getResponse()).code
          === CopperRingErrorCode.ReadUnavailable,
    );

    const defect = new Error('programming defect');
    await assert.rejects(
      () => withCopperRingReadContract(async () => { throw defect; }),
      (error) => error === defect,
    );
  });
});

function assertException(
  exception: { getStatus: () => number; getResponse: () => string | object },
  status: number,
  message: string,
  error: string,
  code: CopperRingErrorCode,
) {
  assert.equal(exception.getStatus(), status);
  assert.deepEqual(exception.getResponse(), { message, error, code });
}
