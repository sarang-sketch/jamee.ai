-- 0010_seed_disease_knowledge.sql
--
-- The five verified knowledge-base rows. This migration is the MINIMUM half of Requirement 4.1's
-- "exactly five": 0004's check constraint and unique index make five the maximum, and these five
-- inserts make it the minimum. `scripts/check-deployment.ts` asserts count(*) = 5 to confirm both
-- held.
--
-- Requirements: 4.1 (exactly the five Verified_Conditions), 4.2 (created and populated through a
--               seed migration, with `source` populated for each row), 3.4 (Tomato Healthy
--               carries no treatment content), 17.6 (migrations create every seed row)
-- Design: "0010: seed the five verified conditions"
--
-- DEPENDS ON 0004_disease_knowledge.sql.
--
-- =============================================================================
-- ABOUT THE `source` COLUMN — read before editing any row
-- =============================================================================
--
-- Requirement 4.3 makes this table the ONLY source of agricultural content a farmer ever reads:
-- every symptom, cause, treatment and prevention sentence is rephrased from a row here, and the
-- model is forbidden from adding anything. `source` is therefore not metadata — it is the
-- provenance of advice a smallholder farmer may act on in a field.
--
-- Each citation below is a real, retrievable public extension-service publication, checked
-- 2026-09-15, named by institution, exact publication title, and URL. The design left these as
-- `<extension-service citation - fill at implementation>` on purpose and instructed that the
-- design "does not invent a citation" — the same fail-loud discipline the V-items apply to
-- third-party values, applied to agronomy.
--
-- **Do not add a row, a treatment sentence, or a prevention sentence that its cited publication
-- does not support.** An unsupported sentence here is indistinguishable, to every layer above it,
-- from verified advice — which is the exact failure the two-stage validation and the
-- rephrase-only prompt exist to prevent everywhere else.
--
-- Deliberate omissions in every `treatment` array: no product brand names, no dose figures, and
-- no spray intervals. Each says "a fungicide labelled for X, following the label rate" instead.
-- Registrations, permitted actives and rates differ by country and change between seasons, so a
-- number frozen into a migration would eventually be wrong in a way a farmer cannot detect. The
-- product label is the authority a farmer has in hand.
--
-- =============================================================================

insert into public.disease_knowledge
  (disease_name, crop, scientific_name, symptoms, causes, treatment, prevention,
   default_severity, source)
values

  -- ---------------------------------------------------------------------------
  -- Tomato Early Blight
  --
  -- On `scientific_name`: this row records `Alternaria solani`, which is what the cited WVU
  -- Extension publication states. A TAXONOMIC REVISION EXISTS and is recorded here rather than
  -- silently resolved: NC State Extension's "Early Blight of Tomato" gives the tomato pathogen as
  -- *Alternaria linariae* (= *A. tomatophila*, formerly *A. solani*), while *A. solani* remains
  -- correct for the potato row below. The two are not in conflict about the disease, only about
  -- current nomenclature, and the value here is the one its own citation supports. If this row is
  -- ever recited to NC State, change the name in the same edit.
  -- ---------------------------------------------------------------------------
  ('Tomato Early Blight','tomato','Alternaria solani',
   array['Dark brown spots with concentric rings on older, lower leaves',
         'Yellow halo around each spot',
         'Affected leaves dry and drop, starting from the bottom of the plant'],
   array['Fungal infection by Alternaria solani',
         'Warm, humid weather with leaf wetness',
         'Spores surviving on crop debris and volunteer plants'],
   array['Remove and destroy affected lower leaves',
         'Apply a protectant fungicide labelled for early blight, following the label rate',
         'Avoid overhead irrigation late in the day'],
   array['Rotate away from tomato and potato for two seasons',
         'Stake plants for airflow and mulch to limit soil splash',
         'Use certified disease-free seed and clear crop debris after harvest'],
   'moderate',
   'West Virginia University Extension, "Early Blight of Tomatoes", https://extension.wvu.edu/lawn-gardening-pests/plant-disease/fruit-vegetable-diseases/early-blight-of-tomatoes (checked 2026-09-15)'),

  -- ---------------------------------------------------------------------------
  -- Tomato Late Blight
  --
  -- Cited to Virginia Cooperative Extension ANR-6, which covers late blight on BOTH tomato and
  -- potato in one publication — so this row and the potato late blight row below share an
  -- authority, which is appropriate for one pathogen on two hosts.
  -- ---------------------------------------------------------------------------
  ('Tomato Late Blight','tomato','Phytophthora infestans',
   array['Large greasy grey-green to brown patches on leaves',
         'White fuzzy growth on leaf undersides in humid conditions',
         'Firm brown lesions on stems and fruit; rapid collapse of foliage'],
   array['Oomycete infection by Phytophthora infestans',
         'Cool, wet, humid weather',
         'Spores carried by wind and rain from nearby infected plants or tubers'],
   array['Remove and destroy infected plants immediately, do not compost them',
         'Apply a fungicide labelled for late blight without delay, following the label rate',
         'Harvest healthy fruit early if spread is rapid'],
   array['Plant resistant varieties where available',
         'Avoid overhead irrigation and crowded spacing',
         'Destroy volunteer tomato and potato plants and cull piles'],
   'high',
   'Virginia Cooperative Extension, publication ANR-6, "Late Blight of Tomato and Potato", https://pubs.ext.vt.edu/ANR/ANR-6.html (checked 2026-09-15)'),

  -- ---------------------------------------------------------------------------
  -- Tomato Healthy
  --
  -- Requirement 3.4: `treatment` is an EMPTY ARRAY, and the `healthy_has_no_treatment` check
  -- constraint in 0004 refuses any other value for this row.
  --
  -- That is what makes "a healthy classification carries no treatment content" (Property 12) hold
  -- BY CONSTRUCTION rather than by the model's cooperation: since every farmer-facing treatment
  -- sentence is composed from this column (Requirement 4.3), an empty array means there is no
  -- treatment text available to render, whatever the model returns.
  --
  -- `causes` is not empty, because a farmer reading a healthy result should be told what the
  -- result MEANS — and specifically that it is a judgement about the submitted photo, not a
  -- clean bill of health for the field.
  -- ---------------------------------------------------------------------------
  ('Tomato Healthy','tomato',null,
   array['Uniform green leaves with no spots, lesions, or wilting',
         'Normal leaf shape and size for the growth stage'],
   array['No disease detected in the submitted photo'],
   array[]::text[],
   array['Continue regular monitoring of lower leaves',
         'Keep foliage dry by watering at the base',
         'Maintain crop rotation and field sanitation'],
   'none',
   'Utah State University Extension, Vegetable Guide: Tomato, Pepper, Eggplant, https://extension.usu.edu/vegetableguide/tomato-pepper-eggplant (checked 2026-09-15)'),

  -- ---------------------------------------------------------------------------
  -- Potato Early Blight
  --
  -- The angular, vein-bounded lesion outline in `symptoms` is the field-visible difference from
  -- late blight on the same crop, which is why it is stated as its own sentence rather than folded
  -- into the first one: it is the distinction a farmer can actually make while standing in a row.
  -- ---------------------------------------------------------------------------
  ('Potato Early Blight','potato','Alternaria solani',
   array['Dark concentric-ringed lesions on older leaves',
         'Lesions bounded by leaf veins, giving an angular outline',
         'Progressive yellowing and death of lower foliage'],
   array['Fungal infection by Alternaria solani',
         'Warm temperatures with alternating wet and dry periods',
         'Inoculum surviving in soil and crop residue'],
   array['Remove severely affected foliage',
         'Apply a protectant fungicide labelled for early blight on potato, per label rate',
         'Maintain balanced nitrogen to avoid early senescence'],
   array['Rotate with non-solanaceous crops',
         'Plant certified seed tubers',
         'Bury or remove crop residue after harvest'],
   'moderate',
   'North Dakota State University Extension, "Early Blight of Potato", https://www.ndsu.edu/agriculture/extension/publications/early-blight-potato (checked 2026-09-15)'),

  -- ---------------------------------------------------------------------------
  -- Potato Late Blight
  --
  -- `default_severity` is 'high' for both late blight rows, and that is a product decision with a
  -- real consequence: late blight can collapse a crop within days in cool, wet weather, so a
  -- result that under-reported it would be actively harmful. Killing the haulm before harvest is
  -- included because tuber protection is the action that still helps once foliage is lost.
  -- ---------------------------------------------------------------------------
  ('Potato Late Blight','potato','Phytophthora infestans',
   array['Water-soaked pale green patches that turn brown-black',
         'White sporulation at lesion margins on leaf undersides in humid weather',
         'Dark firm rot on tubers'],
   array['Oomycete infection by Phytophthora infestans',
         'Cool, wet, humid conditions',
         'Infected seed tubers and wind-blown spores'],
   array['Destroy infected plants and affected tubers',
         'Apply a fungicide labelled for potato late blight promptly, per label rate',
         'Kill the haulm before harvest in a severe outbreak to protect tubers'],
   array['Plant certified, disease-free seed tubers',
         'Hill soil well to cover tubers and improve drainage',
         'Remove cull piles and volunteer plants'],
   'high',
   'North Dakota State University Extension, "Late Blight in Potato", https://www.ndsu.edu/agriculture/extension/publications/late-blight-potato (checked 2026-09-15)')

-- Idempotent re-run. `disease_name` is unique (0004), so this makes running the whole migration
-- directory twice a no-op rather than a unique violation — which matters because the documented
-- deployment step is "run supabase/migrations/* in order", and an operator re-running it after a
-- partial failure should not have to reason about which files already applied.
--
-- Note what this does NOT do: it does not UPDATE an existing row. Changing knowledge-base content
-- is a new migration, deliberately, so an edit to advice a farmer may have acted on leaves a
-- record instead of quietly replacing it.
on conflict (disease_name) do nothing;

-- Requirement 4.1's minimum, asserted here rather than only in the deployment script. If a future
-- edit drops a row from the VALUES list, the failure should surface in the migration that caused
-- it and not in a test run later.
do $$
declare
  v_count integer;
  v_missing_source integer;
begin
  select count(*) into v_count from public.disease_knowledge;
  if v_count <> 5 then
    raise exception
      'Requirement 4.1: disease_knowledge must hold exactly 5 rows after seeding, found %', v_count;
  end if;

  -- Requirement 4.2: `source` is `not null` in 0004, but not null is not the same as populated.
  select count(*) into v_missing_source
    from public.disease_knowledge where btrim(source) = '';
  if v_missing_source > 0 then
    raise exception
      'Requirement 4.2: every disease_knowledge row must carry a non-empty source, % row(s) are blank', v_missing_source;
  end if;
end $$;
