import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readMobileAuthAccounts } from './mobile-auth-config';

function config(values: Record<string, string | undefined>) {
  return {
    get<T = string>(key: string): T | undefined {
      return values[key] as T | undefined;
    },
  };
}

describe('readMobileAuthAccounts', () => {
  it('preserves the legacy single-account configuration', () => {
    const accounts = readMobileAuthAccounts(config({
      MOBILE_AUTH_USERNAME: 'player',
      MOBILE_AUTH_PASSWORD: 'secret',
      MOBILE_AUTH_TELEGRAM_ID: 'android-player',
      MOBILE_AUTH_DISPLAY_NAME: 'Android Player',
    }));

    assert.deepEqual(accounts, [{
      username: 'player',
      password: 'secret',
      telegramId: 'android-player',
      displayName: 'Android Player',
    }]);
  });

  it('adds multiple JSON accounts after the legacy account', () => {
    const accounts = readMobileAuthAccounts(config({
      MOBILE_AUTH_USERNAME: 'player',
      MOBILE_AUTH_PASSWORD: 'secret',
      MOBILE_AUTH_TELEGRAM_ID: 'android-player',
      MOBILE_AUTH_USERS_JSON: JSON.stringify([
        { username: 'qa-two', password: 'fixture-secret-two', telegramId: 'android-qa-two', displayName: 'QA Two' },
        { username: 'qa-three', password: 'fixture-secret-three', telegramId: 'android-qa-three', displayName: 'QA Three' },
      ]),
    }));

    assert.equal(accounts.length, 3);
    assert.equal(accounts[1].username, 'qa-two');
    assert.equal(accounts[2].telegramId, 'android-qa-three');
  });

  it('supports JSON-only configuration', () => {
    const accounts = readMobileAuthAccounts(config({
      MOBILE_AUTH_USERS_JSON: JSON.stringify([
        { username: 'qa-two', password: 'fixture-secret-two', telegramId: 'android-qa-two' },
      ]),
    }));

    assert.deepEqual(accounts, [{
      username: 'qa-two',
      password: 'fixture-secret-two',
      telegramId: 'android-qa-two',
      displayName: null,
    }]);
  });

  it('rejects malformed JSON and non-array values', () => {
    assert.throws(
      () => readMobileAuthAccounts(config({ MOBILE_AUTH_USERS_JSON: '{bad' })),
      /must be valid JSON/,
    );
    assert.throws(
      () => readMobileAuthAccounts(config({ MOBILE_AUTH_USERS_JSON: '{}' })),
      /must be an array/,
    );
  });

  it('rejects incomplete accounts', () => {
    assert.throws(
      () => readMobileAuthAccounts(config({
        MOBILE_AUTH_USERS_JSON: JSON.stringify([{ username: 'qa-two', password: 'fixture-secret-two' }]),
      })),
      /invalid account/,
    );
  });

  it('rejects duplicate usernames and identities', () => {
    assert.throws(
      () => readMobileAuthAccounts(config({
        MOBILE_AUTH_USERS_JSON: JSON.stringify([
          { username: 'qa-two', password: 'fixture-one', telegramId: 'android-qa-two' },
          { username: 'qa-two', password: 'fixture-two', telegramId: 'android-qa-three' },
        ]),
      })),
      /duplicate username/,
    );
    assert.throws(
      () => readMobileAuthAccounts(config({
        MOBILE_AUTH_USERS_JSON: JSON.stringify([
          { username: 'qa-two', password: 'fixture-one', telegramId: 'same-id' },
          { username: 'qa-three', password: 'fixture-two', telegramId: 'same-id' },
        ]),
      })),
      /duplicate telegramId/,
    );
  });
});
