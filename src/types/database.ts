/**
 * Database types for the `public` schema.
 *
 * Requirements: 17.8 (the codebase compiles under strict mode with no type errors)
 * Depends on: V1
 *
 * =============================================================================
 * HAND-AUTHORED, PENDING REGENERATION — read this before editing
 * =============================================================================
 *
 * Task 4.10 asks for this file to be produced by the Supabase type generator run against the
 * migrated database. **That could not be done here: generating requires a live Supabase project,
 * and creating one is an external account step that `docs/DEPLOYMENT.md` owns (step 1), not an
 * implementation task.** So this file was written BY HAND to match
 * `supabase/migrations/0001`–`0010` exactly, in the shape the generator emits.
 *
 * Consequences, stated plainly rather than papered over:
 *
 *  - It is correct only insofar as it matches those migrations. It is not derived from them, so a
 *    migration edit that forgets this file compiles fine and fails at runtime.
 *  - `docs/DEPLOYMENT.md` step 3 therefore carries `supabase gen types typescript` as an ordered
 *    step, and its output REPLACES this file. Diffing the generated output against this file is a
 *    free check on the migrations, and any difference is a real finding.
 *  - Everything below is annotated with the migration and column it mirrors, so that diff is
 *    readable rather than a wall of churn.
 *
 * The generator's own conventions are followed deliberately, including the ones that look odd:
 * `Insert` omits columns with defaults, `Update` makes everything optional, `Relationships` is
 * present but empty (Jamee builds no PostgREST embedded selects), and enum-like `text` columns are
 * typed as string unions matching their check constraints — which the real generator does not do,
 * and which is the one deliberate improvement over its output. Keep it: it turns
 * `channel: 'whatsap'` into a compile error instead of a constraint violation at runtime.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/* -------------------------------------------------------------------------- */
/* Check-constraint unions — mirrored from the migrations, not from schemas.ts */
/* -------------------------------------------------------------------------- */

/**
 * These intentionally DUPLICATE the unions in `src/lib/schemas.ts` instead of importing them.
 *
 * The generator has no knowledge of the application's Zod schemas, so importing here would make
 * this file un-regenerable — the next `supabase gen types` run would silently drop the import and
 * widen every column to `string`. Keeping them local means a regeneration produces a readable diff
 * and the domain types stay the single source for the APPLICATION, while these stay a description
 * of the DATABASE. The unit test in `tests/unit/database-types.test.ts` asserts the two agree.
 */
type DbLanguage = 'en' | 'hi' | 'mr';
type DbChannel = 'web' | 'whatsapp';
type DbSeverity = 'none' | 'low' | 'moderate' | 'high';
type DbCrop = 'tomato' | 'potato';
type DbOperation = 'image' | 'chat' | 'voice';
type DbWindowKind = 'day' | 'minute';
type DbMessageRole = 'farmer' | 'jamee';
type DbInputKind = 'text' | 'voice' | 'image';
type DbDiagnosisStatus = 'identified' | 'unknown';
type DbModelProvider = 'gemini' | 'groq';
/** `usage_logs` additionally allows 'none': a quota decline reached no provider. */
type DbUsageProvider = 'gemini' | 'groq' | 'none';
/** `rate_limited` was added by `0011_usage_logs_audit_vocabulary.sql` (Requirement 13.8). */
type DbUsageOutcome =
  | 'success'
  | 'inconclusive'
  | 'validation_rejected'
  | 'provider_error'
  | 'timeout'
  | 'quota_declined'
  | 'rate_limited'
  | 'duplicate_ignored';
/**
 * `usage_logs.rejection_reason` only — no other table carries the column.
 *
 * A SUPERSET of the application's `RejectionReason`: `rephrase_rejected` was added by
 * `0011_usage_logs_audit_vocabulary.sql` and is audit-only, so it has no farmer-facing copy. The
 * application union it mirrors is `usageRejectionReasonSchema`, not `rejectionReasonSchema`.
 */
type DbRejectionReason =
  | 'not_json'
  | 'missing_field'
  | 'confidence_out_of_range'
  | 'invalid_severity'
  | 'unverified_condition'
  | 'model_unclear'
  | 'model_no_plant'
  | 'rephrase_rejected';
type DbVerifiedCondition =
  | 'Tomato Early Blight'
  | 'Tomato Late Blight'
  | 'Tomato Healthy'
  | 'Potato Early Blight'
  | 'Potato Late Blight';
type DbWhatsappInboundStatus = 'received' | 'processed' | 'failed' | 'rejected';

export interface Database {
  public: {
    Tables: {
      /* ------------------------------------------------------------------ */
      /* 0002_profiles.sql                                                   */
      /* ------------------------------------------------------------------ */
      profiles: {
        Row: {
          id: string;
          phone: string;
          display_name: string | null;
          language: DbLanguage;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          /** No default: `id` references `auth.users(id)` and is always supplied. */
          id: string;
          phone: string;
          display_name?: string | null;
          language?: DbLanguage;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          phone?: string;
          display_name?: string | null;
          language?: DbLanguage;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      /* ------------------------------------------------------------------ */
      /* 0003_conversations_messages.sql                                     */
      /* ------------------------------------------------------------------ */
      conversations: {
        Row: {
          id: string;
          user_id: string;
          channel: DbChannel;
          title: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          channel: DbChannel;
          title?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          channel?: DbChannel;
          title?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      messages: {
        Row: {
          id: string;
          conversation_id: string;
          /** Denormalized from the conversation so RLS is a single-column predicate. */
          user_id: string;
          role: DbMessageRole;
          content: string;
          language: DbLanguage;
          channel: DbChannel;
          input_kind: DbInputKind;
          /** Storage path of the recording; usually points at an object already deleted (8.9). */
          transcript_of: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          user_id: string;
          role: DbMessageRole;
          content: string;
          language: DbLanguage;
          channel: DbChannel;
          input_kind?: DbInputKind;
          transcript_of?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          user_id?: string;
          role?: DbMessageRole;
          content?: string;
          language?: DbLanguage;
          channel?: DbChannel;
          input_kind?: DbInputKind;
          transcript_of?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };

      /* ------------------------------------------------------------------ */
      /* 0004_disease_knowledge.sql + 0010 seed                              */
      /* ------------------------------------------------------------------ */
      disease_knowledge: {
        Row: {
          id: string;
          disease_name: DbVerifiedCondition;
          crop: DbCrop;
          scientific_name: string | null;
          symptoms: string[];
          causes: string[];
          /** Empty array for `Tomato Healthy` — `healthy_has_no_treatment` (Requirement 3.4). */
          treatment: string[];
          prevention: string[];
          default_severity: DbSeverity;
          /** Requirement 4.2 — `not null`; provenance per row. */
          source: string;
          created_at: string;
          updated_at: string;
        };
        /**
         * Present because the generator emits it, NOT because Jamee ever inserts here.
         * Requirement 13.4 restricts writes to migrations run with the service-role key, and
         * `disease_knowledge` has no insert/update/delete policy at all.
         */
        Insert: {
          id?: string;
          disease_name: DbVerifiedCondition;
          crop: DbCrop;
          scientific_name?: string | null;
          symptoms: string[];
          causes: string[];
          treatment: string[];
          prevention: string[];
          default_severity: DbSeverity;
          source: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          disease_name?: DbVerifiedCondition;
          crop?: DbCrop;
          scientific_name?: string | null;
          symptoms?: string[];
          causes?: string[];
          treatment?: string[];
          prevention?: string[];
          default_severity?: DbSeverity;
          source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      /* ------------------------------------------------------------------ */
      /* 0005_diagnoses.sql                                                  */
      /* ------------------------------------------------------------------ */
      diagnoses: {
        Row: {
          id: string;
          user_id: string;
          conversation_id: string;
          status: DbDiagnosisStatus;
          /** Null on the inconclusive branch — `diagnoses_unknown_shape` (Requirement 6.5). */
          disease_name: DbVerifiedCondition | null;
          knowledge_id: string | null;
          /**
           * `numeric(4,3)`. PostgREST returns numeric as a NUMBER in JSON, so this is `number`
           * rather than `string` — the generator's own choice, kept.
           */
          confidence: number | null;
          severity: DbSeverity;
          explanation: string;
          language: DbLanguage;
          needs_expert: boolean;
          channel: DbChannel;
          image_bucket: 'crop-images';
          image_path: string;
          /** Requirement 18.7 — stamped by the sweep; null while the original survives. */
          full_image_deleted_at: string | null;
          model_provider: DbModelProvider;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          conversation_id: string;
          status: DbDiagnosisStatus;
          disease_name?: DbVerifiedCondition | null;
          knowledge_id?: string | null;
          confidence?: number | null;
          severity: DbSeverity;
          explanation: string;
          language: DbLanguage;
          needs_expert?: boolean;
          channel: DbChannel;
          image_bucket: 'crop-images';
          image_path: string;
          full_image_deleted_at?: string | null;
          model_provider: DbModelProvider;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          conversation_id?: string;
          status?: DbDiagnosisStatus;
          disease_name?: DbVerifiedCondition | null;
          knowledge_id?: string | null;
          confidence?: number | null;
          severity?: DbSeverity;
          explanation?: string;
          language?: DbLanguage;
          needs_expert?: boolean;
          channel?: DbChannel;
          image_bucket?: 'crop-images';
          image_path?: string;
          full_image_deleted_at?: string | null;
          model_provider?: DbModelProvider;
          created_at?: string;
        };
        Relationships: [];
      };

      /* ------------------------------------------------------------------ */
      /* 0006_usage_logs.sql                                                 */
      /* ------------------------------------------------------------------ */
      usage_logs: {
        Row: {
          id: string;
          user_id: string;
          operation: DbOperation;
          channel: DbChannel;
          model_provider: DbUsageProvider | null;
          outcome: DbUsageOutcome;
          used_fallback: boolean;
          rejection_reason: DbRejectionReason | null;
          quota_spent: boolean;
          latency_ms: number | null;
          prompt_version: string | null;
          conversation_id: string | null;
          diagnosis_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          operation: DbOperation;
          channel: DbChannel;
          model_provider?: DbUsageProvider | null;
          outcome: DbUsageOutcome;
          used_fallback?: boolean;
          rejection_reason?: DbRejectionReason | null;
          quota_spent?: boolean;
          latency_ms?: number | null;
          prompt_version?: string | null;
          conversation_id?: string | null;
          diagnosis_id?: string | null;
          created_at?: string;
        };
        /** Present for shape only — the table is append-only (0006 grants no update policy). */
        Update: {
          id?: string;
          user_id?: string;
          operation?: DbOperation;
          channel?: DbChannel;
          model_provider?: DbUsageProvider | null;
          outcome?: DbUsageOutcome;
          used_fallback?: boolean;
          rejection_reason?: DbRejectionReason | null;
          quota_spent?: boolean;
          latency_ms?: number | null;
          prompt_version?: string | null;
          conversation_id?: string | null;
          diagnosis_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };

      /* ------------------------------------------------------------------ */
      /* 0007_counters_and_quota_fn.sql                                      */
      /* ------------------------------------------------------------------ */
      counters: {
        Row: {
          user_id: string;
          operation: DbOperation;
          window_kind: DbWindowKind;
          window_key: string;
          used: number;
          updated_at: string;
        };
        /**
         * Shape only. Writes go through `counter_try_increment` / `counter_decrement`, which are
         * `security definer` precisely because this table grants `authenticated` no write policy.
         */
        Insert: {
          user_id: string;
          operation: DbOperation;
          window_kind: DbWindowKind;
          window_key: string;
          used?: number;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          operation?: DbOperation;
          window_kind?: DbWindowKind;
          window_key?: string;
          used?: number;
          updated_at?: string;
        };
        Relationships: [];
      };

      /* ------------------------------------------------------------------ */
      /* 0008_whatsapp_inbound.sql                                           */
      /* ------------------------------------------------------------------ */
      whatsapp_inbound: {
        Row: {
          provider_message_id: string;
          from_phone: string;
          user_id: string | null;
          message_type: string;
          status: DbWhatsappInboundStatus;
          received_at: string;
          completed_at: string | null;
        };
        Insert: {
          provider_message_id: string;
          from_phone: string;
          user_id?: string | null;
          message_type: string;
          status?: DbWhatsappInboundStatus;
          received_at?: string;
          completed_at?: string | null;
        };
        Update: {
          provider_message_id?: string;
          from_phone?: string;
          user_id?: string | null;
          message_type?: string;
          status?: DbWhatsappInboundStatus;
          received_at?: string;
          completed_at?: string | null;
        };
        Relationships: [];
      };
    };

    Views: Record<never, never>;

    /* -------------------------------------------------------------------- */
    /* Functions — 0007                                                      */
    /* -------------------------------------------------------------------- */
    Functions: {
      /**
       * Returns the new count, or **null** when already at the limit. That null is the at-limit
       * signal, so `Returns` must stay nullable — narrowing it to `number` would make the
       * decline branch unreachable in TypeScript while still happening at runtime.
       */
      counter_try_increment: {
        Args: {
          p_user: string;
          p_operation: DbOperation;
          p_window_kind: DbWindowKind;
          p_window_key: string;
          p_limit: number;
        };
        Returns: number | null;
      };
      /** Null when no row matched, i.e. already at zero. Never returns a negative. */
      counter_decrement: {
        Args: {
          p_user: string;
          p_operation: DbOperation;
          p_window_kind: DbWindowKind;
          p_window_key: string;
        };
        Returns: number | null;
      };
      /** `coalesce(..., 0)`, so an absent row reads as 0 rather than null. */
      counter_used: {
        Args: {
          p_user: string;
          p_operation: DbOperation;
          p_window_kind: DbWindowKind;
          p_window_key: string;
        };
        Returns: number;
      };
      counter_prune_minute_windows: {
        Args: { p_older_than_minutes?: number };
        Returns: number;
      };
    };

    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}

/* -------------------------------------------------------------------------- */
/* Row/Insert aliases, for call sites that would otherwise repeat the path     */
/* -------------------------------------------------------------------------- */

type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type TablesInsert<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Update'];
export type Functions<T extends keyof PublicSchema['Functions']> = PublicSchema['Functions'][T];

export type ProfileRow = Tables<'profiles'>;
export type ConversationRow = Tables<'conversations'>;
export type MessageRow = Tables<'messages'>;
export type DiseaseKnowledgeRow = Tables<'disease_knowledge'>;
export type DiagnosisRow = Tables<'diagnoses'>;
export type UsageLogRow = Tables<'usage_logs'>;
export type CounterRow = Tables<'counters'>;
export type WhatsappInboundRow = Tables<'whatsapp_inbound'>;
