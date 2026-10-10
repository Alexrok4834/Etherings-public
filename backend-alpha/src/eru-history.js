import { getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage } from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token-2022';

const decoder = getCompiledTransactionMessageDecoder();
const decimal = value => {
  if (value == null) return null;
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(text))
    throw new Error('Invalid stored ERU amount');
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
};
const units = value => {
  const whole = value / 1_000_000_000n;
  const fraction = String(value % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
};
const time = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function decodeCanonicalSend(messageBase64, gateway) {
  const message = Buffer.from(messageBase64, 'base64');
  if (!message.length || message.toString('base64') !== messageBase64)
    throw new Error('Invalid stored canonical Send message');
  const instructions = getInstructionsFromCompiledTransactionMessage(decoder.decode(message));
  const ata = instructions[1];
  const transfer = instructions[2];
  if (instructions.length !== 3 || ata?.programAddress !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS ||
      ata.accounts?.length < 3 || transfer?.programAddress !== gateway ||
      transfer.accounts?.length !== 13 || transfer.data?.length !== 25 ||
      transfer.data[0] !== 1 || transfer.accounts[2].address !== ata.accounts[1].address)
    throw new Error('Invalid stored canonical Send graph');
  const amount = Buffer.from(transfer.data).readBigUInt64LE(1);
  const nonce = Buffer.from(transfer.data).readBigUInt64LE(9);
  if (amount === 0n || nonce === 0n)
    throw new Error('Invalid stored canonical Send terms');
  return { sender: transfer.accounts[4].address, recipient: ata.accounts[2].address,
    amount: units(amount), fee: units((amount * 200n + 9_999n) / 10_000n),
    nonce: String(nonce) };
}

export async function readEruHistory(pool, user, gateway) {
  const wallet = user.wallet_address;
  const account = user.id;
  const [intents, cooper, silver, breeding, draw] = await Promise.all([
    pool.query(`SELECT id, wallet_address, intent_namespace, nonce, status,
        transaction_signature, message_base64, created_at
      FROM alpha_eru_intents WHERE cluster = 'devnet'
        AND (account_id = $1 OR (intent_namespace = 'canonical' AND status = 'confirmed'))
      ORDER BY created_at DESC, id DESC LIMIT 1000`, [account]),
    pool.query(`SELECT p.operation_id AS id, p.status, p.eru_principal AS amount,
        p.eru_fee AS fee, p.created_at, i.nonce, s.signature,
        sub.signature AS submitted_signature
      FROM alpha_cooper_level_eru_preparations p
      LEFT JOIN alpha_cooper_level_eru_issuances i ON i.operation_id = p.operation_id
      LEFT JOIN alpha_cooper_level_eru_settlements s ON s.operation_id = p.operation_id
      LEFT JOIN LATERAL (SELECT signature FROM alpha_cooper_level_eru_submissions
        WHERE operation_id = p.operation_id ORDER BY recorded_at DESC LIMIT 1) sub ON true
      WHERE p.account_id = $1 AND p.wallet_address = $2 AND p.cluster = 'devnet'
      ORDER BY p.created_at DESC LIMIT 100`, [account, wallet]),
    pool.query(`SELECT p.id, p.status, p.eru_principal AS amount,
        p.eru_fee AS fee, p.created_at, s.signature,
        sub.signature AS submitted_signature
      FROM alpha_silver_progression_operations p
      LEFT JOIN alpha_silver_progression_settlements s ON s.operation_id = p.id
      LEFT JOIN LATERAL (SELECT signature FROM alpha_silver_progression_submissions
        WHERE operation_id = p.id ORDER BY recorded_at DESC LIMIT 1) sub ON true
      WHERE p.account_id = $1 AND p.wallet_address = $2 AND p.cluster = 'devnet'
        AND p.eru_principal > 0
      ORDER BY p.created_at DESC LIMIT 100`, [account, wallet]),
    pool.query(`SELECT o.id, o.eru_principal AS amount, o.eru_fee AS fee,
        o.created_at, i.nonce, s.signature, sub.signature AS submitted_signature
      FROM alpha_cooper_breeding_operations o
      LEFT JOIN alpha_cooper_breeding_issuances i ON i.operation_id = o.id
      LEFT JOIN alpha_cooper_breeding_settlements s ON s.operation_id = o.id
      LEFT JOIN LATERAL (SELECT signature FROM alpha_cooper_breeding_submissions
        WHERE operation_id = o.id ORDER BY recorded_at DESC LIMIT 1) sub ON true
      WHERE o.account_id = $1 AND o.wallet_address = $2 AND o.cluster = 'devnet'
      ORDER BY o.created_at DESC LIMIT 100`, [account, wallet]),
    pool.query(`SELECT r.id, r.created_at, f.state, f.chain_signature AS signature,
        c.amount_exact AS amount
      FROM alpha_draw_results r
      JOIN alpha_draw_operations o ON o.id = r.operation_id
      JOIN alpha_draw_configuration_rewards c ON c.configuration_id = r.configuration_id
        AND c.reward_id = r.selected_reward_id
      LEFT JOIN alpha_draw_fulfillments f ON f.result_id = r.id
      WHERE r.account_id = $1 AND o.wallet_address = $2
        AND r.selected_reward_type = 'ERU'
      ORDER BY r.created_at DESC LIMIT 100`, [account, wallet]),
  ]);
  const entries = [];
  for (const row of intents.rows) {
    if (row.intent_namespace === 'legacy') {
      if (row.wallet_address === wallet)
        entries.push({ id: row.id, type: 'legacy_send', direction: 'out',
          amount: null, fee: null, counterparty: null, nonce: String(row.nonce),
          status: row.status, transactionSignature: row.transaction_signature,
          createdAt: time(row.created_at) });
      continue;
    }
    if (row.intent_namespace !== 'canonical') throw new Error('Unknown Send namespace');
    const terms = decodeCanonicalSend(row.message_base64, gateway);
    if (terms.sender !== row.wallet_address || terms.nonce !== String(row.nonce))
      throw new Error('Stored Send identity mismatch');
    const outgoing = row.wallet_address === wallet;
    if (!outgoing && (row.status !== 'confirmed' || terms.recipient !== wallet)) continue;
    entries.push({ id: row.id, type: 'send', direction: outgoing ? 'out' : 'in',
      amount: terms.amount, fee: outgoing ? terms.fee : null,
      counterparty: outgoing ? terms.recipient : terms.sender, nonce: terms.nonce,
      status: row.status, transactionSignature: row.transaction_signature,
      createdAt: time(row.created_at) });
  }
  for (const row of cooper.rows) {
    if (row.status === 'confirmed' && !row.signature)
      throw new Error('Cooper ERU settlement missing');
    entries.push({ id: row.id, type: 'cooper_level_up',
    direction: 'out', amount: decimal(row.amount), fee: decimal(row.fee),
    counterparty: null, nonce: row.nonce == null ? null : String(row.nonce),
    status: row.status === 'prepared' ?
      (row.submitted_signature ? 'unknown' : 'pending') : row.status,
    transactionSignature: row.signature ?? row.submitted_signature,
    createdAt: time(row.created_at) });
  }
  for (const row of silver.rows) {
    if (row.status === 'confirmed' && !row.signature)
      throw new Error('Silver ERU settlement missing');
    entries.push({ id: row.id, type: 'silver_level_up',
    direction: 'out', amount: decimal(row.amount), fee: decimal(row.fee),
    counterparty: null, nonce: null, status: row.status === 'prepared' ?
      (row.submitted_signature ? 'unknown' : 'pending') : row.status,
    transactionSignature: row.signature ?? row.submitted_signature,
    createdAt: time(row.created_at) });
  }
  for (const row of breeding.rows) entries.push({ id: row.id, type: 'breeding',
    direction: 'out', amount: decimal(row.amount), fee: decimal(row.fee),
    counterparty: null, nonce: row.nonce == null ? null : String(row.nonce),
    status: row.signature ? 'confirmed' : row.submitted_signature ? 'unknown' : 'pending',
    transactionSignature: row.signature ?? row.submitted_signature,
    createdAt: time(row.created_at) });
  for (const row of draw.rows) {
    if (row.state === 'CONFIRMED' && !row.signature)
      throw new Error('Draw ERU settlement missing');
    entries.push({ id: row.id, type: 'draw_reward',
    direction: 'in', amount: decimal(row.amount), fee: null, counterparty: null,
    nonce: null, status: row.state === 'CONFIRMED' ? 'confirmed' :
      row.state === 'UNKNOWN' ? 'unknown' : 'pending',
    transactionSignature: row.signature, createdAt: time(row.created_at) });
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { status: 200, body: { cluster: 'devnet', walletAddress: wallet,
    operations: entries.slice(0, 20) } };
}
