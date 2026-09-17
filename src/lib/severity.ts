import type { Severity } from '@/lib/schemas';

/**
 * The non-colour severity indicator that accompanies the severity label text.
 *
 * Requirements: 15.4 (what a farmer reads about a result)
 * Design: "Frontend — Mobile layout and accessibility" — *severity is conveyed by label text and
 *          icon, never colour alone*
 *
 * ### Why this exists, and why it is a filled-dot count rather than a picture
 *
 * The label text half was already done: `catalog.severity[...]` renders "Mild" / "Moderate" /
 * "Severe" in the farmer's own language on the result card, in the history list and on the detail
 * page. The design asks for an *icon* as well, and there was none anywhere. Adding one has to clear
 * three bars at once, and a pictogram clears none of them:
 *
 *  1. **It cannot be an image-only signal.** An `<img>`, an inline `<svg>` or a webfont glyph is a
 *     separate asset to fetch on a metered 2G connection, and a broken or unsupported one leaves a
 *     farmer with nothing where a severity used to be. These are ordinary text characters in the
 *     document, so they cost no request and cannot half-load.
 *  2. **It cannot carry meaning a screen reader cannot read** — and the honest way to satisfy that
 *     is not to make the indicator readable, it is to make it *redundant*. A screen reader is given
 *     the words, which are unambiguous and already translated; the dots are `aria-hidden` (see the
 *     three call sites) because "black circle black circle white circle Moderate" is worse than
 *     "Moderate", not better. Nothing here is the only carrier of anything.
 *  3. **It cannot smuggle colour back in.** Every level uses the same two characters in the same
 *     ink — what differs is *how many are filled*, which is a quantity a farmer with any colour
 *     vision reads identically. A red/amber/green set of otherwise identical shapes would be the
 *     colour-only encoding the design rules out, wearing an icon's clothes.
 *
 * A filled-dot count also says the one thing a pictogram does not: severity is **ordinal**. Three
 * of three filled reads as worse than one of three without knowing which word is which, which is
 * exactly the help a farmer who is scanning a twenty-entry history list wants.
 *
 * ### The characters, and the fallback risk
 *
 * `●` U+25CF BLACK CIRCLE and `○` U+25CB WHITE CIRCLE, both from the Geometric Shapes block. They
 * are present in every family named in `--font-sans` and in the platform fallback fonts behind it,
 * which is why they were preferred over the Braille or box-drawing alternatives. That coverage is a
 * documented claim rather than a measured one: whether these render as circles at body size in the
 * families a specific Android and iOS build resolves belongs to the manual device pass (task 30.1).
 * If one of them ever renders as tofu, the severity is still stated in words beside it — which is
 * the whole reason the dots are the redundant half and not the primary one.
 *
 * `none` is three empty dots rather than an em dash: `severity: 'none'` is Requirement 6.4's
 * healthy/inconclusive value, and "no dots filled" is the bottom of the same scale rather than an
 * absence of information.
 */
export const SEVERITY_SCALE_LENGTH = 3;

const FILLED = '\u25CF';
const EMPTY = '\u25CB';

/** How many of the three dots are filled at each level. `none` is the floor, not a gap. */
const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
};

/**
 * The indicator for one severity, as a plain string.
 *
 * Built from `SEVERITY_RANK` rather than written out four times so the scale cannot end up with a
 * level whose dot count disagrees with its neighbours, and so a fifth `Severity` added to
 * `severitySchema` fails this file at the type level instead of silently rendering nothing.
 *
 * Always `SEVERITY_SCALE_LENGTH` characters wide, including at `none`: a fixed width is what makes
 * a column of these comparable at a glance in the history list, and what stops the label text
 * beside it from shifting left and right between entries.
 */
export function severityIndicator(severity: Severity): string {
  const filled = SEVERITY_RANK[severity];
  return FILLED.repeat(filled) + EMPTY.repeat(SEVERITY_SCALE_LENGTH - filled);
}
