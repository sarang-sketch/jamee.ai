'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { AppError } from '@/lib/errors';
import { languageCookie } from '@/lib/language';
import {
  chatRequestSchema,
  diagnoseRequestSchema,
  voiceRequestSchema,
  type ChatRequest,
  type DiagnoseRequest,
  type Language,
  type VoiceRequest,
} from '@/lib/schemas';

/**
 * The active language, and the only way a screen sends a diagnosis, chat or voice request.
 *
 * Requirements: 9.1 (the three Supported_Languages), 9.2 (the selected code is included in
 *               **every subsequent** diagnosis, chat and voice request), 1.8 (persisting a
 *               preferred language is the profile screen's job, not this one's)
 * Design: "Frontend"; D1 (`/api/diagnose` takes a JSON storage reference, not multipart)
 *
 * ### Why a context AND a request helper, rather than a `language` prop
 *
 * A prop threaded by hand satisfies Requirement 9.2 only for as long as every author remembers
 * it. Three screens do not exist yet — `/diagnose` (task 12.2), `/chat` (task 16.1) and
 * `/voice` (task 19.2) — so "remember to pass the language" would be advice given now to code
 * written later, which is the weakest kind of guarantee there is. Omitting it would not break a
 * build; it would send `language: 'en'` to a Marathi farmer, and only the farmer would notice.
 *
 * So the mechanism is chosen to make omission **impossible rather than discouraged**, in three
 * layers:
 *
 *  1. `useJameeRequests()` is the only exported way to reach the three endpoints, and it takes
 *     the language from context rather than from an argument.
 *  2. Its three body types are `Omit<…, 'language'>`. A caller **cannot pass a language even
 *     deliberately** — `diagnose({ image, language: 'en' })` is a type error — so there is no
 *     second source for the value and therefore nothing to disagree with the switcher.
 *  3. Each method validates the assembled body against the same Zod schema the route handler
 *     will validate it with, so a body that reached the network without a valid language would
 *     have to fail that parse first.
 *
 * The remaining way to get this wrong is to forget the provider, and that fails loudly and
 * immediately: `useLanguage()` throws with the fix in the message rather than defaulting to
 * `en`. A silent default here is exactly the bug this file exists to prevent.
 *
 * ### What a selection does NOT do
 *
 * **It does not write the Profile.** Requirement 1.8 gives that job to the profile screen, and
 * two writers of one column is how a control ends up fighting the screen that owns it. Two
 * further reasons this is the right split rather than a shortcut:
 *
 *  - The profile's `language` is what the **Telegram** adapter localizes replies from
 *    (`messages/types.ts`, Requirement 10). A farmer switching the web UI to English for one
 *    explanation has said nothing about which language they want their Telegram replies in, and
 *    a silent profile write would re-language a channel they were not looking at.
 *  - Requirements 9.1 and 9.2 ask for a selectable set and for the selection to reach
 *    subsequent requests. Neither asks for persistence. The cookie already carries the
 *    selection across navigations, which is the whole of what 9.2 needs.
 *
 * The profile screen therefore keeps ownership of the durable value, and calls `setLanguage`
 * alongside its own write so the session stops carrying the older answer.
 */

/* ========================================================================== */
/* The typed request helper                                                    */
/* ========================================================================== */

export const API_ENDPOINTS = {
  diagnose: '/api/diagnose',
  chat: '/api/chat',
  voice: '/api/voice',
} as const;

/**
 * The same code, in the query string as well as the body — and the duplication is deliberate.
 *
 * `envelopeLanguage()` in `src/lib/api/authenticated-route.ts` decides which language a refusal
 * is written in **without reading the body**, because parsing up to 4.5 MB of JSON before
 * deciding whether the caller is allowed to be here at all is not a trade worth making. Its
 * first source is exactly this parameter, its second is `Accept-Language`.
 *
 * Without this, a farmer whose session had expired would get their `AUTH_REQUIRED` message in
 * whatever language their browser advertises rather than the one they selected — and on a shared
 * or hand-me-down phone those are routinely different. The body remains the authoritative copy
 * (Requirement 2.2, and task 16.2 validates it there); this is what the error path can read
 * before it gets there.
 */
function endpointFor(endpoint: string, language: Language): string {
  return `${endpoint}?language=${encodeURIComponent(language)}`;
}

/**
 * The seam the unit test substitutes. Narrower than `typeof fetch` on purpose: every Jamee
 * request is a POST to a known path with a JSON body, so a test recorder is a two-argument
 * function rather than a partial reimplementation of the Fetch API.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SendOptions {
  /** For a screen that abandons a request when the farmer navigates away. */
  signal?: AbortSignal;
}

/**
 * The three bodies **without** `language`. This is the type-level half of Requirement 9.2: the
 * field is not optional here, it is absent, so the only value that can ever occupy it is the
 * one the helper supplies from the active context.
 */
export type DiagnoseBody = Omit<DiagnoseRequest, 'language'>;
export type ChatBody = Omit<ChatRequest, 'language'>;
export type VoiceBody = Omit<VoiceRequest, 'language'>;

export interface JameeRequests {
  /** The code every method below stamps onto its body. Exposed for display, not for input. */
  readonly language: Language;
  diagnose(body: DiagnoseBody, options?: SendOptions): Promise<Response>;
  chat(body: ChatBody, options?: SendOptions): Promise<Response>;
  voice(body: VoiceBody, options?: SendOptions): Promise<Response>;
}

/**
 * A body that fails its own schema is a Jamee bug, not something a farmer did.
 *
 * `INTERNAL_ERROR` rather than a new code: the cause is attached for the log and
 * `toEnvelope()` structurally cannot leak it (Requirement 15.6), so the screen renders a
 * generic localized message instead of a Zod error path. Note this throws **before** any
 * request is issued — a malformed body costs no round trip and no quota.
 */
function invalidBody(endpoint: string, cause: unknown): AppError {
  return new AppError('INTERNAL_ERROR', { cause, context: { endpoint } });
}

async function post(
  url: string,
  body: unknown,
  options: SendOptions | undefined,
  fetchImpl: FetchLike,
): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    /** D1: a storage reference, ~200 bytes. Media bytes never pass through here. */
    body: JSON.stringify(body),
    /** Spread rather than assigned: `exactOptionalPropertyTypes` rejects an explicit undefined. */
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  };
  return fetchImpl(url, init);
}

/**
 * Build the three request functions for one language.
 *
 * Exported separately from the hook so the propagation rule can be tested over a real payload
 * without rendering a tree — the assertion that matters is what lands in the request body, and
 * that is this function's output.
 *
 * The response is returned unparsed: `diagnoseResponseSchema`, the error envelope and the retry
 * action belong to the screens and to `ErrorBanner`, and duplicating that here would give the
 * app two places that decide what a 429 means.
 */
export function jameeRequests(
  language: Language,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): JameeRequests {
  return {
    language,

    diagnose(body, options) {
      const parsed = diagnoseRequestSchema.safeParse({ ...body, language });
      if (!parsed.success) throw invalidBody(API_ENDPOINTS.diagnose, parsed.error);
      return post(endpointFor(API_ENDPOINTS.diagnose, language), parsed.data, options, fetchImpl);
    },

    chat(body, options) {
      const parsed = chatRequestSchema.safeParse({ ...body, language });
      if (!parsed.success) throw invalidBody(API_ENDPOINTS.chat, parsed.error);
      return post(endpointFor(API_ENDPOINTS.chat, language), parsed.data, options, fetchImpl);
    },

    voice(body, options) {
      const parsed = voiceRequestSchema.safeParse({ ...body, language });
      if (!parsed.success) throw invalidBody(API_ENDPOINTS.voice, parsed.error);
      return post(endpointFor(API_ENDPOINTS.voice, language), parsed.data, options, fetchImpl);
    },
  };
}

/* ========================================================================== */
/* Context                                                                     */
/* ========================================================================== */

export interface LanguageContextValue {
  language: Language;
  /**
   * Record a selection: local state, the cookie, and a re-render of the server tree.
   *
   * Also the call the profile screen makes after saving a new preferred language, so the
   * session's cookie and the persisted value agree from that moment on.
   */
  setLanguage: (next: Language) => void;
}

/**
 * `null` is the "no provider" signal, and `useLanguage()` throws on it rather than substituting
 * a default. Exported so a test can supply a value without mounting the provider (which needs
 * an app router); application code should use the hooks.
 */
export const LanguageContext = createContext<LanguageContextValue | null>(null);

export interface LanguageProviderProps {
  /**
   * Resolved server-side by `activeLanguage(profile.language)` — the cookie if the farmer has
   * chosen, otherwise their Profile's preferred language, otherwise `en`.
   *
   * Read once, as the initial state: after mount, the switcher's own state is authoritative and
   * matches the cookie a later server render would read anyway.
   */
  initialLanguage: Language;
  children: ReactNode;
}

export function LanguageProvider({ initialLanguage, children }: LanguageProviderProps) {
  const router = useRouter();
  const [language, setActive] = useState<Language>(initialLanguage);

  const setLanguage = useCallback(
    (next: Language): void => {
      setActive(next);
      /**
       * Written before the refresh, and synchronously, so the server render triggered on the
       * next line already reads the new value. Guarded for the server pass of this component,
       * where there is no `document`.
       */
      if (typeof document !== 'undefined') document.cookie = languageCookie(next);
      /**
       * The server shells hold the localized text, so a selection has to re-run them —
       * otherwise the requests would switch language and the surrounding screen would not.
       * `refresh()` re-renders in place and keeps the farmer's scroll position and any typed
       * input, which a full reload would discard.
       */
      router.refresh();
    },
    [router],
  );

  /**
   * Keep the **document element**'s language in step with the active one.
   *
   * Every screen sets `lang` on its own `<main>`, which is what governs the text a farmer reads.
   * This is the element above all of them, and it is the one a screen reader consults to choose a
   * voice for the page and the UA consults to pick a font by document language. `layout.tsx` sets
   * it from the cookie on the server, which leaves two cases only the client can close:
   *
   *  - a farmer whose language comes from their **profile** and who has no cookie yet, so the
   *    server render had nothing better than `en` to go on;
   *  - a **switch**, because `router.refresh()` re-renders the route subtree and `<html>` is not
   *    in it — the attribute would keep the value the page loaded with.
   *
   * Writing an attribute on an element React does not own is exactly what an effect is for, and
   * it is idempotent: assigning the value it already holds is a no-op. `documentElement` is always
   * present in a browser, and this never runs on the server.
   */
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({ language, setLanguage }),
    [language, setLanguage],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/* ========================================================================== */
/* Hooks                                                                       */
/* ========================================================================== */

const NO_PROVIDER =
  'No <LanguageProvider>. A screen shell must resolve the active language with ' +
  'activeLanguage(profile.language) from @/lib/language.server and wrap its client subtree ' +
  'in <LanguageProvider initialLanguage={language}>.';

/** The active language and the setter. Throws rather than guessing `en` (Requirement 9.2). */
export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (value === null) throw new Error(NO_PROVIDER);
  return value;
}

/**
 * The three request functions, already carrying the active language.
 *
 * Memoized on the language so a screen can hold the object across renders; a switch produces a
 * new object, which is what makes an in-flight-after-switch request impossible to build from a
 * stale one.
 */
export function useJameeRequests(): JameeRequests {
  const { language } = useLanguage();
  return useMemo(() => jameeRequests(language), [language]);
}
