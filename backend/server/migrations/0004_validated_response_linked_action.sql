-- Record the epoch-aligned governance-action set each response's proof verdict
-- was evaluated against: the sorted, comma-joined action ids (a single id in the
-- common case), or NULL for a standalone survey. Any action kind may link a
-- survey and several may link the same one (CIP-179 v5). Koios resolves an
-- action's meta_json anchor lazily, and a gov-links fetch can fail transiently,
-- so a survey's link set can change after the first validation. Persisting the
-- set used lets a later refresh detect the change and re-evaluate the verdict
-- instead of freezing a stale one.
ALTER TABLE validated_response ADD COLUMN linked_action_id TEXT;
