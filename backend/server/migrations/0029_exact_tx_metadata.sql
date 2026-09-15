-- Metadata banked before this migration was parsed by `JSON.parse`, which
-- rounds integers above 2^53, and written back by `JSON.stringify`, which
-- keeps the rounded digits (or an exponent form from 22 digits on). Read
-- through the exact parser now in use, such a row would decode to wrong
-- values without any error, and no row says how it was parsed. Refetching the
-- whole cache is cheap: the scan asks again for every hash it lists.
DELETE FROM tx_metadata_cache;
