import { writeSync } from 'node:fs';

import axe, { type Result, type RunOptions } from 'axe-core';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { ChatComposer } from '@/components/ChatComposer';
import { CHAT_HEADING_ID, toChatTurns, type ChatMessageRow } from '@/components/ChatThread';
import {
  DIAGNOSE_HEADING_ID,
  DiagnosisPanel,
  DiagnosisResultCard,
} from '@/components/DiagnosisResultCard';
import { EmptyState } from '@/components/EmptyState';
import { ErrorBanner, type ErrorBannerError } from '@/components/ErrorBanner';
import { HistoryList } from '@/components/HistoryList';
import { LanguageContext, type LanguageContextValue } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SignInForm } from '@/components/SignInForm';
import { VoiceAnswerCard, VoicePanel } from '@/components/VoiceAnswerCard';
import { AppError, toEnvelope } from '@/lib/errors';
import { DIAGNOSE_PATH, type HistoryEntry } from '@/lib/history';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  voiceResponseSchema,
  type IdentifiedResult,
  type InconclusiveResult,
  type Language,
  type VoiceResponse,
} from '@/lib/schemas';

/**
 * The automated accessibility scan (task 26.3).
 *
 * Requirements: 15.1 (the honest in-progress text is real text a screen reader can read),
 *               15.4 (the returned message is displayed, and the retry it offers is a real control)
 * Design: "Frontend — Mobile layout and accessibility"
 *
 * =============================================================================
 * WHAT THIS RUNS, AND WHY IT IS axe-core RATHER THAN A BROWSER
 * =============================================================================
 *
 * `axe-core` is Deque's accessibility engine — the same engine behind `jest-axe`, `vitest-axe`,
 * the Chrome extension and Lighthouse's accessibility category. It is used **directly** rather
 * than through one of those wrappers, because a wrapper's whole contribution is an `expect`
 * matcher and this file already has the two things it would need: a `jsdom` environment (the
 * `unit` project) and a way to turn a component into DOM (`renderToStaticMarkup`, which every
 * component test in `src/components` already uses). It was also *already in the dependency tree*
 * as `eslint-plugin-jsx-a11y`'s engine, so declaring it directly adds a name to `package.json`
 * and no new code to the install.
 *
 * No React testing library was added. The five screens whose markup lives in components render
 * to static markup exactly as the existing component tests render them, and nothing in an axe
 * rule needs an event dispatched or a state transition driven.
 *
 * =============================================================================
 * WHAT A GREEN RUN HERE DOES **NOT** MEAN — READ THIS BEFORE TRUSTING IT
 * =============================================================================
 *
 * An automated scan is not WCAG conformance, and it cannot become one. Five honest limits, each
 * of which is a real gap rather than a caveat:
 *
 *  1. **Contrast is not checked.** `color-contrast` needs computed colours, and Vitest does not
 *     apply the CSS modules these components import (`styles.banner` resolves to a class name with
 *     no rules behind it). The rule is therefore **disabled by name** below rather than left to
 *     report nothing, and the WCAG 2.1 AA contrast target in the design is checked by eye in the
 *     manual pass.
 *
 *  2. **Layout and reading order on a real device are not checked.** Tap-target size, Devanagari
 *     leading and text that scales with the OS font setting are asserted over the stylesheets in
 *     `tests/unit/mobile-layout.test.ts` — which this file deliberately does not duplicate — and
 *     even that reads declarations rather than rendered geometry.
 *
 *  3. **Nothing here uses a screen reader.** Whether an announcement is *useful* — whether the
 *     polite region says the right sentence at the right moment, whether the assertive banner
 *     interrupts at a helpful point — is not a property of the DOM. Task 30.1's manual pass owns
 *     it, and the last test in this file prints that on every run, so a green result cannot be read
 *     as more than it is.
 *
 *  4. **Only rendered states are scanned.** A static render cannot reach a state held behind
 *     `useState`, so the loaded, failed and in-progress states are scanned as the components that
 *     render them (`DiagnosisResultCard`, `VoiceAnswerCard`, `ErrorBanner`) rather than as screen
 *     states arrived at by interaction.
 *
 *  5. **The detail screen is not scanned at all**, and the last `describe` in this file says why
 *     and fails the day that stops being true.
 *
 * =============================================================================
 * WHY THE SHELL IS REPRODUCED
 * =============================================================================
 *
 * Every screen is a server shell (`<main lang>` plus an `<h1>`) around a client subtree. The
 * shells are `async` server components that call `cookies()` and Supabase, so they cannot be
 * rendered here without standing in for Jamee's own modules — which the project does not do.
 *
 * `shell()` therefore reproduces the two elements of the shell the scan genuinely needs: the
 * `lang` that `valid-lang` reads, and the `<h1 id>` that the subtree's `aria-labelledby` points
 * at. Without the heading, every named live region in the app would report a dangling IDREF that
 * does not exist in production. What that costs is stated plainly: this file cannot prove the real
 * shells render those two elements. `DiagnosisResultCard.test.tsx`, `ChatComposer.test.tsx` and
 * `VoiceAnswerCard.test.tsx` pin the subtree half of that contract against the exported id
 * constants, and `/voice`'s id is private to its page, so the voice scan mirrors the pattern with
 * the same literal rather than importing it.
 */

/* ========================================================================== */
/* The engine                                                                  */
/* ========================================================================== */

/**
 * WCAG 2.0/2.1 level A and AA, plus axe's own best-practice set.
 *
 * The best-practice tag is included on purpose: `aria-hidden-focus` and `heading-order` live there,
 * and both bear directly on decisions this codebase has made — the severity dots are
 * `aria-hidden="true"` (they must therefore contain nothing focusable), and every screen has
 * exactly one `<h1>`.
 *
 * Rules whose scope is a whole page (`html-has-lang`, `document-title`, `landmark-one-main`,
 * `page-has-heading-one`, `region`, `bypass`) do not run, because each scan is given a container
 * element rather than the document. That is deliberate: the document here is a test harness, so a
 * page-level rule would be reporting on furniture this file created.
 */
const AXE_OPTIONS: RunOptions = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
  },
  rules: {
    /**
     * Turned off **explicitly**, because it cannot work here and a rule that cannot work should say
     * so rather than be quietly inapplicable.
     *
     * Contrast needs computed colours. Vitest does not apply the CSS modules these components
     * import, and axe reads a pixel through a canvas that jsdom does not implement — left enabled,
     * the rule emits a `getContext() is not implemented` line per scan and evaluates nothing. The
     * WCAG 2.1 AA contrast target is therefore a manual check (task 30.1) and a stylesheet review,
     * which the note at the end of this file prints on every run.
     */
    'color-contrast': { enabled: false },
  },
  resultTypes: ['violations'],
};

/** Long enough for the first run, which compiles every rule before it evaluates one. */
const SCAN_TIMEOUT_MS = 30_000;

/**
 * Render one screen into a real detached-then-attached container and scan it.
 *
 * The container is attached to `document.body` because axe walks the tree from a connected root —
 * visibility, `aria-labelledby` resolution and `aria-hidden` inheritance are all questions about a
 * node's position in a document — and removed afterwards so no scan can see another's markup.
 */
async function violationsIn(screen: ReactElement): Promise<Result[]> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(screen);
  document.body.append(host);

  try {
    const results = await axe.run(host, AXE_OPTIONS);
    return results.violations;
  } finally {
    host.remove();
  }
}

/** A violation list as something a reader can act on: the rule, where it fired, and axe's page. */
function report(violations: readonly Result[]): string {
  if (violations.length === 0) return 'no violations';

  return violations
    .map((violation) => {
      const where = violation.nodes
        .map((node) => `${JSON.stringify(node.target)} ${node.html}`)
        .join('\n      ');
      return [
        `${violation.id} [${violation.impact ?? 'impact unknown'}] — ${violation.help}`,
        `      ${where}`,
        `      ${violation.helpUrl}`,
      ].join('\n');
    })
    .join('\n');
}

/**
 * One assertion, so every screen fails the same readable way.
 *
 * Compared as a string rather than as an empty-array match, because the failure message is the whole
 * value of this test: `expect([]).toEqual([...])` on axe's node objects prints a wall of internal
 * shape, and what a reader needs is the rule, the element and the link.
 */
async function expectNoViolations(screen: ReactElement): Promise<void> {
  const summary = report(await violationsIn(screen));
  expect(summary, summary).toBe('no violations');
}

/* ========================================================================== */
/* The shell every screen shares                                               */
/* ========================================================================== */

interface ShellOptions {
  readonly language: Language;
  /** The screen's `<h1>` text — always one of the catalog's own strings. */
  readonly heading: string;
  /** Present only on the screens whose subtree names a live region with it. */
  readonly headingId?: string;
}

/**
 * `<main lang>` + the switcher + the `<h1>`, which is what all six shells have in common.
 *
 * `LanguageContext.Provider` rather than `LanguageProvider`, following `LanguageSwitcher.test.tsx`:
 * the provider calls `useRouter()`, which needs an app router this test has no business supplying,
 * and the value it would supply is exactly this one.
 */
function shell({ language, heading, headingId }: ShellOptions, children: ReactNode): ReactElement {
  const value: LanguageContextValue = { language, setLanguage: () => {} };

  return (
    <LanguageContext.Provider value={value}>
      <main lang={language}>
        <LanguageSwitcher />
        <h1 id={headingId}>{heading}</h1>
        {children}
      </main>
    </LanguageContext.Provider>
  );
}

/* ========================================================================== */
/* Fixtures — every one of them a real shape from the contract                  */
/* ========================================================================== */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const MESSAGE_ID = '55555555-5555-4555-8555-555555555555';

/** `/voice`'s heading id is private to its page module, so the pattern is mirrored, not imported. */
const VOICE_HEADING_ID = 'jamee-voice-heading';

const STORED_ROWS: readonly ChatMessageRow[] = [
  {
    id: '66666666-6666-4666-8666-666666666666',
    role: 'jamee',
    content: 'Dark rings on the lower leaves point to Tomato Early Blight.',
    language: 'en',
    input_kind: 'text',
    created_at: '2026-09-15T06:01:00.000Z',
  },
  {
    id: '77777777-7777-4777-8777-777777777777',
    role: 'farmer',
    content: 'What should I spray on my potatoes?',
    language: 'en',
    input_kind: 'text',
    created_at: '2026-09-15T06:00:00.000Z',
  },
];

const IDENTIFIED: IdentifiedResult = {
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
};

function inconclusive(language: Language): InconclusiveResult {
  return {
    status: 'unknown',
    diseaseName: null,
    confidence: null,
    severity: 'none',
    explanation: messages(language).inconclusive.model_unclear,
    knowledge: null,
    needsExpert: true,
    language,
  };
}

function voiceResponse(language: Language): VoiceResponse {
  /** Parsed rather than trusted, so a fixture that drifts from the contract fails here. */
  return voiceResponseSchema.parse({
    transcript: 'My tomato leaves have dark spots with yellow edges.',
    answer: {
      messageId: MESSAGE_ID,
      content: 'Those dark spots ringed with yellow point to Tomato Early Blight.',
      language,
      groundedIn: ['Tomato Early Blight'],
      needsExpert: false,
    },
    conversationId: CONVERSATION_ID,
    quota: { operation: 'voice', used: 4, limit: 20, resetsAt: '2026-09-15T18:30:00.000Z' },
  });
}

/** Both image states Requirement 12.1's list can be in, plus the one where neither survived. */
const HISTORY_ENTRIES: readonly HistoryEntry[] = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    condition: 'Tomato Early Blight',
    severity: 'moderate',
    channel: 'web',
    createdAt: '2026-09-14T05:00:00.000Z',
    image: { kind: 'full', url: 'https://signed.test/crop-images/a.jpg?token=t' },
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    condition: null,
    severity: 'none',
    channel: 'whatsapp',
    createdAt: '2026-09-13T05:00:00.000Z',
    image: { kind: 'thumbnail', url: 'https://signed.test/crop-images/b.thumb.jpg?token=t' },
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    condition: 'Potato Late Blight',
    severity: 'high',
    channel: 'web',
    createdAt: '2026-09-12T05:00:00.000Z',
    image: null,
  },
];

/** A real envelope from the taxonomy, so no fixture invents a message, a language or a flag. */
function bannerError(language: Language): ErrorBannerError {
  const { error } = toEnvelope(new AppError('INTERNAL_ERROR', {}), language);
  return { message: error.message, language: error.language, retryable: error.retryable };
}

/* ========================================================================== */
/* The six screens                                                             */
/* ========================================================================== */

/**
 * Every screen, in every Supported_Language.
 *
 * All three languages rather than English only, because two axe rules read language directly —
 * `valid-lang` on the `lang` attributes these components set per block, and `html-lang-valid` on
 * the shell — and because a translated string is what fills every accessible name on the screen.
 */
describe.each(SUPPORTED_LANGUAGES)('accessibility scan (%s)', (language) => {
  const { ui } = messages(language);

  it(
    'sign-in screen has no violations',
    async () => {
      await expectNoViolations(
        shell({ language, heading: ui.appName }, [
          <p key="tagline">{ui.tagline}</p>,
          <SignInForm key="form" language={language} />,
        ]),
      );
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'diagnose screen has no violations',
    async () => {
      await expectNoViolations(
        shell({ language, heading: ui.navDiagnose, headingId: DIAGNOSE_HEADING_ID }, [
          <DiagnosisPanel key="panel" userId={USER_ID} labelledBy={DIAGNOSE_HEADING_ID} />,
        ]),
      );
    },
    SCAN_TIMEOUT_MS,
  );

  /**
   * The two shapes a result can take, scanned where the panel renders them. Both are here because
   * they are structurally different DOM: an identified result carries the severity dots, the
   * confidence value and four grounded lists, and an inconclusive one carries the needs-an-expert
   * banner and none of that.
   */
  it(
    'diagnosis result card has no violations, identified or inconclusive',
    async () => {
      await expectNoViolations(
        shell({ language, heading: ui.navDiagnose }, [
          <DiagnosisResultCard key="identified" result={IDENTIFIED} />,
          <DiagnosisResultCard key="unknown" result={inconclusive(language)} />,
        ]),
      );
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'chat screen has no violations',
    async () => {
      await expectNoViolations(
        shell({ language, heading: ui.navChat, headingId: CHAT_HEADING_ID }, [
          <ChatComposer
            key="composer"
            conversationId={CONVERSATION_ID}
            initialTurns={toChatTurns(STORED_ROWS)}
            labelledBy={CHAT_HEADING_ID}
          />,
        ]),
      );
    },
    SCAN_TIMEOUT_MS,
  );

  /**
   * The recorder is in this subtree, which is the reason the voice screen is worth scanning at all:
   * it is the one control in the app that is press-and-hold, and the design requires a
   * keyboard-operable equivalent. axe reads what the DOM offers — a real `<button>` with an
   * accessible name and no nested interactive content — and the manual pass reads the rest.
   */
  it(
    'voice screen has no violations',
    async () => {
      await expectNoViolations(
        shell({ language, heading: ui.navVoice, headingId: VOICE_HEADING_ID }, [
          <VoicePanel
            key="panel"
            userId={USER_ID}
            conversationId={CONVERSATION_ID}
            labelledBy={VOICE_HEADING_ID}
          />,
        ]),
      );
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'voice answer card has no violations',
    async () => {
      await expectNoViolations(
        shell({ language, heading: ui.navVoice }, [
          <VoiceAnswerCard key="answer" response={voiceResponse(language)} />,
        ]),
      );
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'history screen has no violations, populated or empty',
    async () => {
      await expectNoViolations(
        shell({ language, heading: ui.historyHeading }, [
          <HistoryList key="list" entries={HISTORY_ENTRIES} language={language} />,
        ]),
      );

      await expectNoViolations(
        shell({ language, heading: ui.historyHeading }, [
          <EmptyState
            key="empty"
            message={ui.historyEmpty}
            actionLabel={ui.historyEmptyAction}
            actionHref={DIAGNOSE_PATH}
          />,
        ]),
      );
    },
    SCAN_TIMEOUT_MS,
  );

  /**
   * Requirement 15.4's DOM: the message is readable and the retry is a real control.
   *
   * Scanned standalone because no screen renders a banner until a request has failed. Its
   * **placement** — always a sibling of a polite region, never a child, so an assertive
   * announcement does not double up — is not something an axe rule can see; that is
   * `ErrorBanner`'s own documented rule and `ErrorBanner.test.tsx` is what pins it.
   */
  it(
    'error banner has no violations',
    async () => {
      const error = bannerError(language);

      await expectNoViolations(
        shell({ language, heading: ui.navDiagnose }, [
          <ErrorBanner key="action" error={error} retry={{ kind: 'action', onRetry: () => {} }} />,
          <ErrorBanner key="control" error={error} retry={{ kind: 'control' }} />,
        ]),
      );
    },
    SCAN_TIMEOUT_MS,
  );
});

/* ========================================================================== */
/* What the scan does not reach                                                 */
/* ========================================================================== */

/**
 * The diagnosis detail screen is the sixth screen task 26.3 names, and it is **not scanned**.
 *
 * Its markup is written inline in `src/app/diagnosis/[id]/page.tsx` — an `async` server component
 * that resolves a session, a `diagnoses` row, a knowledge row, a signed URL and a message thread
 * before it renders anything. Scanning it would take one of two things, and both are worse than
 * the gap:
 *
 *  - standing in for `createServerSupabase`, `activeLanguage` and `next/navigation`, which means
 *    substituting Jamee's own modules — the thing every test file in this project refuses to do;
 *  - or rebuilding its markup in this file, which would scan a **copy**. The copy would pass while
 *    the screen regressed, which is the exact failure mode an accessibility gate exists to prevent.
 *
 * The fix is not a test change: extracting that screen's presentation into a module the page
 * renders — the shape every other screen already has — makes it scannable with one entry above.
 * That is a change to the detail screen and belongs to whoever owns it, so it is recorded here
 * rather than done here.
 *
 * The assertion below is what keeps this comment from going stale. It fails the moment the detail
 * screen gains a second `.tsx` module, which is exactly when the paragraph above stops being true.
 */
describe('the detail screen', () => {
  it('still has no importable module to scan, and fails here when it gains one', async () => {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir('src/app/diagnosis', { recursive: true, withFileTypes: true });
    const components = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => entry.name)
      .sort();

    expect(
      components,
      'A .tsx module appeared under src/app/diagnosis beyond the page itself. If it renders any ' +
        'part of the detail screen, add it to the scan above and update this test; the detail ' +
        'screen is currently the one screen named by task 26.3 that nothing scans.',
    ).toEqual(['page.tsx']);
  });
});

/* ========================================================================== */
/* The line this task is required to leave in the test output                   */
/* ========================================================================== */

/**
 * Task 26.3's second clause: the run's own output has to say that full WCAG conformance still needs
 * the manual screen-reader pass tracked in task 30.1.
 *
 * Written to file descriptor 1 rather than through `console`, and that is not a flourish. Vitest's
 * default reporter shows a passing file's console output **nowhere** — not with `silent: false`, not
 * as a test annotation; it surfaces only under `--reporter=verbose` or once the file already fails.
 * A caveat that appears only when something is broken is not a caveat, and this one has to be
 * legible on the green run that would otherwise be mistaken for conformance. `writeSync` sidesteps
 * the capture and lands in the same terminal as the summary. Verified against `npm run test:unit`.
 */
const MANUAL_PASS_NOTE = [
  'An automated scan is NOT WCAG 2.1 AA conformance.',
  'Full conformance additionally requires the manual screen-reader pass tracked in task 30.1,',
  'plus expert review. Not established by this file: colour contrast (the colour-contrast rule is',
  'disabled above — jsdom applies no CSS and implements no canvas); tap-target size, Devanagari',
  'leading and OS text scaling (stylesheet declarations, in tests/unit/mobile-layout.test.ts);',
  'whether an announcement is useful rather than merely present; and the diagnosis detail screen,',
  'which nothing scans — see "the detail screen" above.',
].join(' ');

describe('what this scan does not establish', () => {
  it('records the manual screen-reader pass in the run output', () => {
    writeSync(1, `\n${MANUAL_PASS_NOTE}\n\n`);

    /**
     * Asserted as well as printed, so the sentence cannot be quietly emptied: the clause task 26.3
     * names is the reference to the manual pass, and that is what this pins.
     */
    expect(MANUAL_PASS_NOTE).toContain('manual screen-reader pass tracked in task 30.1');
  });
});
