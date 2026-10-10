import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { TelegramInitDataService } from './telegram-init-data.service';

const botToken = '123456:test-token';

function createInitData(fields: Record<string, string>) {
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });

  return params.toString();
}

describe('TelegramInitDataService', () => {
  const service = new TelegramInitDataService();

  it('verifies valid Telegram initData and returns parsed user', () => {
    const initData = createInitData({
      auth_date: '1710000000',
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: JSON.stringify({
        id: 424242,
        first_name: 'Alice',
        last_name: 'Runner',
        username: 'alice_runner',
        photo_url: 'https://example.test/avatar.jpg',
      }),
    });

    const result = service.verify(initData, botToken);

    assert.equal(result.user.id, 424242);
    assert.equal(result.user.first_name, 'Alice');
    assert.equal(result.user.username, 'alice_runner');
    assert.equal(result.fields.auth_date, '1710000000');
  });

  it('rejects initData when a signed field is modified', () => {
    const initData = createInitData({
      auth_date: '1710000000',
      user: JSON.stringify({ id: 424242, first_name: 'Alice' }),
    });
    const tampered = initData.replace('Alice', 'Mallory');

    assert.throws(() => service.verify(tampered, botToken), UnauthorizedException);
  });

  it('rejects initData without hash', () => {
    const initData = new URLSearchParams({
      auth_date: '1710000000',
      user: JSON.stringify({ id: 424242 }),
    }).toString();

    assert.throws(() => service.verify(initData, botToken), UnauthorizedException);
  });

  it('rejects empty initData', () => {
    assert.throws(() => service.verify('', botToken), BadRequestException);
  });

  it('rejects missing bot token', () => {
    const initData = createInitData({
      auth_date: '1710000000',
      user: JSON.stringify({ id: 424242 }),
    });

    assert.throws(() => service.verify(initData, ''), BadRequestException);
  });
  it('rejects invalid signed user JSON', () => {
    const initData = createInitData({
      auth_date: '1710000000',
      user: '{not-json',
    });

    assert.throws(() => service.verify(initData, botToken), UnauthorizedException);
  });

  it('rejects signed user payload without Telegram id', () => {
    const initData = createInitData({
      auth_date: '1710000000',
      user: JSON.stringify({ first_name: 'Alice' }),
    });

    assert.throws(() => service.verify(initData, botToken), UnauthorizedException);
  });
});
