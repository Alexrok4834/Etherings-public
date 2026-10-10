import { GoneException } from '@nestjs/common';

export const LEGACY_RAFFLE_ADMIN_WRITE_RETIRED_CODE = 'LEGACY_RAFFLE_ADMIN_WRITE_RETIRED';

export function legacyRaffleAdminWriteRetired() {
  return new GoneException({
    message: 'Legacy raffle admin writes are retired; use Raffle v2 configuration management',
    error: 'Gone',
    code: LEGACY_RAFFLE_ADMIN_WRITE_RETIRED_CODE,
  });
}
