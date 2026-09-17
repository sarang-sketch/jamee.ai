import * as fc from 'fast-check';
import type Groq from 'groq-sdk';
import { describe, expect, it } from 'vitest';

import {
  textAdapters,
  visionAdapters,
  type CapabilityDeps,
  type TextCall,
  type VisionCall,
} from '@/lib/ai/capabilities';
import {
  ATTEMPT_BUDGETS,
  run,
  SOFT_BUDGET_MS,
  type AdapterSet,
  type GatewayResult,
  type ProviderId,
  type RunOptions,
} from '@/lib/ai/gateway';
import { AppError, toEnvelope } from '@/lib/errors';
import type { GeminiInteractionResponse, InteractionCreate, JsonSchema } from '@/lib/gemini';
import type { GroqChatCreate } from '@/lib/groq';

/**
 * ### Property 21: The fallback chain either serves the request or reports the busy message
 *
 * > For any operation whose primary provider fails with a rate-limit or unavailability error, the
 * > request is retried on the fallback provider when the capability has one; for any operation whose
 * > provider chain is exhausted — including an image-interpretation chain that has no vision
 * > fallback configured at all — the result is the `PROVIDERS_UNAVAILABLE` error, whose English
 * > rendering is exactly `Jamee is temporarily busy. Please try again shortly.`
 *
 * **Validates: Requirements 14.4, 14.5, 14.8**
 *
 * =============================================================================
 * WHERE THE STUBS SIT, AND WHY IT IS NOT THE FALLBACK LOOP
 * =============================================================================
 *
 * The two seams stubbed below are the same ones `tests/integration/providers.ts` uses:
 * `GeminiAdapterDeps.create` (standing for `interactions.create`) and `GroqAdapterOptions.create`
 * (standing for `chat.completions.create`). One function per SDK method, and nothing above it.
 *
 * Everything the property is *about* therefore runs for real: request shaping in `gemini.ts` and
 * `groq.ts`, V11 error classification in both adapters, `isFallbackTrigger`, chain order from
 * `chainOrderFor`, the shared-deadline arithmetic, the minimum-remaining spend guard, and the
 * fallback loop in `run()` with its single exit.
 *
 * A `CapabilityRunner` stub — or any stub of `run()` itself — would have been shorter and would
 * have proved nothing here: replacing the loop turns "a rate limit on the primary retries on the
 * fallback" (14.4) and "an exhausted chain is one failed operation" (14.8) into assertions about
 * the stub. So a scripted rate limit below is a *rejection carrying HTTP 429*, which the real
 * adapter classifies and the real gateway acts on. `hadSignal` on every recorded call is the cheap
 * proof that these functions really are sitting underneath the adapters: only the adapters pass the
 * gateway's per-attempt `AbortSignal` down to an SDK call.
 *
 * Nothing here reaches a provider and no API key is read — both adapters resolve their SDK call at
 * invoke time, so an injected `create` means no client is ever constructed.
 *
 * ### WHY THE CLOCK IS INJECTED RATHER THAN THE TIMEOUT RAISED
 *
 * The budget is measured against an absolute instant, not slept on, so a "provider that consumed
 * the whole budget" is modelled by advancing an injected clock inside the seam. No real time
 * passes, every run settles in microseconds, and the abort timer `run()` arms is cleared by its own
 * `finally`.
 */

/* ========================================================================== */
/* What the property is checked against                                        */
/* ========================================================================== */

/**
 * Requirement 14.5 names this sentence exactly, and design's error table repeats it as the `en`
 * rendering of `PROVIDERS_UNAVAILABLE`. Written out here rather than read from the catalog on
 * purpose: reading `messages('en').errors.PROVIDERS_UNAVAILABLE` would compare the catalog with
 * itself and pass no matter what it said.
 */
const BUSY_MESSAGE_EN = 'Jamee is temporarily busy. Please try again shortly.';

/** Epoch ms the request begins. Arbitrary, fixed, and the origin of every budget comparison. */
const START = 1_800_000_000_000;

/**
 * A non-null `VISION_FALLBACK_MODEL`, as a placeholder rather than the real identifier.
 *
 * `chainOrderFor` compares against `null` and reads nothing else, so what the string *says* is
 * irrelevant — and pinning today's Preview model id here would make a config edit look like a
 * behaviour change.
 */
const A_CONFIGURED_VISION_FALLBACK = 'stub/vision-fallback';

/** The capabilities whose exhausted chain resolves to `PROVIDERS_UNAVAILABLE`. */
type BusyCapability = 'vision-classify' | 'text-generate';

/**
 * `transcribe` is out of scope, and by the requirements rather than by convenience: Requirement 8.4
 * gives a failed transcription its own code (`TRANSCRIPTION_FAILED`), so `EXHAUSTED_CHAIN_CODE`
 * maps it elsewhere and Property 21's sentence does not describe it.
 */
const BUSY_CAPABILITIES: readonly BusyCapability[] = ['vision-classify', 'text-generate'];

const PROVIDER_IDS: ProviderId[] = ['gemini', 'groq'];

/* ========================================================================== */
/* The per-provider outcome vocabulary                                         */
/* ========================================================================== */

/**
 * What one chain member does when the gateway reaches it.
 *
 * The five kinds the property has to cover — success, rate limit, transient unavailability, hard
 * rejection, and a call that eats the budget — plus two that exist to keep the dichotomy honest:
 *
 *  - `answersEmpty` — an empty answer is a *successful* provider call, not a third outcome. Both
 *    adapters are explicit that judging content is D2's job, so the gateway must serve `''`.
 *  - `transport` — a rejection carrying no status at all (a reset socket). V11's conservative
 *    default puts it on `OTHER`, so it must stop the chain rather than double the spend.
 */
type Outcome =
  | 'answers'
  | 'answersEmpty'
  | 'rateLimit'
  | 'unavailable'
  | 'unprocessable'
  | 'transport'
  | 'burnsBudget';

const OUTCOMES: readonly Outcome[] = [
  'answers',
  'answersEmpty',
  'rateLimit',
  'unavailable',
  'unprocessable',
  'transport',
  'burnsBudget',
];

/** The two buckets Requirement 14.4 admits as a reason to try the next member. */
const FALLBACK_TRIGGERS: readonly Outcome[] = ['rateLimit', 'unavailable', 'burnsBudget'];

/** Outcomes that serve the request. */
const SERVING: readonly Outcome[] = ['answers', 'answersEmpty'];

/**
 * Failures that leave budget behind, so an exhausted chain reports the busy message rather than the
 * deadline's own `DIAGNOSIS_TIMEOUT` (Requirement 3.7, a separately specified exit).
 */
const FAILS_WITHIN_BUDGET: readonly Outcome[] = [
  'rateLimit',
  'unavailable',
  'unprocessable',
  'transport',
];

/** Distinct per provider, so a served result can be attributed without trusting `provider`. */
const ANSWER: Record<ProviderId, string> = {
  gemini: '{"status":"identified"}',
  groq: '{"status":"unclear"}',
};

/* ========================================================================== */
/* Scripted provider rejections                                                */
/* ========================================================================== */

/**
 * The shape both SDKs reject with: an `Error` subclass carrying a numeric `status` and a `Headers`.
 *
 * Deliberately **not** a `ProviderError`. Handing the adapters a pre-classified failure would skip
 * the one thing worth exercising — V11's per-provider table deciding whether this status is a
 * fallback trigger — and Requirement 14.4 is exactly that decision.
 */
class ScriptedRejection extends Error {
  readonly status: number;
  readonly headers: Headers;

  constructor(status: number, headers: Record<string, string> = {}) {
    super(`jamee property harness: scripted HTTP ${status}`);
    this.name = 'ScriptedRejection';
    this.status = status;
    this.headers = new Headers(headers);
  }
}

/** 429 on both providers' V11 tables. */
const RATE_LIMIT_STATUS = 429;
/** 503 on both tables. Gemini's unavailable list is `[503]` alone; Groq's is `[500, 502, 503]`. */
const UNAVAILABLE_STATUS = 503;
/** 422 is absent from both tables on purpose — V11 documents it as covering model output problems. */
const UNPROCESSABLE_STATUS = 422;

/* ========================================================================== */
/* The seams                                                                   */
/* ========================================================================== */

interface SeamCall {
  readonly provider: ProviderId;
  /** Whether the gateway's per-attempt abort reached the SDK call. See the header. */
  readonly hadSignal: boolean;
}

interface Clock {
  nowMs: number;
}

/** The Groq completion envelope, with the scripted text as its only content. */
function completionOf(content: string): Groq.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-jamee-property',
    created: 1,
    model: 'jamee-property-stub',
    object: 'chat.completion',
    choices: [
      { finish_reason: 'stop', index: 0, logprobs: null, message: { role: 'assistant', content } },
    ],
  };
}

function geminiAnswer(text: string): GeminiInteractionResponse {
  return { output_text: text, status: 'completed' };
}

/**
 * Apply one member's scripted outcome, as the SDK call would.
 *
 * `answer` is the provider-specific success envelope, which is the only thing that differs between
 * the two seams — every failure shape is shared, because both SDKs reject with a status and headers.
 */
async function settleOutcome<T>(
  outcome: Outcome,
  provider: ProviderId,
  clock: Clock,
  answer: (text: string) => T,
): Promise<T> {
  switch (outcome) {
    case 'answers':
      return answer(ANSWER[provider]);
    case 'answersEmpty':
      return answer('');
    case 'rateLimit':
      throw new ScriptedRejection(RATE_LIMIT_STATUS, { 'retry-after': '17' });
    case 'unavailable':
      throw new ScriptedRejection(UNAVAILABLE_STATUS);
    case 'unprocessable':
      throw new ScriptedRejection(UNPROCESSABLE_STATUS);
    case 'transport':
      throw new Error('jamee property harness: the connection closed before any status arrived');
    case 'burnsBudget':
      // A full-budget attempt that then rate-limits: the fallback is a real trigger, and the
      // shared deadline is what refuses it. See "one deadline, not a sum of per-call timeouts".
      clock.nowMs += SOFT_BUDGET_MS;
      throw new ScriptedRejection(RATE_LIMIT_STATUS, { 'retry-after': '30' });
  }
}

/* ========================================================================== */
/* One scenario                                                                */
/* ========================================================================== */

interface Scenario {
  readonly capability: BusyCapability;
  /** `null` is the withdrawal case: the vision chain has no second member at all. */
  readonly visionFallbackModel: string | null;
  /** Which adapters were constructed. An absent one is skipped by `providersFor`, not an error. */
  readonly present: readonly ProviderId[];
  readonly outcomes: Readonly<Record<ProviderId, Outcome>>;
}

interface Harness {
  readonly clock: Clock;
  readonly calls: SeamCall[];
  readonly vision: AdapterSet<VisionCall, string>;
  readonly text: AdapterSet<TextCall, string>;
}

const VISION_INPUT: VisionCall = {
  imageUrl: 'https://storage.invalid/crop-images/farmer/leaf.jpg?token=stub',
  imageMimeType: 'image/jpeg',
  prompt: 'Classify the condition visible on this crop.',
  responseSchema: { type: 'object' } satisfies JsonSchema,
};

const TEXT_INPUT: TextCall = { prompt: 'Rephrase the supplied knowledge base row.' };

/** Keep only the adapters a scenario says were constructed. */
function only<TInput>(
  set: AdapterSet<TInput, string>,
  present: readonly ProviderId[],
): AdapterSet<TInput, string> {
  const kept: AdapterSet<TInput, string> = {};
  for (const id of present) {
    const adapter = set[id];
    if (adapter !== undefined) kept[id] = adapter;
  }
  return kept;
}

function harnessFor(scenario: Scenario): Harness {
  const clock: Clock = { nowMs: START };
  const calls: SeamCall[] = [];

  const geminiCreate: InteractionCreate = (_request, options) => {
    calls.push({ provider: 'gemini', hadSignal: options.signal instanceof AbortSignal });
    return settleOutcome(scenario.outcomes.gemini, 'gemini', clock, geminiAnswer);
  };

  const groqCreate: GroqChatCreate = (_body, options) => {
    calls.push({ provider: 'groq', hadSignal: options.signal instanceof AbortSignal });
    return settleOutcome(scenario.outcomes.groq, 'groq', clock, completionOf);
  };

  const deps: CapabilityDeps = {
    gemini: { create: geminiCreate },
    groq: { create: groqCreate },
    visionFallbackModel: scenario.visionFallbackModel,
  };

  return {
    clock,
    calls,
    vision: only(visionAdapters(deps), scenario.present),
    text: only(textAdapters(deps), scenario.present),
  };
}

function runScenario(scenario: Scenario, harness: Harness): Promise<GatewayResult<string>> {
  const options: RunOptions = {
    now: () => harness.clock.nowMs,
    requestStartMs: START,
    // No platform deadline, so the budget is the 45 s arithmetic and nothing reads `getDeadline()`.
    platformDeadline: () => undefined,
    // Passed for both capabilities: `chainOrderFor` reads it only for vision, and asserting that
    // the text chain is unaffected by it costs nothing here.
    visionFallbackModel: scenario.visionFallbackModel,
  };

  return scenario.capability === 'vision-classify'
    ? run('vision-classify', harness.vision, VISION_INPUT, options)
    : run('text-generate', harness.text, TEXT_INPUT, options);
}

/* ========================================================================== */
/* The expectation, derived from the requirements rather than from run()        */
/* ========================================================================== */

/**
 * The chain the design's fallback matrix specifies, intersected with the adapters that exist.
 *
 * Gemini first for both capabilities; the Groq vision member only while a fallback model is
 * configured. This is where Requirement 14.4's "retried on the fallback" ordering is stated — the
 * primary is position 0 — so a gateway that reordered the chain fails the property rather than
 * agreeing with it.
 */
function expectedChain(scenario: Scenario): ProviderId[] {
  const order: ProviderId[] =
    scenario.capability === 'vision-classify' && scenario.visionFallbackModel === null
      ? ['gemini']
      : ['gemini', 'groq'];
  return order.filter((id) => scenario.present.includes(id));
}

interface Served {
  readonly provider: ProviderId;
  readonly usedFallback: boolean;
  readonly value: string;
}

interface Expectation {
  /** Members reached, in order. Every one of them costs a provider call. */
  readonly attempted: readonly ProviderId[];
  readonly served: Served | undefined;
  /** Whether the shared deadline, rather than the chain, is what refused the request. */
  readonly timedOut: boolean;
}

/**
 * Walk the chain the way Requirements 14.4 and 14.8 describe it, and say what should come out.
 *
 * Four rules, and no fifth:
 *  1. A member is reached only if the budget can still fit its attempt (the spend rule).
 *  2. The first member that answers serves the request; `usedFallback` is "we moved past position 0".
 *  3. A rate limit or an unavailability moves to the next member. Anything else stops the chain —
 *     Requirement 14.4 read strictly, so an unrecognized failure never doubles provider spend.
 *  4. An unserved request is one report: the deadline's timeout when the budget is what refused it,
 *     and otherwise the exhausted-chain code, whatever the chain length was.
 */
function expectation(scenario: Scenario): Expectation {
  const chain = expectedChain(scenario);
  const minimumRemainingMs = ATTEMPT_BUDGETS[scenario.capability].minimumRemainingMs;
  const deadlineMs = START + SOFT_BUDGET_MS;

  let clockMs = START;
  let starved = false;
  const attempted: ProviderId[] = [];

  for (const [index, id] of chain.entries()) {
    if (deadlineMs - clockMs < minimumRemainingMs) {
      starved = true;
      break;
    }
    attempted.push(id);

    const outcome = scenario.outcomes[id];
    if (SERVING.includes(outcome)) {
      return {
        attempted,
        served: {
          provider: id,
          usedFallback: index > 0,
          value: outcome === 'answers' ? ANSWER[id] : '',
        },
        timedOut: false,
      };
    }
    if (outcome === 'burnsBudget') clockMs += SOFT_BUDGET_MS;
    if (!FALLBACK_TRIGGERS.includes(outcome)) break;
  }

  return { attempted, served: undefined, timedOut: starved || clockMs >= deadlineMs };
}

/* ========================================================================== */
/* Settling the gateway into one of the shapes the property allows              */
/* ========================================================================== */

type Settled =
  | { readonly kind: 'served'; readonly result: GatewayResult<string> }
  | { readonly kind: 'reported'; readonly error: AppError }
  /** Anything else: a raw provider rejection, a bare `Error`, a third shape. */
  | { readonly kind: 'escaped'; readonly error: unknown };

async function settle(promise: Promise<GatewayResult<string>>): Promise<Settled> {
  try {
    return { kind: 'served', result: await promise };
  } catch (error) {
    return error instanceof AppError
      ? { kind: 'reported', error }
      : { kind: 'escaped', error };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The busy report, in full: the code, the two flags Requirement 15.4 drives a retry button from,
 * and the exact English sentence Requirement 14.5 names.
 *
 * The message is read through `toEnvelope`, which is the API layer's only rendering path — so this
 * asserts what a farmer receives rather than what the gateway happened to raise.
 */
function expectBusyReport(error: AppError): void {
  expect(error.code).toBe('PROVIDERS_UNAVAILABLE');
  expect(error.status).toBe(503);
  expect(error.retryable).toBe(true);
  expect(toEnvelope(error, 'en').error.message).toBe(BUSY_MESSAGE_EN);
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

const capabilityArb = fc.constantFrom(...BUSY_CAPABILITIES);

const outcomeArb = fc.constantFrom(...OUTCOMES);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  capability: capabilityArb,
  visionFallbackModel: fc.constantFrom<string | null>(A_CONFIGURED_VISION_FALLBACK, null),
  // Order-preserving, and it yields `[]` — the empty-chain case Requirement 14.8 also covers.
  present: fc.subarray(PROVIDER_IDS),
  outcomes: fc.record({ gemini: outcomeArb, groq: outcomeArb }),
});

/* ========================================================================== */
/* Property 21                                                                 */
/* ========================================================================== */

describe('Property 21: the fallback chain either serves the request or reports the busy message', () => {
  /**
   * The dichotomy, over every pattern of per-provider outcomes in every chain shape.
   *
   * **Validates: Requirements 14.4, 14.5, 14.8**
   */
  it('serves the request or leaves through the one report, for any pattern of provider outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const harness = harnessFor(scenario);
        const settled = await settle(runScenario(scenario, harness));
        const expected = expectation(scenario);

        // ── Totality. Never a raw provider rejection, never a third shape, never silence.
        if (settled.kind === 'escaped') {
          throw new Error(
            'the gateway left through a third exit rather than serving the request or reporting ' +
              `it: ${describeError(settled.error)}`,
          );
        }

        // ── Requirement 14.4: the primary is attempted first, and a further member is reached
        //    only after a rate limit or an unavailability. No attempt after the chain stops.
        expect(harness.calls.map((call) => call.provider)).toEqual(expected.attempted);
        // Proof the stubs sit under the real adapters: only an adapter forwards this signal.
        expect(harness.calls.every((call) => call.hadSignal)).toBe(true);

        if (settled.kind === 'served') {
          expect(expected.served).not.toBeUndefined();
          expect({
            provider: settled.result.provider,
            usedFallback: settled.result.usedFallback,
            value: settled.result.value,
          }).toEqual(expected.served);
          return;
        }

        // ── The report half. One exhausted-chain exit, whatever the chain length was.
        expect(expected.served).toBeUndefined();
        if (expected.timedOut) {
          // Requirement 3.7's separately specified exit: the shared deadline refused the request,
          // so it is reported as a timeout rather than as a provider verdict.
          expect(settled.error.code).toBe('DIAGNOSIS_TIMEOUT');
        } else {
          // Requirements 14.5 and 14.8.
          expectBusyReport(settled.error);
        }
      }),
      { numRuns: 500 },
    );
  });

  /**
   * The retry half of Requirement 14.4, on its own: a rate limit or an unavailability on the primary
   * is served by the fallback, and the fallback is recorded as such.
   *
   * **Validates: Requirement 14.4**
   */
  it('retries on the fallback provider when the primary rate-limits or is unavailable', async () => {
    await fc.assert(
      fc.asyncProperty(
        capabilityArb,
        fc.constantFrom<Outcome>('rateLimit', 'unavailable'),
        fc.constantFrom(...SERVING),
        async (capability, primaryFailure, fallbackAnswer) => {
          const scenario: Scenario = {
            capability,
            visionFallbackModel: A_CONFIGURED_VISION_FALLBACK,
            present: PROVIDER_IDS,
            outcomes: { gemini: primaryFailure, groq: fallbackAnswer },
          };
          const harness = harnessFor(scenario);
          const settled = await settle(runScenario(scenario, harness));

          expect(settled.kind).toBe('served');
          if (settled.kind !== 'served') return;
          expect(settled.result.provider).toBe('groq');
          expect(settled.result.usedFallback).toBe(true);
          expect(harness.calls.map((call) => call.provider)).toEqual(['gemini', 'groq']);
        },
      ),
    );
  });

  /**
   * A hard rejection is not a fallback trigger, so the chain stops and the busy report is the one a
   * farmer gets — with the fallback's provider allowance untouched.
   *
   * **Validates: Requirements 14.4, 14.5**
   */
  it('stops the chain on a failure that is neither a rate limit nor an unavailability', async () => {
    await fc.assert(
      fc.asyncProperty(
        capabilityArb,
        fc.constantFrom<Outcome>('unprocessable', 'transport'),
        outcomeArb,
        async (capability, primaryFailure, fallbackOutcome) => {
          const scenario: Scenario = {
            capability,
            visionFallbackModel: A_CONFIGURED_VISION_FALLBACK,
            present: PROVIDER_IDS,
            outcomes: { gemini: primaryFailure, groq: fallbackOutcome },
          };
          const harness = harnessFor(scenario);
          const settled = await settle(runScenario(scenario, harness));

          expect(settled.kind).toBe('reported');
          if (settled.kind !== 'reported') return;
          expectBusyReport(settled.error);
          // The fallback was never asked, whatever it would have answered.
          expect(harness.calls.map((call) => call.provider)).toEqual(['gemini']);
        },
      ),
    );
  });

  /**
   * Requirement 14.8, as the indistinguishability claim the design rests on: a vision chain with no
   * fallback member configured at all and a vision chain whose fallback also failed leave through
   * the same exit, with the same code and the same sentence.
   *
   * **Validates: Requirement 14.8**
   */
  it('reports the same busy message whether the vision chain has no fallback or a failed one', async () => {
    const failureArb = fc.constantFrom(...FAILS_WITHIN_BUDGET);

    await fc.assert(
      fc.asyncProperty(failureArb, failureArb, async (primaryFailure, fallbackFailure) => {
        const outcomes = { gemini: primaryFailure, groq: fallbackFailure };
        const withdrawn: Scenario = {
          capability: 'vision-classify',
          visionFallbackModel: null,
          present: PROVIDER_IDS,
          outcomes,
        };
        const configured: Scenario = {
          ...withdrawn,
          visionFallbackModel: A_CONFIGURED_VISION_FALLBACK,
        };

        const withdrawnHarness = harnessFor(withdrawn);
        const withdrawnSettled = await settle(runScenario(withdrawn, withdrawnHarness));
        const configuredHarness = harnessFor(configured);
        const configuredSettled = await settle(runScenario(configured, configuredHarness));

        expect(withdrawnSettled.kind).toBe('reported');
        expect(configuredSettled.kind).toBe('reported');
        if (withdrawnSettled.kind !== 'reported' || configuredSettled.kind !== 'reported') return;

        expectBusyReport(withdrawnSettled.error);
        expectBusyReport(configuredSettled.error);
        expect(withdrawnSettled.error.code).toBe(configuredSettled.error.code);
        expect(toEnvelope(withdrawnSettled.error, 'en')).toEqual(
          toEnvelope(configuredSettled.error, 'en'),
        );

        // The observable difference is spend, not the report: a withdrawn fallback is never called.
        expect(withdrawnHarness.calls.map((call) => call.provider)).toEqual(['gemini']);
        expect(configuredHarness.calls.map((call) => call.provider)).toEqual(
          FALLBACK_TRIGGERS.includes(primaryFailure) ? ['gemini', 'groq'] : ['gemini'],
        );
      }),
    );
  });

  /**
   * A chain with no member at all reaches the same report without issuing a single provider call.
   *
   * **Validates: Requirements 14.5, 14.8**
   */
  it('reports the busy message, and calls nothing, when the chain has no member', async () => {
    await fc.assert(
      fc.asyncProperty(capabilityArb, outcomeArb, async (capability, unusedOutcome) => {
        const scenario: Scenario = {
          capability,
          visionFallbackModel: null,
          present: [],
          outcomes: { gemini: unusedOutcome, groq: unusedOutcome },
        };
        const harness = harnessFor(scenario);
        const settled = await settle(runScenario(scenario, harness));

        expect(settled.kind).toBe('reported');
        if (settled.kind !== 'reported') return;
        expectBusyReport(settled.error);
        expect(harness.calls).toEqual([]);
      }),
    );
  });
});
