-- Existing uploaded-image URLs were saved as http://unplug-ecosystem.onrender.com/...
-- because req.protocol reported 'http' behind Render's TLS proxy (fixed in code +
-- trust proxy). On the https site those http:// images are blocked as mixed content,
-- so covers on articles, events and directory profiles show blank. This rewrites
-- every stored http:// onrender URL to https:// so they load. Idempotent: once a
-- value is https:// it no longer matches the http:// filter, so re-running is a no-op.

-- 1) Every scalar text / varchar column in the public schema. Covers banner_image_url,
--    image_url, cover_image_url, feature_image_url, photo_url, poster_image_url,
--    profile_image_url, youtube_image_url, manual_image_url, and any body/HTML fields
--    that embed an uploaded image — without having to enumerate each table by hand.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'            -- skip views
       AND c.is_updatable = 'YES'
       AND c.data_type IN ('text', 'character varying', 'character')
  LOOP
    EXECUTE format(
      'UPDATE public.%I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
      r.table_name, r.column_name, r.column_name,
      'http://unplug-ecosystem.onrender.com', 'https://unplug-ecosystem.onrender.com',
      r.column_name, 'http://unplug-ecosystem.onrender.com%'
    );
  END LOOP;
END $$;

-- 2) articles.gallery_images is TEXT[] (an array), which the scalar loop above skips.
UPDATE articles
   SET gallery_images = (
     SELECT array_agg(
       replace(img, 'http://unplug-ecosystem.onrender.com', 'https://unplug-ecosystem.onrender.com')
     )
     FROM unnest(gallery_images) AS img
   )
 WHERE gallery_images IS NOT NULL
   AND array_to_string(gallery_images, ',') LIKE '%http://unplug-ecosystem.onrender.com%';
