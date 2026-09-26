import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  DETAIL_MESSAGE_LIMIT,
  formatConfidence,
  formatTimestamp,
  resolveDetailImage,
  toDiagnosisDetail,
  toDiagnosisMessageRow,
  type DetailImage,
  type DiagnosisMessageRow,
} from '@/app/diagnosis/detail';
import { requireFarmer } from '@/lib/auth/session';
import { farmerData } from '@/lib/db/farmer';
import { farmerReads, isValidObjectId } from '@/lib/db/reads';
import { AppError } from '@/lib/errors';
import { knowledgePayloadOf, lookupCondition } from '@/lib/knowledge';
import { activeLanguage } from '@/lib/language.server';
import { messages, type MessageCatalog } from '@/lib/messages';
import { readProfileSettings } from '@/lib/profile';
import type { KnowledgePayload, VerifiedCondition } from '@/lib/schemas';
import { severityIndicator } from '@/lib/severity';

import styles from './page.module.css';

/**
 * The diagnosis detail screen.
 *
 * Requirements: 12.3 (the crop image, the reported condition or the inconclusive label, the
 *               confidence value, the Severity_Value, the full explanation, and the related
 *               Conversation messages), 12.5 (both the image and the thumbnail load through the
 *               Media_Endpoint, Amendment A3), 12.8 / 12.9 / 12.10 (which image survives, and what
 *               to say when one does not), 12.11 (every other field renders regardless), 1.6 (no
 *               session, no protected screen), 6.5 (an inconclusive result shows no name and no
 *               treatment), 9.3 / 9.4 (localized text, untranslated canonical name), 13.2 (own
 *               rows only)
 * Design: "Project structure" — `diagnosis/[id]/page.tsx`; "Media lifecycle and retention"; D18,
 *          Amendment A3
 *
 * Server component throughout: no `'use client'`, no state, no fetch from the browser. Every read
 * goes through the owner-scoped Data_Access_Layer, so the *layer* decides which row is visible and
 * this file only decides how to render what came back.
 *
 * ### A row that is not yours is a 404, never a 403
 *
 * The owner-scoped `findDiagnosis` returns `null` for another farmer's diagnosis (Requirement
 * 13.2), and this page calls `notFound()`. That is the only correct answer: a 403 would confirm
 * that the id names a real diagnosis belonging to someone, which is an existence oracle over every
 * farmer's history. The same 404 covers a malformed id, a row that never existed, and a row that is
 * not the caller's — the page cannot tell them apart and should not try (`findDiagnosis` returns
 * `null` for an unparseable id too).
 */

/**
 * The session and the row decide the entire output, so this page must never be prerendered.
 * `requireFarmer()` reads the session (cookies), which already forces a dynamic render.
 */
export const dynamic = 'force-dynamic';

interface DiagnosisDetailPageProps {
  /** Next 16 hands route params as a Promise. */
  params: Promise<{ id: string }>;
}

export default async function DiagnosisDetailPage({ params }: DiagnosisDetailPageProps) {
  const { id } = await params;

  /**
   * Requirement 1.6, as the second layer behind `src/proxy.ts`. `requireFarmer()` validates the
   * session against the store and `redirect()`s a signed-out visitor. `userId` is the owner every
   * read here is scoped to.
   */
  const userId = await requireFarmer();

  /**
   * The id is validated before the read. `diagnoses._id` is an ObjectId, and an id that is not a
   * valid 24-hex string names no diagnosis — the same 404 as one that is not the farmer's.
   * `findDiagnosis` also treats an unparseable id as a miss, so this is belt-and-braces; validating
   * here keeps the intent legible.
   */
  if (!isValidObjectId(id)) notFound();

  const reads = farmerReads(userId);

  /**
   * Requirement 12.3's fields are read from the farmer's preferred language, not from the row's.
   * `diagnoses.language` records the language the explanation was *written* in and that text is
   * left exactly as stored. The surrounding labels follow the switcher. Read through the
   * owner-scoped Data_Access_Layer accessor.
   */
  const settings = await readProfileSettings(async () => {
    const profile = await farmerData(userId).readProfile();
    return profile === null
      ? null
      : { displayName: profile.displayName ?? null, language: profile.language };
  });
  const language = await activeLanguage(settings?.language ?? null);
  const catalog = messages(language);

  /**
   * The one diagnosis, owner-scoped. `null` is a 404 for all three of "not yours / never existed /
   * unparseable id", which is the only answer that is not an existence oracle.
   */
  let doc: Awaited<ReturnType<typeof reads.findDiagnosis>>;
  try {
    doc = await reads.findDiagnosis(id);
  } catch (cause) {
    throw new AppError('INTERNAL_ERROR', {
      cause,
      context: { reason: 'diagnosis_detail_read_failed', diagnosisId: id, userId },
    });
  }
  if (doc === null) notFound();

  /**
   * The knowledge base is read only for an identified result, and only to render the grounded
   * sections. Requirement 4.3 makes the knowledge row the source of every symptom, cause, treatment
   * and prevention sentence, so these arrays are copied across verbatim by `knowledgePayloadOf`.
   * `lookupCondition` reads through the default owner-less knowledge accessor (Amendment A3); a
   * miss (`found: false`) means an unseeded deployment and costs the grounded sections and nothing
   * else (Requirement 12.11).
   */
  let knowledge: KnowledgePayload | null = null;
  if (doc.status === 'identified' && (doc.diseaseName ?? null) !== null) {
    const lookup = await lookupCondition(doc.diseaseName as VerifiedCondition);
    if (lookup.found) knowledge = knowledgePayloadOf(lookup.entry);
  }

  const detail = toDiagnosisDetail(doc, knowledge);
  /**
   * A row whose columns contradict its own status cannot be rendered honestly, and the setup
   * validator makes it unwritable in the first place. Same 404 as a row that is not there.
   */
  if (detail === null) notFound();

  const image = await resolveDetailImage(doc, reads);

  /**
   * The related conversation messages, owner + conversation scoped, newest-first with a cap so the
   * bound drops the oldest, then reversed for display. The layer throws on a real failure, which
   * surfaces as `INTERNAL_ERROR` rather than a blank thread — a farmer must never be told their
   * questions are gone because a read failed.
   */
  let thread: readonly DiagnosisMessageRow[];
  try {
    const docs = await reads.conversationMessages(detail.conversationId, DETAIL_MESSAGE_LIMIT);
    thread = [...docs].reverse().map(toDiagnosisMessageRow);
  } catch (cause) {
    throw new AppError('INTERNAL_ERROR', {
      cause,
      context: {
        reason: 'diagnosis_detail_messages_read_failed',
        conversationId: detail.conversationId,
        userId,
      },
    });
  }

  return (
    /**
     * `lang` on the landmark rather than on `<html>`: the root layout is language-agnostic and this
     * screen knows which language its labels are in. It matters for pronunciation — Devanagari read
     * under `lang="en"` is mispronounced or skipped.
     */
    <main className={styles.page} lang={language}>
      <Link className={styles.back} href="/history">
        {catalog.ui.backToHistory}
      </Link>

      <header className={styles.header}>
        <h1 className={styles.heading}>
          {detail.status === 'identified' ? (
            /**
             * Requirements 4.6 and 9.4: the Canonical_Disease_Name is rendered in Latin script and
             * is never translated. `lang="en"` tells a screen reader that this run of text is
             * English inside a Hindi or Marathi page.
             */
            <span lang="en">{detail.diseaseName}</span>
          ) : (
            catalog.ui.inconclusiveLabel
          )}
        </h1>
        <p className={styles.meta}>
          {/*
            The timestamp follows the switcher, not the row: a date is screen furniture like the
            labels around it. `dateTime` carries the machine-readable instant either way.
          */}
          <time dateTime={detail.createdAt}>{formatTimestamp(detail.createdAt, language)}</time>
          {' · '}
          {detail.channel === 'web' ? catalog.ui.channelWeb : catalog.ui.channelWhatsapp}
        </p>
      </header>

      <CropPhoto image={image} catalog={catalog} />

      {detail.needsExpert ? (
        /**
         * `role="note"` rather than `role="alert"`: the banner is present when the page loads
         * rather than announced on a change, and an alert would interrupt a farmer mid-sentence.
         */
        <p className={styles.banner} role="note">
          {catalog.ui.needsExpertBanner}
        </p>
      ) : null}

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{catalog.ui.severityLabel}</dt>
          {/*
            Requirement 15.4 / design accessibility: severity is conveyed by label TEXT and a
            non-colour icon. The dots are `aria-hidden` — the redundant half — and the word beside
            them is the one a screen reader is given.
          */}
          <dd className={styles.factValue}>
            <span aria-hidden="true" className={styles.severityIcon}>
              {severityIndicator(detail.severity)}
            </span>
            {catalog.severity[detail.severity]}
          </dd>
        </div>
        {detail.status === 'identified' ? (
          <div className={styles.fact}>
            <dt className={styles.factLabel}>{catalog.ui.confidenceLabel}</dt>
            <dd className={styles.factValue}>{formatConfidence(detail.confidence)}</dd>
          </div>
        ) : null}
      </dl>

      {/*
        Requirement 12.3's "full explanation", exactly as stored — grounded in the knowledge base
        and localized when it was written (Requirement 3.2). `lang` follows the row rather than the
        switcher, because that is the language these sentences are actually in.
      */}
      <section className={styles.explanation} lang={detail.language}>
        {paragraphsOf(detail.explanation).map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </section>

      {/*
        Requirement 6.5 is enforced by the compiler here, not by this condition. `knowledge` is
        typed `null` on the inconclusive branch of `DiagnosisDetail`, so `detail.knowledge !== null`
        narrows `detail` to the identified branch on its own.
      */}
      {detail.knowledge !== null ? (
        <GroundedSections knowledge={detail.knowledge} catalog={catalog} />
      ) : null}

      <section className={styles.conversation}>
        <h2 className={styles.sectionHeading}>{catalog.ui.conversationHeading}</h2>
        {thread.length === 0 ? (
          <p className={styles.empty}>{catalog.ui.conversationEmpty}</p>
        ) : (
          <ol className={styles.thread}>
            {thread.map((message) => (
              <li
                key={message.id}
                className={message.role === 'farmer' ? styles.fromFarmer : styles.fromJamee}
              >
                <p className={styles.speaker}>
                  {message.role === 'farmer' ? catalog.ui.roleFarmer : catalog.ui.roleJamee}
                  {/* Requirement 8.6 — a voice turn is labelled as what Jamee heard. */}
                  {message.inputKind === 'voice' ? ` · ${catalog.ui.transcriptLabel}` : ''}
                </p>
                <p className={styles.messageBody} lang={message.language}>
                  {message.content}
                </p>
                <time className={styles.messageTime} dateTime={message.createdAt}>
                  {formatTimestamp(message.createdAt, language)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

/* ========================================================================== */
/* Pieces                                                                      */
/* ========================================================================== */

/**
 * The crop photo, in whichever of Requirement 12.8/12.9/12.10's three states applies.
 *
 * The `<img>` is deliberate rather than `next/image`: the URL is the Media_Endpoint path
 * (`/api/media/<fileId>`, Amendment A3), served by a route that streams bytes after an owner check,
 * so the image optimizer's remote-pattern allow-list and caching add nothing here. Sizing is CSS,
 * so there is no layout shift to buy back.
 */
function CropPhoto({ image, catalog }: { image: DetailImage; catalog: MessageCatalog }) {
  if (image.kind === 'none') {
    // Requirement 12.10 — no image, and plain language about why.
    return <p className={styles.photoNote}>{catalog.ui.photoNoLongerStored}</p>;
  }

  return (
    <figure className={styles.figure}>
      {/* eslint-disable-next-line @next/next/no-img-element -- owner-checked Media_Endpoint URL */}
      <img
        className={image.kind === 'full' ? styles.photo : styles.photoSmall}
        src={image.url}
        alt={catalog.ui.cropPhotoAlt}
      />
      {image.kind === 'thumbnail' ? (
        // Requirement 12.9 — the surviving derivative, and the sentence that explains it.
        <figcaption className={styles.photoNote}>{catalog.ui.photoThumbnailOnly}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * The knowledge-base sections of an identified result.
 *
 * Every list here is a verbatim array from the `disease_knowledge` row (Requirement 4.3) — nothing
 * on this screen composes or paraphrases an agronomic sentence. An empty array renders no section
 * at all, which is how `Tomato Healthy` shows no treatment heading: its `treatment` array is empty
 * by seed and by the `healthy_has_no_treatment` constraint (Requirement 3.4).
 */
function GroundedSections({
  knowledge,
  catalog,
}: {
  knowledge: KnowledgePayload;
  catalog: MessageCatalog;
}) {
  const sections: readonly { readonly heading: string; readonly items: readonly string[] }[] = [
    { heading: catalog.ui.symptomsHeading, items: knowledge.symptoms },
    { heading: catalog.ui.causesHeading, items: knowledge.causes },
    { heading: catalog.ui.treatmentHeading, items: knowledge.treatment },
    { heading: catalog.ui.preventionHeading, items: knowledge.prevention },
  ];

  return (
    <>
      {sections
        .filter((section) => section.items.length > 0)
        .map((section) => (
          <section key={section.heading} className={styles.grounded}>
            <h2 className={styles.sectionHeading}>{section.heading}</h2>
            <ul className={styles.groundedList}>
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      <section className={styles.grounded}>
        <h2 className={styles.sectionHeading}>{catalog.ui.sourceHeading}</h2>
        {/* Requirement 4.2's per-row provenance, shown so a farmer can trace the advice. */}
        <p className={styles.source}>{knowledge.source}</p>
      </section>
    </>
  );
}

/**
 * A stored explanation split into paragraphs on blank lines.
 *
 * The rephrase path can return several paragraphs in one field, and a single `<p>` would render
 * them as one wall of text on a phone. Splitting on blank lines rather than every newline keeps a
 * soft-wrapped sentence intact. A value that yields nothing falls back to the original string.
 */
function paragraphsOf(explanation: string): readonly string[] {
  const parts = explanation
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? [explanation] : parts;
}
