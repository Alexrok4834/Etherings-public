import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RaffleV2ApiContractError } from './raffle-v2-api-contract';
import { RaffleV2DrawCoreError, RaffleV2DrawCoreFailure } from './raffle-v2-draw-core.service';
import { RaffleV2FulfillmentError, RaffleV2FulfillmentFailure } from './raffle-v2-fulfillment.service';
import { RaffleV2SelectionError, RaffleV2SelectionFailure } from './raffle-v2-integer-selection.service';

export function toRaffleV2HttpException(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof RaffleV2ApiContractError && error.boundary === 'REQUEST') return apiError(BadRequestException,
    'Invalid Raffle request', 'RAFFLE_REQUEST_INVALID');
  if (error instanceof RaffleV2DrawCoreError) {
    if (error.reason === RaffleV2DrawCoreFailure.InvalidRequest) return apiError(BadRequestException,
      'Invalid Raffle request', 'RAFFLE_REQUEST_INVALID');
    if (error.reason === RaffleV2DrawCoreFailure.Unavailable) return apiError(NotFoundException,
      'Raffle is unavailable', 'RAFFLE_UNAVAILABLE');
    if (error.reason === RaffleV2DrawCoreFailure.ConfigurationStale) return apiError(ConflictException,
      'Raffle configuration is stale', 'RAFFLE_CONFIGURATION_STALE');
    if (error.reason === RaffleV2DrawCoreFailure.IdempotencyConflict) return apiError(ConflictException,
      'Raffle operation key conflicts with another request', 'RAFFLE_IDEMPOTENCY_CONFLICT');
  }
  if (error instanceof RaffleV2FulfillmentError) {
    if (error.reason === RaffleV2FulfillmentFailure.InsufficientBalance) return apiError(ConflictException,
      'Insufficient ERT balance', 'RAFFLE_INSUFFICIENT_ERT');
    if (error.reason === RaffleV2FulfillmentFailure.DailyLimitReached) return apiError(ConflictException,
      'Daily Raffle limit reached', 'RAFFLE_DAILY_LIMIT_REACHED');
    if (error.reason === RaffleV2FulfillmentFailure.NoEligibleReward) return noEligibleReward();
  }
  if (error instanceof RaffleV2SelectionError
    && error.reason === RaffleV2SelectionFailure.NoEligibleReward) return noEligibleReward();
  return apiError(ServiceUnavailableException,
    'Raffle write is temporarily unavailable', 'RAFFLE_WRITE_UNAVAILABLE');
}

function noEligibleReward() {
  return apiError(ConflictException, 'No eligible Raffle reward', 'RAFFLE_NO_ELIGIBLE_REWARD');
}

type ExceptionConstructor = new (response: object) => HttpException;

function apiError(Exception: ExceptionConstructor, message: string, code: string) {
  return new Exception({ message, error: errorLabel(Exception), code });
}

function errorLabel(Exception: ExceptionConstructor) {
  if (Exception === BadRequestException) return 'Bad Request';
  if (Exception === NotFoundException) return 'Not Found';
  if (Exception === ConflictException) return 'Conflict';
  return 'Service Unavailable';
}
