import {
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TypeORMError } from 'typeorm';

export enum CopperRingErrorCode {
  NotFound = 'RING_NOT_FOUND',
  StateConflict = 'RING_STATE_CONFLICT',
  ReadUnavailable = 'RING_READ_UNAVAILABLE',
}

export function copperRingNotFound() {
  return new NotFoundException({
    message: 'Ring not found',
    error: 'Not Found',
    code: CopperRingErrorCode.NotFound,
  });
}

export function copperRingStateConflict() {
  return new ConflictException({
    message: 'Ring state is inconsistent',
    error: 'Conflict',
    code: CopperRingErrorCode.StateConflict,
  });
}

export function copperRingReadUnavailable() {
  return new ServiceUnavailableException({
    message: 'Ring data is temporarily unavailable',
    error: 'Service Unavailable',
    code: CopperRingErrorCode.ReadUnavailable,
  });
}

export async function withCopperRingReadContract<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    if (error instanceof TypeORMError) throw copperRingReadUnavailable();
    throw error;
  }
}
