import { EntityManager } from 'typeorm';
import { RaffleConfiguration } from './raffle-configuration.entity';
import { RaffleConfigurationReward } from './raffle-configuration-reward.entity';
import { RaffleDrawOperation } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { RaffleMachine } from './raffle-machine.entity';
import { RaffleV2IntegerSelection } from './raffle-v2-integer-selection.service';

export const RAFFLE_V2_FULFILLMENT_PORT = Symbol('RAFFLE_V2_FULFILLMENT_PORT');

export type RaffleV2LockedDraw = Readonly<{
  machine: RaffleMachine;
  configuration: RaffleConfiguration;
  rewards: ReadonlyArray<RaffleConfigurationReward>;
}>;

export type RaffleV2PreparedFulfillment = Readonly<{
  eligibleRewardIds: ReadonlyArray<string>;
  state: unknown;
}>;

export type RaffleV2FulfillmentResponse = Readonly<{
  cost: Readonly<Record<string, unknown>>;
  attempts: Readonly<Record<string, unknown>>;
  fulfillment: Readonly<Record<string, unknown>>;
}>;

export interface RaffleV2FulfillmentPort {
  lockAndValidate(
    manager: EntityManager,
    input: Readonly<{
      ownerUserId: string;
      operation: RaffleDrawOperation;
      draw: RaffleV2LockedDraw;
    }>,
  ): Promise<RaffleV2PreparedFulfillment>;

  fulfill(
    manager: EntityManager,
    input: Readonly<{
      ownerUserId: string;
      operation: RaffleDrawOperation;
      draw: RaffleV2LockedDraw;
      selection: RaffleV2IntegerSelection;
      result: RaffleDrawResultV2;
      preparedState: unknown;
    }>,
  ): Promise<RaffleV2FulfillmentResponse>;
}
