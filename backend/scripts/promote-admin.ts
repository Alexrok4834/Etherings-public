import { Client } from 'pg';

function getTelegramId() {
  const explicitArg = process.argv.find((arg) => arg.startsWith('--telegram-id='));
  const telegramId = explicitArg?.split('=')[1] ?? process.env.ADMIN_TELEGRAM_ID;

  if (!telegramId || telegramId.trim().length === 0) {
    throw new Error('Missing telegram id. Use --telegram-id=<id> or ADMIN_TELEGRAM_ID=<id>.');
  }

  return telegramId.trim();
}

async function main() {
  const telegramId = getTelegramId();
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://etherings:etherings@localhost:5432/etherings_mvp';
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();

  try {
    const result = await client.query(
      `
        UPDATE users
        SET is_admin = TRUE, updated_at = NOW()
        WHERE telegram_id = $1
        RETURNING id, telegram_id, username, is_admin
      `,
      [telegramId],
    );

    const user = result.rows[0];

    if (!user) {
      throw new Error(`User with telegram_id=${telegramId} was not found. Log in through /auth/telegram first.`);
    }

    console.log(
      JSON.stringify(
        {
          id: user.id,
          telegramId: user.telegram_id,
          username: user.username,
          isAdmin: user.is_admin,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});