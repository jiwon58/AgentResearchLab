CREATE TABLE research_branches (
  research_id TEXT PRIMARY KEY REFERENCES research(id), parent_id TEXT NOT NULL REFERENCES research(id),
  baseline_task_id TEXT NOT NULL, baseline_hypotheses TEXT NOT NULL, independent_partition INTEGER NOT NULL,
  FOREIGN KEY (parent_id, baseline_task_id) REFERENCES tasks(research_id, id)
);
CREATE INDEX research_branches_parent ON research_branches(parent_id);
