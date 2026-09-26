import 'server-only';

import { AppError, isAppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import type { DiagnosisResult, Language } from '@/lib/schemas';

/**
 * The channel-agnostic reply formatters — the ONE place a service result becomes the text a
 * messaging channel sends, so the Telegram and (until wave 6 deletes it) WhatsApp channels format
 * an identical Diagnosis_Result identically.
 *
 * Requirements: 10.7 / 10.13 (channel parity: the same Diagnosis_Result content a given crop image
 *               produces on the Web_App is what the messaging reply carries), 8.6 (a voice reply
 *               carries both the transcript and the answer), 4.7 / 7.6 (the referral sentence IS the
 *               chat answer, so it is not doubled), 15.6 (a failure reply carries only the coded,
 *               localized sentence — never a provider payload)
 * Design: D7 (channel parity is one code path and identical structured fields, not identical prose)
 *
 * =============================================================================
 * WHY THESE MOVED OUT OF `src/lib/whatsapp-dispatch.ts`
 * =============================================================================
 *
 * D7's parity is "same service invocation, same knowledge-base row, identical structured fields".
 * The formatters below add nothing to a service result — they arrange fields the service already
 * grounded and localized — so both channels must render through the SAME formatter or "identical"
 * is a claim two copies can silently break. The functions were authored on the WhatsApp path;
 * Amendment A1 makes Telegram the live channel and wave 6 deletes `whatsapp-dispatch.ts`, so the
 * formatters live here, in a channel-neutral module both adapters import. This file is a **copy**
 * of the WhatsApp definitions rather than a re-export from them, precisely because the WhatsApp
 * module is being deleted — a re-export would break the moment it went.
 *
 * Nothing here reaches a model, a network call, or `process.env`: a reply is arranged from the
 * fields a service already produced, and a failure sentence is read from the catalog through the
 * leak boundary. That keeps a messaging reply under the same rule as an HTTP response body.
 */

/**
 * Blank line between blocks. Telegram (like WhatsApp) renders `\n` literally in a plain-text
 * message, so paragraphs are made explicit rather than left to a renderer.
 */
const BLOCK = '\n\n';

/**
 * A `Diagnosis_Result` as a messaging reply.
 *
 * **Requirement 10.7 is why this function adds nothing.** "The same Diagnosis_Result content for a
 * given crop image as the Web_App returns" holds because both channels render the *same* service
 * output: `explanation` is already knowledge-base grounded and already localized by the service,
 * the canonical name is already in Latin script (Requirements 4.6, 9.4), and the severity label
 * comes from the same catalog entry the results screen uses. Nothing is summarized, re-worded, or
 * dropped, so the two channels cannot come to disagree about what a photo showed.
 *
 * The canonical name leads because it is the one string a farmer may want to search for or repeat
 * to an expert; `sendMessage`'s own 4096-character cap (V24) truncates the tail of the explanation
 * if anything is lost, never the diagnosis.
 */
export function formatDiagnosisReply(result: DiagnosisResult, language: Language): string {
  const { ui, severity } = messages(language);

  const heading =
    result.status === 'identified'
      ? `${result.diseaseName}${BLOCK}${ui.severityLabel}: ${severity[result.severity]}`
      : ui.inconclusiveLabel;

  const blocks = [heading, result.explanation];
  // Requirements 6.4 and 12.1: an inconclusive result says so, and says what to do next. An
  // identified result has `needsExpert: false` by type, so this cannot double up on it.
  if (result.needsExpert) blocks.push(ui.needsExpertBanner);

  return blocks.join(BLOCK);
}

/**
 * A chat answer as a messaging reply: the answer, and nothing around it.
 *
 * No heading and no expert banner. `content` is the whole answer the ChatService produced — and
 * when `needsExpert` is true it *is* the referral sentence (Requirements 4.7, 7.6), so appending
 * `needsExpertBanner` would tell the farmer to consult an expert twice in two different wordings.
 */
export function formatChatReply(content: string): string {
  return content;
}

/**
 * A voice answer as a messaging reply: what Jamee heard, then the answer.
 *
 * The transcript is included for the reason Requirement 8.6 gives it to the web path — a farmer who
 * can see the transcription can tell a wrong answer from a misheard question, which on a voice
 * channel is the difference between "Jamee is wrong" and "say it again". It is labelled with the
 * same catalog string the web screen uses.
 */
export function formatVoiceReply(transcript: string, content: string, language: Language): string {
  const { ui } = messages(language);
  return `${ui.transcriptLabel}: ${transcript}${BLOCK}${content}`;
}

/**
 * The farmer-facing sentence for a failure, in their language.
 *
 * Routed through `toEnvelope`, which is the codebase's leak boundary (Requirement 15.6): it reads
 * the code, the details and the catalog, and structurally never touches `message`, `stack` or
 * `cause`. So a provider payload or a stack fragment cannot reach a messaging reply, for the same
 * reason it cannot reach an HTTP response body.
 */
export function failureReply(error: unknown, language: Language): string {
  const appError = isAppError(error) ? error : new AppError('INTERNAL_ERROR', { cause: error });
  return toEnvelope(appError, language).error.message;
}
