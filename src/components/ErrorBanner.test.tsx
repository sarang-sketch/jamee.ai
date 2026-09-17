import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import {
  ErrorBanner,
  offersRetryControl,
  type ErrorBannerError,
  type ErrorBannerRetry,
} from '@/components/ErrorBanner';
import { AppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import { SUPPORTED_LANGUAGES, type Language } from '@/lib/schemas';

/**
 * Unit tests for the one error banner.
 *
 * Requirements: 15.3 (the localized message the API returned is what a farmer reads), 15.4 (it is
 *               displayed, and a retry action is offered for the failed operation — only when the
 *               envelope says a retry could work), 15.6 (nothing but the message reaches the DOM)
 *
 * Rendered to static markup rather than mounted, following `DiagnosisResultCard.test.tsx` and
 * `VoiceAnswerCard.test.tsx`: this project has no React testing library, and every question here is
 * about what the DOM says. The one thing that cannot be asserted this way is that pressing the retry
 * control calls `onRetry` — a click needs a mounted tree — so what is pinned instead is that the
 * control exists exactly when it should, is a real `<button type="button">`, and carries the
 * catalog's own label. The behaviour of the callback belongs to the manual pass and to task 26.2.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CONTROL: ErrorBannerRetry = { kind: 'control' };
const NONE: ErrorBannerRetry = { kind: 'none' };
const ACTION: ErrorBannerRetry = { kind: 'action', onRetry: () => {} };

/**
 * A real envelope from the taxonomy, so no fixture invents a message, a language or a flag.
 *
 * `QUOTA_EXCEEDED` is the interesting one and it is given everything its sentence interpolates —
 * the limit, the reset instant and the operation — because the point of the verbatim rule is that
 * those values are filled in on the server.
 */
function errorFor(code: 'INTERNAL_ERROR' | 'QUOTA_EXCEEDED', language: Language): ErrorBannerError {
  const error = new AppError(
    code,
    code === 'QUOTA_EXCEEDED'
      ? {
          details: { limit: 20, used: 20, resetsAt: '2026-03-12T18:30:00.000Z' },
          context: { operation: 'image' },
        }
      : {},
  );
  const { error: envelope } = toEnvelope(error, language);
  return {
    message: envelope.message,
    language: envelope.language,
    retryable: envelope.retryable,
  };
}

function render(error: ErrorBannerError, retry: ErrorBannerRetry): string {
  return renderToStaticMarkup(<ErrorBanner error={error} retry={retry} />);
}

/** Text as it reads to a farmer: tags removed, the entities React escapes decoded. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x2019;/g, '\u2019')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ========================================================================== */
/* What a farmer reads (Requirements 15.3, 15.6)                               */
/* ========================================================================== */

describe('the banner itself', () => {
  /**
   * `role="alert"` is the design's error-banner rule, and it is the assertive announcement that
   * makes a failed request reach a farmer who is not looking at the screen.
   */
  it('is an alert region', () => {
    expect(render(errorFor('INTERNAL_ERROR', 'en'), CONTROL)).toContain('role="alert"');
  });

  /**
   * Requirement 15.3, and the whole reason the banner takes a message rather than a code:
   * `QUOTA_EXCEEDED` carries a limit and a reset instant interpolated server-side, and a banner that
   * rebuilt the sentence would produce a second version of it with no access to `details`.
   */
  it('renders the returned message verbatim, interpolated values and all', () => {
    const error = errorFor('QUOTA_EXCEEDED', 'en');
    const markup = render(error, NONE);

    // React escapes the curly quote, so the assertion is on the text a farmer reads.
    expect(textOf(markup)).toContain(textOf(error.message));
    // The server-side interpolation survived: no template placeholder reached the DOM.
    for (const placeholder of ['{limit}', '{resetsAt}', '{operation}']) {
      expect(markup).not.toContain(placeholder);
    }
    // The limit and the reset instant are in the sentence, and only the server put them there.
    expect(error.message).toContain('20');
    expect(error.message).toContain('Mar');
  });

  /**
   * The `lang` comes from the envelope, not from the active switcher: a Devanagari sentence under
   * `lang="en"` is mispronounced or skipped, and a farmer who switched language after sending a
   * request would otherwise get the wrong one.
   */
  it('marks the message with the language it was written in', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const error = errorFor('INTERNAL_ERROR', language);
      const markup = render(error, NONE);

      expect(markup).toContain(`lang="${language}"`);
      expect(markup).toContain(error.message);
    }
  });

  /**
   * Requirement 15.6's client side: the props carry no cause, no stack and no provider payload, so
   * the whole of what the DOM can say is the sentence itself. Asserted as an equality on the text
   * rather than as a list of things that must be absent — a list only rules out what it names.
   */
  it('renders the message and nothing else', () => {
    const error = errorFor('INTERNAL_ERROR', 'en');
    const markup = render(error, NONE);

    expect(textOf(markup)).toBe(textOf(error.message));
    expect(markup).not.toContain('<button');
  });
});

/* ========================================================================== */
/* Whether a retry is offered (Requirement 15.4)                               */
/* ========================================================================== */

describe('the retry action', () => {
  /** The banner owns the retry, and the taxonomy says the same request could succeed. */
  it('renders a labelled control when the banner owns a retryable failure', () => {
    const error = errorFor('INTERNAL_ERROR', 'en');
    const markup = render(error, ACTION);

    expect(error.retryable).toBe(true);
    expect(markup).toContain('<button');
    expect(markup).toContain('type="button"');
    expect(markup).toContain(messages('en').ui.retry);
    expect(offersRetryControl(error, ACTION)).toBe(true);
  });

  /** Labelled in the message's language, so the button and the sentence never disagree. */
  it('labels the control in the language of the message', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const markup = render(errorFor('INTERNAL_ERROR', language), ACTION);
      expect(markup).toContain(messages(language).ui.retry);
    }
  });

  /**
   * `QUOTA_EXCEEDED` is `retryable: false` on purpose (Requirement 14.3): the request will succeed
   * tomorrow, and a button that does nothing for hours is worse than no button. The flag wins over
   * the screen's own request for one.
   */
  it('offers no control for a failure the taxonomy calls unretryable', () => {
    const error = errorFor('QUOTA_EXCEEDED', 'en');

    expect(error.retryable).toBe(false);
    expect(render(error, ACTION)).not.toContain('<button');
    expect(offersRetryControl(error, ACTION)).toBe(false);
  });

  /**
   * The two arms that render no control. `control` means a control already on screen retries the
   * operation with the farmer's input restored; `none` means nothing retries it — `VoicePanel`,
   * which never holds the recording. Both are first-class: a screen has to say which applies, and
   * neither produces a second button next to one that already exists.
   */
  it('adds no control when the screen retries the operation elsewhere, or not at all', () => {
    const error = errorFor('INTERNAL_ERROR', 'en');

    for (const retry of [CONTROL, NONE]) {
      const markup = render(error, retry);
      expect(markup).toContain(error.message);
      expect(markup).not.toContain('<button');
      expect(offersRetryControl(error, retry)).toBe(false);
    }
  });
});
