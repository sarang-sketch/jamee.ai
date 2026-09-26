/**
 * `telegram:poll` — run the Telegram bot on a laptop with no public URL.
 *
 * Run it:  `npm run telegram:poll`   (node --env-file-if-exists=.env.local --experimental-strip-types
 *          scripts/telegram-poll.ts [target-url])
 *
 * It does what a webhook would, from the outside: it deletes any registered webhook (getUpdates and
 * a webhook are mutually exclusive on the Bot API), then long-polls `getUpdates` and forwards each
 * update as a JSON POST to the local Next.js route — with the same `X-Telegram-Bot-Api-Secret-Token`
 * header Telegram would send — so the exact same `src/app/api/telegram/route.ts` pipeline runs. The
 * offset advances to `update_id + 1` only after an update is forwarded, so a crash re-forwards
 * rather than skips, and the route's `update_id` claim makes a re-forward a harmless no-op.
 *
 * =============================================================================
 * WHY THIS IS SELF-CONTAINED (no `@/` imports)
 * =============================================================================
 *
 * Like `scripts/db-setup.ts`, this runs under bare `node --experimental-strip-types`, which resolves
 * neither the `@/*` tsconfig path alias nor Next's `server-only` shim. So it reads its two env vars
 * directly (`--env-file-if-exists=.env.local` loads them) and speaks the Bot API with `fetch` — it
 * imports nothing from the app. The bot token is read once into a local, used only to build request
 * URLs, and NEVER printed: every log line names counts and offsets, not the token or the URL.
 */

const BOT_TOKEN_VAR = 'TELEGRAM_BOT_TOKEN';
const SECRET_TOKEN_VAR = 'TELEGRAM_WEBHOOK_SECRET_TOKEN';
const API_BASE = 'https://api.telegram.org';
const DEFAULT_TARGET = 'http://localhost:3000/api/telegram';
const LONG_POLL_TIMEOUT_SECONDS = 25;
const FORWARD_RETRIES = 2;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. Set it in .env.local. See .env.example and docs/DEPLOYMENT.md.`);
  }
  return value.trim();
}

/** Call one Bot API method. The token is in the URL and is never logged (V25's rule applied here). */
async function callBotApi(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // The status, never the URL (which carries the token).
    throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
  }
  const json = (await response.json()) as { ok?: boolean; result?: unknown; description?: string };
  if (json.ok !== true) {
    throw new Error(`Telegram ${method} returned ok=false${json.description ? `: ${json.description}` : ''}`);
  }
  return json.result;
}

/** Forward one update's raw JSON to the local route, retrying a failed forward `FORWARD_RETRIES` times. */
async function forwardUpdate(target: string, secretToken: string, update: unknown): Promise<boolean> {
  for (let attempt = 0; attempt <= FORWARD_RETRIES; attempt += 1) {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': secretToken,
        },
        body: JSON.stringify(update),
      });
      // The route answers 200 for every authenticated delivery and 401 only on a bad secret; either
      // is a "delivered" outcome for the poller (a 401 means the secret is misconfigured, which
      // retrying will not fix). Only a transport error or a 5xx is worth retrying.
      if (response.status < 500) return true;
      process.stderr.write(`forward attempt ${attempt + 1} got HTTP ${response.status}\n`);
    } catch (error) {
      process.stderr.write(
        `forward attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return false;
}

async function main(): Promise<void> {
  const token = requireEnv(BOT_TOKEN_VAR);
  const secretToken = requireEnv(SECRET_TOKEN_VAR);
  const target = process.argv[2]?.trim() || DEFAULT_TARGET;

  // getUpdates and a registered webhook are mutually exclusive — drop any webhook first.
  await callBotApi(token, 'deleteWebhook', { drop_pending_updates: false });
  process.stdout.write(`telegram:poll forwarding to ${target} (long poll ${LONG_POLL_TIMEOUT_SECONDS}s, message updates only)\n`);

  let running = true;
  const stop = (): void => {
    running = false;
    process.stdout.write('\ntelegram:poll stopping…\n');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let offset = 0;
  while (running) {
    let updates: Array<{ update_id: number }>;
    try {
      updates = (await callBotApi(token, 'getUpdates', {
        offset,
        timeout: LONG_POLL_TIMEOUT_SECONDS,
        allowed_updates: ['message'],
      })) as Array<{ update_id: number }>;
    } catch (error) {
      // A transient getUpdates failure: report and back off briefly rather than exit.
      process.stderr.write(`getUpdates failed: ${error instanceof Error ? error.message : String(error)}\n`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    for (const update of updates) {
      if (!running) break;
      const forwarded = await forwardUpdate(target, secretToken, update);
      // Advance PAST this update only once it has been forwarded, so a crash re-forwards rather than
      // skips; the route's update_id claim makes the re-forward a no-op.
      offset = update.update_id + 1;
      process.stdout.write(`update ${update.update_id} ${forwarded ? 'forwarded' : 'dropped after retries'}\n`);
    }
  }

  process.stdout.write('telegram:poll stopped.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`telegram:poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
