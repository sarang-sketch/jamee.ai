import { diagnosisDetailHref, type HistoryEntry } from '@/lib/history';
import { messages } from '@/lib/messages';
import type { Channel, Language } from '@/lib/schemas';
import { severityIndicator } from '@/lib/severity';
import { formatInstant } from '@/lib/time';

import styles from './HistoryList.module.css';

/**
 * The farmer's past diagnoses, newest first.
 *
 * Requirements: 12.1 (each entry carries the crop image thumbnail, the reported condition or the
 *               inconclusive label, the Severity_Value, the channel, and the creation timestamp),
 *               12.2 (WhatsApp entries appear on the same footing as web ones), 12.3 (selecting an
 *               entry opens its detail view — this component provides the link), 12.5 (the image
 *               URL is a Signed_URL, minted server-side before it reaches this component),
 *               12.10 (an entry with no surviving image says so in plain language), 9.4 (a
 *               Canonical_Disease_Name is never translated)
 * Design: "Frontend" — `/history` is a server component; "Mobile layout and accessibility" —
 *          severity is conveyed by label text and never by colour alone, tap targets are at least
 *          44x44 px, and every size is relative so body text scales with the OS setting
 *
 * Server component: no `'use client'`, no state, no data access. Every entry arrives resolved —
 * including its signed URL — because minting URLs is the page's job (Requirement 12.5) and a
 * client component could not do it without the anon key reaching for objects it has no session
 * to sign.
 *
 * ### Why the whole entry is one link, and why it is a plain `<a>`
 *
 * **One link per entry** because the thumbnail is the thing a farmer's thumb goes for, and
 * splitting the photo from the text would give the screen two small targets where it should have
 * one large one. It also makes the list keyboard-navigable by construction: one Tab stop per
 * entry, in the order the entries read, with no `tabIndex` anywhere.
 *
 * **A plain `<a>` rather than `next/link`** for a reason specific to this audience. Next prefetches
 * in-viewport links, so a 20-entry list would speculatively fetch up to 20 detail pages — each of
 * which signs a URL and reads a conversation — on a connection Jamee's whole media strategy is
 * built around not wasting (V19's 5 GB egress; the design's mechanism 2). A soft transition is
 * worth less here than the bytes it costs, and nothing on this screen holds client state that a
 * full navigation would discard.
 */
export interface HistoryListProps {
  entries: readonly HistoryEntry[];
  /** The active language, already resolved by the page. Picks the catalog and the date locale. */
  language: Language;
}

export function HistoryList({ entries, language }: HistoryListProps) {
  const { ui, severity } = messages(language);

  /**
   * `Record<Channel, string>` rather than a ternary: it is exhaustive, so a third channel added to
   * `channelSchema` breaks this file until it has a label, instead of quietly rendering every
   * new-channel entry as "Website" (Requirement 12.1 names the channel as a field of every entry).
   */
  const channelNames: Record<Channel, string> = {
    web: ui.channelWeb,
    whatsapp: ui.channelWhatsapp,
    telegram: ui.channelTelegram,
  };

  return (
    /**
     * `<ol>` and not `<ul>`: the order is meaningful — Requirement 12.1 specifies reverse
     * chronological — and an ordered list is what tells a screen reader "entry 3 of 20" about a
     * sequence where position carries that meaning.
     */
    <ol className={styles.list}>
      {entries.map((entry) => {
        /**
         * Requirement 12.1's "the reported condition **or** inconclusive label". The condition is
         * the stored canonical name, in Latin script, untranslated (Requirement 9.4); only the
         * inconclusive substitute is localized, because it is Jamee's own words rather than the
         * name of a disease.
         */
        const label = entry.condition ?? ui.inconclusiveLabel;

        return (
          <li key={entry.id} className={styles.item}>
            <a className={styles.entry} href={diagnosisDetailHref(entry.id)}>
              <span className={styles.figure}>
                {entry.image === null ? (
                  /**
                   * Requirement 12.10 — no image, and the reason stated in plain language rather
                   * than a placeholder graphic that would leave a farmer wondering whether the
                   * screen was still loading (Requirement 15.2).
                   */
                  <span className={styles.missing}>{ui.photoNoLongerStored}</span>
                ) : (
                  /**
                   * `<img>` rather than `next/image`, deliberately. These are short-lived signed
                   * URLs into a private bucket, so the optimizer would need `remotePatterns` for a
                   * host whose URLs expire in minutes, would proxy every read through an
                   * optimization step that costs platform units, and would be re-optimizing an
                   * object the browser already re-encoded to ~320 px and ~25 KB
                   * (`THUMBNAIL_MAX_EDGE_PX`). There is nothing left to optimize.
                   *
                   * No `loading="lazy"`, also deliberately: a signed URL expires in
                   * `SIGNED_URL_EXPIRY_SECONDS`, so a URL fetched when a farmer scrolls to it half
                   * an hour later would 403 and show a broken image. Twenty thumbnails is ~500 KB
                   * fetched up front, which is the cheaper and more honest trade.
                   */
                  // eslint-disable-next-line @next/next/no-img-element -- see above
                  <img
                    className={styles.thumbnail}
                    src={entry.image.url}
                    alt={ui.cropPhotoAlt}
                    decoding="async"
                  />
                )}
              </span>

              <span className={styles.facts}>
                <span className={styles.condition}>{label}</span>

                {/*
                  Each fact is a label and a value, both as text. Requirement 12.1 names four
                  fields, and a bare "WhatsApp" or "Moderate" next to a photo does not say which
                  field it is — least of all to a screen reader reading the link's accessible name
                  as one run of text. Severity in particular is label text plus a non-colour icon,
                  never colour alone (design: "Mobile layout and accessibility").
                */}
                <span className={styles.fact}>
                  <span className={styles.factLabel}>{ui.severityLabel}</span>
                  <span className={styles.factValue}>
                    {/*
                      The design's icon half. `aria-hidden` because this whole entry is one link and
                      a screen reader reads its accessible name as a single run of text — three
                      circles in the middle of "Tomato Early Blight, Severity, Moderate, Channel,
                      Website…" would be noise the word beside them has already covered. Same ink at
                      every level, so nothing is carried by colour. See `src/lib/severity.ts`.
                    */}
                    <span aria-hidden="true" className={styles.severityIcon}>
                      {severityIndicator(entry.severity)}
                    </span>
                    {severity[entry.severity]}
                  </span>
                </span>

                <span className={styles.fact}>
                  <span className={styles.factLabel}>{ui.channelLabel}</span>
                  <span className={styles.factValue}>{channelNames[entry.channel]}</span>
                </span>

                <span className={styles.fact}>
                  <span className={styles.factLabel}>{ui.dateLabel}</span>
                  {/*
                    `<time dateTime>` carries the stored instant unchanged for anything reading the
                    markup, while the text is the Asia/Kolkata rendering a farmer can place. The
                    two are the same moment stated twice, which is what the element is for.
                  */}
                  <time className={styles.factValue} dateTime={entry.createdAt}>
                    {formatInstant(entry.createdAt, language)}
                  </time>
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}
