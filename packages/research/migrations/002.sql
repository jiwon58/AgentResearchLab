CREATE TABLE benchmark_trials (
  protocol TEXT NOT NULL, trial TEXT NOT NULL, payload TEXT NOT NULL, finished_at INTEGER NOT NULL,
  PRIMARY KEY (protocol, trial)
);
