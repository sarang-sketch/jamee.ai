import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyState } from '@/components/EmptyState';
import { HistoryList } from '@/components/HistoryList';
import type { HistoryEntry } from '@/lib/history';
import { messages } from '@/lib/messages';
import { SUPPORTED_LANGUAGES, type Language } from '@/lib/schemas';
import { severityIndicator } from '@/lib/severity';

/**
 * Unit tests for what the history markup actually says.
 *
 * Requirements: 12.1 (every entry carries the thumbnail, the condition or the inconclusive label,
 *               the Severity_Value, the channel and the creation timestamp), 12.2 (a WhatsApp entry
 *               is labelled as one), 12.4 (the empty state invites a first upload), 12.10 (no
 *               surviving image says so in plain language), 9.4 (a canonical name is not
 *               translated), 15.4 / 26.2 (severity is conveyed by label text, not colour)
 * Design: "Mobile layout and accessibility" — real alt text, a keyboard-operable list, no
 *          colour-only meaning
 *
 * Rendered to static markup rather than mounted: every question here is about what the DOM says,
 * and a static render answers them without a router. Both components are server components with no
 * state, so a static render is also exactly how they run in production.
 */

const ENTRY: HistoryEntry = {
  id: '22222222-2222-4222-8222-222222222222',
  condition: 'Tomato Early Blight',
  severity: 'moderate',
  channel: 'web',
  createdAt: '2026-09-14T05:00:00.000Z',
  image: { kind: 'thumbnail', url: 'https://signed.test/crop-images/a.thumb.jpg?token=t' },
};

function render(entries: readonly HistoryEntry[], language: Language = 'en'): string {
  return renderToStaticMarkup(<HistoryList entries={entries} language={language} />);
}

describe('HistoryList', () => {
  /** Requirement 12.1's five fields, on one entry, in the markup. */
  it('renders the condition, severity, channel and timestamp of an entry', () => {
    const markup = render([ENTRY]);
    const { ui, severity } = messages('en');

    // Requirement 9.4 — the canonical name, in Latin script, exactly as stored.
    expect(markup).toContain('Tomato Early Blight');
    expect(markup).toContain(severity.moderate);
    expect(markup).toContain(ui.severityLabel);
    expect(markup).toContain(ui.channelWeb);
    expect(markup).toContain(ui.channelLabel);
    expect(markup).toContain(ui.dateLabel);
    // The machine-readable instant sits alongside the rendered one, on a `<time>`.
    expect(markup).toContain('<time');
    expect(markup).toContain('dateTime="2026-09-14T05:00:00.000Z"');
  });

  /** Requirement 12.1's thumbnail, loaded from the signed URL the page minted (12.5). */
  it('renders the thumbnail from the signed URL, with real alt text', () => {
    const markup = render([ENTRY]);

    expect(markup).toContain(`src="${ENTRY.image?.url ?? ''}"`);
    expect(markup).toContain(`alt="${messages('en').ui.cropPhotoAlt}"`);
    // Not an empty alt: the photo is content, not decoration.
    expect(markup).not.toContain('alt=""');
  });

  /**
   * Requirement 12.2. A WhatsApp-originated diagnosis is in the list and says where it came from —
   * the point of the requirement is that the farmer can tell, not that it is hidden.
   */
  it('labels a WhatsApp-originated entry with its channel', () => {
    const markup = render([{ ...ENTRY, channel: 'whatsapp' }]);
    expect(markup).toContain(messages('en').ui.channelWhatsapp);
  });

  /**
   * Requirement 12.1 as amended by A1: Telegram is the live messaging channel, so a
   * Telegram-originated diagnosis appears in history on the same footing as a web one and says where
   * it came from. The `Record<Channel, string>` map is exhaustive, so this also guards that the
   * widened `channelSchema` has a rendered label rather than an `undefined` next to the photo.
   */
  it('labels a Telegram-originated entry with its channel', () => {
    const markup = render([{ ...ENTRY, channel: 'telegram' }]);
    expect(markup).toContain(messages('en').ui.channelTelegram);
    // The web/whatsapp labels are not what a telegram entry shows.
    expect(markup).not.toContain(messages('en').ui.channelWhatsapp);
  });

  /** Requirement 12.1's "or inconclusive label" — localized, unlike the condition name. */
  it('renders the inconclusive label in place of a condition', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const markup = render([{ ...ENTRY, condition: null }], language);
      expect(markup).toContain(messages(language).ui.inconclusiveLabel);
      expect(markup).not.toContain('Tomato Early Blight');
    }
  });

  /** Requirement 12.10 — no image, and the reason in plain language rather than a blank box. */
  it('states that the photo is no longer stored when there is no image', () => {
    const markup = render([{ ...ENTRY, image: null }]);

    expect(markup).toContain(messages('en').ui.photoNoLongerStored);
    expect(markup).not.toContain('<img');
  });

  /**
   * Requirement 12.1's ordering is `readHistory`'s job; what this asserts is that the component
   * preserves it and emits an ordered list, so a screen reader announces position in a sequence
   * where position means something.
   */
  it('renders entries in the given order, as an ordered list', () => {
    const markup = render([
      { ...ENTRY, id: 'newer' },
      { ...ENTRY, id: 'older' },
    ]);

    expect(markup.indexOf('/diagnosis/newer')).toBeLessThan(markup.indexOf('/diagnosis/older'));
    expect([...markup.matchAll(/<ol[ >]/g)]).toHaveLength(1);
    /**
     * The character class matters: React 19 emits a `<link rel="preload" as="image">` for every
     * `<img src>`, and a bare `/<li/` would count those too.
     */
    expect([...markup.matchAll(/<li[ >]/g)]).toHaveLength(2);
  });

  /**
   * Requirement 12.3 is reached from here, and the list has to be operable by keyboard. One real
   * `<a href>` per entry is the whole mechanism: one Tab stop each, in document order, with no
   * `tabindex` and no click-handled `<div>` (design: "Mobile layout and accessibility").
   */
  it('gives each entry one keyboard-reachable link to its detail view', () => {
    const markup = render([{ ...ENTRY, id: 'abc' }, { ...ENTRY, id: 'def' }]);
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);

    expect(hrefs).toEqual(['/diagnosis/abc', '/diagnosis/def']);
    expect(markup).not.toContain('tabindex');
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('onclick');
  });

  /** Every string on the entry comes from the active catalog, in all three languages. */
  it('renders its furniture in each Supported_Language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const markup = render([ENTRY], language);
      const { ui, severity } = messages(language);

      expect(markup).toContain(ui.severityLabel);
      expect(markup).toContain(ui.channelLabel);
      expect(markup).toContain(ui.dateLabel);
      expect(markup).toContain(severity.moderate);
    }
  });

  /**
   * The design asks for severity "by label text **and** icon, never colour alone", and task 26.2
   * added the icon half. Both facts are asserted together because either alone would be the failure
   * mode: label text with no icon is what this list had, and an icon with no text is the
   * colour-and-shape-only reading the design rules out.
   *
   * `aria-hidden` on the icon is part of the claim, not an omission. The entry is one link, so a
   * screen reader reads its whole accessible name as a run of text; three circles inside that run
   * would be noise the translated word beside them has already covered.
   */
  it('carries severity as label text plus an aria-hidden non-colour icon', () => {
    const markup = render([ENTRY]);
    const { severity } = messages('en');

    expect(markup).toContain(severityIndicator('moderate'));
    expect(markup).toContain(severity.moderate);
    expect(markup).toMatch(/aria-hidden="true"[^>]*>\u25CF\u25CF\u25CB/u);
  });

  /**
   * The icon distinguishes levels by how many dots are filled, and by nothing else. Two entries at
   * different severities must therefore differ in the indicator — otherwise the "icon" would be
   * decoration and the text would be doing all the work again.
   */
  it('renders a different indicator for a different severity', () => {
    const high = render([{ ...ENTRY, severity: 'high' }]);
    const none = render([{ ...ENTRY, severity: 'none' }]);

    expect(high).toContain(severityIndicator('high'));
    expect(none).toContain(severityIndicator('none'));
    expect(severityIndicator('high')).not.toBe(severityIndicator('none'));
  });
});

describe('EmptyState', () => {
  /** Requirement 12.4 — the message, and an invitation that is a real link to the upload screen. */
  it('states the empty history and links to a first upload', () => {
    const { ui } = messages('en');
    const markup = renderToStaticMarkup(
      <EmptyState
        message={ui.historyEmpty}
        actionLabel={ui.historyEmptyAction}
        actionHref="/diagnose"
      />,
    );

    expect(markup).toContain(ui.historyEmpty);
    expect(markup).toContain(ui.historyEmptyAction);
    expect(markup).toContain('href="/diagnose"');
    // A link, not a click-handled element — it navigates, so it is an anchor.
    expect([...markup.matchAll(/<a /g)]).toHaveLength(1);
  });

  it('renders in each Supported_Language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const { ui } = messages(language);
      const markup = renderToStaticMarkup(
        <EmptyState
          message={ui.historyEmpty}
          actionLabel={ui.historyEmptyAction}
          actionHref="/diagnose"
        />,
      );

      expect(markup).toContain(ui.historyEmpty);
      expect(markup).toContain(ui.historyEmptyAction);
    }
  });
});
