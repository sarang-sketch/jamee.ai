import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LanguageContext, type LanguageContextValue } from '@/components/LanguageProvider';
import {
  readVoiceResponse,
  VoiceAnswerCard,
  VoicePanel,
} from '@/components/VoiceAnswerCard';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  voiceResponseSchema,
  type Language,
  type VoiceResponse,
} from '@/lib/schemas';

/**
 * Unit tests for what `/voice` says after a farmer speaks, and for how the raw `/api/voice`
 * response is read.
 *
 * Requirements: 8.6 (the transcript AND the answer are both displayed, transcript FIRST), 8.8 (text
 *               answers only — no synthesized speech and no playback control anywhere in this
 *               subtree), 15.7 (the listening state exists exactly once, and it belongs to
 *               `VoiceRecorder` which holds the request), 15.2 (no simulated or time-based
 *               progress), 15.3 / 15.4 (the returned localized message is what gets displayed),
 *               9.3 (each block is rendered in the language it was produced in)
 *
 * Rendered to static markup rather than mounted, following `DiagnosisResultCard.test.tsx`: this
 * project has no React testing library, and the questions here are about what the DOM says. It also
 * happens to be the only way to render `VoiceRecorder` at all — jsdom has neither `MediaRecorder`
 * nor `getUserMedia`, so its capture half cannot be exercised in a browser-like environment either.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CONVERSATION_ID = '4'.repeat(24);
const MESSAGE_ID = '5'.repeat(24);
const USER_ID = '11111111-1111-4111-8111-111111111111';

const TRANSCRIPT = 'My tomato leaves have dark spots with yellow edges.';
const ANSWER = 'Those dark spots ringed with yellow point to Tomato Early Blight.';

function voiceResponse(overrides: Partial<VoiceResponse> = {}): VoiceResponse {
  /** Parsed rather than trusted, so a fixture that drifts from the contract fails here. */
  return voiceResponseSchema.parse({
    transcript: TRANSCRIPT,
    answer: {
      messageId: MESSAGE_ID,
      content: ANSWER,
      language: 'en',
      groundedIn: ['Tomato Early Blight'],
      needsExpert: false,
    },
    conversationId: CONVERSATION_ID,
    quota: {
      operation: 'voice',
      used: 4,
      limit: 20,
      resetsAt: '2026-09-15T18:30:00.000Z',
    },
    ...overrides,
  });
}

function okResponse(payload: VoiceResponse): Response {
  return Response.json(payload);
}

function renderCard(response: VoiceResponse): string {
  return renderToStaticMarkup(<VoiceAnswerCard response={response} />);
}

/** Text as it reads to a farmer: tags removed, entities that matter decoded. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ========================================================================== */
/* The card (Requirements 8.6, 8.8)                                             */
/* ========================================================================== */

describe('VoiceAnswerCard', () => {
  /**
   * Requirement 8.6 — both are displayed, and the transcript is displayed **above** the answer.
   * Asserted on DOM order rather than on CSS, because DOM order is what a screen reader follows
   * and what the surrounding polite live region announces.
   */
  it('renders the transcript above the answer, both labelled', () => {
    const { ui } = messages('en');
    const markup = renderCard(voiceResponse());

    expect(markup).toContain(TRANSCRIPT);
    expect(markup).toContain(ANSWER);
    expect(markup).toContain(ui.transcriptLabel);
    expect(markup).toContain(ui.answerLabel);

    expect(markup.indexOf(TRANSCRIPT)).toBeLessThan(markup.indexOf(ANSWER));
    expect(markup.indexOf(ui.transcriptLabel)).toBeLessThan(markup.indexOf(ui.answerLabel));
  });

  /**
   * Requirement 8.8 — text answers only in this release. There is no `<audio>`, no playback
   * control, and no autoplay: the absence is the requirement, so something has to check it.
   */
  it('offers no audio playback of the answer', () => {
    const markup = renderCard(voiceResponse());

    expect(markup).not.toContain('<audio');
    expect(markup).not.toContain('<video');
    expect(markup).not.toContain('autoplay');
  });

  /**
   * Requirement 9.3 — the labels and both blocks follow the language the answer was produced in,
   * which is also the code the request carried and therefore the language the recording was
   * transcribed into.
   */
  it('labels both blocks in the language the answer was produced in', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = messages(language);
      const markup = renderCard(
        voiceResponse({
          answer: {
            messageId: MESSAGE_ID,
            content: ANSWER,
            language,
            groundedIn: [],
            needsExpert: false,
          },
        }),
      );
      const text = textOf(markup);

      expect(text).toContain(catalog.ui.transcriptLabel);
      expect(text).toContain(catalog.ui.answerLabel);
      // Devanagari announced under `lang="en"` is mispronounced or skipped.
      expect(markup).toContain(`lang="${language}"`);
    }
  });

  /**
   * An empty transcript cannot reach this card through `voice.service.ts` — Requirement 8.7 makes
   * it `TRANSCRIPT_EMPTY`, which arrives as an envelope instead. If it ever did, a label over
   * nothing would read as content that went missing, so the block is omitted entirely.
   */
  it('omits the transcript block entirely when there is no transcript', () => {
    const { ui } = messages('en');
    const text = textOf(renderCard(voiceResponse({ transcript: '   ' })));

    expect(text).not.toContain(ui.transcriptLabel);
    expect(text).toContain(ui.answerLabel);
    expect(text).toContain(ANSWER);
  });
});

/* ========================================================================== */
/* Reading the response (Requirements 15.3, 15.4)                              */
/* ========================================================================== */

describe('readVoiceResponse', () => {
  it('reads a 200 into an answer, transcript preserved verbatim', async () => {
    const payload = voiceResponse();
    const outcome = await readVoiceResponse(okResponse(payload), 'en');

    expect(outcome.kind).toBe('answer');
    if (outcome.kind !== 'answer') return;
    expect(outcome.response.transcript).toBe(TRANSCRIPT);
    expect(outcome.response.answer.content).toBe(ANSWER);
    expect(outcome.response.conversationId).toBe(CONVERSATION_ID);
  });

  /**
   * Requirements 15.3, 15.4 and 8.7 — the message displayed is the one the API returned, not one
   * rebuilt on the client from the code. `TRANSCRIPT_EMPTY` is the case that matters on this
   * screen: an empty transcript is an error carrying "record it again somewhere quieter", not a
   * 200 with nothing in it.
   */
  it('reads a non-2xx envelope and keeps the returned message verbatim', async () => {
    const body = {
      error: {
        code: 'TRANSCRIPT_EMPTY',
        message: messages('mr').errors.TRANSCRIPT_EMPTY,
        language: 'mr' satisfies Language,
        retryable: true,
      },
    };
    const outcome = await readVoiceResponse(Response.json(body, { status: 422 }), 'mr');

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('TRANSCRIPT_EMPTY');
    expect(outcome.envelope.error.message).toBe(body.error.message);
    expect(outcome.cause).toBeUndefined();
  });

  /**
   * A 200 that fails the response contract is Jamee disagreeing with itself: the farmer gets the
   * generic localized sentence and the real cause is returned for the log, never rendered
   * (Requirement 15.6).
   */
  it('turns a malformed 200 into a localized INTERNAL_ERROR', async () => {
    const outcome = await readVoiceResponse(
      Response.json({ transcript: TRANSCRIPT }, { status: 200 }),
      'hi',
    );

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('INTERNAL_ERROR');
    expect(outcome.envelope.error.message).toBe(messages('hi').errors.INTERNAL_ERROR);
    expect(outcome.envelope.error.language).toBe('hi');
    expect(outcome.cause).toBeDefined();
  });

  it('turns a body that is not JSON into a localized INTERNAL_ERROR', async () => {
    const outcome = await readVoiceResponse(
      new Response('<html>gateway timeout</html>', { status: 504 }),
      'en',
    );

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('INTERNAL_ERROR');
    // No provider payload, no markup, no stack trace in what the farmer would read.
    expect(outcome.envelope.error.message).not.toContain('html');
  });

  /** A non-2xx whose body is not an envelope is also Jamee's fault, not a rendered guess. */
  it('turns a non-2xx without an envelope into a localized INTERNAL_ERROR', async () => {
    const outcome = await readVoiceResponse(Response.json({ message: 'nope' }, { status: 500 }), 'en');

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('INTERNAL_ERROR');
  });
});

/* ========================================================================== */
/* The result region                                                           */
/* ========================================================================== */

describe('VoicePanel', () => {
  const HEADING_ID = 'jamee-voice-heading';

  function renderPanel(language: Language): string {
    const value: LanguageContextValue = { language, setLanguage: () => {} };
    return renderToStaticMarkup(
      <LanguageContext.Provider value={value}>
        <VoicePanel userId={USER_ID} conversationId={CONVERSATION_ID} labelledBy={HEADING_ID} />
      </LanguageContext.Provider>,
    );
  }

  /**
   * The region is a named landmark with `aria-live="polite"`, and it is in the DOM **before** any
   * response exists — a polite region inserted together with its text is not reliably announced.
   */
  it('renders an empty aria-live landmark before any response', () => {
    const markup = renderPanel('en');
    const { ui } = messages('en');
    const region = /<section[^>]*aria-live="polite"[^>]*>/.exec(markup);

    expect(region?.[0]).toContain(`aria-labelledby="${HEADING_ID}"`);
    // Nothing is claimed about a question before one has been asked.
    expect(markup).not.toContain(ui.transcriptLabel);
    expect(markup).not.toContain(ui.answerLabel);
  });

  /**
   * Requirement 15.7's listening state belongs to `VoiceRecorder`, which holds the request — and it
   * is the ONLY indicator in the flow. One `role="status"` line, no second one from this panel, and
   * Requirement 15.2's no simulated progress: no percentage, no progress element, no timer.
   */
  it('adds no second loading indicator and no simulated progress', () => {
    const markup = renderPanel('en');
    const { loading } = messages('en');

    expect([...markup.matchAll(/role="status"/g)]).toHaveLength(1);
    // The three real state lines are the recorder's, and none of them is on screen while idle.
    expect(markup).not.toContain(loading.listening);
    expect(markup).not.toContain(loading.uploadingRecording);
    expect(markup).not.toContain(loading.thinking);
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('<progress');
  });

  /** Requirement 8.8, at the screen level: nothing in this subtree can play audio. */
  it('renders no audio element anywhere in the subtree', () => {
    const markup = renderPanel('en');

    expect(markup).not.toContain('<audio');
    expect(markup).not.toContain('autoplay');
  });

  /** The recorder's own controls render in the active language, from the same context. */
  it('renders the recorder controls in the active language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const text = textOf(renderPanel(language));
      const { ui } = messages(language);

      expect(text).toContain(ui.holdToSpeak);
      expect(text).toContain(ui.tapToStart);
    }
  });
});
