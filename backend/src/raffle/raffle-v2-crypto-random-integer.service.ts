import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import {
  isValidRaffleRandomBound,
  isValidRaffleRandomTicket,
  RaffleV2RandomIntegerPort,
} from './raffle-v2-random-integer.port';

@Injectable()
export class RaffleV2CryptoRandomIntegerService implements RaffleV2RandomIntegerPort {
  nextInt(maxExclusive: number): number {
    if (!isValidRaffleRandomBound(maxExclusive)) {
      throw new RangeError('Raffle random upper bound is invalid');
    }

    const ticket = randomInt(0, maxExclusive);
    if (!isValidRaffleRandomTicket(ticket, maxExclusive)) {
      throw new Error('Raffle random source returned an invalid ticket');
    }
    return ticket;
  }
}
