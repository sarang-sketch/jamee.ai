import { type Db, type Document } from 'mongodb';

/**
 * Collection names, the media bucket, and the five condition names are declared LOCALLY here rather
 * than imported from `@/lib/db/names`, and that is deliberate: this module is imported two ways —
 * by the app and tests through the `@/` alias (which resolves `./names`), and by
 * `scripts/db-setup.ts` under bare `node --experimental-strip-types`, which resolves neither the
 * `@/` alias nor an extensionless relative import. Keeping this module free of any relative/aliased
 * import lets the node-run script load it. A unit test (`tests/unit/db-setup-names.test.ts`) asserts
 * these copies equal the canonical `@/lib/db/names` values byte-for-byte, so the duplication cannot
 * drift — the same guard pattern the verified-condition list already uses.
 */
const COLLECTIONS = {
  profiles: 'profiles',
  conversations: 'conversations',
  messages: 'messages',
  diagnoses: 'diagnoses',
  usageLogs: 'usage_logs',
  counters: 'counters',
  diseaseKnowledge: 'disease_knowledge',
  telegramInbound: 'telegram_inbound',
  linkTokens: 'link_tokens',
  paymentOrders: 'payment_orders',
  botEntitlements: 'bot_entitlements',
  webhookThrottle: 'webhook_throttle',
} as const;

const MEDIA_BUCKET = 'media';

const VERIFIED_CONDITION_NAMES = [
  'Tomato Early Blight',
  'Tomato Late Blight',
  'Tomato Healthy',
  'Potato Early Blight',
  'Potato Late Blight',
] as const;

/**
 * The idempotent database setup — collections with `$jsonSchema` validators, every index from
 * design A3, the single GridFS bucket, and the five-condition seed. Exported so `scripts/db-setup.ts`
 * (task 53.1, `npm run db:setup`) calls it against Atlas and the integration harness calls it
 * against an in-memory replica set (task 53.5, V31).
 *
 * Requirements: 4.1, 4.2 (exactly the five conditions, seeded with a source per row), 13.1, 13.3,
 *               13.4 (the collections the Data_Access_Layer scopes; disease_knowledge is read-only
 *               to farmers and writable only here), 13.9 (webhook_throttle), 14.1-14.3 (the counter
 *               unique index the atomic reserve keys on), 17.6 (setup creates every seed row),
 *               21.7, 21.16, 22.11, 22.12 (the unique/partial indexes that enforce the former
 *               UNIQUE constraints)
 * Design: "Data model and collection setup" (read the 0002-0013 SQL blocks under the A3 mapping),
 *         D14, D17, D19; V28, V29
 *
 * =============================================================================
 * IDEMPOTENCE - WHY EVERY STEP IS SAFE TO RE-RUN
 * =============================================================================
 *
 * `npm run db:setup` is documented as safe to re-run, and a re-run after a partial failure must not
 * error. So:
 *  - collections are created with `createCollection` guarded by a `listCollections` check, and an
 *    already-present collection has its validator RE-APPLIED with `collMod` rather than skipped, so
 *    a validator edit lands on a second run;
 *  - indexes use `createIndex`, which the driver treats as a no-op when an identical index already
 *    exists (a name/options clash would throw, which is the correct loud failure);
 *  - the seed upserts on `diseaseName`, so re-running neither duplicates a row nor overwrites one
 *    (changing knowledge content is a deliberate new step, never a silent seed rewrite);
 *  - the GridFS bucket's `.files`/`.chunks` collections are created lazily by the driver on first
 *    write (V29), so setup only creates their metadata indexes, which are themselves idempotent.
 *
 * =============================================================================
 * VALIDATORS - `$jsonSchema` PINS THE ENUMS THE SQL CHECKs USED TO
 * =============================================================================
 *
 * Every former Postgres `CHECK (col in (...))` on an enumerated field becomes a `$jsonSchema`
 * `enum` here (design: "enumerated fields are constrained by collection schema validation where
 * practical"). The vocabulary is the A3 one - `channel in web/telegram`, the widened
 * `telegram_inbound.status`, etc. - and it agrees with the Zod schemas at the wire and the typed
 * accessors in code, so all three layers pin the same set. Validators use `validationLevel:
 * 'moderate'` so a document the app writes is checked while an unrelated legacy shape is not
 * blocked mid-migration; at the 6-farmer academic scale `strict` would be equally fine, and
 * `moderate` is the safer default for a re-runnable script.
 */

const ENUM = {
  language: ['en', 'hi', 'mr'],
  severity: ['none', 'low', 'moderate', 'high'],
  /** A3: the second channel is Telegram (design A3 data model), not the retired WhatsApp. */
  channel: ['web', 'telegram'],
  messageRole: ['farmer', 'jamee'],
  inputKind: ['text', 'voice', 'image'],
  operation: ['image', 'chat', 'voice'],
  modelProvider: ['gemini', 'groq', 'none'],
  windowKind: ['day', 'minute'],
  crop: ['tomato', 'potato'],
  diagnosisStatus: ['identified', 'unknown'],
  usageOutcome: [
    'success',
    'inconclusive',
    'validation_rejected',
    'provider_error',
    'timeout',
    'quota_declined',
    'rate_limited',
    'duplicate_ignored',
  ],
  paymentOrderStatus: ['created', 'captured', 'failed', 'cancelled'],
  telegramMessageType: ['start', 'text', 'photo', 'voice', 'other'],
  telegramInboundStatus: ['received', 'processed', 'failed', 'rejected', 'unlinked', 'not_entitled'],
  webhookRoute: ['payment', 'telegram'],
} as const;

/** A `$jsonSchema` validator body. `required` lists the fields a well-formed document must carry. */
function jsonSchema(properties: Document, required: string[]): Document {
  return { $jsonSchema: { bsonType: 'object', required, properties } };
}

/**
 * The validator for each collection. Only the enumerated and shape-critical fields are pinned;
 * free-text and optional fields are left unconstrained so the validator stays about invariants,
 * not about re-declaring the whole document.
 */
const VALIDATORS: Partial<Record<string, Document>> = {
  [COLLECTIONS.profiles]: jsonSchema({ language: { enum: ENUM.language } }, ['_id', 'language']),
  [COLLECTIONS.conversations]: jsonSchema(
    { ownerId: { bsonType: 'string' }, channel: { enum: ENUM.channel } },
    ['ownerId', 'channel'],
  ),
  [COLLECTIONS.messages]: jsonSchema(
    {
      ownerId: { bsonType: 'string' },
      role: { enum: ENUM.messageRole },
      language: { enum: ENUM.language },
      channel: { enum: ENUM.channel },
      inputKind: { enum: ENUM.inputKind },
    },
    ['ownerId', 'conversationId', 'role', 'content', 'language', 'channel', 'inputKind'],
  ),
  [COLLECTIONS.diseaseKnowledge]: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['diseaseName', 'crop', 'symptoms', 'causes', 'treatment', 'prevention', 'defaultSeverity', 'source'],
      properties: {
        diseaseName: { enum: [...VERIFIED_CONDITION_NAMES] },
        crop: { enum: ENUM.crop },
        defaultSeverity: { enum: ENUM.severity },
        symptoms: { bsonType: 'array' },
        causes: { bsonType: 'array' },
        treatment: { bsonType: 'array' },
        prevention: { bsonType: 'array' },
        source: { bsonType: 'string', minLength: 1 },
      },
    },
  },
  [COLLECTIONS.diagnoses]: jsonSchema(
    {
      ownerId: { bsonType: 'string' },
      status: { enum: ENUM.diagnosisStatus },
      severity: { enum: ENUM.severity },
      channel: { enum: ENUM.channel },
      language: { enum: ENUM.language },
      modelProvider: { enum: ['gemini', 'groq'] },
    },
    ['ownerId', 'conversationId', 'status', 'severity', 'explanation', 'language', 'needsExpert', 'channel', 'mediaRef', 'modelProvider'],
  ),
  [COLLECTIONS.usageLogs]: jsonSchema(
    {
      ownerId: { bsonType: 'string' },
      operation: { enum: ENUM.operation },
      channel: { enum: ENUM.channel },
      outcome: { enum: ENUM.usageOutcome },
      modelProvider: { enum: [...ENUM.modelProvider, null] },
    },
    ['ownerId', 'operation', 'channel', 'outcome', 'usedFallback', 'quotaSpent'],
  ),
  [COLLECTIONS.counters]: jsonSchema(
    {
      ownerId: { bsonType: 'string' },
      operation: { enum: ENUM.operation },
      windowKind: { enum: ENUM.windowKind },
      windowKey: { bsonType: 'string' },
      used: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    },
    ['ownerId', 'operation', 'windowKind', 'windowKey', 'used'],
  ),
  [COLLECTIONS.telegramInbound]: jsonSchema(
    { messageType: { enum: ENUM.telegramMessageType }, status: { enum: ENUM.telegramInboundStatus } },
    ['_id', 'messageType', 'status', 'receivedAt'],
  ),
  [COLLECTIONS.linkTokens]: jsonSchema(
    { ownerId: { bsonType: 'string' }, tokenHash: { bsonType: 'string' } },
    ['ownerId', 'tokenHash', 'expiresAt'],
  ),
  [COLLECTIONS.paymentOrders]: jsonSchema(
    {
      ownerId: { bsonType: 'string' },
      status: { enum: ENUM.paymentOrderStatus },
      amountMinor: { bsonType: ['int', 'long'], minimum: 1 },
    },
    ['ownerId', 'providerOrderId', 'amountMinor', 'currency', 'status'],
  ),
  [COLLECTIONS.botEntitlements]: jsonSchema(
    { providerPaymentId: { bsonType: 'string' } },
    ['_id', 'providerPaymentId', 'expiresAt', 'grantedAt'],
  ),
  [COLLECTIONS.webhookThrottle]: jsonSchema(
    {
      route: { enum: ENUM.webhookRoute },
      callerHash: { bsonType: 'string' },
      windowKey: { bsonType: 'string' },
      used: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    },
    ['route', 'callerHash', 'windowKey', 'used'],
  ),
};

/**
 * Every index to create, keyed by collection. `unique`/`partialFilterExpression`/`sparse` and
 * `expireAfterSeconds` carry the invariants the SQL blocks described:
 *  - a partial-unique index is unique-WHEN-PRESENT, so many documents may omit the field (the
 *    `profiles.telegramUserId` and `payment_orders.providerPaymentId` case A3 point 2 calls out);
 *  - the counter and webhook-throttle compound unique indexes are what make the atomic upserts
 *    race-free (D19);
 *  - a 7-day TTL on `telegram_inbound.receivedAt` keeps the dedup store from growing without bound
 *    (V24 retention reasoning).
 */
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

interface IndexSpec {
  readonly keys: Document;
  readonly options?: Document;
}

const INDEXES: Partial<Record<string, IndexSpec[]>> = {
  [COLLECTIONS.profiles]: [
    {
      keys: { telegramUserId: 1 },
      options: {
        name: 'telegramUserId_partial_unique',
        unique: true,
        partialFilterExpression: { telegramUserId: { $type: 'number' } },
      },
    },
  ],
  [COLLECTIONS.conversations]: [{ keys: { ownerId: 1, updatedAt: -1 }, options: { name: 'owner_recent' } }],
  [COLLECTIONS.messages]: [
    { keys: { ownerId: 1, conversationId: 1, createdAt: -1 }, options: { name: 'owner_conversation_recent' } },
  ],
  [COLLECTIONS.diagnoses]: [
    { keys: { ownerId: 1, createdAt: -1 }, options: { name: 'owner_recent' } },
    { keys: { conversationId: 1, createdAt: -1 }, options: { name: 'conversation_recent' } },
    {
      keys: { createdAt: 1 },
      options: { name: 'retention_pending', partialFilterExpression: { fullImageDeletedAt: null } },
    },
  ],
  [COLLECTIONS.usageLogs]: [
    { keys: { ownerId: 1, createdAt: -1 }, options: { name: 'owner_recent' } },
    { keys: { outcome: 1, createdAt: -1 }, options: { name: 'outcome_recent' } },
  ],
  [COLLECTIONS.counters]: [
    { keys: { ownerId: 1, operation: 1, windowKind: 1, windowKey: 1 }, options: { name: 'counter_key_unique', unique: true } },
  ],
  [COLLECTIONS.diseaseKnowledge]: [
    { keys: { diseaseName: 1 }, options: { name: 'diseaseName_unique', unique: true } },
  ],
  [COLLECTIONS.telegramInbound]: [
    { keys: { receivedAt: -1 }, options: { name: 'received_recent' } },
    { keys: { receivedAt: 1 }, options: { name: 'received_ttl', expireAfterSeconds: SEVEN_DAYS_SECONDS } },
  ],
  [COLLECTIONS.linkTokens]: [
    { keys: { tokenHash: 1 }, options: { name: 'tokenHash_unique', unique: true } },
    { keys: { ownerId: 1, createdAt: -1 }, options: { name: 'owner_recent' } },
  ],
  [COLLECTIONS.paymentOrders]: [
    { keys: { providerOrderId: 1 }, options: { name: 'providerOrderId_unique', unique: true } },
    {
      keys: { providerPaymentId: 1 },
      options: {
        name: 'providerPaymentId_partial_unique',
        unique: true,
        partialFilterExpression: { providerPaymentId: { $type: 'string' } },
      },
    },
    { keys: { ownerId: 1, createdAt: -1 }, options: { name: 'owner_recent' } },
  ],
  [COLLECTIONS.botEntitlements]: [
    { keys: { providerPaymentId: 1 }, options: { name: 'providerPaymentId_unique', unique: true } },
  ],
  [COLLECTIONS.webhookThrottle]: [
    { keys: { route: 1, callerHash: 1, windowKey: 1 }, options: { name: 'throttle_key_unique', unique: true } },
  ],
};

/** The GridFS metadata indexes (D17): owner+kind for the Media_Endpoint check and the sweep filter. */
const GRIDFS_FILES_INDEXES: IndexSpec[] = [
  { keys: { 'metadata.ownerId': 1, 'metadata.kind': 1 }, options: { name: 'owner_kind' } },
  { keys: { uploadDate: 1 }, options: { name: 'uploadDate' } },
];

/* ========================================================================== */
/* The five verified conditions - copied verbatim from 0010, source per row   */
/* ========================================================================== */

/**
 * The seed. Content and every `source` citation are copied EXACTLY from
 * `supabase/migrations/0010_seed_disease_knowledge.sql` (the committed real citations, not the
 * design's placeholders), because Requirement 4.3 makes this the only agricultural content a
 * farmer ever reads and 4.2 requires a real provenance per row. Tomato Healthy's `treatment` is
 * the empty array (3.4).
 */
export const SEED_CONDITIONS: ReadonlyArray<{
  diseaseName: (typeof VERIFIED_CONDITION_NAMES)[number];
  crop: 'tomato' | 'potato';
  scientificName: string | null;
  symptoms: string[];
  causes: string[];
  treatment: string[];
  prevention: string[];
  defaultSeverity: 'none' | 'low' | 'moderate' | 'high';
  source: string;
}> = [
  {
    diseaseName: 'Tomato Early Blight',
    crop: 'tomato',
    scientificName: 'Alternaria solani',
    symptoms: [
      'Dark brown spots with concentric rings on older, lower leaves',
      'Yellow halo around each spot',
      'Affected leaves dry and drop, starting from the bottom of the plant',
    ],
    causes: [
      'Fungal infection by Alternaria solani',
      'Warm, humid weather with leaf wetness',
      'Spores surviving on crop debris and volunteer plants',
    ],
    treatment: [
      'Remove and destroy affected lower leaves',
      'Apply a protectant fungicide labelled for early blight, following the label rate',
      'Avoid overhead irrigation late in the day',
    ],
    prevention: [
      'Rotate away from tomato and potato for two seasons',
      'Stake plants for airflow and mulch to limit soil splash',
      'Use certified disease-free seed and clear crop debris after harvest',
    ],
    defaultSeverity: 'moderate',
    source:
      'West Virginia University Extension, "Early Blight of Tomatoes", https://extension.wvu.edu/lawn-gardening-pests/plant-disease/fruit-vegetable-diseases/early-blight-of-tomatoes (checked 2026-09-15)',
  },
  {
    diseaseName: 'Tomato Late Blight',
    crop: 'tomato',
    scientificName: 'Phytophthora infestans',
    symptoms: [
      'Large greasy grey-green to brown patches on leaves',
      'White fuzzy growth on leaf undersides in humid conditions',
      'Firm brown lesions on stems and fruit; rapid collapse of foliage',
    ],
    causes: [
      'Oomycete infection by Phytophthora infestans',
      'Cool, wet, humid weather',
      'Spores carried by wind and rain from nearby infected plants or tubers',
    ],
    treatment: [
      'Remove and destroy infected plants immediately, do not compost them',
      'Apply a fungicide labelled for late blight without delay, following the label rate',
      'Harvest healthy fruit early if spread is rapid',
    ],
    prevention: [
      'Plant resistant varieties where available',
      'Avoid overhead irrigation and crowded spacing',
      'Destroy volunteer tomato and potato plants and cull piles',
    ],
    defaultSeverity: 'high',
    source:
      'Virginia Cooperative Extension, publication ANR-6, "Late Blight of Tomato and Potato", https://pubs.ext.vt.edu/ANR/ANR-6.html (checked 2026-09-15)',
  },
  {
    diseaseName: 'Tomato Healthy',
    crop: 'tomato',
    scientificName: null,
    symptoms: [
      'Uniform green leaves with no spots, lesions, or wilting',
      'Normal leaf shape and size for the growth stage',
    ],
    causes: ['No disease detected in the submitted photo'],
    treatment: [],
    prevention: [
      'Continue regular monitoring of lower leaves',
      'Keep foliage dry by watering at the base',
      'Maintain crop rotation and field sanitation',
    ],
    defaultSeverity: 'none',
    source:
      'Utah State University Extension, Vegetable Guide: Tomato, Pepper, Eggplant, https://extension.usu.edu/vegetableguide/tomato-pepper-eggplant (checked 2026-09-15)',
  },
  {
    diseaseName: 'Potato Early Blight',
    crop: 'potato',
    scientificName: 'Alternaria solani',
    symptoms: [
      'Dark concentric-ringed lesions on older leaves',
      'Lesions bounded by leaf veins, giving an angular outline',
      'Progressive yellowing and death of lower foliage',
    ],
    causes: [
      'Fungal infection by Alternaria solani',
      'Warm temperatures with alternating wet and dry periods',
      'Inoculum surviving in soil and crop residue',
    ],
    treatment: [
      'Remove severely affected foliage',
      'Apply a protectant fungicide labelled for early blight on potato, per label rate',
      'Maintain balanced nitrogen to avoid early senescence',
    ],
    prevention: [
      'Rotate with non-solanaceous crops',
      'Plant certified seed tubers',
      'Bury or remove crop residue after harvest',
    ],
    defaultSeverity: 'moderate',
    source:
      'North Dakota State University Extension, "Early Blight of Potato", https://www.ndsu.edu/agriculture/extension/publications/early-blight-potato (checked 2026-09-15)',
  },
  {
    diseaseName: 'Potato Late Blight',
    crop: 'potato',
    scientificName: 'Phytophthora infestans',
    symptoms: [
      'Water-soaked pale green patches that turn brown-black',
      'White sporulation at lesion margins on leaf undersides in humid weather',
      'Dark firm rot on tubers',
    ],
    causes: [
      'Oomycete infection by Phytophthora infestans',
      'Cool, wet, humid conditions',
      'Infected seed tubers and wind-blown spores',
    ],
    treatment: [
      'Destroy infected plants and affected tubers',
      'Apply a fungicide labelled for potato late blight promptly, per label rate',
      'Kill the haulm before harvest in a severe outbreak to protect tubers',
    ],
    prevention: [
      'Plant certified, disease-free seed tubers',
      'Hill soil well to cover tubers and improve drainage',
      'Remove cull piles and volunteer plants',
    ],
    defaultSeverity: 'high',
    source:
      'North Dakota State University Extension, "Late Blight in Potato", https://www.ndsu.edu/agriculture/extension/publications/late-blight-potato (checked 2026-09-15)',
  },
];

/* ========================================================================== */
/* The setup steps                                                             */
/* ========================================================================== */

async function ensureCollection(db: Db, name: string, validator?: Document): Promise<void> {
  const existing = await db.listCollections({ name }, { nameOnly: true }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name, validator ? { validator } : undefined);
    return;
  }
  // Already exists: re-apply the validator so an edit lands on a re-run (moderate level).
  if (validator) {
    await db.command({ collMod: name, validator, validationLevel: 'moderate' });
  }
}

async function ensureIndexes(db: Db, name: string, specs: IndexSpec[]): Promise<void> {
  const collection = db.collection(name);
  for (const spec of specs) {
    await collection.createIndex(spec.keys, spec.options ?? {});
  }
}

async function seedDiseaseKnowledge(db: Db): Promise<void> {
  const collection = db.collection(COLLECTIONS.diseaseKnowledge);
  const now = new Date();
  for (const c of SEED_CONDITIONS) {
    await collection.updateOne(
      { diseaseName: c.diseaseName },
      { $setOnInsert: { ...c, createdAt: now, updatedAt: now } },
      { upsert: true },
    );
  }
}

export interface SetupResult {
  readonly collections: string[];
  readonly gridfsBucket: string;
  readonly seededConditions: number;
}

/**
 * The locally-declared names, re-exported ONLY so `tests/unit/db-setup-names.test.ts` can assert
 * they equal the canonical `@/lib/db/names` values. Not for app use — app code imports the
 * canonical module directly.
 */
export const SETUP_NAMES = {
  collections: COLLECTIONS,
  mediaBucket: MEDIA_BUCKET,
  verifiedConditionNames: VERIFIED_CONDITION_NAMES,
} as const;

/**
 * Create every collection + validator + index, the GridFS bucket's metadata indexes, and the seed.
 * Idempotent (see the header). Takes the `Db` explicitly — `scripts/db-setup.ts` passes one built
 * from `MONGODB_URI`, and the integration harness passes an in-memory one (V31). Keeping `db` a
 * required argument (rather than defaulting to the cached `getDb()`) is what lets this module stay
 * free of `server-only` and the `@/`-aliased client, so the node-run setup script can import it.
 */
export async function setupDatabase(db: Db): Promise<SetupResult> {
  // 1. Collections with validators.
  for (const name of Object.values(COLLECTIONS)) {
    await ensureCollection(db, name, VALIDATORS[name]);
  }

  // 2. Indexes.
  for (const [name, specs] of Object.entries(INDEXES)) {
    if (specs) await ensureIndexes(db, name, specs);
  }

  // 3. The single GridFS bucket's metadata indexes. The driver creates the `.files`/`.chunks`
  //    collections lazily on first write (V29); creating the `.files` collection and its indexes up
  //    front lets the owner-check and the retention age-scan hit an index from the first query.
  const filesCollection = `${MEDIA_BUCKET}.files`;
  await ensureCollection(db, filesCollection);
  await ensureIndexes(db, filesCollection, GRIDFS_FILES_INDEXES);

  // 4. Seed.
  await seedDiseaseKnowledge(db);

  return {
    collections: Object.values(COLLECTIONS),
    gridfsBucket: MEDIA_BUCKET,
    seededConditions: SEED_CONDITIONS.length,
  };
}
