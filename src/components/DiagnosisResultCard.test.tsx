import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  confidencePercent,
  DIAGNOSE_HEADING_ID,
  DiagnosisPanel,
  DiagnosisResultCard,
  readDiagnoseResponse,
} from '@/components/DiagnosisResultCard';
import { LanguageContext, type LanguageContextValue } from '@/components/LanguageProvider';
import { messages } from '@/lib/messages';
import {
  diagnoseResponseSchema,
  SUPPORTED_LANGUAGES,
  type DiagnoseResponse,
  type IdentifiedResult,
  type InconclusiveResult,
  type Language,
} from '@/lib/schemas';
import { severityIndicator } from '@/lib/severity';

/**
 * Unit tests for what the result card says, and for how the raw `/api/diagnose` response is read.
 *
 * Requirements: 6.4 (one inconclusive shape carrying `status: 'unknown'` and `needsExpert`),
 *               6.5 (no candidate disease name and NO treatment content on an inconclusive
 *               result), 15.1 / 15.2 (no indicator and no simulated progress in this module),
 *               15.3 / 15.4 (the returned localized message is what gets displayed),
 *               9.4 (the canonical name is language-invariant), 4.5 (treatment omitted entirely
 *               when the knowledge row carries none)
 *
 * Rendered to static markup rather than mounted, following `LanguageSwitcher.test.tsx`: this
 * project has no React testing library, and the questions here are about what the DOM says.
 *
 * Requirement 6.5's other half is not tested here and cannot be: `<KnowledgeSections>` takes a
 * non-nullable `KnowledgePayload`, so rendering treatment for an inconclusive result is a **build
 * error**, and `npm run typecheck` is the assertion. What these tests cover is the half a
 * compiler cannot see — that the card does not go looking for the content some other way.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const DIAGNOSIS_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

function identified(overrides: Partial<IdentifiedResult> = {}): IdentifiedResult {
  return {
    status: 'identified',
    diseaseName: 'Tomato Late Blight',
    confidence: 0.87,
    severity: 'high',
    explanation: 'Dark water-soaked patches are spreading on the leaves.',
    knowledge: {
      symptoms: ['Water-soaked patches', 'White growth on the leaf underside'],
      causes: ['Cool wet weather'],
      treatment: ['Remove affected leaves', 'Apply an approved fungicide'],
      prevention: ['Space the plants for airflow'],
      source: 'State agricultural extension service, tomato late blight leaflet',
    },
    needsExpert: false,
    language: 'en',
    ...overrides,
  };
}

function inconclusive(overrides: Partial<InconclusiveResult> = {}): InconclusiveResult {
  return {
    status: 'unknown',
    diseaseName: null,
    confidence: null,
    severity: 'none',
    explanation: messages('en').inconclusive.model_unclear,
    knowledge: null,
    needsExpert: true,
    language: 'en',
    ...overrides,
  };
}

function envelopeResponse(payload: DiagnoseResponse): DiagnoseResponse {
  /** Parsed rather than trusted, so a fixture that drifts from the contract fails here. */
  return diagnoseResponseSchema.parse(payload);
}

function okResponse(result: IdentifiedResult | InconclusiveResult): Response {
  const body = envelopeResponse({
    diagnosisId: DIAGNOSIS_ID,
    conversationId: CONVERSATION_ID,
    result,
    quota: {
      operation: 'image',
      used: 3,
      limit: 20,
      resetsAt: '2026-09-15T18:30:00.000Z',
    },
  });
  return Response.json(body);
}

function render(result: IdentifiedResult | InconclusiveResult): string {
  return renderToStaticMarkup(<DiagnosisResultCard result={result} />);
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
/* Identified results                                                          */
/* ========================================================================== */

describe('DiagnosisResultCard — identified', () => {
  it('renders the canonical name, severity label text and confidence', () => {
    const { ui, severity } = messages('en');
    const text = textOf(render(identified()));

    expect(text).toContain('Tomato Late Blight');
    // Severity is carried by LABEL TEXT, not by colour (design: accessibility specifics).
    expect(text).toContain(ui.severityLabel);
    expect(text).toContain(severity.high);
    expect(text).toContain(ui.confidenceLabel);
    expect(text).toContain('87%');
  });

  /**
   * The other half of the design's severity rule, added by task 26.2: label text **and** icon. The
   * icon is `aria-hidden` because the word beside it is the carrier a screen reader is given, and it
   * is the same ink at every level — what changes is how many of the three dots are filled, which is
   * why it is not a colour signal wearing an icon's clothes.
   */
  it('carries severity as label text plus an aria-hidden non-colour icon', () => {
    const markup = render(identified());

    expect(markup).toContain(severityIndicator('high'));
    expect(markup).toMatch(/aria-hidden="true"[^>]*>\u25CF\u25CF\u25CF/u);
    // The label text is still there and is still the authoritative statement.
    expect(textOf(markup)).toContain(messages('en').severity.high);
  });

  it('renders every non-empty knowledge section and the source', () => {
    const { ui } = messages('en');
    const result = identified();
    const text = textOf(render(result));

    for (const heading of [
      ui.symptomsHeading,
      ui.causesHeading,
      ui.treatmentHeading,
      ui.preventionHeading,
      ui.sourceHeading,
    ]) {
      expect(text).toContain(heading);
    }
    for (const item of result.knowledge.treatment) {
      expect(text).toContain(item);
    }
    expect(text).toContain(result.knowledge.source);
  });

  /** Requirement 6.4 — `needsExpert` is false for an identified condition, so no banner. */
  it('shows no needs-expert banner', () => {
    expect(textOf(render(identified()))).not.toContain(messages('en').ui.needsExpertBanner);
  });

  /**
   * Requirement 4.5 — `Tomato Healthy` carries an empty treatment array by seed AND by the
   * `healthy_has_no_treatment` constraint, and an empty section is omitted entirely rather than
   * rendered as a heading over nothing.
   */
  it('omits an empty treatment section entirely', () => {
    const { ui } = messages('en');
    const text = textOf(
      render(
        identified({
          diseaseName: 'Tomato Healthy',
          severity: 'none',
          knowledge: {
            symptoms: ['Even green colour'],
            causes: [],
            treatment: [],
            prevention: ['Keep watering even'],
            source: 'State agricultural extension service, healthy tomato leaflet',
          },
        }),
      ),
    );

    expect(text).not.toContain(ui.treatmentHeading);
    expect(text).not.toContain(ui.causesHeading);
    expect(text).toContain(ui.preventionHeading);
    expect(text).toContain(ui.symptomsHeading);
  });

  /**
   * Requirements 4.6 and 9.4 — the canonical name is Latin script and identical in all three
   * languages, while the labels around it are localized. Both halves in one assertion, because
   * "the name did not change" is only meaningful if the rest of the card did.
   */
  it('never translates the canonical name, and localizes the labels around it', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const markup = render(identified({ language }));
      const text = textOf(markup);

      expect(text).toContain('Tomato Late Blight');
      expect(text).toContain(messages(language).ui.severityLabel);
      expect(text).toContain(messages(language).severity.high);
      // The name is marked as English inside a Devanagari card, for pronunciation.
      expect(markup).toContain('lang="en"');
    }
  });
});

/* ========================================================================== */
/* Inconclusive results (Requirements 6.4, 6.5)                                 */
/* ========================================================================== */

describe('DiagnosisResultCard — inconclusive', () => {
  it('renders the inconclusive label and the needs-expert banner', () => {
    const { ui } = messages('en');
    const text = textOf(render(inconclusive()));

    expect(text).toContain(ui.inconclusiveLabel);
    expect(text).toContain(ui.needsExpertBanner);
    expect(text).toContain(ui.severityLabel);
    expect(text).toContain(messages('en').severity.none);
  });

  /** Requirement 6.5 — no treatment content, and no knowledge heading to suggest there is any. */
  it('renders no treatment or other knowledge content', () => {
    const { ui } = messages('en');
    const text = textOf(render(inconclusive()));

    for (const heading of [
      ui.symptomsHeading,
      ui.causesHeading,
      ui.treatmentHeading,
      ui.preventionHeading,
      ui.sourceHeading,
    ]) {
      expect(text).not.toContain(heading);
    }
    // Nothing from a real knowledge row leaks in from anywhere else either.
    expect(text).not.toContain('Remove affected leaves');
  });

  /**
   * Requirement 6.5 — the rejected model's confidence is discarded, so there is no number to
   * render. Not a `0%`, which would be a quantified claim about a photo Jamee could not judge.
   */
  it('renders no confidence at all', () => {
    const text = textOf(render(inconclusive()));

    expect(text).not.toContain(messages('en').ui.confidenceLabel);
    expect(text).not.toContain('%');
  });

  it('carries the static localized copy for the rejection reason, in every language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = messages(language);
      const text = textOf(
        render(inconclusive({ language, explanation: catalog.inconclusive.model_no_plant })),
      );

      expect(text).toContain(catalog.inconclusive.model_no_plant);
      expect(text).toContain(catalog.ui.inconclusiveLabel);
    }
  });
});

/* ========================================================================== */
/* Reading the response (Requirements 15.3, 15.4)                              */
/* ========================================================================== */

describe('readDiagnoseResponse', () => {
  /** An inconclusive diagnosis is a successful result, not an error (Requirement 6.4). */
  it('reads a 200 into a result, inconclusive included', async () => {
    for (const result of [identified(), inconclusive()]) {
      const outcome = await readDiagnoseResponse(okResponse(result), 'en');

      expect(outcome.kind).toBe('result');
      if (outcome.kind !== 'result') return;
      expect(outcome.response.result).toEqual(result);
      expect(outcome.response.diagnosisId).toBe(DIAGNOSIS_ID);
    }
  });

  /**
   * Requirements 15.3 and 15.4 — the message displayed is the one the API returned, not one
   * rebuilt on the client from the code. `QUOTA_EXCEEDED` is the case that proves it: its
   * sentence carries a limit and a reset time interpolated server-side.
   */
  it('reads a non-2xx envelope and keeps the returned message verbatim', async () => {
    const body = {
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'You have used all 20 of today\u2019s image requests.',
        language: 'mr' satisfies Language,
        retryable: false,
        details: { limit: 20, used: 20, resetsAt: '2026-09-15T18:30:00.000Z' },
      },
    };
    const response = Response.json(body, { status: 429 });

    const outcome = await readDiagnoseResponse(response, 'mr');

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('QUOTA_EXCEEDED');
    expect(outcome.envelope.error.message).toBe(body.error.message);
    expect(outcome.envelope.error.details?.limit).toBe(20);
    expect(outcome.cause).toBeUndefined();
  });

  /**
   * A 200 that fails the response contract is Jamee disagreeing with itself: the farmer gets the
   * generic localized sentence and the real cause is returned for the log, never rendered
   * (Requirement 15.6).
   */
  it('turns a malformed 200 into a localized INTERNAL_ERROR', async () => {
    const outcome = await readDiagnoseResponse(
      Response.json({ diagnosisId: 'not-a-uuid' }, { status: 200 }),
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
    const outcome = await readDiagnoseResponse(
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
    const outcome = await readDiagnoseResponse(
      Response.json({ message: 'nope' }, { status: 500 }),
      'en',
    );

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.envelope.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('confidencePercent', () => {
  it('renders a whole percentage from the closed [0, 1] interval', () => {
    expect(confidencePercent(0)).toBe(0);
    expect(confidencePercent(1)).toBe(100);
    expect(confidencePercent(0.874)).toBe(87);
  });
});

/* ========================================================================== */
/* The result region                                                           */
/* ========================================================================== */

describe('DiagnosisPanel', () => {
  function renderPanel(language: Language): string {
    const value: LanguageContextValue = { language, setLanguage: () => {} };
    return renderToStaticMarkup(
      <LanguageContext.Provider value={value}>
        <DiagnosisPanel
          userId="11111111-1111-4111-8111-111111111111"
          labelledBy={DIAGNOSE_HEADING_ID}
        />
      </LanguageContext.Provider>,
    );
  }

  /**
   * The region is a named landmark with `aria-live="polite"`, and it is in the DOM **before** any
   * result exists — a polite region inserted together with its text is not reliably announced.
   *
   * Its name is the screen's own visible `<h1>`, which `/chat` and `/voice` already did and task
   * 26.2 brought this panel to. The heading itself is rendered by the server shell, so it is outside
   * this fragment: what is asserted here is that the region points at that id and that the panel
   * contributes **no off-screen heading of its own** to name itself with.
   */
  it('renders an empty aria-live landmark named by the screen heading', () => {
    const markup = renderPanel('en');
    const section = /<section([^>]*)>/.exec(markup);

    expect(section?.[1]).toContain('aria-live="polite"');
    expect(section?.[1]).toContain(`aria-labelledby="${DIAGNOSE_HEADING_ID}"`);
    expect(markup).not.toContain('<h2');
    expect(markup).not.toContain(messages('en').ui.answerLabel);
    // Nothing is claimed about a crop before a photo has been sent.
    expect(markup).not.toContain(messages('en').ui.needsExpertBanner);
    expect(markup).not.toContain(messages('en').ui.inconclusiveLabel);
  });

  /**
   * Requirement 15.1's text belongs to `ImageUploader`, which owns the request — and it is the
   * ONLY indicator in the flow. Requirement 15.2: nothing here is time-driven, and there is no
   * percentage to advance.
   */
  it('adds no second loading indicator and no simulated progress', () => {
    const markup = renderPanel('en');
    const { loading } = messages('en');

    expect([...markup.matchAll(/role="status"/g)]).toHaveLength(1);
    expect(markup).not.toContain(loading.analyzing);
    expect(markup).not.toContain(loading.uploading);
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('<progress');
  });
});
