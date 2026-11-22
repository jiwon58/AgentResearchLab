CREATE TABLE argument_graph_versions (
  research_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (research_id, task_id),
  FOREIGN KEY (research_id, task_id) REFERENCES tasks(research_id, id)
);
CREATE TABLE argument_nodes (
  research_id TEXT NOT NULL, task_id TEXT NOT NULL, id TEXT NOT NULL,
  kind TEXT NOT NULL, value TEXT NOT NULL, evidence_ids TEXT NOT NULL,
  agent TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (research_id, task_id, id),
  FOREIGN KEY (research_id, task_id) REFERENCES argument_graph_versions(research_id, task_id)
);
CREATE TABLE argument_edges (
  research_id TEXT NOT NULL, task_id TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
  relation TEXT NOT NULL, evidence_ids TEXT NOT NULL, agent TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (research_id, task_id, id),
  FOREIGN KEY (research_id, task_id, source) REFERENCES argument_nodes(research_id, task_id, id),
  FOREIGN KEY (research_id, task_id, target) REFERENCES argument_nodes(research_id, task_id, id)
);
CREATE TABLE scientific_sim (
  research_id TEXT NOT NULL, task_id TEXT NOT NULL, category TEXT NOT NULL, subject TEXT NOT NULL,
  evidence_ids TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (research_id, task_id, category, subject),
  FOREIGN KEY (research_id, task_id) REFERENCES tasks(research_id, id)
);
CREATE INDEX scientific_sim_category ON scientific_sim(category, research_id, task_id);
