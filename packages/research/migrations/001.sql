CREATE TABLE research (
  id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL, plan TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE proposals (
  research_id TEXT NOT NULL REFERENCES research(id), id TEXT NOT NULL, decision TEXT NOT NULL,
  reason TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (research_id, id)
);
CREATE TABLE tasks (
  research_id TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, token TEXT, lease_until INTEGER,
  result TEXT, PRIMARY KEY (research_id, id),
  FOREIGN KEY (research_id, id) REFERENCES proposals(research_id, id)
);
CREATE UNIQUE INDEX one_active_session_task ON tasks(research_id, role) WHERE status = 'RUNNING';
CREATE TABLE dependencies (
  research_id TEXT NOT NULL, task_id TEXT NOT NULL, prerequisite_id TEXT NOT NULL,
  PRIMARY KEY (research_id, task_id, prerequisite_id),
  FOREIGN KEY (research_id, task_id) REFERENCES tasks(research_id, id),
  FOREIGN KEY (research_id, prerequisite_id) REFERENCES tasks(research_id, id)
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research(id),
  kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX research_event_order ON events(research_id, sequence);
CREATE TABLE memberships (
  research_id TEXT NOT NULL REFERENCES research(id), role TEXT NOT NULL,
  session_key TEXT NOT NULL UNIQUE, session_ref TEXT, genome TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'CREATED', PRIMARY KEY (research_id, role)
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY, research_id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private','shared')), payload TEXT NOT NULL,
  source TEXT NOT NULL, validation TEXT NOT NULL, genome TEXT NOT NULL, created_at INTEGER NOT NULL,
  FOREIGN KEY (research_id, owner) REFERENCES memberships(research_id, role)
);
CREATE INDEX scoped_memory ON memories(research_id, owner, visibility, created_at);
CREATE TABLE comparisons (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
