-- 0005_gin_fastupdate.sql — the GIN index on journal_entries.entity_refs served every entity lookup through its
-- fastupdate pending list: inserts (ingestion at 20+ entries/s) park new keys in a pending list of up to
-- gin_pending_list_limit (4 MB = 512 pages) that every `entity_refs @> …` lookup must scan in full until a VACUUM
-- or gin_clean_pending_list() merges it (measured under PILOT-09: 322 pending pages, 326 index buffers and 5-12 ms
-- per lookup; 4 buffers / 0.24 ms after the merge). With fastupdate off each insert updates the index directly
-- (a few page writes per entry) and lookups stay at a few pages. Additive, semantics unchanged (ADR-0008 follow-up).
ALTER INDEX journal_entries_entity_idx SET (fastupdate = off);
SELECT gin_clean_pending_list('journal_entries_entity_idx'::regclass);
