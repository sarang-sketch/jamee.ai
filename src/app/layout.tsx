import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { activeLanguage } from '@/lib/language.server';

import './globals.css';

export const metadata: Metadata = {
  title: 'Jamee',
  description:
    'Crop disease detection for farmers, with answers in English, Hindi and Marathi.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Root layout: locale + font shell only.
 *
 * Requirements: 9.1 (en, hi, mr), 9.3 (all three readable on the same screens)
 * Design: "Frontend — Mobile layout and accessibility"
 *
 * Server component — no `'use client'`, no state, no data access.
 *
 * ### Why `<html lang>` is resolved here as well as on every `<main>`
 *
 * Each screen shell already sets `lang` on its landmark, which governs the text inside it. The
 * document element governs three things that sit *above* any landmark and that a per-screen
 * attribute cannot reach: the voice a screen reader picks when the page loads, the font the UA
 * chooses by document language before a single CSS rule is consulted, and anything a browser
 * offers on the page as a whole (translate prompts, hyphenation dictionaries). A fully Marathi
 * page under `lang="en"` announces its first landmark in an English voice.
 *
 * `activeLanguage(null)` gives the **cookie** answer, which is what this element can honestly
 * know: the profile's preferred language needs a session and a `profiles` read, and doing either
 * in the root layout would put a database call in front of every route including the ones that
 * redirect. So there are two halves, and they cover different cases:
 *
 *  - here, the cookie — correct from the very first byte for any farmer who has ever used the
 *    switcher on this device;
 *  - `LanguageProvider`, after hydration — corrects the remaining case (a profile preference with
 *    no cookie yet) and keeps the attribute in step with a switch, which `router.refresh()` alone
 *    would not do for an element outside the refreshed subtree.
 *
 * Awaiting `cookies()` marks every route dynamic. Nothing is lost: `/`, `/diagnose`, `/chat`,
 * `/voice`, `/history`, `/profile` and `/diagnosis/[id]` all resolve a session, and each already
 * declares `dynamic = 'force-dynamic'` for that reason.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const language = await activeLanguage(null);

  return (
    <html lang={language}>
      <body>{children}</body>
    </html>
  );
}
