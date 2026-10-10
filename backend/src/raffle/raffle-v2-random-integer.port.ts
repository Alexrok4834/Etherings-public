export const RAFFLE_V2_RANDOM_INTEGER_PORT = Symbol('RAFFLE_V2_RANDOM_INTEGER_PORT');
export const RAFFLE_V2_RANDOM_ALGORITHM = 'CSPRNG_UNBIASED_INT_V1';
export const RAFFLE_V2_RANDOM_MAX_EXCLUSIVE = 2 ** 48;

export interface RaffleV2RandomIntegerPort {
  nextInt(maxExclusive: number): number;
}

export function isValidRaffleRandomBound(maxExclusive: number) {
  return Number.isSafeInteger(maxExclusive)
    && maxExclusive > 0
    && maxExclusive < RAFFLE_V2_RANDOM_MAX_EXCLUSIVE;
}

export function isValidRaffleRandomTicket(ticket: number, maxExclusive: number) {
  return Number.isSafeInteger(ticket) && ticket >= 0 && ticket < maxExclusive;
}
