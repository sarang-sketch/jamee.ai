import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { STORAGE_BUCKETS, STORAGE_OWNER_PATH_SEGMENT_INDEX } from '@/lib/config/verified';
import { isAppError, type AppError } from '@/lib/errors';
import { knowledgeReaderFrom } from '@/lib/knowledge';
import { STORAGE_PATH_REGEX, VERIFIED_CONDITIONS, type Channel, type VerifiedCondition } from '@/lib/schemas';
import { assertOwnershipInBucket, ownerSegmentOf, type StorageClientLike } from '@/lib/storage';
import { WHATSAPP_PROFILE_SELECT, adminProfileByPhoneStore } from '@/lib/whatsapp-dispatch';
import { conversationStoreFrom } from '@/services/conversation.service';
import type { Database } from '@/types/database';

import { FARMER_SCOPED_TABLES, TENANT_FREE_TABLES } from '../../scripts/check-secret-scope';

/**
 * ### Property 27: Tenant isolation holds across tables, storage, and the knowledge base
 *
 * *"For any two distinct farmers, every attempt by one to read or write the other's rows in
 * `profiles`, `conversations`, `messages`, `diagnoses`, or `usage_logs` returns no rows or fails, and
 * every attempt to read or write an object under the other's storage path prefix in either private
 * bucket is denied; and for any authenticated farmer, reads of `disease_knowledge` succeed while
 * every insert, update, and delete is denied."*
 *
 * **Validates: Requirements 13.2, 13.4, 13.6**
 *
 * =============================================================================
 * READ THIS FIRST: WHICH HALF OF THE CLAIM IS HERE, AND WHICH HALF IS NOT
 * =============================================================================
 *
 * **The mechanism this property is about is row-level security, which is a Postgres behaviour, and a
 * Node property test cannot exercise a Postgres policy.** Saying that plainly is the first
 * deliverable of this file. What is emphatically *not* done below is the obvious fake: an in-memory
 * table that filters by `user_id` and a green test that "proves" isolation. Such a test asserts the
 * stub. It would pass with every policy dropped from every migration, which makes it worse than no
 * test at all — it would be a false negative wearing a requirement number.
 *
 * So the claim is split, and each half is asserted where it is decidable:
 *
 * **HERE, at unit level, and all of it real:**
 *
 *  1. **The policies exist in the migrations with the shape the requirements describe.** The
 *     `create policy` statements are extracted from `supabase/migrations/*.sql` and their predicate
 *     text is *interpreted* — not pattern-matched — over generated farmer pairs, under Postgres's
 *     three-valued logic. A policy whose predicate stopped being own-row, a policy added for `anon`,
 *     a table that lost `enable row level security`, or a write policy appearing on
 *     `disease_knowledge` all fail here. This is the same technique `tests/unit/api-docs.test.ts`
 *     uses to bind `docs/API.md` to the schemas, applied to SQL.
 *  2. **The application-side ownership gate refuses cross-tenant references**, in both private
 *     buckets and in both directions, through the real `assertOwnershipInBucket()`.
 *  3. **The queries the application composes carry their scoping predicate, with the caller's own
 *     value in it.** The real store adapters run against a recording client, so the predicates are
 *     production's rather than this file's.
 *
 * **NOT HERE — deferred to the integration project, which runs against real Postgres and is gated
 * behind `JAMEE_TEST_DATABASE_URL` (`tests/integration/database.ts`):** that Postgres *applies*
 * those predicates to every statement — i.e. that farmer B's client really does read zero rows of
 * farmer A's, that an insert claiming another owner really is rejected, and that the storage policies
 * really deny an object under another prefix. `tests/integration/harness.test.ts` makes exactly those
 * assertions today with two real sessions (`profiles`, `diagnoses` read and insert, `usage_logs`),
 * and `tests/integration/release-acceptance.test.ts` drives the end-to-end run on the same harness
 * whose header records that two farmers exist *because* "tenant isolation is the assertion a unit
 * test cannot make". The storage-object half of Requirement 13.6 is acceptance ground for
 * deployment step 8 rather than a unit claim.
 *
 * A narrow honest test plus a named boundary is the deliverable. A green test that overclaimed would
 * not be.
 *
 * =============================================================================
 * THE KNOWLEDGE BASE'S ISOLATION CLAIM IS A DIFFERENT KIND OF CLAIM
 * =============================================================================
 *
 * The third clause of the property is not partitioning, and it would be wrong to read it as such.
 * `disease_knowledge` is **shared read-only reference data**: it holds the five human-verified
 * entries, has **no owner column at all**, and Requirement 13.3 grants every authenticated farmer an
 * unconditional read of the whole table. There is no tenant dimension to isolate along, so "farmer A
 * cannot see farmer B's knowledge rows" is not a meaningful statement — every farmer sees the same
 * five rows, by design, and that is what grounds every diagnosis.
 *
 * What *is* isolated is the other direction: **no farmer can change what any other farmer reads.**
 * Requirement 13.4 restricts writes to migrations run with the service-role key, and the mechanism is
 * the *absence* of any insert, update or delete policy combined with RLS being enabled — `0004`'s own
 * comment says so and warns against "fixing" the gap. So the assertions for this surface are:
 *
 *  - the table has no owner column, and is deliberately absent from
 *    `check-secret-scope.ts`'s `FARMER_SCOPED_TABLES` and named in its `TENANT_FREE_TABLES`;
 *  - its one policy is a `select` for `authenticated` with an unconditional predicate;
 *  - no policy admits an insert, update or delete, for any role, so every farmer's write is denied;
 *  - the statement `knowledge.ts` composes carries **no** tenant predicate — correctly, and the
 *    absence is asserted rather than assumed — and that module contains no write verb at all.
 *
 * =============================================================================
 * WHAT THE SQL INTERPRETER DOES, AND WHERE IT REFUSES TO GUESS
 * =============================================================================
 *
 * `evaluate()` below understands exactly the predicate forms Jamee's migrations use — `auth.uid() =
 * id`, `auth.uid() = user_id`, `true`, and the storage conjunction `bucket_id = '…' and
 * (storage.foldername(name))[1] = auth.uid()::text` — and **throws on anything else**. That is the
 * point: a new policy written in a form this file cannot evaluate fails the run rather than being
 * silently treated as safe.
 *
 * Two Postgres behaviours are modelled because the migrations' own comments turn on them:
 *
 *  - **Three-valued logic.** `auth.uid()` is NULL for an anonymous request, so `auth.uid() = id`
 *    evaluates to NULL — *not* false — and a row is visible only when a permissive policy evaluates
 *    to **true**. `0002`'s comment states exactly this, and `evaluate()` returns `'unknown'` rather
 *    than collapsing it into `false` so the distinction stays visible in a failure message.
 *  - **`storage.foldername(name)` returns the object's *folders*, and Postgres arrays are 1-indexed**
 *    (V4). So `[1]` is the first folder — NULL for a bucket-root object, which denies. Modelled as
 *    `name.split('/')` minus the file name rather than as a plain first-segment split, because the
 *    difference *is* the bucket-root case and that case is generated below.
 */

/* ========================================================================== */
/* Reading the migrations                                                      */
/* ========================================================================== */

const REPO_ROOT = resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

/** Every migration, in the order Postgres would apply them. */
function migrationFiles(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * `--` line comments replaced by nothing.
 *
 * Necessary rather than tidy: these migrations carry more prose than SQL, `0009`'s comments discuss
 * `for all` policies it deliberately does **not** create, and `0004`'s discuss the write policies
 * whose absence is the mechanism. A scan over raw text would read those sentences as statements.
 */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Whitespace collapsed, so a predicate spanning three indented lines is one comparable string. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The balanced parenthesis group that starts at `open`, exclusive of the outer parens.
 *
 * A regex cannot do this: `using (bucket_id = 'crop-images' and (storage.foldername(name))[1] = …)`
 * nests two levels deep, and a non-greedy `\((.*?)\)` would stop at the first `)` and hand back a
 * truncated predicate — which would then be *interpreted*, silently, as something else.
 */
function balancedGroup(sql: string, open: number): { body: string; end: number } {
  let depth = 0;
  let inQuote = false;
  for (let i = open; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") inQuote = !inQuote;
    if (inQuote) continue;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return { body: sql.slice(open + 1, i), end: i + 1 };
    }
  }
  throw new Error(`unbalanced parentheses in a migration statement at offset ${open}`);
}

type Verb = 'select' | 'insert' | 'update' | 'delete';

const VERBS: readonly Verb[] = ['select', 'insert', 'update', 'delete'];

interface Policy {
  readonly file: string;
  readonly name: string;
  /** Schema-qualified, as written: `public.profiles`, `storage.objects`. */
  readonly table: string;
  /** The bare table name. */
  readonly relation: string;
  /** One of the four verbs, or `all`. */
  readonly verb: Verb | 'all';
  /** The `to` clause's roles. **Empty means PUBLIC** — the policy applies to every role. */
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
}

const POLICY_HEAD =
  /^create policy (\S+) on (\S+) for (select|insert|update|delete|all)(?: to ([a-z_, ]+?))?(?= using| with check|$)/i;

/**
 * Every `create policy` statement in the migrations, parsed.
 *
 * Split on `;` after comment removal. That is safe for this repository and would not be in general:
 * `0002` contains a `$$ … $$` function body, so the split is applied to statements and the two
 * `create policy` shapes are matched by an anchored pattern — a body fragment cannot match it.
 */
function policiesInMigrations(): readonly Policy[] {
  const found: Policy[] = [];

  for (const file of migrationFiles()) {
    const sql = withoutComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));

    for (const raw of sql.split(';')) {
      const statement = oneLine(raw);
      if (!/^create policy /i.test(statement)) continue;

      const head = POLICY_HEAD.exec(statement);
      if (head === null) {
        throw new Error(`${file}: a create policy statement was not parseable: ${statement}`);
      }

      const [, name = '', table = '', verbWord = '', roleList] = head;
      const usingAt = statement.toLowerCase().indexOf(' using (');
      const checkAt = statement.toLowerCase().indexOf(' with check (');

      found.push({
        file,
        name,
        table,
        relation: table.includes('.') ? (table.split('.')[1] ?? table) : table,
        verb: verbWord.toLowerCase() as Verb | 'all',
        roles:
          roleList === undefined
            ? []
            : roleList
                .split(',')
                .map((role) => role.trim())
                .filter((role) => role.length > 0),
        using: usingAt < 0 ? null : oneLine(balancedGroup(statement, usingAt + ' using '.length).body),
        withCheck:
          checkAt < 0 ? null : oneLine(balancedGroup(statement, checkAt + ' with check '.length).body),
      });
    }
  }

  return found;
}

/** Every relation the migrations turn RLS on for. */
function rlsEnabledRelations(): ReadonlySet<string> {
  const enabled = new Set<string>();
  for (const file of migrationFiles()) {
    const sql = withoutComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    for (const match of sql.matchAll(
      /alter\s+table\s+(\S+)\s+enable\s+row\s+level\s+security/gi,
    )) {
      const table = match[1] ?? '';
      enabled.add(table.includes('.') ? (table.split('.')[1] ?? table) : table);
    }
  }
  return enabled;
}

/** The column names of one `create table public.<name> ( … )`, for the owner-column assertion. */
function columnNamesOf(relation: string): readonly string[] {
  for (const file of migrationFiles()) {
    const sql = withoutComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    const at = sql.search(new RegExp(`create\\s+table\\s+public\\.${relation}\\s*\\(`, 'i'));
    if (at < 0) continue;

    const open = sql.indexOf('(', at);
    const body = balancedGroup(sql, open).body;
    return body
      .split('\n')
      .map((line) => oneLine(line))
      .filter((line) => line.length > 0 && !/^(constraint|primary key|unique|check|foreign key)\b/i.test(line))
      .map((line) => line.split(/[\s(]/)[0] ?? '')
      .filter((name) => name.length > 0);
  }
  throw new Error(`no create table statement for public.${relation} in supabase/migrations`);
}

const POLICIES = policiesInMigrations();
const RLS_ENABLED = rlsEnabledRelations();

function policiesFor(relation: string): readonly Policy[] {
  return POLICIES.filter((policy) => policy.relation === relation);
}

/* ========================================================================== */
/* The interpreter                                                             */
/* ========================================================================== */

/** Postgres's three-valued logic. A row is admitted only on `true`. */
type Truth = true | false | 'unknown';

type Role = 'authenticated' | 'anon';

interface Env {
  /** `auth.uid()`. `null` for an anonymous request. */
  readonly authUid: string | null;
  /** The columns a predicate may name, including storage's `bucket_id` and `name`. */
  readonly columns: Readonly<Record<string, string | null>>;
}

/**
 * `storage.foldername(name)[1]`, per V4: the object's **folders** as a 1-indexed array, so `[1]` is
 * the first folder and a bucket-root object yields NULL.
 */
function firstFolderOf(name: string | null): string | null {
  if (name === null) return null;
  const folders = name.split('/').slice(0, -1);
  return folders.length === 0 ? null : (folders[0] ?? null);
}

/** One side of a comparison, resolved to a string or SQL NULL. Unknown forms throw. */
function termOf(term: string, env: Env): string | null {
  const text = term.trim();

  if (text === 'auth.uid()' || text === 'auth.uid()::text') return env.authUid;
  if (text === '(storage.foldername(name))[1]') return firstFolderOf(env.columns.name ?? null);
  if (/^'[^']*'$/.test(text)) return text.slice(1, -1);
  if (/^[a-z_][a-z0-9_]*$/i.test(text)) {
    if (!(text in env.columns)) {
      throw new Error(
        `a policy predicate names the column "${text}", which this interpreter was not given a ` +
          'value for. Add it to the generated row rather than widening the interpreter.',
      );
    }
    return env.columns[text] ?? null;
  }

  throw new Error(
    `a policy predicate contains the term "${text}", which this interpreter cannot evaluate. ` +
      'Extend evaluate() deliberately — do not let an unrecognized predicate pass as safe.',
  );
}

/** `=` under three-valued logic: NULL on either side is unknown, never false. */
function equals(left: string | null, right: string | null): Truth {
  if (left === null || right === null) return 'unknown';
  return left === right;
}

function and(left: Truth, right: Truth): Truth {
  if (left === false || right === false) return false;
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  return true;
}

/**
 * A policy expression, evaluated. `null` — an absent `using` or `with check` — is `true`, which is
 * Postgres's own default for the clause a verb does not carry.
 */
function evaluate(expression: string | null, env: Env): Truth {
  if (expression === null) return true;
  const text = expression.trim();
  if (text === 'true') return true;
  if (text === 'false') return false;

  return text
    .split(/\s+and\s+/i)
    .map((conjunct) => {
      const sides = conjunct.split('=');
      if (sides.length !== 2) {
        throw new Error(
          `a policy predicate conjunct is not a single comparison: "${conjunct}". ` +
            'Extend evaluate() deliberately.',
        );
      }
      return equals(termOf(sides[0] ?? '', env), termOf(sides[1] ?? '', env));
    })
    .reduce<Truth>((accumulated, next) => and(accumulated, next), true);
}

/** Whether this policy is one Postgres would consult for this role and verb. */
function applies(policy: Policy, verb: Verb, role: Role): boolean {
  const verbMatches = policy.verb === 'all' || policy.verb === verb;
  const roleMatches = policy.roles.length === 0 || policy.roles.includes(role);
  return verbMatches && roleMatches;
}

/**
 * Whether this policy admits the operation.
 *
 * `select` and `delete` are decided by `using`; `insert` by `with check`; `update` needs both — the
 * old row must be visible and the new row must satisfy the check.
 */
function admits(policy: Policy, verb: Verb, env: Env): Truth {
  switch (verb) {
    case 'select':
    case 'delete':
      return evaluate(policy.using, env);
    case 'insert':
      return evaluate(policy.withCheck, env);
    case 'update':
      return and(evaluate(policy.using, env), evaluate(policy.withCheck, env));
  }
}

/** RLS is permissive-by-policy: the operation happens only if some consulted policy says `true`. */
function permitted(relation: string, verb: Verb, env: Env, role: Role): boolean {
  return policiesFor(relation)
    .filter((policy) => applies(policy, verb, role))
    .some((policy) => admits(policy, verb, env) === true);
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

/** `auth.users.id` is a uuid, so this is the value space `auth.uid()` really compares. */
const farmerIdArb = fc.uuid();

/** Two *distinct* farmers. Without the filter, "the other farmer's row" would sometimes be one's own. */
const twoFarmersArb = fc.tuple(farmerIdArb, farmerIdArb).filter(([a, b]) => a !== b);

const verbArb = fc.constantFrom<Verb>(...VERBS);
const roleArb = fc.constantFrom<Role>('authenticated', 'anon');

/** The five tables Property 27 names. */
const ISOLATED_TABLES = [
  'profiles',
  'conversations',
  'messages',
  'diagnoses',
  'usage_logs',
] as const;

type IsolatedTable = (typeof ISOLATED_TABLES)[number];

const isolatedTableArb = fc.constantFrom<IsolatedTable>(...ISOLATED_TABLES);

/**
 * The owner column of each table, taken from `check-secret-scope.ts`'s `FARMER_SCOPED_TABLES` rather
 * than written out here, so the two gates cannot disagree about what "belongs to a farmer" means.
 * `profiles` is the special case the script already records: its **primary key** is the auth user id.
 */
function ownerColumnOf(table: IsolatedTable): string {
  return table === 'profiles' ? 'id' : 'user_id';
}

/** Every column a policy on these tables could name, with this row's owner in it. */
function rowOwnedBy(table: IsolatedTable, owner: string): Readonly<Record<string, string | null>> {
  return { [ownerColumnOf(table)]: owner };
}

const bucketArb = fc.constantFrom(STORAGE_BUCKETS.cropImages, STORAGE_BUCKETS.voiceMessages);
const yearArb = fc.integer({ min: 2024, max: 2099 }).map(String);
const monthArb = fc.integer({ min: 1, max: 12 }).map((month) => String(month).padStart(2, '0'));
const extensionArb = fc.constantFrom('jpg', 'jpeg', 'png', 'webp');

interface PathParts {
  readonly year: string;
  readonly month: string;
  readonly objectId: string;
  readonly extension: string;
}

const pathPartsArb = fc.record({
  year: yearArb,
  month: monthArb,
  objectId: fc.uuid(),
  extension: extensionArb,
});

/** `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` — the one convention `buildStorageRef()` emits. */
function conformingPath(owner: string, parts: PathParts): string {
  return `${owner}/${parts.year}/${parts.month}/${parts.objectId}.${parts.extension}`;
}

/* ========================================================================== */
/* Surface 1 — the five farmer-scoped tables                                   */
/* ========================================================================== */

describe('Property 27, surface 1: the five farmer-scoped tables are own-row by policy', () => {
  it('enables RLS on every one of them, and lists each in the static anchor gate', () => {
    for (const table of ISOLATED_TABLES) {
      expect(RLS_ENABLED.has(table), `Requirement 13.1: RLS is not enabled on ${table}`).toBe(true);
      expect(
        Object.keys(FARMER_SCOPED_TABLES),
        `${table} is not a farmer-scoped table in check-secret-scope.ts`,
      ).toContain(table);
      expect(
        FARMER_SCOPED_TABLES[table],
        `${table}'s anchor columns do not include ${ownerColumnOf(table)}`,
      ).toContain(ownerColumnOf(table));
    }
  });

  it('admits an operation only for the row’s own farmer, and never for the other or for anon', () => {
    /** `table:verb`, so the run can prove it reached all twenty combinations. */
    const combinationsSeen = new Set<string>();
    /** Which mechanism denied the other farmer: a scoped policy, or no policy at all. */
    const mechanismsSeen = new Set<'policy_predicate' | 'no_policy_for_verb'>();
    const rolesSeen = new Set<Role>();

    fc.assert(
      fc.property(
        isolatedTableArb,
        verbArb,
        twoFarmersArb,
        roleArb,
        (table, verb, farmers, role) => {
          const [caller, other] = farmers;
          combinationsSeen.add(`${table}:${verb}`);
          rolesSeen.add(role);

          const consulted = policiesFor(table).filter((policy) => applies(policy, verb, role));
          mechanismsSeen.add(consulted.length === 0 ? 'no_policy_for_verb' : 'policy_predicate');

          const label = `${table}.${verb} as ${role}`;

          /**
           * `auth.uid()` for this role. An anonymous request has **no** uid — pairing the `anon`
           * role with a uid would describe a request that cannot exist, and the five tables' policies
           * carry no `to` clause (they are PUBLIC), so it is the null uid rather than a role filter
           * that closes them to anon.
           */
          const callerUid = role === 'anon' ? null : caller;

          // The other farmer's row, viewed by this caller. This is the whole property: never
          // admitted, whichever verb and whichever role.
          expect(
            permitted(table, verb, { authUid: callerUid, columns: rowOwnedBy(table, other) }, role),
            `${label}: the caller was admitted to another farmer's row`,
          ).toBe(false);

          // An anonymous request is admitted to nothing, including its "own" row — there is no own
          // row without a uid. `auth.uid()` is NULL, so the predicate is unknown rather than false,
          // which `evaluate()` keeps distinct and `permitted()` still refuses.
          expect(
            permitted(table, verb, { authUid: null, columns: rowOwnedBy(table, other) }, 'anon'),
            `${label}: an anonymous request was admitted`,
          ).toBe(false);

          // The other direction, so the policies are not vacuously restrictive: whatever verbs a
          // farmer *does* have on their own row must still work, and the verbs with no policy must
          // be closed for the owner too (deny by default is the mechanism 0004 and 0006 rely on).
          const ownRow = { authUid: callerUid, columns: rowOwnedBy(table, caller) };
          expect(permitted(table, verb, ownRow, role), label).toBe(
            role === 'authenticated' && consulted.length > 0,
          );
        },
      ),
      { numRuns: 400 },
    );

    expect([...combinationsSeen].sort()).toStrictEqual(
      ISOLATED_TABLES.flatMap((table) => VERBS.map((verb) => `${table}:${verb}`)).sort(),
    );
    expect([...mechanismsSeen].sort()).toStrictEqual(['no_policy_for_verb', 'policy_predicate']);
    expect([...rolesSeen].sort()).toStrictEqual(['anon', 'authenticated']);
  });

  it('writes every one of those predicates as an own-row comparison and nothing looser', () => {
    const shapesSeen = new Set<string>();

    for (const table of ISOLATED_TABLES) {
      const policies = policiesFor(table);
      expect(policies.length, `${table} has no policy at all`).toBeGreaterThan(0);

      for (const policy of policies) {
        const expected = `auth.uid() = ${ownerColumnOf(table)}`;
        for (const expression of [policy.using, policy.withCheck]) {
          if (expression === null) continue;
          shapesSeen.add(expression);
          expect(expression, `${policy.name} in ${policy.file} is not own-row`).toBe(expected);
        }
        // No `to anon`, and no `to public` spelled out. An absent `to` clause is PUBLIC, which is
        // safe here only because the predicate denies a null uid — asserted in the run above.
        expect(policy.roles, `${policy.name} names a role explicitly`).not.toContain('anon');
        expect(policy.roles, `${policy.name} names a role explicitly`).not.toContain('public');
      }
    }

    // Exactly two predicate shapes across all five tables: the primary key one for `profiles` and
    // the `user_id` one for the other four. A third shape appearing here is a policy nobody has
    // reviewed against this property.
    expect([...shapesSeen].sort()).toStrictEqual(['auth.uid() = id', 'auth.uid() = user_id']);
  });
});

/* ========================================================================== */
/* The recording client — one fake, three real adapters                        */
/* ========================================================================== */

interface Predicate {
  readonly kind: 'eq' | 'in' | 'is' | 'lt';
  readonly column: string;
  readonly value: unknown;
}

interface RecordedStatement {
  readonly table: string;
  readonly verb: 'select' | 'insert' | 'update';
  readonly columns: string;
  readonly predicates: readonly Predicate[];
  readonly payload?: unknown;
  readonly returned: number;
}

interface Recorder {
  readonly client: SupabaseClient<Database>;
  readonly statements: readonly RecordedStatement[];
}

/**
 * A generic row store that applies **whatever predicates the caller supplied** and records them.
 *
 * It knows nothing about farmers, tables or tenancy: the narrowing is the production adapter's, which
 * is what makes the assertions below assertions about production code rather than about this
 * function. A statement that omitted its `user_id` predicate would come back with both farmers' rows
 * and fail — the fake is the thing that would *let* the leak through, not the thing that prevents it.
 *
 * This is the same idiom `chat-context.property.test.ts` and `persistence.property.test.ts` use.
 */
function recorder(tables: Readonly<Record<string, readonly Record<string, unknown>[]>>): Recorder {
  const statements: RecordedStatement[] = [];

  const from = (table: string): unknown => {
    const rows = tables[table];
    if (rows === undefined) {
      throw new Error(`the recorder holds no "${table}" table; a statement reached past its seam`);
    }

    const predicates: Predicate[] = [];
    let columns = '';

    const matched = (): readonly Record<string, unknown>[] =>
      rows.filter((row) =>
        predicates.every((predicate) => {
          const actual = row[predicate.column];
          switch (predicate.kind) {
            case 'eq':
              return actual === predicate.value;
            case 'in':
              return (predicate.value as readonly unknown[]).includes(actual);
            case 'is':
              return actual === predicate.value;
            case 'lt':
              return String(actual) < String(predicate.value);
          }
        }),
      );

    const record = (
      verb: RecordedStatement['verb'],
      returned: number,
      payload?: unknown,
    ): void => {
      statements.push({
        table,
        verb,
        columns,
        predicates: [...predicates],
        ...(payload === undefined ? {} : { payload }),
        returned,
      });
    };

    const chain = {
      select: (list?: string) => {
        columns = list ?? '';
        return chain;
      },
      eq: (column: string, value: unknown) => {
        predicates.push({ kind: 'eq', column, value });
        return chain;
      },
      in: (column: string, value: unknown) => {
        predicates.push({ kind: 'in', column, value });
        return chain;
      },
      is: (column: string, value: unknown) => {
        predicates.push({ kind: 'is', column, value });
        return chain;
      },
      lt: (column: string, value: unknown) => {
        predicates.push({ kind: 'lt', column, value });
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        const found = matched();
        record('select', found.length);
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      single: () => {
        const found = matched();
        record('select', found.length);
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
        const found = matched();
        record('select', found.length);
        return resolve({ data: found, error: null });
      },
      insert: (payload: unknown) => {
        record('insert', 0, payload);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: payload, error: null }),
          }),
        };
      },
    };

    return chain;
  };

  return { client: { from } as unknown as SupabaseClient<Database>, statements };
}

function predicateFor(statement: RecordedStatement, column: string): Predicate {
  const found = statement.predicates.filter((predicate) => predicate.column === column);
  if (found.length !== 1) {
    throw new Error(
      `the ${statement.table} ${statement.verb} carried ${found.length} "${column}" predicates; ` +
        'Requirement 13.2 needs exactly one',
    );
  }
  return found[0] as Predicate;
}

/* ========================================================================== */
/* Surface 1b — the statements the application composes                        */
/* ========================================================================== */

/**
 * The behavioural complement to the SQL assertions above, and it adds something the static gate
 * cannot see.
 *
 * `scripts/check-secret-scope.ts` already asserts, over all of `src/**`, that every statement against
 * a farmer-scoped table carries a tenant anchor — but it reads text, so it can only see that a
 * `.eq('user_id', …)` is *present*. What it cannot see is **which value goes in it**. The two
 * adapters below are the two whose statements run on the service-role client in production (the
 * WhatsApp webhook carries no session), which is precisely where `admin.ts` says the application
 * check *is* the boundary with nothing behind it. So they are driven for real, with two farmers'
 * rows present, and the value in the predicate is asserted.
 *
 * `messages`, `diagnoses` and `usage_logs` are deliberately not re-driven here: their statements are
 * covered behaviourally by Property 15 (conversation context), Property 26 (history) and Property 22
 * (the audit row), and statically by the anchor gate. Repeating them would add a fourth copy of one
 * claim rather than a new one.
 */
describe('Property 27, surface 1b: every statement carries the caller’s own scoping value', () => {
  it('scopes the conversation lookup to the caller and the channel, and the insert to the caller', async () => {
    const channelsSeen = new Set<Channel>();

    await fc.assert(
      fc.asyncProperty(
        twoFarmersArb,
        fc.constantFrom<Channel>('web', 'whatsapp'),
        async (farmers, channel) => {
          const [caller, other] = farmers;
          channelsSeen.add(channel);

          const rows = [
            { id: 'other-web', user_id: other, channel: 'web', updated_at: '2026-01-02' },
            { id: 'other-wa', user_id: other, channel: 'whatsapp', updated_at: '2026-01-02' },
            { id: 'mine', user_id: caller, channel, updated_at: '2026-01-01' },
          ];
          const fake = recorder({ conversations: rows });
          const store = conversationStoreFrom(fake.client);

          const found = await store.mostRecent(caller, channel);

          // The row that came back is the caller's, on the requested channel — with two of the other
          // farmer's rows sitting in the same table, one of them more recently updated.
          expect(found?.user_id).toBe(caller);
          expect(found?.channel).toBe(channel);

          const read = fake.statements[0];
          if (read === undefined) throw new Error('the conversation lookup issued no statement');
          expect(read.table).toBe('conversations');
          // The anchor, and the value in it. `admin.ts`'s rule, checked rather than read.
          expect(predicateFor(read, 'user_id').value).toBe(caller);
          expect(predicateFor(read, 'channel').value).toBe(channel);
          expect(read.returned).toBe(1);

          await store.create(caller, channel);
          const insert = fake.statements.find((statement) => statement.verb === 'insert');
          if (insert === undefined) throw new Error('create issued no insert');
          expect(insert.payload).toMatchObject({ user_id: caller, channel });
        },
      ),
      { numRuns: 100 },
    );

    expect([...channelsSeen].sort()).toStrictEqual(['web', 'whatsapp']);
  });

  it('resolves an inbound phone through the unique identity column and nothing wider', async () => {
    await fc.assert(
      fc.asyncProperty(twoFarmersArb, async (farmers) => {
        const [caller, other] = farmers;
        const callerPhone = '+911111111111';
        const otherPhone = '+922222222222';

        const fake = recorder({
          profiles: [
            { id: other, phone: otherPhone, language: 'hi' },
            { id: caller, phone: callerPhone, language: 'en' },
          ],
        });

        const { data, error } = await adminProfileByPhoneStore(fake.client).byPhone(callerPhone);

        expect(error).toBeNull();
        expect(data?.id).toBe(caller);

        const read = fake.statements[0];
        if (read === undefined) throw new Error('the profile lookup issued no statement');
        expect(read.table).toBe('profiles');
        // `phone` is the anchor `FARMER_SCOPED_TABLES` records for this table, and it is `unique` in
        // 0002 — which is what makes Requirement 10.2 a function rather than a guess.
        expect(predicateFor(read, 'phone').value).toBe(callerPhone);
        // And it selects two columns rather than `*`: a service-role read of another farmer's row
        // cannot leak a column it never asked for.
        expect(read.columns).toBe(WHATSAPP_PROFILE_SELECT);
        expect(read.returned).toBe(1);
      }),
      { numRuns: 60 },
    );
  });
});

/* ========================================================================== */
/* Surface 2 — storage                                                         */
/* ========================================================================== */

/** The two private buckets, and the four policies over `storage.objects`. */
describe('Property 27, surface 2: both private buckets are per-farmer by prefix', () => {
  it('creates both buckets private and fails the migration if either already exists public', () => {
    const sql = withoutComments(
      readFileSync(join(MIGRATIONS_DIR, '0009_storage_buckets_policies.sql'), 'utf8'),
    );
    const oneLined = oneLine(sql);

    // Requirement 13.5. `public` is the privacy column (V4) and `false` is stated rather than left
    // to the default, so an upstream change of default breaks loudly.
    for (const bucket of [STORAGE_BUCKETS.cropImages, STORAGE_BUCKETS.voiceMessages]) {
      expect(oneLined).toContain(`('${bucket}','${bucket}',false)`);
    }
    // And the guard that catches a bucket the idempotent insert left public.
    expect(oneLined).toMatch(/raise exception .*must be PRIVATE/i);
    // No third bucket. `video-inputs` is deferred and the design says it is not created.
    expect(oneLined).not.toContain('video-inputs');
  });

  it('admits an object only under the requesting farmer’s own first folder, in either bucket', () => {
    const seen = new Set<string>();
    const pathKindsSeen = new Set<'conforming' | 'bucket_root' | 'empty_owner'>();

    fc.assert(
      fc.property(
        twoFarmersArb,
        verbArb,
        bucketArb,
        pathPartsArb,
        fc.constantFrom<'conforming' | 'bucket_root' | 'empty_owner'>(
          'conforming',
          'bucket_root',
          'empty_owner',
        ),
        (farmers, verb, bucket, parts, pathKind) => {
          const [caller, other] = farmers;
          seen.add(`${bucket}:${verb}`);
          pathKindsSeen.add(pathKind);

          const own = conformingPath(caller, parts);
          const theirs = conformingPath(other, parts);
          const label = `${bucket}.${verb}`;

          const env = (name: string, authUid: string | null) => ({
            authUid,
            columns: { bucket_id: bucket, name },
          });

          // The other farmer's prefix: never admitted, on any verb.
          expect(
            permitted('objects', verb, env(theirs, caller), 'authenticated'),
            `${label}: another farmer's object was admitted`,
          ).toBe(false);

          // Anonymous: never admitted. The policies are `to authenticated`, so they are not even
          // consulted — a second, independent reason on top of the null-uid predicate.
          expect(
            permitted('objects', verb, env(own, null), 'anon'),
            `${label}: an anonymous request was admitted`,
          ).toBe(false);

          // The farmer's own prefix: `select` and `insert` only. `update` and `delete` have no
          // policy at all, which is 0009's deliberate narrowing — every deletion in Jamee runs with
          // the service role (Requirements 8.11, 18.9), so a farmer cannot orphan their own
          // history's image.
          expect(permitted('objects', verb, env(own, caller), 'authenticated'), label).toBe(
            verb === 'select' || verb === 'insert',
          );

          // A path with no usable first folder is denied by NULL rather than by comparison — and the
          // application gate refuses the same paths through its schema, so the two boundaries agree
          // on the awkward cases as well as the obvious ones.
          const ownerless = pathKind === 'bucket_root' ? `${parts.objectId}.jpg` : `/${parts.objectId}.jpg`;
          if (pathKind !== 'conforming') {
            expect(
              permitted('objects', verb, env(ownerless, caller), 'authenticated'),
              `${label}: an object with no owning folder was admitted`,
            ).toBe(false);
            expect(STORAGE_PATH_REGEX.test(ownerless), label).toBe(false);
          } else {
            expect(STORAGE_PATH_REGEX.test(own), label).toBe(true);
            // The two boundaries read the *same* segment: `[1]` in SQL (1-indexed folders) and
            // index 0 in JavaScript. `config/verified.ts` exists to keep them tied.
            expect(ownerSegmentOf(own)).toBe(caller);
            expect(STORAGE_OWNER_PATH_SEGMENT_INDEX).toBe(0);
          }
        },
      ),
      { numRuns: 300 },
    );

    expect([...seen].sort()).toStrictEqual(
      [STORAGE_BUCKETS.cropImages, STORAGE_BUCKETS.voiceMessages]
        .flatMap((bucket) => VERBS.map((verb) => `${bucket}:${verb}`))
        .sort(),
    );
    expect([...pathKindsSeen].sort()).toStrictEqual(['bucket_root', 'conforming', 'empty_owner']);
  });

  /* ------------------------------------------------------------------------ */
  /* The application gate, in both buckets and both directions                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Property 5 (`storage.property.test.ts`) already exercises this gate exhaustively over its refusal
   * classes, but through `crop-images` only — `voice-messages` appears there as the *wrong bucket*
   * case. Property 27's claim is different: **either private bucket**, and the symmetric two-farmer
   * form. So what is asserted here is the pair, per bucket: a farmer's own reference is accepted, and
   * the other farmer's is refused, with the existence probe never reached.
   */
  it('refuses a cross-tenant reference in either bucket, without probing storage for it', async () => {
    const bucketsSeen = new Set<string>();

    await fc.assert(
      fc.asyncProperty(twoFarmersArb, bucketArb, pathPartsArb, async (farmers, bucket, parts) => {
        const [caller, other] = farmers;
        bucketsSeen.add(bucket);

        let probes = 0;
        const client: StorageClientLike = {
          storage: {
            from: () => ({
              exists: () => {
                probes += 1;
                return Promise.resolve({ data: true, error: null });
              },
              createSignedUrl: (path: string) =>
                Promise.resolve({ data: { signedUrl: `https://storage.test/${path}` }, error: null }),
            }),
          },
        };

        // Own reference, own bucket: accepted, and the probe is the one round trip it takes.
        await assertOwnershipInBucket(
          { bucket, path: conformingPath(caller, parts) },
          caller,
          bucket,
          client,
        );
        expect(probes, `${bucket}: an owned reference was not probed`).toBe(1);

        // The other farmer's object in the same bucket: refused, and **not probed**. The prefix
        // comparison precedes the probe deliberately — on the service-role client the probe bypasses
        // RLS, so confirming another farmer's object exists would be a worse gate that still
        // returned 403.
        probes = 0;
        const error = await refusalOf(
          assertOwnershipInBucket(
            { bucket, path: conformingPath(other, parts) },
            caller,
            bucket,
            client,
          ),
        );
        expect(error.code, bucket).toBe('STORAGE_REF_FORBIDDEN');
        expect(error.status, bucket).toBe(403);
        expect(probes, `${bucket}: a cross-tenant reference reached the network`).toBe(0);
      }),
      { numRuns: 150 },
    );

    expect([...bucketsSeen].sort()).toStrictEqual(
      [STORAGE_BUCKETS.cropImages, STORAGE_BUCKETS.voiceMessages].sort(),
    );
  });
});

/** The `AppError` a refusal must be. Anything else — including success — fails the property. */
async function refusalOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('the cross-tenant reference was accepted; Property 27 requires a refusal');
}

/* ========================================================================== */
/* Surface 3 — the knowledge base                                              */
/* ========================================================================== */

describe('Property 27, surface 3: the knowledge base is shared read-only reference data', () => {
  const KNOWLEDGE_CLAUSES = [
    'no_owner_column',
    'read_allowed_for_authenticated',
    'read_denied_for_anon',
    'insert_denied',
    'update_denied',
    'delete_denied',
  ] as const;

  it('has no owner column, so there is no tenant dimension to isolate along', () => {
    const columns = columnNamesOf('disease_knowledge');

    expect(columns).toContain('disease_name');
    // The claim: nothing here belongs to a farmer.
    expect(columns).not.toContain('user_id');
    expect(columns).not.toContain('owner_id');
    expect(columns).not.toContain('profile_id');

    // And the two static gates agree about that, which is what keeps the omission a decision rather
    // than an oversight — `check-secret-scope.ts` names this table in exactly one of its two lists.
    expect(Object.keys(FARMER_SCOPED_TABLES)).not.toContain('disease_knowledge');
    expect(TENANT_FREE_TABLES).toContain('disease_knowledge');
  });

  it('grants every authenticated farmer the same unconditional read and refuses every write', () => {
    const clausesSeen = new Set<string>();
    clausesSeen.add('no_owner_column'); // asserted in the test above, over the same source

    expect(RLS_ENABLED.has('disease_knowledge')).toBe(true);

    const policies = policiesFor('disease_knowledge');
    // One policy, and its exact shape: `for select to authenticated using (true)`. Requirement 13.3.
    expect(policies).toHaveLength(1);
    const only = policies[0];
    if (only === undefined) throw new Error('disease_knowledge has no policy');
    expect(only.verb).toBe('select');
    expect(only.roles).toStrictEqual(['authenticated']);
    expect(only.using).toBe('true');
    expect(only.withCheck).toBeNull();

    fc.assert(
      fc.property(twoFarmersArb, verbArb, (farmers, verb) => {
        const [oneFarmer, another] = farmers;
        const env = (authUid: string | null) => ({ authUid, columns: {} });

        if (verb === 'select') {
          // Both farmers, identical answer: allowed. There is no per-farmer view of this table, and
          // that is the design — every diagnosis is grounded in the same five verified rows.
          expect(permitted('disease_knowledge', verb, env(oneFarmer), 'authenticated')).toBe(true);
          expect(permitted('disease_knowledge', verb, env(another), 'authenticated')).toBe(true);
          clausesSeen.add('read_allowed_for_authenticated');

          // Anonymous is not `authenticated`, so the one policy is not consulted at all.
          expect(permitted('disease_knowledge', verb, env(null), 'anon')).toBe(false);
          clausesSeen.add('read_denied_for_anon');
          return;
        }

        // Requirement 13.4: the mechanism is the ABSENCE of a write policy plus RLS being enabled.
        // Denied for both farmers and for anon — there is no owner who could be granted it, which is
        // what makes "one farmer cannot rewrite what another farmer reads" hold.
        for (const farmer of [oneFarmer, another]) {
          expect(
            permitted('disease_knowledge', verb, env(farmer), 'authenticated'),
            `a farmer was admitted to ${verb} on disease_knowledge`,
          ).toBe(false);
        }
        expect(permitted('disease_knowledge', verb, env(null), 'anon')).toBe(false);
        clausesSeen.add(`${verb}_denied`);
      }),
      { numRuns: 200 },
    );

    expect([...clausesSeen].sort()).toStrictEqual([...KNOWLEDGE_CLAUSES].sort());
  });

  it('reads it with no tenant predicate, and exposes no way to write it', async () => {
    // The read statement, composed by the real adapter. The absence of a `user_id` predicate is
    // asserted rather than assumed: `admin.ts`'s anchor rule cannot apply to a table with no owner
    // column, and `knowledge.ts`'s header says so — so the *right* statement here is the unanchored
    // one, and a `user_id` predicate appearing would mean the table had grown a tenant dimension.
    await fc.assert(
      fc.asyncProperty(
        twoFarmersArb,
        fc.subarray([...VERIFIED_CONDITIONS], { minLength: 1 }),
        async (_farmers, names) => {
          const rows = VERIFIED_CONDITIONS.map((name, index) => ({
            id: `k-${index}`,
            disease_name: name,
          }));
          const fake = recorder({ disease_knowledge: rows });

          const read = await knowledgeReaderFrom(fake.client)(names as readonly VerifiedCondition[]);

          expect(read.map((row) => row.disease_name).sort()).toStrictEqual([...names].sort());

          const statement = fake.statements[0];
          if (statement === undefined) throw new Error('the knowledge read issued no statement');
          expect(statement.table).toBe('disease_knowledge');
          expect(statement.predicates.map((predicate) => predicate.column)).toStrictEqual([
            'disease_name',
          ]);
          expect(statement.predicates[0]?.kind).toBe('in');
        },
      ),
      { numRuns: 100 },
    );

    // And no write verb anywhere in the module: the read side is the whole of `knowledge.ts`, so
    // Requirement 13.4's "writes belong in a migration" has no application-side back door.
    const source = readFileSync(join(REPO_ROOT, 'src', 'lib', 'knowledge.ts'), 'utf8');
    const statements = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const verb of ['.insert(', '.update(', '.delete(', '.upsert(']) {
      expect(statements, `knowledge.ts contains ${verb}`).not.toContain(verb);
    }
  });
});
