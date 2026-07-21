-- A digest identifies bytes, not their interpretation. Preserve both
-- identities so one upload can contain the same bytes under distinct, safe
-- media types without one row overwriting or selecting the other.
ALTER TABLE artifact_objects
  DROP CONSTRAINT artifact_objects_pkey;

ALTER TABLE artifact_objects
  ADD CONSTRAINT artifact_objects_pkey PRIMARY KEY (upload_id, sha256, media_type);
