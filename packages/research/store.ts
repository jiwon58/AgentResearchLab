import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { actionRoles, availableActions, hash, parseProposal, philosophies, projectRoles, researchRequirements, rolePhilosophies, snapshotRevisions, type Action, type Decision, type Plan, type Proposal,
  type Role, type RunStatus, type Task, type TaskStatus } from './contracts.ts';
import type { Finding, Graph, GraphEdge, GraphNode } from '../scientific-reasoning/schema.ts';
import { readRevisionProof, type RevisionKind, type RevisionConfiguration } from './revisions.ts';
import { parseMeasurements, type DataSnapshot, type Hypothesis } from './science.ts';

type Parameter = string | number | null;
interface Statement {
  run(...args: Parameter[]): { changes: number | bigint };
  get(...args: Parameter[]): unknown;
  all(...args: Parameter[]): unknown[];
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

export async function openStore(path: string): Promise<ResearchStore> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  if (Object.hasOwn(process.versions, 'bun')) {
    const moduleName = 'bun:sqlite';
    const { Database } = await import(moduleName);
    return new ResearchStore(new Database(path));
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new ResearchStore(new DatabaseSync(path) as Database);
}

export interface Run { id: string; objective: string; status: RunStatus; plan: Plan }
interface RunRow extends Omit<Run, 'plan'> { plan: string }
interface TaskRow extends Omit<Task, 'proposal' | 'result'> { payload: string; result: string | null }
interface Member {
  role: Role; agent_id: string | null; session_key: string; session_ref: string | null; genome: string; lifecycle: string;
}
interface EventRow { sequence: number; kind: string; payload: string; created_at: number }
export interface Receipt { decision: Decision; reason: string }
export interface Claim { task: Task; token: string }
export interface TaskOutcome { result: unknown; followups?: unknown[]; graph?: Graph; findings?: Finding[] }
interface MessageRecord { task_id: string; kind: 'TASK_DELEGATED' | 'TASK_RESULT'; sender: Role; recipient: Role; refs: string; created_at: number }

const taskSelect = `SELECT t.*, p.payload FROM tasks t JOIN proposals p ON p.research_id=t.research_id AND p.id=t.id`;

function decodeTask(row: TaskRow): Task {
  const { id, research_id, role, action, status, attempt, payload, result } = row;
  return { id, research_id, role, action, status, attempt, proposal: JSON.parse(payload),
    ...(result === null ? {} : { result: JSON.parse(result) }) };
}

export class ResearchStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.transaction(() => {
      const version = this.get<{ user_version: number }>('PRAGMA user_version')?.user_version;
      if (version === undefined || version < 0 || version > 5) throw new Error('Unsupported database schema');
      for (const migration of [1, 2, 3, 4, 5].slice(version)) {
        const filename = String(migration).padStart(3, '0');
        db.exec(readFileSync(new URL(`./migrations/${filename}.sql`, import.meta.url), 'utf8'));
        db.exec(`PRAGMA user_version=${migration}`);
      }
      if (version < 4) {
        const existing = this.all<{ role: Role }>('SELECT DISTINCT role FROM memberships');
        for (const { role } of existing) this.write('UPDATE memberships SET agent_id=? WHERE role=?', this.resident(role), role);
      }
    });
  }

  private get<T>(sql: string, ...args: Parameter[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined ?? undefined;
  }
  private all<T>(sql: string, ...args: Parameter[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  private write(sql: string, ...args: Parameter[]): number { return Number(this.db.prepare(sql).run(...args).changes); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private event(project: string, kind: string, payload: unknown, at = Date.now()) {
    this.write('INSERT INTO events(research_id,kind,payload,created_at) VALUES(?,?,?,?)', project, kind, JSON.stringify(payload), at);
  }

  close() { this.db.close(); }

  private resident(role: Role) {
    const seedId = `seed-v1:${role}`;
    const definition = { version: 1, role, philosophy: rolePhilosophies[role].map(name => [name, philosophies[name]]),
      allowedActions: Object.entries(actionRoles).filter(([, owner]) => owner === role).map(([action]) => action), toolBoundary: 'NO_UNAPPROVED_TOOLS' };
    const contentHash = hash(definition);
    this.write('INSERT OR IGNORE INTO agent_seeds VALUES(?,?,?,?)', seedId, role, JSON.stringify(definition), contentHash);
    if (this.get<{ content_hash: string }>('SELECT content_hash FROM agent_seeds WHERE id=?', seedId)?.content_hash !== contentHash) {
      throw new Error('Immutable resident seed does not match the current seed version');
    }
    this.write('INSERT OR IGNORE INTO resident_agents VALUES(?,?,?,?,?)', randomUUID(), role, seedId,
      JSON.stringify(rolePhilosophies[role]), Date.now());
    return this.get<{ id: string }>('SELECT id FROM resident_agents WHERE role=?', role)!.id;
  }

  create(objective: string, plan: Plan): Run {
    return this.transaction(() => this.createRun(objective, plan));
  }

  private createRun(objective: string, plan: Plan): Run {
    if (typeof objective !== 'string' || objective.trim().length < 3 || objective.length > 2000) throw new Error('Invalid objective');
    const id = randomUUID();
    this.write('INSERT INTO research VALUES(?,?,?,?,?)', id, objective.trim(), 'ACTIVE', JSON.stringify(plan), Date.now());
    for (const role of projectRoles(plan)) {
      this.write('INSERT INTO memberships(research_id,role,agent_id,session_key,genome) VALUES(?,?,?,?,?)', id, role,
        this.resident(role), randomUUID(), (role === 'hypothesis' ? plan.genome?.id : undefined) ?? `seed-v1:${role}`);
    }
    this.event(id, 'research.created', { planHash: plan.hash });
    return this.run(id);
  }

  branchResearch(parent: string, objective?: string): Run {
    return this.transaction(() => {
      const previous = this.run(parent);
      const tasks = this.tasks(parent);
      const baseline = tasks.findLast(task => task.action === 'GENERATE_HYPOTHESES' && task.status === 'DONE');
      if (previous.plan.reasoning !== 'council-v1' || previous.status === 'ACTIVE' || tasks.some(task => task.status === 'RUNNING') || !baseline) {
        throw new Error('Branching requires an inactive Council run with recorded hypotheses');
      }
      const source = (baseline.result as { hypotheses: Hypothesis[] }).hypotheses;
      let plan = previous.plan;
      if (!plan.dataset) {
        let seed = Number.parseInt(hash(randomUUID()).slice(0, 8), 16);
        if (seed === plan.seed) seed = (seed + 1) >>> 0;
        plan = snapshotRevisions(plan, { seed });
      }
      const child = this.createRun(objective ?? `${previous.objective.slice(0, 1980)} · 분기`, plan);
      this.write('INSERT INTO research_branches VALUES(?,?,?,?,?)', child.id, previous.id, baseline.id, JSON.stringify(source), Number(!plan.dataset));
      this.event(child.id, 'research.branched', { parent: previous.id, baselineTask: baseline.id, independentPartition: !plan.dataset });
      return child;
    });
  }

  branchContext(project: string) {
    const row = this.get<{ parent_id: string; baseline_task_id: string; baseline_hypotheses: string; independent_partition: number }>(
      'SELECT parent_id,baseline_task_id,baseline_hypotheses,independent_partition FROM research_branches WHERE research_id=?', project);
    return row ? { parent: row.parent_id, baselineTask: row.baseline_task_id, hypotheses: JSON.parse(row.baseline_hypotheses) as Hypothesis[],
      independentPartition: Boolean(row.independent_partition) } : undefined;
  }

  researchRelations(project: string) {
    const parent = this.get<{ id: string; objective: string; status: RunStatus; independent_partition: number }>(
      'SELECT r.id,r.objective,r.status,b.independent_partition FROM research_branches b JOIN research r ON r.id=b.parent_id WHERE b.research_id=?', project);
    const children = this.all<NonNullable<typeof parent>>(
      'SELECT r.id,r.objective,r.status,b.independent_partition FROM research_branches b JOIN research r ON r.id=b.research_id WHERE b.parent_id=? ORDER BY r.created_at,r.id', project);
    return { parent: parent ?? null, children };
  }

  run(id: string): Run {
    const row = this.get<RunRow>('SELECT id,objective,status,plan FROM research WHERE id=?', id);
    if (!row) throw new Error('Unknown research project');
    return { ...row, plan: JSON.parse(row.plan) };
  }

  list() { return this.all<Omit<RunRow, 'plan'>>('SELECT id,objective,status FROM research ORDER BY created_at DESC,id'); }

  tasks(id: string): Task[] {
    return this.all<TaskRow>(`${taskSelect} WHERE t.research_id=? ORDER BY t.rowid`, id).map(decodeTask);
  }

  events(id: string) {
    return this.all<EventRow>('SELECT sequence,kind,payload,created_at FROM events WHERE research_id=? ORDER BY sequence', id)
      .map(event => ({ ...event, payload: JSON.parse(event.payload) }));
  }

  member(project: string, role: Role): Member {
    const member = this.get<Member>('SELECT role,agent_id,session_key,session_ref,genome,lifecycle FROM memberships WHERE research_id=? AND role=?', project, role);
    if (!member) throw new Error('Unknown research member');
    return member;
  }

  bindSession(project: string, role: Role, reference: string, claim: Claim) {
    return this.transaction(() => {
      const owned = this.get('SELECT 1 FROM tasks WHERE research_id=? AND id=? AND role=? AND status=\'RUNNING\' AND token=? AND lease_until>?',
        project, claim.task.id, role, claim.token, Date.now());
      if (!owned) throw new Error('Session lease lost');
      const changes = this.write(`UPDATE memberships SET session_ref=? WHERE research_id=? AND role=?
        AND (session_ref IS NULL OR session_ref=?)`, reference, project, role, reference);
      if (!changes) throw new Error('Session reference conflict');
    });
  }

  proposals(id: string) {
    return this.all<Receipt & { id: string; payload: string }>('SELECT id,decision,reason,payload FROM proposals WHERE research_id=? ORDER BY rowid', id)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) as Proposal }));
  }

  submit(project: string, actor: Role, input: unknown): Receipt {
    return this.transaction(() => this.admit(project, actor, input));
  }

  private admit(project: string, actor: Role, input: unknown, fromSettledTask = false, reviewed = false): Receipt {
    const run = this.run(project);
    let p: Proposal;
    try { p = parseProposal(input); } catch {
      const receipt: Receipt = { decision: 'REJECTED', reason: 'INVALID_SCHEMA' };
      this.event(project, 'proposal.invalid', { actor, ...receipt });
      return receipt;
    }
    if (p.research_id !== project || p.proposer_agent_id !== actor || !projectRoles(run.plan).includes(actor)) {
      return { decision: 'REJECTED', reason: 'SCOPE_MISMATCH' };
    }
    const saved = this.get<Receipt & { payload: string }>('SELECT decision,reason,payload FROM proposals WHERE research_id=? AND id=?', project, p.proposal_id);
    if (saved && !reviewed) return hash(JSON.parse(saved.payload)) === hash(p)
      ? { decision: saved.decision, reason: saved.reason } : { decision: 'REJECTED', reason: 'IDEMPOTENCY_CONFLICT' };
    const tasks = this.tasks(project);
    const dependencies = [...new Set(p.dependencies)];
    const parentTasks = tasks.filter(task => dependencies.includes(task.id));
    const target = actionRoles[p.action_type];
    let receipt: Receipt = { decision: 'APPROVED', reason: 'VALIDATED' };
    if (run.status !== 'ACTIVE' && !(run.status === 'PAUSED' && fromSettledTask)) receipt = { decision: 'REJECTED', reason: 'RUN_INACTIVE' };
    else if (p.target_agent_ids[0] !== target || !projectRoles(run.plan).includes(target)) receipt = { decision: 'REJECTED', reason: 'ROLE_MISMATCH' };
    else if (!availableActions(run.plan).includes(p.action_type)) receipt = { decision: 'REJECTED', reason: 'ACTION_OUTSIDE_PRESET' };
    else if (p.action_type === 'DELEGATE_NATIVE_REVIEW' && (actor !== 'director' || !p.native_review || !run.plan.native?.includes(p.native_review))) {
      receipt = { decision: 'REJECTED', reason: 'NATIVE_REVIEW_NOT_APPROVED' };
    }
    else if (p.estimated_resources.time_ms > run.plan.timeoutMs || tasks.length >= run.plan.maxTasks) {
      receipt = { decision: 'REJECTED', reason: 'RESOURCE_LIMIT' };
    } else if (p.risk_level === 'HIGH') receipt = { decision: 'REJECTED', reason: 'RISK_OUTSIDE_EXECUTION_POLICY' };
    else if (p.action_type === 'REVIEW_STAGNATION' && actor !== 'director') receipt = { decision: 'REJECTED', reason: 'DIRECTOR_ACTION_REQUIRED' };
    else if (!reviewed && (p.action_type === 'DELEGATE_NATIVE_REVIEW' || p.risk_level !== 'LOW' || (actor !== 'director' && !['INVESTIGATE', 'CRITIQUE', 'REVIEW_ARGUMENTS'].includes(p.action_type)
      && !((actor === 'hypothesis' && p.action_type === 'CONSTRUCT_ARGUMENTS') || (actor === 'argumentation' && p.action_type === 'OPEN_DEBATE')
        || (actor === 'skeptic' && p.action_type === 'MODERATE_DEBATE') || (actor === 'meta-reviewer' && p.action_type === 'CHECK_DATA_QUALITY'))))) {
      receipt = { decision: 'NEEDS_HUMAN_APPROVAL', reason: 'OUTSIDE_DIRECT_DELEGATION' };
    } else if (parentTasks.length !== dependencies.length || parentTasks.some(task => ['FAILED', 'CANCELLED'].includes(task.status))
      || (researchRequirements(run.plan)[p.action_type] ?? []).some(action => !parentTasks.some(task => task.action === action))
      || p.evidence_refs.some(ref => !tasks.some(task => task.id === ref && task.status === 'DONE'))) {
      receipt = { decision: 'NEEDS_REVISION', reason: 'MISSING_PREREQUISITE_OR_EVIDENCE' };
    } else if (tasks.some(task => !['FAILED', 'CANCELLED'].includes(task.status) && task.action === p.action_type
      && (p.action_type !== 'DELEGATE_NATIVE_REVIEW' || task.proposal.native_review === p.native_review)
      && hash([...new Set(task.proposal.dependencies)].sort()) === hash(dependencies.sort()))) {
      receipt = { decision: 'REJECTED', reason: 'DUPLICATE_WORK' };
    }
    if (reviewed) this.write('UPDATE proposals SET decision=?,reason=? WHERE research_id=? AND id=?', receipt.decision, receipt.reason, project, p.proposal_id);
    else this.write('INSERT INTO proposals VALUES(?,?,?,?,?)', project, p.proposal_id, receipt.decision, receipt.reason, JSON.stringify(p));
    this.event(project, 'proposal.decided', { id: p.proposal_id, actor, target, reviewed, ...receipt });
    if (receipt.decision === 'APPROVED') {
      this.write('INSERT INTO tasks(research_id,id,role,action,status) VALUES(?,?,?,?,?)', project, p.proposal_id, target, p.action_type, 'QUEUED');
      for (const parent of dependencies) this.write('INSERT INTO dependencies VALUES(?,?,?)', project, p.proposal_id, parent);
      if (actor !== 'director' && actor !== target) {
        this.message(project, p.proposal_id, 'TASK_DELEGATED', actor, target, p.evidence_refs, Date.now());
        this.event(project, 'agent.delegated', { from: actor, to: target, task: p.proposal_id });
      }
    }
    return receipt;
  }

  reviewProposal(project: string, id: string, approval: boolean): Receipt {
    return this.transaction(() => {
      const p = this.get<Receipt & { payload: string }>('SELECT decision,reason,payload FROM proposals WHERE research_id=? AND id=?', project, id);
      if (!p || p.decision !== 'NEEDS_HUMAN_APPROVAL') return { decision: 'REJECTED', reason: 'PROPOSAL_NOT_PENDING_REVIEW' };
      if (approval && !['ACTIVE', 'NEEDS_HUMAN'].includes(this.run(project).status)) {
        return { decision: 'REJECTED', reason: 'RUN_INACTIVE' };
      }
      this.event(project, 'proposal.human_review', { id, approval });
      if (!approval) {
        this.write("UPDATE proposals SET decision='REJECTED',reason='OPERATOR_REJECTED' WHERE research_id=? AND id=?", project, id);
        return { decision: 'REJECTED', reason: 'OPERATOR_REJECTED' };
      }
      // A review may reopen a run that paused for a decision. Other terminal states stay final.
      const stopped = this.run(project).status === 'NEEDS_HUMAN';
      if (stopped) this.write("UPDATE research SET status='ACTIVE' WHERE id=?", project);
      const proposal = parseProposal(JSON.parse(p.payload));
      const receipt = this.admit(project, proposal.proposer_agent_id, proposal, false, true);
      if (stopped && receipt.decision === 'APPROVED') this.event(project, 'research.status', { status: 'ACTIVE', reason: 'HUMAN_REVIEW_APPROVED' });
      if (stopped && receipt.decision !== 'APPROVED') this.write("UPDATE research SET status='NEEDS_HUMAN' WHERE id=?", project);
      return receipt;
    });
  }

  claim(id: string, now = Date.now(), allowed?: string[]): Claim | undefined {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.status !== 'ACTIVE') return;
      this.recover(id, now, run.plan.retries);
      const tasks = this.tasks(id);
      if (tasks.filter(task => task.status === 'RUNNING').length >= run.plan.maxParallel) return;
      const task = tasks.find(candidate => candidate.status === 'QUEUED' && (!allowed || allowed.includes(candidate.id))
        && candidate.proposal.dependencies.every(dep => tasks.some(parent => parent.id === dep && parent.status === 'DONE'))
        && !tasks.some(other => other.role === candidate.role && other.status === 'RUNNING'));
      if (!task) return;
      const token = randomUUID();
      const lease = now + task.proposal.estimated_resources.time_ms + 5_000;
      this.write("UPDATE tasks SET status='RUNNING',attempt=attempt+1,token=?,lease_until=? WHERE research_id=? AND id=?", token, lease, id, task.id);
      this.write("UPDATE memberships SET lifecycle='RUNNING' WHERE research_id=? AND role=?", id, task.role);
      this.event(id, 'task.claimed', { id: task.id, attempt: task.attempt + 1 }, now);
      return { task: { ...task, status: 'RUNNING', attempt: task.attempt + 1 }, token };
    });
  }

  ownsClaim(claim: Claim, now = Date.now()) {
    return Boolean(this.get("SELECT 1 FROM tasks WHERE research_id=? AND id=? AND status='RUNNING' AND token=? AND lease_until>?",
      claim.task.research_id, claim.task.id, claim.token, now));
  }

  private recover(id: string, now: number, retries: number) {
    const expired = this.all<{ id: string; role: Role; attempt: number }>(
      "SELECT id,role,attempt FROM tasks WHERE research_id=? AND status='RUNNING' AND lease_until<=?", id, now);
    for (const task of expired) {
      const next = task.attempt <= retries ? 'QUEUED' : 'FAILED';
      this.transition(id, task.id, task.role, next, null);
      this.event(id, 'task.lease_expired', { id: task.id, status: next }, now);
    }
    this.cancelBlocked(id);
  }

  private transition(project: string, task: string, role: Role, status: TaskStatus, result: string | null) {
    this.write('UPDATE tasks SET status=?,result=?,token=NULL,lease_until=NULL WHERE research_id=? AND id=?', status, result, project, task);
    this.write('UPDATE memberships SET lifecycle=? WHERE research_id=? AND role=?', status === 'FAILED' ? 'FAILED' : 'IDLE', project, role);
  }

  private cancelBlocked(project: string) {
    let changed: number;
    do {
      changed = this.write(`UPDATE tasks SET status='CANCELLED' WHERE research_id=? AND status='QUEUED' AND EXISTS (
        SELECT 1 FROM dependencies d JOIN tasks parent ON parent.research_id=d.research_id AND parent.id=d.prerequisite_id
        WHERE d.research_id=tasks.research_id AND d.task_id=tasks.id AND parent.status IN ('FAILED','CANCELLED'))`, project);
    } while (changed);
  }

  cancelTask(project: string, id: string): boolean {
    return this.transaction(() => {
      const task = this.tasks(project).find(candidate => candidate.id === id);
      if (!task || !['QUEUED', 'RUNNING'].includes(task.status)) return false;
      if (task.status === 'RUNNING') this.transition(project, id, task.role, 'CANCELLED', null);
      else this.write("UPDATE tasks SET status='CANCELLED' WHERE research_id=? AND id=?", project, id);
      this.cancelBlocked(project);
      this.event(project, 'task.cancelled', { id });
      return true;
    });
  }

  finish(claim: Claim, outcome: TaskOutcome | { error: string }, now = Date.now()): boolean {
    const { task, token } = claim;
    const project = task.research_id;
    return this.transaction(() => {
      const owned = this.get("SELECT 1 FROM tasks WHERE research_id=? AND id=? AND status='RUNNING' AND token=? AND lease_until>?", project, task.id, token, now);
      if (!owned) return false;
      const run = this.run(project);
      const status = 'error' in outcome ? (task.attempt <= run.plan.retries ? 'QUEUED' : 'FAILED') : 'DONE';
      this.transition(project, task.id, task.role, status, 'result' in outcome ? JSON.stringify(outcome.result) : null);
      this.event(project, 'task.settled', { id: task.id, status, reason: 'error' in outcome ? outcome.error : undefined }, now);
      if ('result' in outcome) {
        if (outcome.graph) this.saveGraph(project, task.id, outcome.graph, now);
        for (const item of outcome.findings ?? []) {
          this.write('INSERT OR IGNORE INTO scientific_sim VALUES(?,?,?,?,?,?)', project, task.id, item.code, item.subject, JSON.stringify(item.refs), now);
        }
        if (run.plan.memory === 'private' || run.plan.memory === 'both') {
          this.remember(project, task.role, 'episodic', 'private', { action: task.action, result: outcome.result }, task.id, 'NOT_EVALUATED', now);
          if (task.action === 'INVESTIGATE') {
            this.remember(project, task.role, 'semantic', 'private', outcome.result, task.id, 'PROVENANCE_VERIFIED', now);
          }
          if (outcome.findings?.length) this.remember(project, task.role, 'reflective', 'private',
            { findingCategories: [...new Set(outcome.findings.map(item => item.code))], sourceEpisode: task.id }, task.id, 'VALIDATOR_REPORTED', now);
        }
        if ((run.plan.memory === 'shared' || run.plan.memory === 'both') && task.action === 'INVESTIGATE') {
          this.remember(project, task.role, 'semantic', 'shared', outcome.result, task.id, 'PROVENANCE_VERIFIED', now);
        }
        for (const p of (outcome.followups ?? []).slice(0, 3)) this.admit(project, task.role, p, true);
        const proposer = task.proposal.proposer_agent_id;
        if (proposer !== 'director' && proposer !== task.role) this.message(project, task.id, 'TASK_RESULT', task.role, proposer, [], now);
      } else if (status === 'FAILED' && (run.plan.memory === 'private' || run.plan.memory === 'both')) {
        this.remember(project, task.role, 'reflective', 'private', { action: task.action, failureCategory: outcome.error,
          attempts: task.attempt }, task.id, 'EXECUTION_OBSERVED', now);
      }
      this.cancelBlocked(project);
      return true;
    });
  }

  private message(project: string, task: string, kind: MessageRecord['kind'], sender: Role, recipient: Role, refs: string[], at: number) {
    this.write('INSERT OR IGNORE INTO collaboration_messages VALUES(?,?,?,?,?,?,?)', project, task, kind, sender, recipient, JSON.stringify(refs), at);
  }

  messages(project: string, recipient?: Role) {
    if (recipient) this.member(project, recipient);
    return this.all<MessageRecord>(`SELECT task_id,kind,sender,recipient,refs,created_at FROM collaboration_messages
      WHERE research_id=? AND (? IS NULL OR recipient=?) ORDER BY created_at DESC,rowid DESC LIMIT 24`, project, recipient ?? null, recipient ?? null)
      .map(row => ({ ...row, refs: JSON.parse(row.refs) as string[] }));
  }

  residentView(project: string) {
    return projectRoles(this.run(project).plan).map(role => {
      const { session_ref, ...member } = this.member(project, role);
      const seed = this.get<{ id: string; content_hash: string }>(`SELECT s.id,s.content_hash FROM resident_agents a
        JOIN agent_seeds s ON s.id=a.seed_id WHERE a.id=?`, member.agent_id);
      const privateMemory = this.get<{ count: number }>("SELECT count(*) AS count FROM memories WHERE research_id=? AND owner=? AND visibility='private'", project, role)!.count;
      return { ...member, sessionBound: Boolean(session_ref), privateMemory, seed, philosophy: rolePhilosophies[role] };
    });
  }

  private saveGraph(project: string, task: string, graph: Graph, at: number) {
    this.write('INSERT INTO argument_graph_versions VALUES(?,?,?)', project, task, at);
    for (const node of graph.nodes) {
      this.write('INSERT INTO argument_nodes VALUES(?,?,?,?,?,?,?,?,?)', project, task, node.id, node.kind, node.value,
        JSON.stringify(node.evidenceIds), node.agent, node.createdAt, node.status);
    }
    for (const edge of graph.edges) {
      this.write('INSERT INTO argument_edges VALUES(?,?,?,?,?,?,?,?,?,?)', project, task, edge.id, edge.from, edge.to, edge.relation,
        JSON.stringify(edge.evidenceIds), edge.agent, edge.createdAt, edge.status);
    }
  }

  argumentGraph(project: string, version?: string): Graph | null {
    const task = version ?? this.get<{ task_id: string }>('SELECT task_id FROM argument_graph_versions WHERE research_id=? ORDER BY rowid DESC LIMIT 1', project)?.task_id;
    if (!task) return null;
    const nodes = this.all<Omit<GraphNode, 'evidenceIds'> & { refs: string }>(`SELECT id,kind,value,evidence_ids AS refs,
      agent,created_at AS createdAt,status FROM argument_nodes WHERE research_id=? AND task_id=? ORDER BY rowid`, project, task);
    const edges = this.all<Omit<GraphEdge, 'evidenceIds'> & { refs: string }>(`SELECT id,source AS "from",target AS "to",relation,evidence_ids AS refs,
      agent,created_at AS createdAt,status FROM argument_edges WHERE research_id=? AND task_id=? ORDER BY rowid`, project, task);
    return { nodes: nodes.map(({ refs, ...row }) => ({ ...row, evidenceIds: JSON.parse(refs) })),
      edges: edges.map(({ refs, ...row }) => ({ ...row, evidenceIds: JSON.parse(refs) })) };
  }

  scientificSim(project: string) {
    const findings = this.all<{ task_id: string; category: string; subject: string; refs: string }>(
      'SELECT task_id,category,subject,evidence_ids AS refs FROM scientific_sim WHERE research_id=? ORDER BY rowid', project);
    const repeated = this.all<{ category: string; occurrences: number }>(`SELECT all_findings.category, COUNT(DISTINCT all_findings.research_id) AS occurrences
      FROM scientific_sim all_findings WHERE all_findings.category IN (SELECT category FROM scientific_sim WHERE research_id=?)
      GROUP BY all_findings.category HAVING COUNT(DISTINCT all_findings.research_id)>=2 ORDER BY all_findings.category`, project);
    const changes: Record<string, string> = { MISSING_WARRANT: 'Prompt', EVIDENCE_REUSE_BIAS: 'Evidence Retrieval',
      PREMATURE_CONSENSUS: 'Debate Protocol', RESEARCH_STAGNATION: 'Debate Protocol', WEAK_EXPERIMENTAL_DESIGN: 'Reasoning Gate' };
    return { findings: findings.map(({ refs, ...row }) => ({ ...row, evidenceRefs: JSON.parse(refs) })),
      harnessCandidates: repeated.map(row => ({ ...row, target: changes[row.category] ?? 'Prompt', disposition: 'PENDING_INDEPENDENT_EVALUATION' })) };
  }

  private remember(project: string, owner: Role, kind: string, visibility: 'private' | 'shared', payload: unknown,
    source: string, validation: string, now: number) {
    this.write('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)', randomUUID(), project, owner, kind, visibility,
      JSON.stringify(payload), source, validation, this.member(project, owner).genome, now);
  }

  memory(project: string, actor: Role) {
    this.member(project, actor);
    return this.all<{ payload: string; source: string; owner: Role; visibility: string; kind: string; validation: string; genome: string }>(
      `SELECT payload, source, owner, visibility, kind, validation, genome FROM memories WHERE research_id=?
       AND (visibility='shared' OR owner=?) ORDER BY created_at DESC,rowid DESC LIMIT 12`, project, actor)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  changeStatus(project: string, status: RunStatus, reason: string): boolean {
    return this.transaction(() => {
      const current = this.run(project).status;
      if (current !== 'ACTIVE' && !(current === 'PAUSED' && status === 'ACTIVE')) return false;
      if (status === 'ACTIVE' && current !== 'PAUSED') return false;
      this.write('UPDATE research SET status=? WHERE id=?', status, project);
      if (status !== 'ACTIVE' && status !== 'PAUSED') {
        this.write("UPDATE tasks SET status='CANCELLED' WHERE research_id=? AND status='QUEUED'", project);
      }
      this.event(project, 'research.status', { status, reason });
      return true;
    });
  }

  checkpoint(project: string, kind: string, payload: unknown) {
    this.event(project, kind, payload);
  }

  comparison(payload: unknown) {
    const id = randomUUID();
    this.write('INSERT INTO comparisons VALUES(?,?,?)', id, JSON.stringify(payload), Date.now());
    return id;
  }

  activeRevision(kind: RevisionKind, binding: string) {
    const row = this.get<{ id: string; parent_id: string | null; benchmark_id: string; configuration: string; evaluation: string }>(
      'SELECT o.* FROM active_revisions a JOIN operational_revisions o ON o.id=a.revision_id WHERE a.kind=? AND a.binding_id=?', kind, binding);
    return row && { ...row, configuration: JSON.parse(row.configuration) as RevisionConfiguration, evaluation: JSON.parse(row.evaluation) as unknown };
  }

  revisionStatus(binding: string) {
    return { policy: this.activeRevision('policy', binding) ?? null, genome: this.activeRevision('genome', binding) ?? null,
      actions: this.all('SELECT kind,action,previous_id,next_id,created_at FROM revision_actions WHERE binding_id=? ORDER BY sequence DESC LIMIT 20', binding) };
  }

  genomeLineage(plan: Plan) {
    if (!plan.genome || !plan.runtimeBinding) return [];
    return this.all<{ id: string; parent_id: string | null; benchmark_id: string; created_at: number; code: number }>(
      `WITH RECURSIVE lineage AS (
        SELECT o.*, 0 AS distance FROM operational_revisions o WHERE id=? AND kind='genome' AND binding_id=?
        UNION ALL
        SELECT o.*, l.distance+1 FROM operational_revisions o JOIN lineage l ON l.parent_id=o.id
           WHERE o.kind='genome' AND o.binding_id=l.binding_id
      ) SELECT id,parent_id,benchmark_id,created_at,json_extract(configuration,'$.code') AS code
        FROM lineage ORDER BY distance DESC`, plan.genome.id, plan.runtimeBinding);
  }

  registerDataset(input: unknown, sourceVersion: string) {
    if (!/^[a-f0-9]{64}$/.test(sourceVersion)) throw new Error('An approved source digest is required');
    const records = parseMeasurements(input);
    const id = hash(records);
    this.write('INSERT OR IGNORE INTO approved_datasets VALUES(?,?,?,?,?)', id, sourceVersion, records.length, JSON.stringify(records), Date.now());
    return { id, rows: records.length, access: 'READ_ONLY' };
  }

  datasets() {
    return this.all<{ id: string; source_version: string; row_count: number }>(
      'SELECT id,source_version,row_count FROM approved_datasets ORDER BY created_at DESC,id');
  }

  dataset(id: string): DataSnapshot {
    const found = this.get<{ records: string }>('SELECT records FROM approved_datasets WHERE id=?', id);
    if (!found) throw new Error('Unknown approved dataset');
    const records = parseMeasurements(JSON.parse(found.records));
    if (hash(records) !== id) throw new Error('Approved snapshot integrity failure');
    return { id, records };
  }

  withApprovedDataset(plan: Plan, dataset: unknown) {
    if (dataset == null || dataset === '') return plan;
    if (plan.researchType !== 'causal-discovery') throw new Error('The approved measurement adapter is specific to manufacturing research');
    if (typeof dataset !== 'string' || !this.get('SELECT 1 FROM approved_datasets WHERE id=?', dataset)) throw new Error('Unknown approved dataset');
    return snapshotRevisions(plan, { dataset });
  }

  withOperationalRevisions(plan: Plan) {
    if (plan.runtime !== 'router' || !plan.runtimeBinding || plan.researchType !== 'causal-discovery') return plan;
    const policy = plan.strategy === 'evolutionary-hybrid' ? this.activeRevision('policy', plan.runtimeBinding) : undefined;
    const genome = plan.evolution === 'quality-diversity' ? this.activeRevision('genome', plan.runtimeBinding) : undefined;
    return policy || genome ? snapshotRevisions(plan, {
      ...(policy ? { policy: { id: policy.id, maxParallel: policy.configuration.maxParallel! } } : {}),
      ...(genome ? { genome: { id: genome.id, code: genome.configuration.code! } } : {}),
    }) : plan;
  }

  activateRevision(kind: RevisionKind, binding: string, benchmark: string) {
    return this.transaction(() => {
      const previous = this.activeRevision(kind, binding);
      if (previous?.benchmark_id === benchmark) return previous;
      const saved = this.get<{ payload: string }>('SELECT payload FROM comparisons WHERE id=?', benchmark);
      if (!saved) throw new Error('Unknown evaluation');
      const proof = readRevisionProof(JSON.parse(saved.payload), kind, binding);
      if (proof.parentId !== (previous?.id ?? null)) throw new Error('Evaluation incumbent changed');
      if (hash(proof.configuration) === hash(previous?.configuration ?? (kind === 'policy' ? { maxParallel: 3 } : { code: 0 }))) {
        throw new Error('Evaluation does not change the incumbent');
      }
      const id = hash({ kind, binding, benchmark, parent: proof.parentId, configuration: proof.configuration });
      const now = Date.now();
      this.write('INSERT OR IGNORE INTO operational_revisions VALUES(?,?,?,?,?,?,?,?)', id, kind, proof.parentId,
        benchmark, binding, JSON.stringify(proof.configuration), JSON.stringify(proof.evaluation), now);
      this.write(`INSERT INTO active_revisions VALUES(?,?,?,?) ON CONFLICT(kind,binding_id)
        DO UPDATE SET revision_id=excluded.revision_id,updated_at=excluded.updated_at`, kind, binding, id, now);
      this.write('INSERT INTO revision_actions(kind,binding_id,action,previous_id,next_id,created_at) VALUES(?,?,?,?,?,?)', kind, binding, 'ACTIVATE', proof.parentId, id, now);
      return this.activeRevision(kind, binding)!;
    });
  }

  rollbackRevision(kind: RevisionKind, binding: string, expected: string) {
    return this.transaction(() => {
      const current = this.activeRevision(kind, binding);
      if (!current || current.id !== expected) throw new Error('Active revision changed');
      const now = Date.now();
      if (current.parent_id) this.write('UPDATE active_revisions SET revision_id=?,updated_at=? WHERE kind=? AND binding_id=?', current.parent_id, now, kind, binding);
      else this.write('DELETE FROM active_revisions WHERE kind=? AND binding_id=?', kind, binding);
      this.write('INSERT INTO revision_actions(kind,binding_id,action,previous_id,next_id,created_at) VALUES(?,?,?,?,?,?)',
        kind, binding, 'ROLLBACK', current.id, current.parent_id, now);
      return this.activeRevision(kind, binding) ?? null;
    });
  }

  comparisons(limit = 20, id?: string) {
    type ComparisonRow = { id: string; created_at: number; payload: string };
    const rows = id ? this.all<ComparisonRow>('SELECT * FROM comparisons WHERE id=?', id)
      : this.all<ComparisonRow>('SELECT * FROM comparisons ORDER BY created_at DESC,rowid DESC LIMIT ?', limit);
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  comparisonHistory() {
    return this.all<{ id: string; created_at: number; scope: string }>(
      "SELECT id, created_at, json_extract(payload, '$.scope') AS scope FROM comparisons ORDER BY created_at DESC,rowid DESC LIMIT 20");
  }

  benchmarkTrial<T>(protocol: string, trial: string): T | undefined {
    const row = this.get<{ payload: string }>('SELECT payload FROM benchmark_trials WHERE protocol=? AND trial=?', protocol, trial);
    return row && JSON.parse(row.payload);
  }

  recordBenchmarkTrial<T>(protocol: string, trial: string, payload: T): T {
    return this.transaction(() => {
      this.write('INSERT OR IGNORE INTO benchmark_trials VALUES(?,?,?,?)', protocol, trial, JSON.stringify(payload), Date.now());
      return this.benchmarkTrial<T>(protocol, trial)!;
    });
  }
}
