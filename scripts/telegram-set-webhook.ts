/**
 * `telegram:webhook` — register the Telegram webhook against a public HTTPS base URL.
 *
 * Run it:  `npm run telegram:webhook -- https://your-app.example.com`
 *          (node --env-file-if-exists=.env.local --experimental-strip-types
 *          scripts/telegram-set-webhook.ts https://your-app.example.com)
 *
 * It calls `setWebhook` with the base URL plus `/api/telegram`, the `secret_token` Jamee will
 * compare on every delivery (V24, D12), and `allowed_updates: ['message']` so Jamee is not sent
 * update kinds it does not handle. It then calls `getWebhookInfo` and prints a summary so an
 * operator can confirm the registration took — the URL, pending count, and last error, but never
 * the secret token or the bot token.
 *
 * =============================================================================
 * WHY THIS IS SELF-CONTAINED (no `@/` imports)
 * =============================================================================
 *
 * Same reason as `scripts/db-setup.ts` and `scripts/telegram-poll.ts`: it runs under bare
 * `node --experimental-strip-types`, which resolves neither the `@/*` alias nor `server-only`, so it
 * reads its env vars directly and speaks the Bot API with `fetch`. The bot token is read once into a
 * local and only ever placed in a request URL — never logged. The secret token is sent to Telegram
 * (that is its whole purpose) but is never printed in the summary.
 */

const BOT_TOKEN_VAR = 'TELEGRAM_BOT_TOKEN';
const SECRET_TOKEN_VAR = 'TELEGRAM_WEBHOOK_SECRET_TOKEN';
const API_BASE = 'https://api.telegram.org';
const WEBHOOK_PATH = '/api/telegram';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. Set it in .env.local. See .env.example and docs/DEPLOYMENT.md.`);
  }
  return value.trim();
}

/** Call one Bot API method. The token is in the URL and is never logged. */
async function callBotApi(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
  }
  const json = (await response.json()) as { ok?: boolean; result?: unknown; description?: string };
  if (json.ok !== true) {
    throw new Error(`Telegram ${method} returned ok=false${json.description ? `: ${json.description}` : ''}`);
  }
  return json.result;
}

/** Normalize the base URL and append the webhook path exactly once. */
function webhookUrl(baseArg: string): string {
  const base = baseArg.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) {
    throw new Error(`The webhook base URL must be an https:// URL. Received: ${base || '(empty)'}`);
  }
  return `${base}${WEBHOOK_PATH}`;
}

async function main(): Promise<void> {
  const token = requireEnv(BOT_TOKEN_VAR);
  const secretToken = requireEnv(SECRET_TOKEN_VAR);

  const baseArg = process.argv[2];
  if (baseArg === undefined || baseArg.trim() === '') {
    throw new Error(
      'Usage: npm run telegram:webhook -- https://your-app.example.com  (the public HTTPS base URL of the deployment)',
    );
  }

  const url = webhookUrl(baseArg);

  await callBotApi(token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message'],
  });
  process.stdout.write(`setWebhook registered ${url} (message updates only, secret token set)\n`);

  const info = (await callBotApi(token, 'getWebhookInfo', {})) as {
    url?: string;
    has_custom_certificate?: boolean;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
    max_connections?: number;
    allowed_updates?: string[];
  };

  // The summary names the webhook state, never the secret or the bot token.
  process.stdout.write('getWebhookInfo:\n');
  process.stdout.write(`  url:                   ${info.url ?? '(none)'}\n`);
  process.stdout.write(`  pending_update_count:  ${info.pending_update_count ?? 0}\n`);
  process.stdout.write(`  max_connections:       ${info.max_connections ?? '(default)'}\n`);
  process.stdout.write(`  allowed_updates:       ${(info.allowed_updates ?? ['(default)']).join(', ')}\n`);
  if (info.last_error_message !== undefined) {
    const when = info.last_error_date !== undefined ? new Date(info.last_error_date * 1000).toISOString() : 'unknown time';
    process.stdout.write(`  last_error:            ${info.last_error_message} (at ${when})\n`);
  } else {
    process.stdout.write('  last_error:            (none)\n');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`telegram:webhook failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
