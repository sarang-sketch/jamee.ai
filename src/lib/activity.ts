import 'server-only';

import { listRecentMessages, type MessageRecord } from '@/lib/db/reads';
import { AppError } from '@/lib/errors';
import type { Channel, InputKind, Language, MessageRole } from '@/lib/schemas';

export const ACTIVITY_MESSAGE_LIMIT = 24;

export interface ActivityMessage {
  readonly channel: Channel;
  readonly content: string;
  readonly createdAt: string;
  readonly id: string;
  readonly inputKind: InputKind;
  readonly language: Language;
  readonly role: MessageRole;
}

export interface ReadRecentActivityInput {
  limit?: number;
  read?: (ownerId: string, limit: number) => Promise<readonly MessageRecord[]>;
  userId: string;
}

/**
 * Read one newest-first stream of this farmer's persisted website and Telegram messages.
 * The owner is always supplied by the server-confirmed session, and `listRecentMessages` merges it
 * into the MongoDB query before applying the bound. No browser-provided id or channel filter is
 * accepted, so both channels appear together without weakening tenant isolation.
 */
export async function readRecentActivity({
  limit = ACTIVITY_MESSAGE_LIMIT,
  read = listRecentMessages,
  userId,
}: ReadRecentActivityInput): Promise<ActivityMessage[]> {
  let rows: readonly MessageRecord[];
  try {
    rows = await read(userId, limit);
  } catch (cause) {
    throw new AppError('INTERNAL_ERROR', {
      cause,
      context: { reason: 'cross_channel_activity_read_failed', userId },
    });
  }

  return rows.map((row) => ({
    channel: row.channel,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    id: row._id.toHexString(),
    inputKind: row.inputKind,
    language: row.language,
    role: row.role,
  }));
}
