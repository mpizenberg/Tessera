-- A native script a response's transaction does not carry is looked up by
-- hash, and counts if it is on chain by the end of the survey's end epoch.
-- The emitter looks a bounded number of times while the survey is open (the
-- lookups are banked per script hash, 0034), then waits for that epoch to be
-- final and looks once more. Non-NULL marks a verdict parked for that last
-- lookup, holding the misses counted; NULL otherwise.
ALTER TABLE validated_response ADD COLUMN script_lookups INTEGER;

-- The final lookup reads the surveys with a parked verdict each refresh; only
-- those rows carry a count, so the partial index stays small.
CREATE INDEX validated_response_script_lookups
  ON validated_response (survey_key) WHERE script_lookups IS NOT NULL;
