import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';

export enum CopperAttributeAllocationErrorCode {
  RequestInvalid = 'RING_ATTRIBUTE_ALLOCATION_REQUEST_INVALID',
  AllocationInvalid = 'RING_ATTRIBUTE_ALLOCATION_INVALID',
  StalePoints = 'RING_ATTRIBUTE_POINTS_STALE',
  InsufficientPoints = 'RING_ATTRIBUTE_POINTS_INSUFFICIENT',
  IdempotencyConflict = 'RING_ATTRIBUTE_ALLOCATION_IDEMPOTENCY_CONFLICT',
  WriteUnavailable = 'RING_ATTRIBUTE_ALLOCATION_WRITE_UNAVAILABLE',
}

export function copperAttributeAllocationRequestInvalid() {
  return new BadRequestException({
    message: 'Attribute allocation request is invalid',
    error: 'Bad Request',
    code: CopperAttributeAllocationErrorCode.RequestInvalid,
  });
}

export function copperAttributeAllocationInvalid() {
  return new BadRequestException({
    message: 'Attribute allocation is invalid',
    error: 'Bad Request',
    code: CopperAttributeAllocationErrorCode.AllocationInvalid,
  });
}

export function copperAttributePointsStale() {
  return new ConflictException({
    message: 'Unspent attribute points changed; reload the ring',
    error: 'Conflict',
    code: CopperAttributeAllocationErrorCode.StalePoints,
  });
}

export function copperAttributePointsInsufficient() {
  return new ConflictException({
    message: 'Unspent attribute points are insufficient',
    error: 'Conflict',
    code: CopperAttributeAllocationErrorCode.InsufficientPoints,
  });
}

export function copperAttributeAllocationIdempotencyConflict() {
  return new ConflictException({
    message: 'Idempotency key was already used for another allocation',
    error: 'Conflict',
    code: CopperAttributeAllocationErrorCode.IdempotencyConflict,
  });
}

export function copperAttributeAllocationWriteUnavailable() {
  return new ServiceUnavailableException({
    message: 'Attribute allocation is temporarily unavailable',
    error: 'Service Unavailable',
    code: CopperAttributeAllocationErrorCode.WriteUnavailable,
  });
}
