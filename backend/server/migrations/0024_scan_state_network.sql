-- Bank which network the walker's rows came from.
--
-- The store had no idea what chain it mirrored: a process configured for one
-- network against a database walked for another would list the wrong chain,
-- integrate its records and sweep the real ones away as rolled back. The
-- refresh now stamps the network next to the cursor and refuses to run when
-- the banked one disagrees with its config. NULL is a row banked before this
-- column existed; the next run stamps it.
ALTER TABLE scan_state ADD COLUMN network TEXT;
