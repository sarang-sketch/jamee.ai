import { describe, expect, it } from 'vitest';

import {
  classifySignal,
  isFallbackTrigger,
  parseRetryAfterSeconds,
  PROVIDER_FAILURES,
  ProviderError,
  retryAfterFromHeaders,
  retryAfterSecondsOf,
  type FailureClassification,
} from '@/lib/ai/errors';
import {
  GEMINI_RATE_LIMIT_STATUS_NAME,
  GEMINI_UNAVAILABLE_STATUS_NAME,
  PROVIDER_RATE_LIMIT_STATUSES,
  PROVIDER_UNAVAILABLE_STATUSES,
} from '@/lib/config/verified';

/**
 * Unit tests for the classification seam: the conservative default, and the fact that the two Groq
 * input-validation codes cannot become fallback triggers.
 *
 * The tables below are built here rather than imported because each adapter owns its own (tasks
 * 8.2, 8.3). They are the V11 tables `errors.ts` documents, which is what makes these tests a
 * check on the matcher rather than on an adapter that does not exist yet.
 *
 * Requirements: 14.4
 */

const GROQ: FailureClassification = {
  rateLimitStatuses: PROVIDER_RATE_LIMIT_STATUSES,
  unavailableStatuses: PROVIDER_UNAVAILABLE_STATUSES,
  rateLimitStatusNames: [],
  unavailableStatusNames: [],
};

const GEMINI: FailureClassification = {
  rateLimitStatuses: PROVIDER_RATE_LIMIT_STATUSES,
  // Narrower than Groq's on purpose: V11 documents only `503 UNAVAILABLE` for Gemini.
  unavailableStatuses: [503],
  rateLimitStatusNames: [GEMINI_RATE_LIMIT_STATUS_NAME],
  unavailableStatusNames: [GEMINI_UNAVAILABLE_STATUS_NAME],
};

describe('isFallbackTrigger', () => {
  it('admits exactly the two transport buckets', () => {
    expect(PROVIDER_FAILURES.filter(isFallbackTrigger)).toEqual(['RATE_LIMIT', 'UNAVAILABLE']);
  });
});

describe('classifySignal', () => {
  it('maps the Groq signals V11 resolved', () => {
    expect(classifySignal({ status: 429 }, GROQ)).toBe('RATE_LIMIT');
    expect(classifySignal({ status: 500 }, GROQ)).toBe('UNAVAILABLE');
    expect(classifySignal({ status: 502 }, GROQ)).toBe('UNAVAILABLE');
    expect(classifySignal({ status: 503 }, GROQ)).toBe('UNAVAILABLE');
  });

  it('keeps Groq 413 and 422 out of the fallback path', () => {
    // 413 is Jamee's own oversized payload and 422 is documented to include model hallucinations.
    // Retrying either on a second provider spends a call to learn nothing.
    for (const status of [413, 422]) {
      const failure = classifySignal({ status }, GROQ);
      expect(failure).toBe('OTHER');
      expect(isFallbackTrigger(failure)).toBe(false);
    }
  });

  it('maps the Gemini signals V11 resolved, on status name or status', () => {
    expect(classifySignal({ status: 429, statusName: 'RESOURCE_EXHAUSTED' }, GEMINI)).toBe(
      'RATE_LIMIT',
    );
    expect(classifySignal({ status: 503, statusName: 'UNAVAILABLE' }, GEMINI)).toBe('UNAVAILABLE');
    expect(classifySignal({ status: 429 }, GEMINI)).toBe('RATE_LIMIT');
  });

  it('leaves Gemini 408 and 500 as OTHER', () => {
    // Deliberate conservatism: V11 records Gemini's own retry set as 429/408/5xx, but widening
    // these buckets changes when Jamee doubles provider spend and belongs in VERIFIED_VALUES.md.
    expect(classifySignal({ status: 408 }, GEMINI)).toBe('OTHER');
    expect(classifySignal({ status: 500, statusName: 'INTERNAL' }, GEMINI)).toBe('OTHER');
  });

  it('defaults to OTHER for a signal carrying nothing recognisable', () => {
    expect(classifySignal({}, GROQ)).toBe('OTHER');
    expect(classifySignal({}, GEMINI)).toBe('OTHER');
    expect(classifySignal({ status: 418, statusName: 'TEAPOT' }, GEMINI)).toBe('OTHER');
  });
});

describe('ProviderError', () => {
  it('builds its message from the status and status name only', () => {
    const error = new ProviderError({
      failure: 'RATE_LIMIT',
      status: 429,
      statusName: 'RESOURCE_EXHAUSTED',
      retryAfterSeconds: 12,
      cause: new Error('rate limit reached for model X on tokens per minute'),
    });

    expect(error.message).toBe('provider failure RATE_LIMIT (HTTP 429 RESOURCE_EXHAUSTED)');
    expect(error.message).not.toContain('tokens per minute');
    expect(retryAfterSecondsOf(error)).toBe(12);
  });

  it('reads a retry-after off nothing else', () => {
    expect(retryAfterSecondsOf(new Error('429'))).toBeUndefined();
    expect(retryAfterSecondsOf(new ProviderError({ failure: 'UNAVAILABLE' }))).toBeUndefined();
  });
});

describe('parseRetryAfterSeconds', () => {
  it('reads whole seconds and rejects anything else', () => {
    expect(parseRetryAfterSeconds('7')).toBe(7);
    expect(parseRetryAfterSeconds(' 2.4 ')).toBe(3);
    expect(parseRetryAfterSeconds('0')).toBe(0);
    expect(parseRetryAfterSeconds('-1')).toBeUndefined();
    // The HTTP-date form is deliberately not parsed — no provider Jamee talks to documents it.
    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
  });

  it('reads the V11 header name off a fetch Headers object', () => {
    expect(retryAfterFromHeaders(new Headers({ 'Retry-After': '30' }))).toBe(30);
    expect(retryAfterFromHeaders(new Headers())).toBeUndefined();
  });
});
