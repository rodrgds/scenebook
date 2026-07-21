ALTER TABLE cta_submissions
  ADD COLUMN IF NOT EXISTS cta_id text;

-- Before canonical multi-CTA submission identity, the API only accepted the
-- deprecated single Step.cta. Backfill those rows with its deterministic
-- projected identity while preserving the IdSchema length bound.
UPDATE cta_submissions
SET cta_id = CASE
  WHEN step_id IS NULL OR step_id = '' THEN 'legacy-cta'
  ELSE left(step_id, 124) || '-cta'
END
WHERE cta_id IS NULL;

ALTER TABLE cta_submissions
  ALTER COLUMN cta_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cta_submissions_cta_id_guard'
      AND conrelid = 'cta_submissions'::regclass
  ) THEN
    ALTER TABLE cta_submissions
      ADD CONSTRAINT cta_submissions_cta_id_guard
      CHECK (
        char_length(cta_id) BETWEEN 1 AND 128
        AND cta_id ~ '^[a-z0-9][a-z0-9._:-]*$'
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS cta_submissions_subject_cta_idx
  ON cta_submissions(release_id, scene_id, step_id, cta_id, created_at);
