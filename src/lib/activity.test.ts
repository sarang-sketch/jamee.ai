import { ObjectId, type WithId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { readRecentActivity } from '@/lib/activity';
import type { MessageDoc } from '@/lib/db/collections';

const FARMER = 'auth-user-activity';

function message(
  channel: MessageDoc['channel'],
  content: string,
  createdAt: string,
): WithId<MessageDoc> {
  return {
    _id: new ObjectId(),
    ownerId: FARMER,
    conversationId: new ObjectId(),
    role: channel === 'web' ? 'farmer' : 'jamee',
    content,
    language: channel === 'web' ? 'en' : 'mr',
    channel,
    inputKind: channel === 'web' ? 'text' : 'voice',
    createdAt: new Date(createdAt),
  };
}

describe('readRecentActivity', () => {
  it('keeps the bounded newest-first website and Telegram stream together', async () => {
    const rows = [
      message('telegram', 'Telegram answer', '2026-09-27T08:00:00.000Z'),
      message('web', 'Website question', '2026-09-27T07:00:00.000Z'),
    ];
    const calls: Array<{ ownerId: string; limit: number }> = [];

    const result = await readRecentActivity({
      userId: FARMER,
      limit: 12,
      read: (ownerId, limit) => {
        calls.push({ ownerId, limit });
        return Promise.resolve(rows);
      },
    });

    expect(calls).toEqual([{ ownerId: FARMER, limit: 12 }]);
    expect(result.map(({ channel, content }) => ({ channel, content }))).toEqual([
      { channel: 'telegram', content: 'Telegram answer' },
      { channel: 'web', content: 'Website question' },
    ]);
    expect(result[0]?.inputKind).toBe('voice');
    expect(result[0]?.createdAt).toBe('2026-09-27T08:00:00.000Z');
  });

  it('turns a database failure into the stable internal error taxonomy', async () => {
    await expect(
      readRecentActivity({
        userId: FARMER,
        read: () => Promise.reject(new Error('synthetic database failure')),
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
