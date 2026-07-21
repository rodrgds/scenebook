-- Align persisted Review states with the versioned Review artifact contract.
-- Legacy `unverified` rows fail closed as `blocked`; `unchanged` is the former
-- spelling of the canonical `passed` state. Keep the JSON document and indexed
-- columns in lockstep so repository reads remain schema-valid after migration.
UPDATE reviews
SET
  change_state = 'passed',
  review_json = jsonb_set(review_json, '{changeState}', '"passed"'::jsonb, true)
WHERE change_state = 'unchanged';

UPDATE reviews
SET
  change_state = 'blocked',
  review_json = jsonb_set(review_json, '{changeState}', '"blocked"'::jsonb, true)
WHERE change_state = 'unverified';

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_change_state_check;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_change_state_check
  CHECK (change_state IN ('passed', 'changed', 'broken', 'blocked'));
