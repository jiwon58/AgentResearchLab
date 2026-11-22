CREATE TABLE agent_seeds (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, definition TEXT NOT NULL, content_hash TEXT NOT NULL
);
CREATE TABLE resident_agents (
  id TEXT PRIMARY KEY, role TEXT NOT NULL UNIQUE, seed_id TEXT NOT NULL REFERENCES agent_seeds(id), philosophy TEXT NOT NULL, created_at INTEGER NOT NULL
);
ALTER TABLE memberships ADD COLUMN agent_id TEXT REFERENCES resident_agents(id);

CREATE TABLE collaboration_messages (
  research_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
  refs TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (research_id, task_id, kind, sender, recipient),
  FOREIGN KEY (research_id, task_id) REFERENCES tasks(research_id, id),
  FOREIGN KEY (research_id, sender) REFERENCES memberships(research_id, role),
  FOREIGN KEY (research_id, recipient) REFERENCES memberships(research_id, role)
);

CREATE TABLE operational_revisions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('policy','genome')), parent_id TEXT REFERENCES operational_revisions(id),
  benchmark_id TEXT NOT NULL REFERENCES comparisons(id), binding_id TEXT NOT NULL,
  configuration TEXT NOT NULL, evaluation TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE active_revisions (
  kind TEXT NOT NULL CHECK(kind IN ('policy','genome')), binding_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES operational_revisions(id), updated_at INTEGER NOT NULL,
  PRIMARY KEY(kind, binding_id)
);
CREATE TABLE revision_actions (
  sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, binding_id TEXT NOT NULL, action TEXT NOT NULL,
  previous_id TEXT REFERENCES operational_revisions(id), next_id TEXT REFERENCES operational_revisions(id), created_at INTEGER NOT NULL
);
CREATE TABLE approved_datasets (
  id TEXT PRIMARY KEY, source_version TEXT NOT NULL, row_count INTEGER NOT NULL, records TEXT NOT NULL, created_at INTEGER NOT NULL
);
