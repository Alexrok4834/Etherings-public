import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';

export enum CopperLevelUpErrorCode {
  PreviewRequestInvalid = 'RING_LEVEL_PREVIEW_REQUEST_INVALID',
  AllocationInvalid = 'RING_LEVEL_ALLOCATION_INVALID',
  StaleLevel = 'RING_LEVEL_STALE',
  TransitionInvalid = 'RING_LEVEL_TRANSITION_INVALID',
  MutationRequestInvalid = 'RING_LEVEL_MUTATION_REQUEST_INVALID',
  InsufficientErt = 'RING_LEVEL_INSUFFICIENT_ERT',
  InsufficientEru = 'RING_LEVEL_INSUFFICIENT_ERU',
  IdempotencyConflict = 'RING_LEVEL_IDEMPOTENCY_CONFLICT',
  WriteUnavailable = 'RING_LEVEL_WRITE_UNAVAILABLE',
}

export function copperLevelMutationRequestInvalid() {
  return new BadRequestException({
    message: 'Level-up request is invalid', error: 'Bad Request', code: CopperLevelUpErrorCode.MutationRequestInvalid,
  });
}

export function copperLevelInsufficientErt() {
  return new ConflictException({
    message: 'ERT balance is insufficient', error: 'Conflict', code: CopperLevelUpErrorCode.InsufficientErt,
  });
}

export function copperLevelInsufficientEru() {
  return new ConflictException({
    message: 'ERU balance is insufficient', error: 'Conflict', code: CopperLevelUpErrorCode.InsufficientEru,
  });
}

export function copperLevelIdempotencyConflict() {
  return new ConflictException({
    message: 'Idempotency key was already used for another request', error: 'Conflict', code: CopperLevelUpErrorCode.IdempotencyConflict,
  });
}

export function copperLevelWriteUnavailable() {
  return new ServiceUnavailableException({
    message: 'Level-up is temporarily unavailable', error: 'Service Unavailable', code: CopperLevelUpErrorCode.WriteUnavailable,
  });
}

export function copperLevelPreviewRequestInvalid() {
  return new BadRequestException({
    message: 'Level preview request is invalid',
    error: 'Bad Request',
    code: CopperLevelUpErrorCode.PreviewRequestInvalid,
  });
}

export function copperLevelAllocationInvalid() {
  return new BadRequestException({
    message: 'Attribute allocation must contain exactly four integer points',
    error: 'Bad Request',
    code: CopperLevelUpErrorCode.AllocationInvalid,
  });
}

export function copperLevelStale() {
  return new ConflictException({
    message: 'Ring level changed; request a new preview',
    error: 'Conflict',
    code: CopperLevelUpErrorCode.StaleLevel,
  });
}

export function copperLevelTransitionInvalid() {
  return new ConflictException({
    message: 'Requested level transition is unavailable',
    error: 'Conflict',
    code: CopperLevelUpErrorCode.TransitionInvalid,
  });
}
