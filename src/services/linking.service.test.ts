import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `src/services/linking.service.ts` with the Data_Access_Layer and the public env
 * mocked.
 *
 * Requirements: 21.2 (the token is derived from nothing), 21.4 (the TTL), 21.5 (a secure source),
 *               21.6 (the deep-link form), 21.8, 21.10–21.13 (the outcome mapping), 21.15 (unlink)
 * Design: D13
 *
 * What these decide vs what the integration test decides. Everything here is a fact about the
 * SERVICE: the token is minted from a CSPRNG and never derived from an id, only the sha-256 is
 * stored, the deep link is `https://t.me/<bot>?start=<plaintext>`, and the DAL's terminal result is
 * mapped one-to-one onto the published `BindOutcome`. The atomicity of the consume-and-bind, and
 * that "already linked elsewhere leaves the token unconsumed", are facts about a real transaction
 * and a real unique index — those are in `tests/integration/access-flow.test.ts`, where a stub
 * cannot fake them.
 */

const {
  insertLinkToken,
  invalidateOutstandingLinkTokens,
  clearTelegramLink,
  consumeAndBindDal,
} = vi.hoisted(() => ({
  insertLinkToken: vi.fn(),
  invalidateOutstandingLinkTokens: vi.fn(),
  clearTelegramLink: vi.fn(),
  consumeAndBindDal: vi.fn(),
}));

vi.mock('@/lib/db/access', () => ({
  accessData: (ownerId: string) => ({
    ownerId,
    insertLinkToken,
    invalidateOutstandingLinkTokens,
    clearTelegramLink,
  }),
  consumeAndBind: consumeAndBindDal,
}));

vi.mock('@/lib/db/farmer', () => ({
  // The service passes this straight through to the mocked DAL consumeAndBind, which ignores it.
  withTransaction: vi.fn(),
}));

vi.mock('@/lib/env.public', () => ({
  telegramBotUsername: () => 'jamee_test_bot',
}));

import { mintLinkToken, consumeAndBind, unlink, hashToken } from '@/services/linking.service';
import { LINK_TOKEN_TTL_MINUTES } from '@/lib/config/access';

const sha256 = (plaintext: string): string => createHash('sha256').update(plaintext, 'utf8').digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  insertLinkToken.mockResolvedValue({ _id: 'x' });
  invalidateOutstandingLinkTokens.mockResolvedValue(1);
  clearTelegramLink.mockResolvedValue(undefined);
});

/* ========================================================================== */
/* mintLinkToken                                                               */
/* ========================================================================== */

describe('mintLinkToken', () => {
  it('returns a t.me deep link carrying the plaintext, and stores only its sha-256 (21.2, 21.5, 21.6, D13)', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = await mintLinkToken('farmer-A', now);

    // The deep link is exactly `https://t.me/<bot>?start=<plaintext>`.
    const match = /^https:\/\/t\.me\/jamee_test_bot\?start=(.+)$/.exec(result.deepLink);
    expect(match).not.toBeNull();
    const plaintext = match![1]!;

    // The token is url-safe base64 of 32 bytes → 43 chars, and contains no id fragment (21.2).
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(plaintext).not.toContain('farmer-A');

    // Only the hash was stored, with the TTL expiry (21.4).
    expect(insertLinkToken).toHaveBeenCalledTimes(1);
    const stored = insertLinkToken.mock.calls[0]![0] as { tokenHash: string; expiresAt: Date };
    expect(stored.tokenHash).toBe(sha256(plaintext));
    expect(stored.tokenHash).not.toBe(plaintext);
    expect(stored.expiresAt.getTime()).toBe(now.getTime() + LINK_TOKEN_TTL_MINUTES * 60 * 1000);
    expect(result.expiresAt).toBe(stored.expiresAt.toISOString());
  });

  it('mints a different token on every call (21.5)', async () => {
    const a = await mintLinkToken('farmer-A');
    const b = await mintLinkToken('farmer-A');
    expect(a.deepLink).not.toBe(b.deepLink);
  });
});

/* ========================================================================== */
/* consumeAndBind — the DAL result maps one-to-one onto the BindOutcome        */
/* ========================================================================== */

describe('consumeAndBind', () => {
  it('hashes the plaintext before the DAL lookup (D13)', async () => {
    consumeAndBindDal.mockResolvedValue({ kind: 'invalid' });
    await consumeAndBind('the-plaintext', 111);
    expect(consumeAndBindDal).toHaveBeenCalledTimes(1);
    expect(consumeAndBindDal.mock.calls[0]![0]).toBe(hashToken('the-plaintext'));
    expect(consumeAndBindDal.mock.calls[0]![1]).toBe(111);
  });

  it('maps every DAL variant to its BindOutcome', async () => {
    consumeAndBindDal.mockResolvedValueOnce({ kind: 'bound', ownerId: 'A' });
    expect(await consumeAndBind('t', 1)).toEqual({ kind: 'bound', ownerId: 'A' });

    consumeAndBindDal.mockResolvedValueOnce({ kind: 'already_linked', ownerId: 'A' });
    expect(await consumeAndBind('t', 1)).toEqual({ kind: 'already_linked', ownerId: 'A' });

    consumeAndBindDal.mockResolvedValueOnce({ kind: 'replaced', ownerId: 'A', replacedTelegramUserId: 42 });
    expect(await consumeAndBind('t', 1)).toEqual({ kind: 'replaced', ownerId: 'A', replacedTelegramUserId: 42 });

    consumeAndBindDal.mockResolvedValueOnce({ kind: 'already_linked_elsewhere', ownerId: 'A' });
    expect(await consumeAndBind('t', 1)).toEqual({ kind: 'already_linked_elsewhere', ownerId: 'A' });

    consumeAndBindDal.mockResolvedValueOnce({ kind: 'invalid' });
    expect(await consumeAndBind('t', 1)).toEqual({ kind: 'invalid' });
  });
});

/* ========================================================================== */
/* unlink                                                                      */
/* ========================================================================== */

describe('unlink', () => {
  it('clears the telegram id AND invalidates outstanding tokens (21.15)', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await unlink('farmer-A', now);
    expect(clearTelegramLink).toHaveBeenCalledTimes(1);
    expect(invalidateOutstandingLinkTokens).toHaveBeenCalledTimes(1);
    expect(invalidateOutstandingLinkTokens).toHaveBeenCalledWith(now);
  });
});
