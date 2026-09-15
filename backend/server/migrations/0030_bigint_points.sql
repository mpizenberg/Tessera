-- Points budgets and allocations are bigints now, so their wire JSON is the
-- tagged `{"$bigint":"…"}` rather than a plain number, and the typed record
-- decoders the refresh, validation and finalization read stored rows with
-- refuse the old form. Every stored record carrying one is rewritten into the
-- new form in place, element order kept, so no read meets the old shape and no
-- row has to wait for the walker to re-derive it.
--
-- A rewritten survey row is stamped now: a mirror following the change
-- selection receives it in the next delta. Response rows carry no stamp.
UPDATE survey_index
SET record = json_set(record, '$.definition.questions', json((
      SELECT json_group_array(json(
               CASE WHEN json_extract(q.value, '$.type') = 'pointsAllocation'
                    THEN json_set(q.value, '$.budget', json_object(
                           '$bigint', CAST(json_extract(q.value, '$.budget') AS TEXT)))
                    ELSE q.value END)
             ORDER BY q.key)
      FROM json_each(survey_index.record, '$.definition.questions') AS q))),
    changed_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE EXISTS (
  SELECT 1 FROM json_each(survey_index.record, '$.definition.questions') AS q
  WHERE json_extract(q.value, '$.type') = 'pointsAllocation');

UPDATE response
SET record = json_set(record, '$.response.answers.answers', json((
      SELECT json_group_array(json(
               CASE WHEN json_extract(a.value, '$.type') = 'pointsAllocation'
                    THEN json_set(a.value, '$.allocations', json((
                           SELECT json_group_array(json(json_set(p.value, '$.points',
                                    json_object('$bigint',
                                      CAST(json_extract(p.value, '$.points') AS TEXT))))
                                  ORDER BY p.key)
                           FROM json_each(a.value, '$.allocations') AS p)))
                    ELSE a.value END)
             ORDER BY a.key)
      FROM json_each(response.record, '$.response.answers.answers') AS a)))
WHERE json_extract(record, '$.response.answers.type') = 'public'
  AND EXISTS (
    SELECT 1 FROM json_each(response.record, '$.response.answers.answers') AS a
    WHERE json_extract(a.value, '$.type') = 'pointsAllocation');

-- A revealed sealed response is a cursor entry, not state: an absent row is
-- decrypted again, to the same plaintext, by the next finalization pass.
DELETE FROM sealed_reveal WHERE response LIKE '%"pointsAllocation"%';
