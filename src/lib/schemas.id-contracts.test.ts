import { describe, expect, it } from 'vitest';

import {
  chatRequestSchema,
  dbIdSchema,
  diagnoseRequestSchema,
  mediaRefSchema,
  voiceRequestSchema,
} from '@/lib/schemas';

/**
 * The API contracts key `conversationId`, `diagnosisId` and the message ids to MongoDB ObjectId hex
 * (Amendment A3), not to uuid. Before this was fixed, `diagnose` returned an ObjectId-hex
 * `conversationId` and the chat/voice request schemas — still on the Supabase-era `z.uuid()` —
 * rejected it, so every follow-up chat or voice turn failed with `CONVERSATION_NOT_FOUND` before the
 * service ran. These tests pin the substrate-correct id format so the regression cannot return.
 */
const OBJECT_ID = '6ab8c4243a158fc361039c03'; // a real 24-hex ObjectId from a live diagnose
const UUID = '11111111-2222-4333-8444-555555555555';

describe('dbIdSchema (MongoDB ObjectId hex on the wire)', () => {
  it('accepts a 24-character lowercase hex ObjectId', () => {
    expect(dbIdSchema.safeParse(OBJECT_ID).success).toBe(true);
  });

  it('rejects a uuid (the retired Supabase id form)', () => {
    expect(dbIdSchema.safeParse(UUID).success).toBe(false);
  });

  it('rejects uppercase hex and wrong lengths', () => {
    expect(dbIdSchema.safeParse(OBJECT_ID.toUpperCase()).success).toBe(false);
    expect(dbIdSchema.safeParse(OBJECT_ID.slice(0, 23)).success).toBe(false);
    expect(dbIdSchema.safeParse('').success).toBe(false);
  });
});

describe('chat/voice request schemas accept an ObjectId-hex conversationId', () => {
  const validMediaVoice = { fileId: OBJECT_ID, kind: 'voice' as const };

  it('chatRequestSchema accepts an ObjectId-hex conversationId', () => {
    const parsed = chatRequestSchema.safeParse({ conversationId: OBJECT_ID, message: 'hello', language: 'en' });
    expect(parsed.success).toBe(true);
  });

  it('chatRequestSchema rejects a uuid conversationId', () => {
    const parsed = chatRequestSchema.safeParse({ conversationId: UUID, message: 'hello', language: 'en' });
    expect(parsed.success).toBe(false);
  });

  it('voiceRequestSchema accepts an ObjectId-hex conversationId', () => {
    const parsed = voiceRequestSchema.safeParse({
      audio: validMediaVoice,
      language: 'en',
      conversationId: OBJECT_ID,
      durationSeconds: 3,
    });
    expect(parsed.success).toBe(true);
  });

  it('diagnoseRequestSchema accepts an optional ObjectId-hex conversationId', () => {
    const parsed = diagnoseRequestSchema.safeParse({
      image: { fileId: OBJECT_ID, kind: 'crop-image' },
      language: 'en',
      conversationId: OBJECT_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('diagnoseRequestSchema still accepts an omitted conversationId', () => {
    const parsed = diagnoseRequestSchema.safeParse({
      image: { fileId: OBJECT_ID, kind: 'crop-image' },
      language: 'en',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('mediaRefSchema is unchanged and still ObjectId-hex', () => {
  it('accepts a crop-image ref with an ObjectId-hex fileId', () => {
    expect(mediaRefSchema.safeParse({ fileId: OBJECT_ID, kind: 'crop-image' }).success).toBe(true);
  });
});
