import { ConflictException } from '@nestjs/common';

export const M2E_RING_SELECTION_UNAVAILABLE = 'M2E_RING_SELECTION_UNAVAILABLE';

export function m2eRingSelectionUnavailable() {
  return new ConflictException({
    statusCode: 409,
    message: 'M2E Ring selection is unavailable for this account state',
    error: 'Conflict',
    code: M2E_RING_SELECTION_UNAVAILABLE,
  });
}
