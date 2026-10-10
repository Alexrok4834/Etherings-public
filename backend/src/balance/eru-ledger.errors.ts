import { BadRequestException, ConflictException } from '@nestjs/common';

export enum EruLedgerErrorCode {
  IdempotencyConflict = 'ERU_IDEMPOTENCY_CONFLICT',
  InsufficientBalance = 'INSUFFICIENT_ERU_BALANCE',
}

export function eruIdempotencyConflict() {
  return new ConflictException({
    message: 'ERU mutation reference conflicts with an existing transaction',
    error: 'Conflict',
    code: EruLedgerErrorCode.IdempotencyConflict,
  });
}

export function insufficientEruBalance() {
  return new BadRequestException({
    message: 'Insufficient ERU balance',
    error: 'Bad Request',
    code: EruLedgerErrorCode.InsufficientBalance,
  });
}
