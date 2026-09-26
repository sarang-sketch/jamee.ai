import { describe, expect, it, vi } from 'vitest';

import {
  ACCEPTED_VOICE_MIMES,
  detectVoiceContainerMime,
  downloadFile,
  getFile,
  parseUpdate,
  sendMessage,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  TELEGRAM_PHOTO_MIME,
  TELEGRAM_SECRET_TOKEN_HEADER,
  TELEGRAM_TEXT_MAX_CHARS,
  TelegramApiError,
  timingSafeEqualStr,
  truncateText,
  verifySecretToken,
  VOICE_MIME_M4A,
  VOICE_MIME_MP3,
  VOICE_MIME_OGG,
  type TelegramFetch,
} from '@/lib/telegram';

/**
 * Unit tests for `src/lib/telegram.ts` (the pure provider half — task 57.1's telegram half).
 *
 * Requirements: 11.1–11.4 (the secret-token check: match, absent, wrong, flipped byte,
 *               unconfigured), 10.4 / 10.6 / 10.9 (every update kind and the media path), V26 (the
 *               three voice containers plus a refused one), V25 (the 20 MB refusal), 15.6 (the bot
 *               token never appears in an error).
 *
 * Every function takes its secret as an explicit parameter, so no test reads the environment.
 */

const BOT_TOKEN = 'test-bot-token:AAExampleSecretPortion';
const SECRET = 'jamee-webhook-secret-token-123';

function headersWith(secret: string | null): Headers {
  const h = new Headers();
  if (secret !== null) h.set(TELEGRAM_SECRET_TOKEN_HEADER, secret);
  return h;
}

function flipLastByte(s: string): string {
  const last = s[s.length - 1] ?? 'a';
  const flipped = last === 'a' ? 'b' : 'a';
  return s.slice(0, -1) + flipped;
}

/* -------------------------------------------------------------------------- */
/* Secret-token verification (Requirements 11.1–11.4)                          */
/* -------------------------------------------------------------------------- */

describe('verifySecretToken', () => {
  it('accepts a matching header', () => {
    expect(verifySecretToken(headersWith(SECRET), SECRET)).toBe(true);
  });

  it('rejects an absent header', () => {
    expect(verifySecretToken(headersWith(null), SECRET)).toBe(false);
  });

  it('rejects a wrong value', () => {
    expect(verifySecretToken(headersWith('completely-different'), SECRET)).toBe(false);
  });

  it('rejects a value with one flipped byte', () => {
    expect(verifySecretToken(headersWith(flipLastByte(SECRET)), SECRET)).toBe(false);
  });

  it('an unconfigured secret never grants access', () => {
    // In production an absent TELEGRAM_WEBHOOK_SECRET_TOKEN makes serverEnv throw before this is
    // reached, landing in the same 401 branch as a wrong token. Here we confirm the comparison
    // itself never treats a real presented header as matching an empty configured secret, and an
    // absent header against an empty secret is still not a deliberate accepted delivery.
    expect(verifySecretToken(headersWith(SECRET), '')).toBe(false);
    expect(verifySecretToken(headersWith('anything'), '')).toBe(false);
  });
});

describe('timingSafeEqualStr', () => {
  it('handles null and undefined as non-matches without throwing', () => {
    expect(timingSafeEqualStr(null, SECRET)).toBe(false);
    expect(timingSafeEqualStr(undefined, SECRET)).toBe(false);
  });

  it('matches identical strings and rejects different-length ones', () => {
    expect(timingSafeEqualStr(SECRET, SECRET)).toBe(true);
    expect(timingSafeEqualStr(SECRET + 'x', SECRET)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Update parsing — every kind (Requirements 10.4, 10.5, 10.6, 10.9)           */
/* -------------------------------------------------------------------------- */

describe('parseUpdate', () => {
  it('parses a text message', () => {
    const result = parseUpdate({
      update_id: 42,
      message: { from: { id: 777 }, chat: { id: 777 }, text: 'why is my tomato leaf spotted?' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dispatch).toMatchObject({
      updateId: 42,
      telegramUserId: 777,
      chatId: 777,
      kind: 'text',
      textBody: 'why is my tomato leaf spotted?',
      fileId: null,
      startPayload: null,
    });
  });

  it('parses a /start with a payload', () => {
    const result = parseUpdate({
      update_id: 7,
      message: { from: { id: 5 }, chat: { id: 5 }, text: '/start abc123LINKTOKEN' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dispatch.kind).toBe('start');
    expect(result.dispatch.startPayload).toBe('abc123LINKTOKEN');
    expect(result.dispatch.textBody).toBe('/start abc123LINKTOKEN');
  });

  it('parses a bare /start (and /start@botname) as start with a null payload', () => {
    for (const text of ['/start', '/start   ', '/start@jamee_bot']) {
      const result = parseUpdate({ update_id: 1, message: { from: { id: 5 }, chat: { id: 5 }, text } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dispatch.kind).toBe('start');
      expect(result.dispatch.startPayload).toBeNull();
    }
  });

  it('takes the largest (last) photo size for a photo update', () => {
    const result = parseUpdate({
      update_id: 9,
      message: {
        from: { id: 3 },
        chat: { id: 3 },
        photo: [
          { file_id: 'small', width: 90, height: 90, file_size: 1000 },
          { file_id: 'medium', width: 320, height: 320, file_size: 8000 },
          { file_id: 'largest', width: 1280, height: 1280, file_size: 90000 },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dispatch.kind).toBe('photo');
    expect(result.dispatch.fileId).toBe('largest');
  });

  it('parses a voice update and carries the reported mime_type when present', () => {
    const result = parseUpdate({
      update_id: 11,
      message: {
        from: { id: 8 },
        chat: { id: 8 },
        voice: { file_id: 'voice-file-1', duration: 6, mime_type: 'audio/ogg', file_size: 20000 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dispatch.kind).toBe('voice');
    expect(result.dispatch.fileId).toBe('voice-file-1');
    expect(result.dispatch.voiceMimeType).toBe('audio/ogg');
  });

  it('classifies audio and document as other (the unsupported type of Requirement 10.9)', () => {
    for (const message of [
      { from: { id: 1 }, chat: { id: 1 }, audio: { file_id: 'song' } },
      { from: { id: 1 }, chat: { id: 1 }, document: { file_id: 'doc' } },
    ]) {
      const result = parseUpdate({ update_id: 2, message });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dispatch.kind).toBe('other');
      expect(result.dispatch.fileId).toBeNull();
    }
  });

  it('classifies an update with no message as other, with null ids', () => {
    const result = parseUpdate({ update_id: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dispatch).toMatchObject({ updateId: 100, kind: 'other', telegramUserId: null, chatId: null });
  });

  it('rejects a payload missing update_id (caller acknowledges 200 and drops)', () => {
    const result = parseUpdate({ message: { chat: { id: 1 }, text: 'hi' } });
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Voice container detection — all three, plus a refused one (V26)             */
/* -------------------------------------------------------------------------- */

describe('detectVoiceContainerMime', () => {
  it('detects OGG/Opus from the OggS magic', () => {
    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x01]);
    expect(detectVoiceContainerMime(bytes)).toBe(VOICE_MIME_OGG);
  });

  it('detects MP3 from an ID3 tag', () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
    expect(detectVoiceContainerMime(bytes)).toBe(VOICE_MIME_MP3);
  });

  it('detects MP3 from a raw MPEG frame sync', () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    expect(detectVoiceContainerMime(bytes)).toBe(VOICE_MIME_MP3);
  });

  it('detects M4A from an ftyp box', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    expect(detectVoiceContainerMime(bytes)).toBe(VOICE_MIME_M4A);
  });

  it('refuses anything else', () => {
    expect(detectVoiceContainerMime(new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]))).toBeNull();
    expect(detectVoiceContainerMime(new Uint8Array([]))).toBeNull();
  });

  it('the three accepted mimes are exactly the three container types', () => {
    expect([...ACCEPTED_VOICE_MIMES].sort()).toEqual([VOICE_MIME_M4A, VOICE_MIME_MP3, VOICE_MIME_OGG].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* getFile + downloadFile (V25) — helpers                                      */
/* -------------------------------------------------------------------------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function bytesResponse(bytes: Uint8Array, status = 200): Response {
  // Node/undici accepts a Uint8Array body at runtime; the cast satisfies the DOM `BodyInit` typing.
  return new Response(bytes as unknown as BodyInit, { status });
}

/** A fetch that returns queued responses in order and records the URLs it was called with. */
function scriptedFetch(responses: Response[]): { fetchImpl: TelegramFetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl: TelegramFetch = (input) => {
    urls.push(input);
    const next = responses[i++];
    if (next === undefined) throw new Error('scriptedFetch ran out of responses');
    return Promise.resolve(next);
  };
  return { fetchImpl, urls };
}

const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02, 0x03]);

describe('getFile', () => {
  it('returns the file_path and reported size', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 2048 } })]);
    const result = await getFile('file-abc', { botToken: BOT_TOKEN, fetchImpl });
    expect(result.filePath).toBe('voice/file_1.oga');
    expect(result.fileSize).toBe(2048);
  });

  it('throws a TelegramApiError with no token in the message on a non-2xx', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse({ ok: false }, 400)]);
    await expect(getFile('file-abc', { botToken: BOT_TOKEN, fetchImpl })).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(TelegramApiError);
      expect((e as Error).message).not.toContain(BOT_TOKEN);
      return true;
    });
  });
});

describe('downloadFile', () => {
  it('downloads a photo and reports image/jpeg', async () => {
    const { fetchImpl, urls } = scriptedFetch([
      jsonResponse({ ok: true, result: { file_path: 'photos/file_9.jpg', file_size: 50000 } }),
      bytesResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
    ]);
    const result = await downloadFile('photo-id', { botToken: BOT_TOKEN, fetchImpl, kind: 'photo' });
    expect(result.mimeType).toBe(TELEGRAM_PHOTO_MIME);
    expect(result.size).toBe(4);
    // The download URL embeds the token; that is expected in the URL and only in the URL.
    expect(urls[1]).toContain('/file/bot');
  });

  it('downloads a voice note and uses the reported mime_type', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: OGG_BYTES.length } }),
      bytesResponse(OGG_BYTES),
    ]);
    const result = await downloadFile('voice-id', {
      botToken: BOT_TOKEN,
      fetchImpl,
      kind: 'voice',
      reportedMimeType: 'audio/ogg',
    });
    expect(result.mimeType).toBe(VOICE_MIME_OGG);
  });

  it('sniffs the container when no mime_type is reported (U-V26)', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse({ ok: true, result: { file_path: 'voice/file_1', file_size: OGG_BYTES.length } }),
      bytesResponse(OGG_BYTES),
    ]);
    const result = await downloadFile('voice-id', { botToken: BOT_TOKEN, fetchImpl, kind: 'voice', reportedMimeType: null });
    expect(result.mimeType).toBe(VOICE_MIME_OGG);
  });

  it('refuses a voice note whose bytes match no permitted container', async () => {
    const junk = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    const { fetchImpl } = scriptedFetch([
      jsonResponse({ ok: true, result: { file_path: 'voice/file_x', file_size: junk.length } }),
      bytesResponse(junk),
    ]);
    await expect(
      downloadFile('voice-id', { botToken: BOT_TOKEN, fetchImpl, kind: 'voice', reportedMimeType: null }),
    ).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('refuses a file above 20 MB from the reported size, before downloading (V25)', async () => {
    const { fetchImpl, urls } = scriptedFetch([
      jsonResponse({ ok: true, result: { file_path: 'big/file', file_size: TELEGRAM_MAX_DOWNLOAD_BYTES + 1 } }),
    ]);
    await expect(downloadFile('big', { botToken: BOT_TOKEN, fetchImpl, kind: 'photo' })).rejects.toBeInstanceOf(
      TelegramApiError,
    );
    // Only getFile was called; no binary fetch was attempted.
    expect(urls).toHaveLength(1);
  });

  it('refuses a file above 20 MB by actual length when the report was absent', async () => {
    const big = new Uint8Array(TELEGRAM_MAX_DOWNLOAD_BYTES + 8);
    big.set([0xff, 0xd8, 0xff, 0xe0], 0);
    const { fetchImpl } = scriptedFetch([
      jsonResponse({ ok: true, result: { file_path: 'big/file' } }),
      bytesResponse(big),
    ]);
    await expect(downloadFile('big', { botToken: BOT_TOKEN, fetchImpl, kind: 'photo' })).rejects.toBeInstanceOf(
      TelegramApiError,
    );
  });

  it('never puts the bot token in the error message when the download itself fails', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse({ ok: true, result: { file_path: 'photos/file.jpg', file_size: 10 } }),
      bytesResponse(new Uint8Array([0x00]), 500),
    ]);
    await expect(downloadFile('photo-id', { botToken: BOT_TOKEN, fetchImpl, kind: 'photo' })).rejects.toSatisfy(
      (e: unknown) => {
        expect((e as Error).message).not.toContain(BOT_TOKEN);
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* sendMessage (V24)                                                           */
/* -------------------------------------------------------------------------- */

describe('truncateText', () => {
  it('leaves a short reply unchanged', () => {
    expect(truncateText('short reply')).toBe('short reply');
  });

  it('never exceeds the 4096-character cap and marks a cut', () => {
    const long = 'x'.repeat(TELEGRAM_TEXT_MAX_CHARS + 500);
    const out = truncateText(long);
    expect(out.length).toBe(TELEGRAM_TEXT_MAX_CHARS);
    expect(out.endsWith('\u2026')).toBe(true);
  });
});

describe('sendMessage', () => {
  it('posts chat_id and text and reads the returned message id', async () => {
    const fetchImpl = vi.fn<TelegramFetch>().mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 555 } }));
    const result = await sendMessage(999, 'diagnosis reply', { botToken: BOT_TOKEN, fetchImpl });
    expect(result).toEqual({ ok: true, sentMessageId: 555 });
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1]?.body ?? '{}') as string);
    expect(body).toEqual({ chat_id: 999, text: 'diagnosis reply' });
  });

  it('returns ok:false with the status on a non-2xx, never throwing', async () => {
    const fetchImpl = vi.fn<TelegramFetch>().mockResolvedValue(jsonResponse({ ok: false }, 403));
    await expect(sendMessage(1, 'x', { botToken: BOT_TOKEN, fetchImpl })).resolves.toEqual({ ok: false, status: 403 });
  });

  it('returns ok:false with null status on a transport error', async () => {
    const fetchImpl: TelegramFetch = () => Promise.reject(new Error('network down'));
    await expect(sendMessage(1, 'x', { botToken: BOT_TOKEN, fetchImpl })).resolves.toEqual({ ok: false, status: null });
  });

  it('throws for an empty body (a caller defect, not a send failure)', async () => {
    await expect(sendMessage(1, '   ', { botToken: BOT_TOKEN, fetchImpl: () => Promise.reject() })).rejects.toThrow();
  });
});
