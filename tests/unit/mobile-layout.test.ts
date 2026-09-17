import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The mobile-first layout rules, asserted over every stylesheet in the project.
 *
 * Requirements: 9.1, 9.3 (English, Hindi and Marathi are all readable on the same screens),
 *               15.2 (no simulated or time-based progress)
 * Design: "Frontend — Mobile layout and accessibility"
 *
 * ### Why a test over CSS text rather than a rendered page
 *
 * Every rule in that design section fails *silently and only on a device*: a clipped Devanagari
 * matra, a 32 px tap target, text that stops scaling with the OS font setting. None of them throws,
 * none of them shows up in a snapshot of the markup, and none of them is visible to a reviewer
 * reading English. The manual device pass in task 30.1 is what confirms they look right; this test
 * is what keeps them from regressing between those passes, and it is the only check that runs on
 * every commit.
 *
 * It reads declarations, not rendered geometry, so it cannot tell you that a control *renders* at
 * 44 px — only that nothing in the codebase expresses a floor in a unit that would stop scaling.
 * That is the honest limit of a static check, and it is stated again at the bottom of this file.
 */

const CSS_ROOTS = ['src/app', 'src/components'] as const;

/**
 * The Devanagari leading floor. Below this, the upper matras of one line collide with the lower
 * matras of the line above — see the reasoning block in `src/app/globals.css`, which owns the
 * decision this test enforces.
 */
const LINE_HEIGHT_FLOOR = 1.35;

/** 44 px at the default root font size (design: tap targets at least 44×44 px). */
const TAP_TARGET_FLOOR_REM = 2.75;

function collectStylesheets(): { path: string; css: string }[] {
  const found: { path: string; css: string }[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.css')) {
        found.push({ path: full.replaceAll('\\', '/'), css: readFileSync(full, 'utf8') });
      }
    }
  };

  for (const root of CSS_ROOTS) walk(root);
  return found;
}

/**
 * Comments are stripped before every scan.
 *
 * These stylesheets carry long explanatory headers that quote the very things the assertions look
 * for — `44px`, `line-height: 1.2`, "no transitions" — so a scan over raw text would fail on the
 * prose explaining why the rule exists. Stripping first means the test reads what the browser
 * reads.
 */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const stylesheets = collectStylesheets();
const globals = declarations(readFileSync('src/app/globals.css', 'utf8'));

/** Comment-stripped declarations by path, so an `it.each` case cannot miss its own stylesheet. */
const byPath = new Map(stylesheets.map((s) => [s.path, declarations(s.css)]));
const paths = [...byPath.keys()];

function declarationsFor(path: string): string {
  const css = byPath.get(path);
  if (css === undefined) throw new Error(`no stylesheet collected for ${path}`);
  return css;
}

/** Every value of one property in a stylesheet, trimmed. `String(...)` for the index-access rule. */
function valuesOf(css: string, property: string): string[] {
  return [...css.matchAll(new RegExp(`${property}:\\s*([^;}]+)`, 'g'))].map((m) =>
    String(m[1]).trim(),
  );
}

/** The first capture group of `pattern` in `css`, or `''` when it does not match. */
function capture(css: string, pattern: RegExp): string {
  return String(pattern.exec(css)?.[1] ?? '').trim();
}

describe('mobile layout rules hold across every stylesheet', () => {
  it('finds the screen shells and the component modules', () => {
    // A silent zero-file walk would make every assertion below vacuously true.
    expect(paths.length).toBeGreaterThanOrEqual(18);
    expect(paths).toContain('src/app/globals.css');
  });

  it.each(paths)('declares no time-driven CSS in %s (Requirement 15.2)', (path) => {
    const css = declarationsFor(path);

    // `transition-*`, `animation-*` and `@keyframes` all at once, longhands included.
    expect(css).not.toMatch(/(^|[;{\s])(transition|animation)[-a-z]*\s*:/);
    expect(css).not.toMatch(/@keyframes/);
  });

  it.each(paths)('sizes text in relative units in %s', (path) => {
    for (const value of valuesOf(declarationsFor(path), 'font-size')) {
      // `px` would pin the text at one size while the farmer's OS font setting grew around it.
      expect(value, `${path}: font-size ${value}`).not.toMatch(/\d(px|pt)\b/);
    }
  });

  it.each(paths)('keeps tap-target floors scalable in %s', (path) => {
    for (const value of valuesOf(declarationsFor(path), 'min-(?:height|width)')) {
      /*
       * `0` is not a floor (it is a flex-shrink escape hatch, as in `HistoryList`'s `.facts`), and
       * `rem` / the token both scale. A `px` floor is what stops scaling.
       */
      expect(value, `${path}: min-height/min-width ${value}`).toMatch(
        /^(0|var\(--tap-target-min\)|[\d.]+rem|[\d.]+em)$/,
      );
    }
  });

  it.each(paths)(
    `keeps every line-height at or above the ${LINE_HEIGHT_FLOOR} Devanagari floor in %s`,
    (path) => {
      for (const value of valuesOf(declarationsFor(path), 'line-height')) {
        if (value.startsWith('var(')) {
          // The two tokens are checked against the floor directly, further down.
          expect(value).toMatch(/^var\(--line-height-(base|tight)\)$/);
          continue;
        }

        const ratio = Number.parseFloat(value);
        expect(
          Number.isNaN(ratio),
          `${path}: line-height ${value} is neither a token nor a unitless ratio`,
        ).toBe(false);
        expect(ratio, `${path}: line-height ${value} clips Devanagari matras`).toBeGreaterThanOrEqual(
          LINE_HEIGHT_FLOOR,
        );
      }
    },
  );
});

describe('globals.css owns the layout decision', () => {
  it('names a Devanagari family for every target platform', () => {
    const stack = capture(globals, /--font-sans:([^;]+);/);

    // Hindi and Marathi are two of the three Supported_Languages; a Latin-only stack renders tofu.
    expect(stack).toMatch(/Noto Sans Devanagari/); // Android
    expect(stack).toMatch(/Kohinoor Devanagari|Devanagari Sangam MN/); // iOS / macOS
    expect(stack).toMatch(/Nirmala UI|Mangal/); // Windows
    expect(stack).toMatch(/Lohit Devanagari|Samyak Devanagari/); // Linux

    // A generic family last, so a platform none of the above covers still resolves to something.
    expect(stack.trim()).toMatch(/sans-serif\s*$/);
  });

  it('sets both leading tokens at or above the Devanagari floor', () => {
    const tight = Number.parseFloat(capture(globals, /--line-height-tight:\s*([\d.]+)/));
    const base = Number.parseFloat(capture(globals, /--line-height-base:\s*([\d.]+)/));

    expect(tight).toBeGreaterThanOrEqual(LINE_HEIGHT_FLOOR);
    // Body copy runs to many lines, so it gets more room than a one-line heading, never less.
    expect(base).toBeGreaterThanOrEqual(tight);
  });

  it('sets the tap-target token in a unit that scales', () => {
    const value = capture(globals, /--tap-target-min:\s*([^;]+);/);

    expect(value).toMatch(/^[\d.]+rem$/);
    expect(Number.parseFloat(value)).toBeGreaterThanOrEqual(TAP_TARGET_FLOOR_REM);
  });

  it('never pins the root font size, so OS text scaling still applies', () => {
    expect(globals).toMatch(/font-size:\s*100%/);
    expect(globals).not.toMatch(/html\s*\{[^}]*font-size:\s*\d+px/);
  });

  it('wraps long Latin names inside Devanagari text globally', () => {
    /*
     * Requirement 9.4 keeps a Canonical_Disease_Name in Latin script inside otherwise Devanagari
     * text, so `Alternaria solani` — one unbreakable token to the line breaker — has to be allowed
     * to break or it widens the whole single-column layout on a 320 px viewport. `overflow-wrap` is
     * inherited, so declaring it on `body` is what makes it a guarantee rather than a per-module
     * habit.
     */
    expect(globals).toMatch(/body\s*\{[^}]*overflow-wrap:\s*break-word/);
  });

  it('constrains replaced elements to their column', () => {
    // One unconstrained 4000 px camera photo turns a single-column screen into a sideways scroll.
    expect(globals).toMatch(/max-width:\s*100%/);
  });
});

/**
 * What this file cannot assert, and where it is covered instead.
 *
 * Static text gives no glyph metrics, no viewport and no font files, so none of the following is
 * checked here — all of it belongs to the manual device pass in task 30.1:
 *
 *  - that a Devanagari heading actually renders uncliped at `--line-height-tight` in the family the
 *    device resolves, rather than merely being given enough leading to;
 *  - that the named Devanagari families are present on the specific Android and iOS versions tested;
 *  - that a control's rendered box measures at least 44×44 CSS px once its label and padding are
 *    laid out, at the default *and* at an enlarged OS font setting;
 *  - that the primary action on each screen falls within thumb reach on a real handset;
 *  - contrast ratios as rendered, and full WCAG 2.1 AA conformance, which the design already
 *    records as requiring a screen-reader pass and expert review.
 */
