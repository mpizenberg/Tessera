-- Points budgets and allocations are bigints now, so their wire JSON is the
-- tagged `{"$bigint":"…"}` rather than a plain number, and the typed record
-- decoders the refresh, validation and finalization read stored rows with
-- refuse the old form. Every stored record carrying one is rewritten into the
-- new form in place, element order kept, so no read meets the old shape and no
-- row has to wait for the walker to re-derive it.
--
-- A rewritten survey row is stamped now: a mirror following the change
-- selection receives it in the next delta. Response rows carry no stamp.
--
-- Each array is rebuilt from an ordered subquery: Turso's SQL parser rejects an
-- ORDER BY inside an aggregate's arguments.
UPDATE survey_index
SET record = json_set(record, '$.definition.questions', json((
      SELECT json_group_array(json(question))
      FROM (SELECT CASE WHEN json_extract(value, '$.type') = 'pointsAllocation'
                        THEN json_set(value, '$.budget', json_object(
                               '$bigint', CAST(json_extract(value, '$.budget') AS TEXT)))
                        ELSE value END AS question
            FROM json_each(survey_index.record, '$.definition.questions')
            ORDER BY key)))),
    changed_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE EXISTS (
  SELECT 1 FROM json_each(survey_index.record, '$.definition.questions') AS q
  WHERE json_extract(q.value, '$.type') = 'pointsAllocation');

UPDATE response
SET record = json_set(record, '$.response.answers.answers', json((
      SELECT json_group_array(json(answer))
      FROM (SELECT CASE WHEN json_extract(a.value, '$.type') = 'pointsAllocation'
                        THEN json_set(a.value, '$.allocations', json((
                               SELECT json_group_array(json(allocation))
                               FROM (SELECT json_set(p.value, '$.points',
                                              json_object('$bigint',
                                                CAST(json_extract(p.value, '$.points') AS TEXT)))
                                              AS allocation
                                     FROM json_each(a.value, '$.allocations') AS p
                                     ORDER BY p.key))))
                        ELSE a.value END AS answer
            FROM json_each(response.record, '$.response.answers.answers') AS a
            ORDER BY a.key))))
WHERE json_extract(record, '$.response.answers.type') = 'public'
  AND EXISTS (
    SELECT 1 FROM json_each(response.record, '$.response.answers.answers') AS a
    WHERE json_extract(a.value, '$.type') = 'pointsAllocation');

-- A revealed sealed response is a cursor entry, not state: an absent row is
-- decrypted again, to the same plaintext, by the next finalization pass.
DELETE FROM sealed_reveal WHERE response LIKE '%"pointsAllocation"%';
