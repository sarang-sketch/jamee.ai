-- 0009_storage_buckets_policies.sql
--
-- The two private buckets and the path-prefix policies that make them per-farmer.
--
-- Requirements: 13.5 (both buckets private), 13.6 (each farmer's read and write restricted to
--               objects under that farmer's own path prefix)
-- Design: "0009: storage buckets and policies"; "Object path convention";
--         "The browser never deletes"
-- Depends on: V4 (the folder-extraction helper and the bucket-privacy setting name)

-- ---------------------------------------------------------------------------
-- Buckets (Requirement 13.5)
-- ---------------------------------------------------------------------------

-- V4: the privacy setting is the boolean column `public`, and buckets are private by default.
-- `false` is stated explicitly anyway, because "private" is a requirement here and a default
-- that changes upstream should break loudly rather than quietly publish a farmer's photos.
--
-- `on conflict (id) do nothing` makes re-running the migration safe. It does NOT repair a bucket
-- that already exists as public — see the assertion below, which does.
insert into storage.buckets (id, name, public)
values ('crop-images','crop-images',false),
       ('voice-messages','voice-messages',false)
on conflict (id) do nothing;

-- Requirement 13.5 is a property of the deployment, not of this INSERT. If either bucket already
-- existed as public, the `do nothing` above left it public and every farmer photo in it is
-- world-readable by URL. Fail the migration rather than continue.
do $$
begin
  if exists (
    select 1 from storage.buckets
     where id in ('crop-images','voice-messages') and public is true
  ) then
    raise exception
      'Requirement 13.5: crop-images and voice-messages must be PRIVATE. One or both already exists as a public bucket; set public = false in the Supabase dashboard before re-running.';
  end if;
end $$;

-- NO `video-inputs` BUCKET. Requirement 19 (video frame analysis) is deferred and forms no part
-- of release acceptance; the design states explicitly that this bucket is not created. Creating
-- it "for later" would be an unreferenced private bucket with no policy story.

-- ---------------------------------------------------------------------------
-- Object policies (Requirement 13.6)
-- ---------------------------------------------------------------------------

-- V4: `storage.foldername(name)` returns the object's subfolders as a text array, and Postgres
-- arrays are 1-INDEXED — so `[1]` is the first path segment, not `[0]`. Getting that wrong yields
-- NULL, which compares as NULL, which denies everything: a policy that fails closed but for the
-- wrong reason and is maddening to debug. The application-side check in src/lib/storage.ts
-- compares the SAME segment (index 0 in JavaScript), which is recorded in
-- config/verified.ts so the two boundaries cannot drift apart.
--
-- The `{user_id}` first segment does double duty: it is this RLS predicate, and it is what the
-- API-side ownership check compares against the session user (Requirements 2.5, 2.6). WhatsApp
-- media is uploaded with the SERVICE ROLE but still under the resolved profile's `{user_id}/`
-- prefix, which is what lets a farmer later read their WhatsApp images from the web history
-- through an ordinary signed URL (Requirements 12.2, 12.5).
--
-- ### Scope: `select, insert` only — NOT `for all`
--
-- The design's first draft wrote these `for all`, which grants a farmer session `delete` and
-- `update` on their own objects. No Jamee code path uses either:
--
--   * nothing is ever upserted — every path carries a fresh uuid (and V4 notes `upsert` would
--     additionally need SELECT + UPDATE, so its absence here is self-consistent);
--   * EVERY deletion runs with the service role. Requirements 8.11 and 18.9 both say so, and the
--     reason is structural rather than stylistic: the WhatsApp path has no farmer session at all,
--     so a session-scoped delete could never have been the single implementation.
--
-- So narrowing costs nothing and removes a farmer's ability to orphan a `diagnoses` row's image
-- out from under their own history view — which, after the media-lifecycle amendment, is a view
-- that reads `full_image_deleted_at` to decide what to say about a missing photo. A
-- farmer-deleted object would make that column lie.

create policy crop_images_read_own on storage.objects
  for select to authenticated
  using (bucket_id = 'crop-images'
         and (storage.foldername(name))[1] = auth.uid()::text);

create policy crop_images_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'crop-images'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy voice_messages_read_own on storage.objects
  for select to authenticated
  using (bucket_id = 'voice-messages'
         and (storage.foldername(name))[1] = auth.uid()::text);

create policy voice_messages_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'voice-messages'
              and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Object path convention, recorded here because these policies depend on it
-- ---------------------------------------------------------------------------
--
--   crop-images/{user_id}/{YYYY}/{MM}/{uuid}.{jpg|png|webp}         <- Full_Size_Image
--   crop-images/{user_id}/{YYYY}/{MM}/{uuid}.thumb.{jpg|png|webp}   <- Thumbnail_Derivative
--   voice-messages/{user_id}/{YYYY}/{MM}/{uuid}.{ext}
--
-- The thumbnail convention inserts `.thumb` immediately before the extension rather than using a
-- sibling folder, and one of the three reasons is visible right here: `(storage.foldername(name))[1]`
-- is still `{user_id}`, so BOTH objects are covered by the policies above with no new grant. A
-- convention that changed the FIRST segment would have needed a policy edit; this one is immune to
-- that class of mistake.
--
-- The other two reasons: both derivatives share an extension, because the browser produces them in
-- one re-encode pass with one output MIME type; and `.thumb.` is a single unambiguous predicate for
-- the retention sweep, which must delete originals and keep thumbnails while scanning one bucket
-- (Requirements 18.3, 18.5).
