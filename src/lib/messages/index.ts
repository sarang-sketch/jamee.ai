import { en } from '@/lib/messages/en';
import { hi } from '@/lib/messages/hi';
import { mr } from '@/lib/messages/mr';
import type { MessageCatalog } from '@/lib/messages/types';
import type { Language } from '@/lib/schemas';

export type { MessageCatalog } from '@/lib/messages/types';
export { interpolate } from '@/lib/messages/types';

/**
 * The catalog lookup. One pure object access; **no model call is reachable from here**
 * (D5, Requirement 6.6).
 *
 * `Record<Language, MessageCatalog>` is exhaustive over the three supported codes, so adding a
 * fourth language to `languageSchema` breaks this file until a catalog exists for it. That is
 * the same structural-completeness trick the catalogs themselves use for error codes.
 */
const CATALOGS: Record<Language, MessageCatalog> = { en, hi, mr };

/**
 * Messages for a resolved language.
 *
 * The parameter is typed `Language`, so an unsupported code cannot reach this function — it is
 * refused at the API edge with HTTP 400 naming the three supported codes (Requirement 9.5).
 * There is deliberately no `?? en` fallback here: a silent fallback would turn a validation bug
 * into an English message shown to a Marathi farmer, which reads as working software.
 */
export function messages(language: Language): MessageCatalog {
  return CATALOGS[language];
}

export { en, hi, mr };
