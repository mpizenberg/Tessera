-- Record the governance action each response's proof verdict was evaluated
-- against (mechanism B's linking action, or NULL for a standalone survey).
-- Koios resolves an action's meta_json anchor lazily, and a gov-links fetch can
-- fail transiently, so a survey's link set can change after the first
-- validation. Persisting the link used lets a later refresh detect the change
-- and re-evaluate the verdict instead of freezing a stale one.
ALTER TABLE validated_response ADD COLUMN linked_action_id TEXT;
