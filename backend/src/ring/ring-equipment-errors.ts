import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';

export enum RingEquipmentErrorCode {
  RequestInvalid = 'RING_EQUIPMENT_REQUEST_INVALID',
  Stale = 'RING_EQUIPMENT_STALE',
  IdempotencyConflict = 'RING_EQUIPMENT_IDEMPOTENCY_CONFLICT',
  WriteUnavailable = 'RING_EQUIPMENT_WRITE_UNAVAILABLE',
}

export function ringEquipmentRequestInvalid() {
  return new BadRequestException({
    message: 'Ring equipment request is invalid',
    error: 'Bad Request',
    code: RingEquipmentErrorCode.RequestInvalid,
  });
}

export function ringEquipmentStale() {
  return new ConflictException({
    message: 'Equipped Ring changed before this request',
    error: 'Conflict',
    code: RingEquipmentErrorCode.Stale,
  });
}

export function ringEquipmentIdempotencyConflict() {
  return new ConflictException({
    message: 'Idempotency key was already used for another equipment request',
    error: 'Conflict',
    code: RingEquipmentErrorCode.IdempotencyConflict,
  });
}

export function ringEquipmentWriteUnavailable() {
  return new ServiceUnavailableException({
    message: 'Ring equipment is temporarily unavailable',
    error: 'Service Unavailable',
    code: RingEquipmentErrorCode.WriteUnavailable,
  });
}
