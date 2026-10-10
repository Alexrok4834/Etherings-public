import { GoneException } from '@nestjs/common';

export const LEGACY_RAFFLE_PLAYER_DRAW_RETIRED_CODE = 'LEGACY_RAFFLE_PLAYER_DRAW_RETIRED';

export function legacyRafflePlayerDrawRetired() {
  return new GoneException({
    message: 'Legacy player Draw is retired; use Raffle v2 Draw',
    error: 'Gone',
    code: LEGACY_RAFFLE_PLAYER_DRAW_RETIRED_CODE,
  });
}
