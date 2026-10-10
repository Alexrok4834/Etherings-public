import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TelegramInitDataUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
};

export type VerifiedTelegramInitData = {
  fields: Record<string, string>;
  user: TelegramInitDataUser;
};

@Injectable()
export class TelegramInitDataService {
  verify(initData: string, botToken: string): VerifiedTelegramInitData {
    if (!initData || initData.trim().length === 0) {
      throw new BadRequestException('Telegram initData is required');
    }

    if (!botToken || botToken.trim().length === 0) {
      throw new BadRequestException('Telegram bot token is not configured');
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if (!hash) {
      throw new UnauthorizedException('Telegram initData hash is missing');
    }

    const fields = this.toRecord(params);
    const dataCheckString = this.buildDataCheckString(params);
    const expectedHash = this.sign(dataCheckString, botToken);

    if (!this.isSafeEqualHex(hash, expectedHash)) {
      throw new UnauthorizedException('Invalid Telegram initData signature');
    }

    const user = this.parseUser(fields.user);

    return { fields, user };
  }

  private toRecord(params: URLSearchParams) {
    const fields: Record<string, string> = {};

    for (const [key, value] of params.entries()) {
      fields[key] = value;
    }

    return fields;
  }

  private buildDataCheckString(params: URLSearchParams) {
    return [...params.entries()]
      .filter(([key]) => key !== 'hash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  }

  private sign(dataCheckString: string, botToken: string) {
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  }

  private isSafeEqualHex(left: string, right: string) {
    if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
      return false;
    }

    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');

    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  private parseUser(rawUser: string | undefined) {
    if (!rawUser) {
      throw new UnauthorizedException('Telegram initData user is missing');
    }

    try {
      const user = JSON.parse(rawUser) as TelegramInitDataUser;

      if (!user.id) {
        throw new UnauthorizedException('Telegram user id is missing');
      }

      return user;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Telegram initData user is invalid');
    }
  }
}
