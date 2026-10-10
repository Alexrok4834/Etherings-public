import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/user.entity';
import { LedgerTransactionType } from '../balance/ledger-transaction.entity';
import { LedgerService } from '../balance/ledger.service';
import { canonicalEru, displayEru, parseUnsignedEruDecimal } from '../balance/eru-decimal';
import { canonicalErt, displayErt } from '../m2e/ert-decimal';
import { RaffleDraw } from '../raffle/raffle-draw.entity';
import { RewardType } from '../raffle/reward.entity';

export type AdminBalanceAdjustmentInput = {
  userId?: unknown;
  amount?: unknown;
  reason?: unknown;
};

@Injectable()
export class AdminAuditService {
  constructor(
    @InjectRepository(RaffleDraw)
    private readonly raffleDrawRepository: Repository<RaffleDraw>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly ledgerService: LedgerService,
  ) {}

  async listRaffleDraws() {
    const draws = await this.raffleDrawRepository.find({
      relations: { user: true, pool: true, reward: true },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return draws.map((draw) => this.toDrawContract(draw));
  }

  async adjustBalance(input: AdminBalanceAdjustmentInput) {
    const userId = this.requiredString(input.userId, 'userId', 128);
    const amount = this.requiredSignedInteger(input.amount, 'amount');
    const reason = this.requiredString(input.reason, 'reason', 512);
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const amountExact = canonicalErt(String(Math.abs(amount)));
    const mutation = {
      userId,
      amount: amountExact,
      type: LedgerTransactionType.AdminAdjustment,
      referenceType: 'admin_adjustment',
      referenceId: null,
      metadata: { reason },
    };

    const result = amount > 0
      ? await this.ledgerService.creditDecimal(mutation)
      : await this.ledgerService.debitDecimal(mutation);

    return this.toAdjustmentContract(result, mutation);
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new BadRequestException(`${field} is required`);
    }

    const trimmed = value.trim();

    if (trimmed.length > maxLength) {
      throw new BadRequestException(`${field} is too long`);
    }

    return trimmed;
  }

  private requiredSignedInteger(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value === 0) {
      throw new BadRequestException(`${field} must be a non-zero integer`);
    }

    return value;
  }

  private toDrawContract(draw: RaffleDraw) {
    const costErtExact = exactIntegerErt(draw.costErt, 'draw.costErt');
    const snapshot = draw.rewardSnapshot ?? {};
    let amount = { exact: null as string | null, display: null as string | null };
    if (snapshot.type === RewardType.Ert && snapshot.amount !== null && snapshot.amount !== undefined) {
      amount = exactIntegerContract(snapshot.amount, 'draw.rewardSnapshot.amount');
    } else if (snapshot.type === RewardType.Eru) {
      const exact = canonicalEru(snapshot.amountExact, 'draw.rewardSnapshot.amountExact');
      parseUnsignedEruDecimal(exact, 'draw.rewardSnapshot.amountExact', false);
      amount = { exact, display: displayEru(exact) };
    }
    return {
      ...draw,
      costErtExact,
      costErtDisplay: displayErt(costErtExact),
      rewardSnapshot: {
        ...snapshot,
        amountExact: amount.exact,
        amountDisplay: amount.display,
      },
    };
  }

  private toAdjustmentContract(
    result: Awaited<ReturnType<LedgerService['creditDecimal']>>,
    mutation: { userId: string; type: LedgerTransactionType; referenceType: string; referenceId: null; metadata: { reason: string } },
  ) {
    const signedAmountExact = canonicalErt(result.ledgerTransaction.amount);
    return {
      balance: {
        userId: mutation.userId,
        ertBalance: Number(result.balance.ertBalance),
        ertBalanceExact: result.balance.ertBalance,
        ertBalanceDisplay: displayErt(result.balance.ertBalance),
        lifetimeEarnedErt: Number(result.balance.lifetimeEarnedErt),
        lifetimeEarnedErtExact: result.balance.lifetimeEarnedErt,
        lifetimeEarnedErtDisplay: displayErt(result.balance.lifetimeEarnedErt),
        lifetimeSpentErt: Number(result.balance.lifetimeSpentErt),
        lifetimeSpentErtExact: result.balance.lifetimeSpentErt,
        lifetimeSpentErtDisplay: displayErt(result.balance.lifetimeSpentErt),
        updatedAt: result.balance.updatedAt,
      },
      ledgerTransaction: {
        id: result.ledgerTransaction.id,
        userId: mutation.userId,
        type: mutation.type,
        amount: Number(signedAmountExact),
        amountExact: signedAmountExact,
        amountDisplay: displayErt(signedAmountExact),
        balanceAfter: Number(result.ledgerTransaction.balanceAfter),
        balanceAfterExact: result.ledgerTransaction.balanceAfter,
        balanceAfterDisplay: displayErt(result.ledgerTransaction.balanceAfter),
        referenceType: mutation.referenceType,
        referenceId: mutation.referenceId,
        metadata: mutation.metadata,
        createdAt: result.ledgerTransaction.createdAt,
      },
    };
  }
}

function exactIntegerErt(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return canonicalErt(String(value));
}

function exactIntegerContract(value: unknown, field: string) {
  if (typeof value !== 'number') throw new Error(`${field} must be a number`);
  const exact = exactIntegerErt(value, field);
  return { exact, display: displayErt(exact) };
}
