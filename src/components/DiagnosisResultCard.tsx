'use client';

import { useState } from 'react';

import { ErrorBanner } from '@/components/ErrorBanner';
import { ImageUploader } from '@/components/ImageUploader';
import { useLanguage } from '@/components/LanguageProvider';
import { AppError, toEnvelope } from '@/lib/errors';
import { messages, type MessageCatalog } from '@/lib/messages';
import {
  diagnoseResponseSchema,
  errorEnvelopeSchema,
  type DiagnoseResponse,
  type DiagnosisResult,
  type ErrorEnvelope,
  type KnowledgePayload,
  type Language,
} from '@/lib/schemas';
import { severityIndicator } from '@/lib/severity';

import styles from './DiagnosisResultCard.module.css';

/**
 * What a farmer reads after sending a crop photo: the condition or the inconclusive label, its
 * severity, its confidence, the needs-expert banner, and the knowledge-base content behind it.
 *
 * Requirements: 6.4 (one inconclusive shape, `status: 'unknown'` with `needsExpert` true),
 *               6.5 (no candidate disease name and no treatment content on an inconclusive
 *               result), 15.1 / 15.2 (the analyzing text is bound to the real request state and
 *               nothing here simulates progress), 9.4 (the canonical name is never translated),
 *               15.4 (a returned error message is displayed)
 * Design: "Frontend" → screens table (`/diagnose` = server shell + client `ImageUploader` and
 *          `DiagnosisResultCard`), *Honest loading states*, *Mobile layout and accessibility*
 *
 * ### Requirement 6.5 is enforced by the compiler, not by this file remembering it
 *
 * `inconclusiveResultSchema` pins `knowledge` to `null` (and `diseaseName` and `confidence` with
 * it), so the inconclusive branch of `DiagnosisResult` has no payload to render treatment from.
 * `KnowledgeSections` takes a **non-nullable** `KnowledgePayload`, which is what turns that into
 * a build error rather than a code-review note: writing
 *
 * ```tsx
 * <KnowledgeSections knowledge={result.knowledge} ui={ui} />   // outside the identified branch
 * ```
 *
 * fails to compile, because `result.knowledge` is `KnowledgePayload | null` there. The same rule
 * holds at two more boundaries — the `diagnoses_unknown_shape` check constraint in migration
 * `0005`, and `DiagnosisService` building the shape in the first place — so three independent
 * layers have to be defeated for treatment text to appear under an inconclusive result.
 *
 * ### Where the loading text is, and why it is not here
 *
 * `ImageUploader` owns the request, so it owns the indicator: `loading.uploading` while objects
 * are going to the bucket and Requirement 15.1's exact `loading.analyzing` while the POST is
 * open, both flipped by the real request and cleared when it resolves. **This module adds no
 * second indicator**, because two components rendering "is a request open?" from two pieces of
 * state is how one of them ends up wrong. Nothing here reads a timer, and no percentage exists
 * anywhere in the flow to advance (Requirement 15.2).
 *
 * One consequence is worth stating rather than hiding: a farmer who submits a second photo keeps
 * seeing the previous result until the new one arrives. That is honest — it is a real result of a
 * real earlier request, and the analyzing text is on screen at the same time — and the
 * alternative would need `ImageUploader` to publish a request-start event it does not have.
 */

/* ========================================================================== */
/* Reading the response (Requirements 15.3, 15.4)                              */
/* ========================================================================== */

/**
 * The two things `/api/diagnose` can answer with, after parsing.
 *
 * An **inconclusive diagnosis is a `result`, not an `error`** — that is Requirement 6.4 read
 * literally and `schemas.ts` says so too: the request worked, the photo could not be judged, and
 * the response is a 200 carrying `status: 'unknown'`. Routing it through the error branch would
 * lose the severity, the explanation and the banner the farmer is supposed to see.
 */
export type DiagnosisOutcome =
  | { kind: 'result'; response: DiagnoseResponse }
  /** `cause` is the local parse failure when there was one. Logged, never rendered (15.6). */
  | { kind: 'error'; envelope: ErrorEnvelope; cause: unknown };

/**
 * A body Jamee could not make sense of, as a localized envelope.
 *
 * `INTERNAL_ERROR` is the honest code: a 200 that fails `diagnoseResponseSchema`, or a non-2xx
 * whose body is not an error envelope, is Jamee disagreeing with itself. The farmer gets the
 * generic localized sentence and the real cause goes to the console, which is Requirement 15.6's
 * rule applied on the client side of the same boundary.
 */
function internalFailure(language: Language, cause: unknown): DiagnosisOutcome {
  return {
    kind: 'error',
    envelope: toEnvelope(new AppError('INTERNAL_ERROR'), language),
    cause,
  };
}

/**
 * Turn the raw `/api/diagnose` response into one of the two outcomes.
 *
 * Exported and free of React so the branch that matters can be tested over real `Response`
 * objects: `ImageUploader` hands over the response **unparsed** precisely so that the schema, the
 * envelope and the retry decision live in one place instead of being duplicated per screen.
 *
 * The status code decides which schema is applied, not the body's shape. A 200 is validated
 * against the response contract and a non-2xx against the error envelope — so a 429 carrying a
 * plausible-looking result, or a 200 carrying an error envelope, is a parse failure rather than
 * something rendered on the strength of guessing which one it meant.
 */
export async function readDiagnoseResponse(
  response: Response,
  language: Language,
): Promise<DiagnosisOutcome> {
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (cause) {
    return internalFailure(language, cause);
  }

  if (response.ok) {
    const parsed = diagnoseResponseSchema.safeParse(payload);
    return parsed.success
      ? { kind: 'result', response: parsed.data }
      : internalFailure(language, parsed.error);
  }

  /**
   * Requirements 15.3 and 15.4: the message rendered is the one the API returned, in the language
   * it was asked for. It is not re-derived from the code here — `QUOTA_EXCEEDED` carries a limit
   * and a reset time interpolated server-side, and rebuilding that sentence on the client would
   * give the app two versions of it.
   */
  const envelope = errorEnvelopeSchema.safeParse(payload);
  return envelope.success
    ? { kind: 'error', envelope: envelope.data, cause: undefined }
    : internalFailure(language, envelope.error);
}

/* ========================================================================== */
/* The card                                                                    */
/* ========================================================================== */

/** The one number a farmer reads on this card, as a whole percentage. */
export function confidencePercent(confidence: number): number {
  return Math.round(confidence * 100);
}

interface KnowledgeSectionProps {
  heading: string;
  items: readonly string[];
}

/**
 * One knowledge-base list, or nothing.
 *
 * An empty array renders **no heading at all**, which is Requirement 4.5's "treatment omitted
 * entirely" for `Tomato Healthy` — a "What to do" heading over an empty list would read as
 * missing content rather than as an absence of advice. It applies to every section for the same
 * reason, so a partially populated row cannot produce an empty heading either.
 */
function KnowledgeSection({ heading, items }: KnowledgeSectionProps) {
  if (items.length === 0) return null;

  return (
    <section>
      {/* One level under the card's own `<h2>`. See the note on that heading for why the level matters. */}
      <h3 className={styles.sectionHeading}>{heading}</h3>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

interface KnowledgeSectionsProps {
  /**
   * **Non-nullable on purpose.** This is the type-level half of Requirement 6.5: the inconclusive
   * branch's `knowledge` is `null`, so this component is unreachable from it without a compile
   * error. See the module header.
   */
  knowledge: KnowledgePayload;
  ui: MessageCatalog['ui'];
}

function KnowledgeSections({ knowledge, ui }: KnowledgeSectionsProps) {
  return (
    <>
      <KnowledgeSection heading={ui.symptomsHeading} items={knowledge.symptoms} />
      <KnowledgeSection heading={ui.causesHeading} items={knowledge.causes} />
      {/* Empty for `Tomato Healthy`, and therefore absent rather than empty. */}
      <KnowledgeSection heading={ui.treatmentHeading} items={knowledge.treatment} />
      <KnowledgeSection heading={ui.preventionHeading} items={knowledge.prevention} />
      {/*
       * Requirement 4.4's citation. Rendered as text rather than a link: the seed carries an
       * extension-service citation, not a guaranteed URL, and linking a string that may not be
       * one would produce a dead control on a phone.
       */}
      <p className={styles.source}>
        <strong>{ui.sourceHeading}:</strong> {knowledge.source}
      </p>
    </>
  );
}

export interface DiagnosisResultCardProps {
  result: DiagnosisResult;
}

/**
 * The result itself: condition or inconclusive label, severity, confidence, explanation, banner,
 * and — only for an identified condition — the knowledge-base content.
 *
 * **The language comes from the result, not from the switcher.** `DiagnosisResult.language` is the
 * language the explanation was actually produced in, so labelling it with the currently selected
 * language would put an English "Confidence" next to a Marathi sentence for anyone who switched
 * after sending a photo. It also means the card needs no context and can be rendered — and
 * tested — on its own.
 */
export function DiagnosisResultCard({ result }: DiagnosisResultCardProps) {
  const { ui, severity } = messages(result.language);

  return (
    /**
     * `lang` from the result for the same reason the labels are: a screen reader given Devanagari
     * under `lang="en"` mispronounces or skips it.
     */
    <article className={styles.card} lang={result.language}>
      {/*
       * `<h2>`, not `<h3>`, and the level is load-bearing rather than cosmetic.
       *
       * The card is the first heading under `/diagnose`'s `<h1>`, so h3 here skipped a level in the
       * document outline — which is how a screen reader user navigating by heading learns there is
       * a section they have missed. It read correctly while `DiagnosisPanel` carried an off-screen
       * `<h2>` of its own; task 26.2 removed that (see the panel below) and left the skip behind,
       * and task 26.3's scan is what found it. `tests/unit/accessibility.test.tsx` now holds the
       * outline of every screen, so the pair cannot drift apart again silently.
       *
       * Size and spacing come from `.conditionName`, which outranks the `h1`–`h4` rule in
       * `globals.css` on specificity, so nothing about how this reads on a phone changes.
       */}
      <h2 className={styles.conditionName}>
        {result.status === 'identified' ? (
          /**
           * Requirements 4.6 and 9.4: the canonical name is written in Latin script and is never
           * translated, in any language. `lang="en"` and the LTR isolation are what keep it
           * pronounced and laid out as the Latin string it is inside a Devanagari paragraph.
           */
          <span className={styles.canonical} lang="en">
            {result.diseaseName}
          </span>
        ) : (
          /** Requirement 6.5: the label, never the name the model guessed. */
          ui.inconclusiveLabel
        )}
      </h2>

      <dl className={styles.facts}>
        <dt className={styles.factLabel}>{ui.severityLabel}</dt>
        <dd className={styles.factValue}>
          {/*
           * Both halves of the design's rule, in this order: the icon, then the label text. The
           * dots are `aria-hidden` because they are the redundant half — a screen reader is given
           * the word, which is unambiguous and translated, and reading the circles out as well
           * would add noise rather than information. They are also the same ink at every level, so
           * nothing here is carried by colour. See `src/lib/severity.ts`.
           */}
          <span aria-hidden="true" className={styles.severityIcon}>
            {severityIndicator(result.severity)}
          </span>
          {severity[result.severity]}
        </dd>

        {/*
         * `confidence` is `null` on the inconclusive branch (Requirement 6.5), so there is
         * nothing to render — not a zero, and not "unknown". A number here would be a
         * quantified claim about a photo Jamee could not judge.
         */}
        {result.confidence === null ? null : (
          <>
            <dt className={styles.factLabel}>{ui.confidenceLabel}</dt>
            <dd className={styles.factValue}>{`${confidencePercent(result.confidence)}%`}</dd>
          </>
        )}
      </dl>

      {/*
       * Identified: the grounded, rephrased explanation. Inconclusive: static catalog copy for
       * the rejection reason (D5), written in the repository and reached with no model call
       * (Requirement 6.6). Both are already localized by the time they get here.
       */}
      <p className={styles.explanation}>{result.explanation}</p>

      {/*
       * Requirement 6.4 — `needsExpert` is `true` on every inconclusive result and `false` on
       * every identified one, so this is the banner the shape itself asks for. Keyed off the
       * field rather than off `status` so it stays correct if the contract ever grows a third
       * branch that needs it.
       */}
      {result.needsExpert ? <p className={styles.needsExpert}>{ui.needsExpertBanner}</p> : null}

      {/*
       * The knowledge-base content, and the one place Requirement 6.5's second half is decided.
       * Inside this branch `result.knowledge` is a `KnowledgePayload`; outside it, it is `null`
       * and `KnowledgeSections` will not accept it.
       */}
      {result.status === 'identified' ? (
        <KnowledgeSections knowledge={result.knowledge} ui={ui} />
      ) : null}
    </article>
  );
}

/* ========================================================================== */
/* The screen's result region                                                  */
/* ========================================================================== */

/**
 * The id of `/diagnose`'s own visible `<h1>`, which is what names the result region.
 *
 * A module constant rather than `useId()` because the two ends of the reference live in different
 * components — the server shell renders the heading, this client panel renders the region — and the
 * screen renders exactly one of each. The same shape `ChatThread` uses for `CHAT_HEADING_ID` and
 * `/voice` for its own heading id.
 */
export const DIAGNOSE_HEADING_ID = 'jamee-diagnose-heading';

export interface DiagnosisPanelProps {
  /** The signed-in farmer, resolved server-side by the `/diagnose` shell. */
  userId: string;
  /** Attach the diagnosis to an existing thread when the screen has one (Requirement 2.2). */
  conversationId?: string;
  /**
   * The id of the screen's visible `<h1>`. Names the result region below.
   *
   * Required rather than defaulted: a `<section>` whose `aria-labelledby` points at nothing is not a
   * landmark and has no accessible name, and that failure is invisible in markup. Making the screen
   * state the id is what keeps the two ends of the reference in one place a reader can check.
   */
  labelledBy: string;
}

/**
 * The uploader and the live region that answers it, in one client subtree.
 *
 * This lives beside the card rather than in a third file because it is not a screen — it is the
 * result region plus the control that fills it, and `/diagnose` is a **server** component that
 * cannot hand `ImageUploader` the `onDiagnosisResponse` callback itself. Something on the client
 * side of that boundary has to hold the response, and holding it next to the component that
 * renders it keeps the parse, the card and the error branch in one place.
 *
 * The region is a landmark with `aria-live="polite"` (design: *Mobile layout and accessibility*),
 * and it is in the DOM from the first render — **including while it is empty**. A polite live
 * region inserted together with its text is not reliably announced, so an empty `<section>` is
 * what makes the announcement happen when a diagnosis arrives.
 *
 * It is named by the screen's **own visible `<h1>`**, which is the reading `ChatThread` recorded and
 * `/voice` adopted; task 26.2 brought this panel to the same one. It used to carry an off-screen
 * `<h2>` reading `ui.answerLabel` instead, which worked but left the app naming three regions that
 * do one job by two different strategies — and an off-screen heading is a second string to keep
 * translated, a second heading in the document outline, and a name a sighted farmer cannot see and
 * therefore cannot be told to look for over a phone call.
 *
 * The error banner is the opposite case and therefore sits **outside** that region: `role="alert"`
 * is assertive, it is announced on insertion, and nesting it inside the polite region would
 * announce one failure twice. `ErrorBanner` owns that rule for every screen.
 */
export function DiagnosisPanel({ userId, conversationId, labelledBy }: DiagnosisPanelProps) {
  const { language } = useLanguage();

  const [outcome, setOutcome] = useState<DiagnosisOutcome | null>(null);

  /**
   * `ImageUploader` hands over the raw response synchronously; parsing it is async. The promise
   * is deliberately detached with `void` rather than awaited: the callback's contract is
   * `(response: Response) => void`, and returning a promise into it would be a promise nothing
   * observes.
   */
  function onDiagnosisResponse(response: Response): void {
    void (async () => {
      const next = await readDiagnoseResponse(response, language);
      if (next.kind === 'error' && next.cause !== undefined) {
        /** Requirement 15.6's client-side half: the cause is logged, never rendered. */
        console.error('[jamee] /api/diagnose response could not be read', next.cause);
      }
      setOutcome(next);
    })();
  }

  return (
    <>
      <ImageUploader
        userId={userId}
        onDiagnosisResponse={onDiagnosisResponse}
        {...(conversationId === undefined ? {} : { conversationId })}
      />

      {/*
       * Requirement 15.4: the message the API returned, verbatim, in the language it was asked for.
       *
       * **A sibling of the polite region below, not a child of it.** `role="alert"` is an assertive
       * live region, and nesting one inside a polite one gives two announcements of one event — the
       * reading `ChatComposer` and `VoicePanel` already applied, now applied here too so all three
       * screens place a banner the same way. It also puts the sentence next to the control that
       * retries it.
       *
       * `retry: 'control'` is that control: `ImageUploader`'s submit stays enabled with the same
       * photo still selected, so pressing it re-sends the request that failed. This panel has no
       * handle on the uploader's submission, which is the other reason the banner does not own a
       * button here.
       */}
      {outcome !== null && outcome.kind === 'error' ? (
        <ErrorBanner
          error={outcome.envelope.error}
          retry={{ kind: 'control' }}
          className={styles.errorSlot}
        />
      ) : null}

      <section className={styles.region} aria-live="polite" aria-labelledby={labelledBy}>
        {/*
         * The result, and nothing else. A failure has already been said above, and a stale card
         * left under it would suggest the photo Jamee just refused had still been judged.
         */}
        {outcome === null || outcome.kind !== 'result' ? null : (
          <DiagnosisResultCard result={outcome.response.result} />
        )}
      </section>
    </>
  );
}
