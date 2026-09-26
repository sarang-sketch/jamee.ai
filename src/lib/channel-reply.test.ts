import { describe, expect, it } from 'vitest';

import { formatChatReply, formatDiagnosisReply, formatVoiceReply, failureReply } from '@/lib/channel-reply';
import { AppError } from '@/lib/errors';
import { messages } from '@/lib/messages';
import type { DiagnosisResult } from '@/lib/schemas';

/**
 * Unit tests for the channel-agnostic reply formatters (`src/lib/channel-reply.ts`).
 *
 * These are the ONE place a service result becomes messaging text, so both channels format an
 * identical Diagnosis_Result identically (D7). The tests assert the structure — the canonical name
 * leads, the severity is a catalog label, an inconclusive result carries the expert banner, a chat
 * answer is passed through unchanged, and a voice reply carries transcript + answer — and that a
 * failure reply carries only the coded, localized sentence with no provider payload (15.6).
 */

const identified: DiagnosisResult = {
  status: 'identified',
  diseaseName: 'Tomato Early Blight',
  confidence: 0.9,
  severity: 'moderate',
  explanation: 'Grounded explanation of early blight.',
  knowledge: {} as never,
  needsExpert: false,
  language: 'en',
};

const inconclusive: DiagnosisResult = {
  status: 'unknown',
  diseaseName: null,
  confidence: null,
  severity: 'none',
  explanation: 'Jamee could not judge this photo.',
  knowledge: null,
  needsExpert: true,
  language: 'en',
};

describe('formatDiagnosisReply', () => {
  it('leads with the canonical name (untranslated) and the catalog severity label', () => {
    const reply = formatDiagnosisReply(identified, 'en');
    const { ui, severity } = messages('en');
    expect(reply.startsWith('Tomato Early Blight')).toBe(true);
    expect(reply).toContain(`${ui.severityLabel}: ${severity.moderate}`);
    expect(reply).toContain('Grounded explanation of early blight.');
    // An identified result does not carry the expert banner.
    expect(reply).not.toContain(ui.needsExpertBanner);
  });

  it('an inconclusive result shows the inconclusive label and the expert banner', () => {
    const reply = formatDiagnosisReply(inconclusive, 'en');
    const { ui } = messages('en');
    expect(reply).toContain(ui.inconclusiveLabel);
    expect(reply).toContain(ui.needsExpertBanner);
  });
});

describe('formatChatReply', () => {
  it('passes the answer content through unchanged (no heading, no doubled referral)', () => {
    expect(formatChatReply('Consult your local agricultural officer.')).toBe(
      'Consult your local agricultural officer.',
    );
  });
});

describe('formatVoiceReply', () => {
  it('carries the transcript label, the transcript, then the answer', () => {
    const reply = formatVoiceReply('what is wrong with my crop', 'Water it less.', 'en');
    const { ui } = messages('en');
    expect(reply).toContain(`${ui.transcriptLabel}: what is wrong with my crop`);
    expect(reply).toContain('Water it less.');
    expect(reply.indexOf('what is wrong')).toBeLessThan(reply.indexOf('Water it less.'));
  });
});

describe('failureReply', () => {
  it('returns only the coded localized sentence — never a provider payload or stack', () => {
    const err = new AppError('INTERNAL_ERROR', { cause: new Error('raw provider stack: secret-ish') });
    const reply = failureReply(err, 'en');
    expect(reply).toBe(messages('en').errors.INTERNAL_ERROR);
    expect(reply).not.toContain('secret-ish');
    expect(reply).not.toContain('stack');
  });

  it('wraps a non-AppError as INTERNAL_ERROR', () => {
    const reply = failureReply(new Error('boom'), 'hi');
    expect(reply).toBe(messages('hi').errors.INTERNAL_ERROR);
    expect(reply).not.toContain('boom');
  });
});
