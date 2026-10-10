export type MobileAuthAccount = {
  username: string;
  password: string;
  telegramId: string;
  displayName: string | null;
};

type ConfigReader = {
  get<T = string>(key: string): T | undefined;
};

export function readMobileAuthAccounts(config: ConfigReader): MobileAuthAccount[] {
  const accounts: MobileAuthAccount[] = [];
  const legacy = accountFromUnknown({
    username: config.get<string>('MOBILE_AUTH_USERNAME'),
    password: config.get<string>('MOBILE_AUTH_PASSWORD'),
    telegramId: config.get<string>('MOBILE_AUTH_TELEGRAM_ID'),
    displayName: config.get<string>('MOBILE_AUTH_DISPLAY_NAME'),
  });

  if (legacy) {
    accounts.push(legacy);
  }

  const rawUsers = config.get<string>('MOBILE_AUTH_USERS_JSON')?.trim();
  if (rawUsers) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawUsers);
    } catch {
      throw new Error('MOBILE_AUTH_USERS_JSON must be valid JSON');
    }

    if (!Array.isArray(parsed)) {
      throw new Error('MOBILE_AUTH_USERS_JSON must be an array');
    }

    for (const value of parsed) {
      const account = accountFromUnknown(value);
      if (!account) {
        throw new Error('MOBILE_AUTH_USERS_JSON contains an invalid account');
      }
      accounts.push(account);
    }
  }

  assertUnique(accounts, 'username');
  assertUnique(accounts, 'telegramId');
  return accounts;
}

function accountFromUnknown(value: unknown): MobileAuthAccount | null {
  if (!isRecord(value)) {
    return null;
  }

  const username = normalizedRequiredString(value.username);
  const password = normalizedRequiredString(value.password);
  const telegramId = normalizedRequiredString(value.telegramId);
  if (!username || !password || !telegramId) {
    return null;
  }

  const displayName = typeof value.displayName === 'string' && value.displayName.trim()
    ? value.displayName.trim()
    : null;

  return { username, password, telegramId, displayName };
}

function normalizedRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertUnique(accounts: MobileAuthAccount[], field: 'username' | 'telegramId') {
  const values = new Set<string>();
  for (const account of accounts) {
    if (values.has(account[field])) {
      throw new Error(`Mobile auth accounts contain duplicate ${field}`);
    }
    values.add(account[field]);
  }
}
