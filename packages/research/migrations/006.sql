CREATE TABLE approved_ml_datasets (
  id TEXT PRIMARY KEY, source_version TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('classification','regression')),
  row_count INTEGER NOT NULL, target TEXT NOT NULL, features TEXT NOT NULL, records TEXT NOT NULL, created_at INTEGER NOT NULL
);
