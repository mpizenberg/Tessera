-- Digest of the materialized snapshot rows this envelope was published with.
-- The refresh compares the next run's digest against it and, on a match, skips
-- the whole row reconcile (upserts and tombstone sweeps — the one refresh cost
-- that grows with corpus size) in favour of republishing the envelope alone.
-- NULL on existing rows means "unknown", which never matches, so the first
-- refresh after this migration reconciles fully and banks the digest.
ALTER TABLE snapshot_meta ADD COLUMN payload_digest TEXT;

-- Validated responses still awaiting an enrichment retry when the run
-- recorded itself. Banked so /api/health serves the number from the latest
-- run row instead of counting the validated_response table per request.
-- NULL on rows recorded before the column existed.
ALTER TABLE refresh_run ADD COLUMN validation_backlog INTEGER;
