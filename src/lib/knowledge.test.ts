import { describe, expect, it } from 'vitest';

import {
  hasTreatmentContent,
  knowledgePayloadOf,
  lookupCondition,
  matchConditions,
  resolveScope,
  type KnowledgeEntry,
  type KnowledgeReader,
} from '@/lib/knowledge';
import { VERIFIED_CONDITIONS, type VerifiedCondition } from '@/lib/schemas';

/**
 * Unit tests for `src/lib/knowledge.ts` with the database access stubbed at the `KnowledgeReader`
 * seam — a plain function, so nothing here reproduces a PostgREST builder chain or casts its way
 * past a client type.
 *
 * Requirements: 4.1, 4.3, 4.7, 7.6, 3.4
 *
 * `knowledgeReaderFrom()` is deliberately not exercised here: it is the one place a real Supabase
 * client is touched, its correctness is a question about a live database rather than about logic,
 * and the integration project (task 29.1) seeds real rows to answer it. What IS asserted here is
 * everything that decides a farmer-visible outcome — the lookup contract, the healthy-versus-miss
 * distinction, and the scope decision that gates whether a model is called at all.
 */

/* ========================================================================== */
/* Fixtures — the shape and semantics of the seeded rows (0010), trimmed        */
/* ========================================================================== */

function row(
  disease_name: VerifiedCondition,
  overrides: Partial<KnowledgeEntry> = {},
): KnowledgeEntry {
  return {
    id: `id-${disease_name}`,
    disease_name,
    crop: disease_name.startsWith('Tomato') ? 'tomato' : 'potato',
    scientific_name: 'Alternaria solani',
    symptoms: ['a symptom'],
    causes: ['a cause'],
    treatment: ['a treatment'],
    prevention: ['a prevention'],
    default_severity: 'moderate',
    source: 'Some Extension Service, "A Publication", https://example.invalid',
    created_at: '2026-09-15T00:00:00.000Z',
    updated_at: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

const TOMATO_LATE_BLIGHT = row('Tomato Late Blight', {
  scientific_name: 'Phytophthora infestans',
  symptoms: ['Large greasy grey-green to brown patches on leaves', 'White fuzzy growth beneath'],
  causes: ['Oomycete infection by Phytophthora infestans', 'Cool, wet, humid weather'],
  treatment: ['Remove and destroy infected plants immediately', 'Apply a labelled fungicide'],
  prevention: ['Plant resistant varieties where available'],
  default_severity: 'high',
  source: 'Virginia Cooperative Extension, ANR-6, "Late Blight of Tomato and Potato"',
});

/**
 * The row whose `treatment` array is empty by seed AND by the `healthy_has_no_treatment` check
 * constraint in 0004 (Requirement 3.4). `scientific_name` is null for the same row.
 */
const TOMATO_HEALTHY = row('Tomato Healthy', {
  scientific_name: null,
  symptoms: ['Uniform green leaves with no spots, lesions, or wilting'],
  causes: ['No disease detected in the submitted photo'],
  treatment: [],
  prevention: ['Continue regular monitoring of lower leaves'],
  default_severity: 'none',
});

const ALL_ROWS: readonly KnowledgeEntry[] = VERIFIED_CONDITIONS.map((name) => {
  if (name === 'Tomato Late Blight') return TOMATO_LATE_BLIGHT;
  if (name === 'Tomato Healthy') return TOMATO_HEALTHY;
  return row(name);
});

/** A reader over a fixed row set, answering in an order the caller did not ask for. */
function readerOver(rows: readonly KnowledgeEntry[]): KnowledgeReader {
  return (names) =>
    Promise.resolve([...rows].reverse().filter((r) => names.includes(r.disease_name)));
}

/** A reader that fails the test if it is called at all. */
const unreachableReader: KnowledgeReader = () => {
  throw new Error('the knowledge base was read; an out-of-scope question must not reach it');
};

/* ========================================================================== */
/* lookupCondition                                                             */
/* ========================================================================== */

describe('lookupCondition', () => {
  it('returns the row content for a known canonical name', async () => {
    const result = await lookupCondition('Tomato Late Blight', readerOver(ALL_ROWS));

    expect(result.found).toBe(true);
    if (!result.found) return;

    expect(result.entry.symptoms).toEqual(TOMATO_LATE_BLIGHT.symptoms);
    expect(result.entry.causes).toEqual(TOMATO_LATE_BLIGHT.causes);
    expect(result.entry.treatment).toEqual(TOMATO_LATE_BLIGHT.treatment);
    expect(result.entry.prevention).toEqual(TOMATO_LATE_BLIGHT.prevention);
    expect(result.entry.source).toBe(TOMATO_LATE_BLIGHT.source);
    expect(result.entry.scientific_name).toBe('Phytophthora infestans');
    expect(result.entry.default_severity).toBe('high');
  });

  it('reports a miss rather than throwing when the row is absent', async () => {
    const withoutHealthy = ALL_ROWS.filter((r) => r.disease_name !== 'Tomato Healthy');

    expect(await lookupCondition('Tomato Healthy', readerOver(withoutHealthy))).toEqual({
      found: false,
    });
  });

  it('reports a miss for a name outside the five verified conditions', async () => {
    // Unreachable through the type system — `visionVerifiedSchema` is the gate, and this parameter
    // is a `VerifiedCondition`. The cast pins the runtime behaviour anyway, because the SQL check
    // constraint means no such row can exist even if a caller found a way past the type.
    const outside = 'Wheat Rust' as VerifiedCondition;

    expect(await lookupCondition(outside, readerOver(ALL_ROWS))).toEqual({ found: false });
  });

  it('distinguishes "healthy, so no treatment" from a failed lookup', async () => {
    const healthy = await lookupCondition('Tomato Healthy', readerOver(ALL_ROWS));

    // The distinction the whole union exists for: found is true, and the empty array is content.
    expect(healthy.found).toBe(true);
    if (!healthy.found) return;

    expect(healthy.entry.treatment).toEqual([]);
    expect(hasTreatmentContent(healthy.entry)).toBe(false);
    // Still a real row: symptoms, prevention and a citation are all present.
    expect(healthy.entry.symptoms.length).toBeGreaterThan(0);
    expect(healthy.entry.prevention.length).toBeGreaterThan(0);
    expect(healthy.entry.source).not.toBe('');

    const miss = await lookupCondition(
      'Tomato Healthy',
      readerOver(ALL_ROWS.filter((r) => r.disease_name !== 'Tomato Healthy')),
    );
    expect(miss.found).toBe(false);
    expect(healthy).not.toEqual(miss);
  });
});

describe('knowledgePayloadOf', () => {
  it('copies the five verified fields verbatim and nothing else', () => {
    expect(knowledgePayloadOf(TOMATO_LATE_BLIGHT)).toEqual({
      symptoms: TOMATO_LATE_BLIGHT.symptoms,
      causes: TOMATO_LATE_BLIGHT.causes,
      treatment: TOMATO_LATE_BLIGHT.treatment,
      prevention: TOMATO_LATE_BLIGHT.prevention,
      source: TOMATO_LATE_BLIGHT.source,
    });
  });

  it('carries the empty treatment array through for the healthy row', () => {
    expect(knowledgePayloadOf(TOMATO_HEALTHY).treatment).toEqual([]);
  });
});

/* ========================================================================== */
/* matchConditions — the pure half of the scope decision                        */
/* ========================================================================== */

describe('matchConditions', () => {
  it('narrows to one condition when the question names crop and qualifier', () => {
    expect(matchConditions('my tomato plant has late blight, what do I do?')).toEqual([
      'Tomato Late Blight',
    ]);
  });

  it('returns every condition of a crop when only the crop is named', () => {
    expect(matchConditions('there are spots on my potato leaves')).toEqual([
      'Potato Early Blight',
      'Potato Late Blight',
    ]);
  });

  it('spans both crops when only the qualifier is named', () => {
    expect(matchConditions('what is late blight?')).toEqual([
      'Tomato Late Blight',
      'Potato Late Blight',
    ]);
  });

  it('falls back to every blight row for a bare qualifier word', () => {
    expect(matchConditions('is this blight?')).toEqual([
      'Tomato Early Blight',
      'Tomato Late Blight',
      'Potato Early Blight',
      'Potato Late Blight',
    ]);
  });

  it('treats a plural as the same word', () => {
    expect(matchConditions('my tomatoes look bad')).toEqual(matchConditions('my tomato looks bad'));
  });

  it('matches nothing for a crop Jamee does not cover', () => {
    expect(matchConditions('my wheat has rust')).toEqual([]);
  });

  it('matches nothing for a subject-less follow-up', () => {
    expect(matchConditions('why?')).toEqual([]);
    expect(matchConditions('how much should I use?')).toEqual([]);
  });
});

/* ========================================================================== */
/* resolveScope                                                                */
/* ========================================================================== */

describe('resolveScope', () => {
  it('grounds a question in the matching rows, in canonical order', async () => {
    const scope = await resolveScope({ question: 'what is late blight?' }, readerOver(ALL_ROWS));

    expect(scope.kind).toBe('grounded');
    expect(scope.conditions).toEqual(['Tomato Late Blight', 'Potato Late Blight']);
    expect(scope.entries.map((e) => e.disease_name)).toEqual([
      'Tomato Late Blight',
      'Potato Late Blight',
    ]);
  });

  it('resolves a subject-less follow-up against the conversation condition', async () => {
    const scope = await resolveScope(
      { condition: 'Tomato Early Blight', question: 'why?' },
      readerOver(ALL_ROWS),
    );

    expect(scope.kind).toBe('grounded');
    expect(scope.conditions).toEqual(['Tomato Early Blight']);
  });

  it('treats a null condition the same as an absent one', async () => {
    const scope = await resolveScope(
      { condition: null, question: 'my tomato has early blight' },
      readerOver(ALL_ROWS),
    );

    expect(scope.conditions).toEqual(['Tomato Early Blight']);
  });

  it('reports a referral, with an empty set the caller can detect, for an out-of-scope question', async () => {
    const scope = await resolveScope({ question: 'my wheat has rust' }, unreachableReader);

    // The contract the design depends on: detectable without a model call AND without a read.
    expect(scope.kind).toBe('referral');
    expect(scope.entries).toEqual([]);
    expect(scope.conditions).toEqual([]);
    if (scope.kind === 'referral') expect(scope.reason).toBe('out_of_scope');
  });

  it('reports a referral for a subject-less question with no established diagnosis', async () => {
    const scope = await resolveScope({ question: 'why?' }, unreachableReader);

    expect(scope.kind).toBe('referral');
    expect(scope.entries).toEqual([]);
  });

  it('reports a referral when a matched condition has no row in the base', async () => {
    const scope = await resolveScope(
      { condition: 'Tomato Late Blight' },
      readerOver(ALL_ROWS.filter((r) => r.disease_name !== 'Tomato Late Blight')),
    );

    expect(scope.kind).toBe('referral');
    if (scope.kind === 'referral') expect(scope.reason).toBe('no_verified_content');
  });

  it('grounds the healthy row without inventing treatment content', async () => {
    const scope = await resolveScope({ condition: 'Tomato Healthy' }, readerOver(ALL_ROWS));

    expect(scope.kind).toBe('grounded');
    if (scope.kind !== 'grounded') return;
    expect(scope.entries[0].treatment).toEqual([]);
    expect(scope.entries[0].source).not.toBe('');
  });
});
