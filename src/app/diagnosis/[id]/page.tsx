import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';

import { SIGN_IN_PATH } from '@/app/auth/callback/ensure-profile';
import {
  DETAIL_MESSAGE_LIMIT,
  DIAGNOSIS_DETAIL_SELECT,
  DIAGNOSIS_MESSAGES_SELECT,
  formatConfidence,
  formatTimestamp,
  resolveDetailImage,
  toDiagnosisDetail,
  type DetailImage,
  type DiagnosisMessageRow,
} from '@/app/diagnosis/detail';
import { AppError } from '@/lib/errors';
import { knowledgePayloadOf, knowledgeReaderFrom, lookupCondition } from '@/lib/knowledge';
import { activeLanguage } from '@/lib/language.server';
import { messages, type MessageCatalog } from '@/lib/messages';
import { PROFILE_SETTINGS_SELECT, readProfileSettings } from '@/lib/profile';
import type { KnowledgePayload } from '@/lib/schemas';
import { severityIndicator } from '@/lib/severity';
import { createServerSupabase, currentUserId } from '@/lib/supabase/server';

import styles from './page.module.css';

/**
 * The diagnosis detail screen.
 *
 * Requirements: 12.3 (the crop image, the reported condition or the inconclusive label, the
 *               confidence value, the Severity_Value, the full explanation, and the related
 *               Conversation messages), 12.5 (both the image and the thumbnail load through a
 *               Signed_URL), 12.8 / 12.9 / 12.10 (which image survives, and what to say when one
 *               does not), 12.11 (every other field renders regardless), 1.6 (no session, no
 *               protected screen), 6.5 (an inconclusive result shows no name and no treatment),
 *               9.3 / 9.4 (localized text, untranslated canonical name), 13.2 (own rows only)
 * Design: "Project structure" — `diagnosis/[id]/page.tsx`; "Media lifecycle and retention"
 *
 * Server component throughout: no `'use client'`, no state, no fetch from the browser. Every read
 * goes through the RLS-scoped server client, so the *database* decides which row is visible and
 * this file only decides how to render what came back.
 *
 * ### A row that is not yours is a 404, never a 403
 *
 * RLS returns nothing for another farmer's diagnosis (Requirement 13.2), so `maybeSingle()` yields
 * `null` and this page calls `notFound()`. That is deliberate and it is the only correct answer:
 * a 403 would confirm that the id names a real diagnosis belonging to someone, which is an
 * existence oracle over every farmer's history. The same 404 covers a malformed id, a row that
 * never existed, and a row that is not the caller's — the page cannot tell them apart and should
 * not try. `storage.ts`'s note on collapsing "absent" into "forbidden" is the same argument
 * applied to the other verb.
 */

/**
 * The session and the row decide the entire output, so this page must never be prerendered.
 * `cookies()` inside `createServerSupabase()` already forces a dynamic render; saying so keeps a
 * build without Supabase credentials from failing on a page whose output could not be reused.
 */
export const dynamic = 'force-dynamic';

interface DiagnosisDetailPageProps {
  /** Next 16 hands route params as a Promise. */
  params: Promise<{ id: string }>;
}

export default async function DiagnosisDetailPage({ params }: DiagnosisDetailPageProps) {
  const { id } = await params;

  /**
   * Requirement 1.6. `currentUserId()` is `getUser()` underneath — server-confirmed rather than
   * decoded from a cookie. The Proxy already gates `/diagnosis` (`protected-paths.ts`); this is the
   * local check this page needs in order to have a farmer whose rows it can read.
   */
  const userId = await currentUserId();
  if (userId === null) redirect(SIGN_IN_PATH);

  /**
   * The id is validated before it reaches PostgREST. `diagnoses.id` is a `uuid`, and a non-uuid
   * filter comes back as a Postgres cast error (`22P02`) — which would surface as a 500 for what is
   * simply a URL that names no diagnosis. `z.uuid()` is the same validator the wire schemas use.
   */
  if (!z.uuid().safeParse(id).success) notFound();

  const supabase = await createServerSupabase();

  const { data: row, error } = await supabase
    .from('diagnoses')
    .select(DIAGNOSIS_DETAIL_SELECT)
    .eq('id', id)
    /**
     * RLS is the boundary; this predicate is the second layer the design's defence-in-depth note
     * asks for. It also makes the intent of the query readable without going to the policy.
     */
    .eq('user_id', userId)
    .maybeSingle();

  if (error !== null) {
    throw new AppError('INTERNAL_ERROR', {
      cause: error,
      context: { reason: 'diagnosis_detail_read_failed', diagnosisId: id, userId },
    });
  }
  if (row === null) notFound();

  /**
   * Requirement 12.3's fields are read from the farmer's preferred language, not from the row's.
   * `diagnoses.language` records the language the explanation was *written* in and that text is
   * left exactly as stored — re-translating a stored explanation would need a model call this
   * screen has no business making. The surrounding labels follow the switcher.
   */
  const settings = await readProfileSettings(
    () => supabase.from('profiles').select(PROFILE_SETTINGS_SELECT).eq('id', userId).maybeSingle(),
    userId,
  );
  const language = await activeLanguage(settings?.language ?? null);
  const catalog = messages(language);

  /**
   * The knowledge base is read only for an identified result, and only to render the grounded
   * sections. Requirement 4.3 makes the knowledge row the source of every symptom, cause,
   * treatment and prevention sentence a farmer reads, so these arrays are copied across verbatim
   * by `knowledgePayloadOf` — nothing on this screen composes agronomic prose.
   *
   * A miss (`found: false`) means an unseeded deployment. It costs the grounded sections and
   * nothing else, which is what Requirement 12.11's spirit asks for.
   */
  let knowledge: KnowledgePayload | null = null;
  if (row.status === 'identified' && row.disease_name !== null) {
    const lookup = await lookupCondition(row.disease_name, knowledgeReaderFrom(supabase));
    if (lookup.found) knowledge = knowledgePayloadOf(lookup.entry);
  }

  const detail = toDiagnosisDetail(row, knowledge);
  /**
   * A row whose columns contradict its own status cannot be rendered honestly, and the two check
   * constraints in migration `0005` make it unwritable in the first place. Same 404 as a row that
   * is not there: there is nothing a farmer could act on either way.
   */
  if (detail === null) notFound();

  const image = await resolveDetailImage(row, supabase);

  const { data: messageRows, error: messagesError } = await supabase
    .from('messages')
    .select(DIAGNOSIS_MESSAGES_SELECT)
    .eq('conversation_id', detail.conversationId)
    .eq('user_id', userId)
    /**
     * Newest first at the read so `DETAIL_MESSAGE_LIMIT` drops the oldest, then reversed for
     * display. `id` breaks a timestamp tie so the order is total and two renders agree. Served by
     * `messages_conversation_idx` on `(conversation_id, created_at desc)`.
     */
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(DETAIL_MESSAGE_LIMIT);

  if (messagesError !== null) {
    /**
     * A failed read is not an empty conversation. Rendering "you have not asked anything yet"
     * because a query failed would tell a farmer their questions are gone, so this fails loudly
     * instead — the same distinction `knowledge.ts` and `conversation.service.ts` both make.
     */
    throw new AppError('INTERNAL_ERROR', {
      cause: messagesError,
      context: {
        reason: 'diagnosis_detail_messages_read_failed',
        conversationId: detail.conversationId,
        userId,
      },
    });
  }

  const thread: readonly DiagnosisMessageRow[] = [...(messageRows ?? [])].reverse();

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
             * is never translated, in any Supported_Language. `lang="en"` is not decoration — it
             * tells a screen reader that this run of text is English inside a Hindi or Marathi
             * page, which is the difference between "Tomato Late Blight" and a Devanagari
             * transliteration attempt.
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
          {detail.channel === 'whatsapp' ? catalog.ui.channelWhatsapp : catalog.ui.channelWeb}
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
            non-colour icon. The dots are `aria-hidden` — they are the redundant half, and the word
            beside them is the one a screen reader is given. Same ink at every level, so nothing here
            is carried by colour. See `src/lib/severity.ts`.
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
        narrows `detail` to the identified branch on its own — and there is no cast, optional chain
        or default that reaches treatment text for an inconclusive result.
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
                  {message.input_kind === 'voice' ? ` · ${catalog.ui.transcriptLabel}` : ''}
                </p>
                <p className={styles.messageBody} lang={message.language}>
                  {message.content}
                </p>
                <time className={styles.messageTime} dateTime={message.created_at}>
                  {formatTimestamp(message.created_at, language)}
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
 * The `<img>` is deliberate rather than `next/image`, for two reasons that both come from the URL
 * being a Signed_URL. Its expiry is measured in seconds (`SIGNED_URL_EXPIRY_SECONDS`), so the image
 * optimizer would cache a URL that is dead before the cache entry is; and `remotePatterns` cannot
 * name a Supabase host that is only known from the environment at runtime. Sizing is CSS, so there
 * is no layout shift to buy back.
 */
function CropPhoto({
  image,
  catalog,
}: {
  image: DetailImage;
  catalog: MessageCatalog;
}) {
  if (image.kind === 'none') {
    // Requirement 12.10 — no image, and plain language about why.
    return (
      <p className={styles.photoNote}>{catalog.ui.photoNoLongerStored}</p>
    );
  }

  return (
    <figure className={styles.figure}>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed URL, see the note above */}
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
 * by seed and by the `healthy_has_no_treatment` constraint (Requirement 3.4), so the omission
 * needs no special case.
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
 * The rephrase path can return several paragraphs in one column, and a single `<p>` would render
 * them as one wall of text on a phone. Splitting on blank lines rather than every newline keeps a
 * soft-wrapped sentence intact. A value that yields nothing falls back to the original string, so
 * the field is never silently dropped.
 */
function paragraphsOf(explanation: string): readonly string[] {
  const parts = explanation
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? [explanation] : parts;
}
