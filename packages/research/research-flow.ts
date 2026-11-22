import { availableActions, type Action, type Plan, type Proposal, type RunStatus, type Task } from './contracts.ts';

const stages = [
  { id: 'data', title: '데이터 수집·품질', actions: ['COLLECT_ML_DATA', 'PROFILE_ML_DATA'] },
  { id: 'plan', title: '연구 계획', actions: ['REPLAN', 'PLAN_PRESET_STUDY'] },
  { id: 'hypotheses', title: '근거와 가설', actions: ['INVESTIGATE', 'CHECK_DATA_QUALITY', 'GENERATE_HYPOTHESES',
    'CONSTRUCT_ARGUMENTS', 'OPEN_DEBATE', 'CRITIQUE', 'MODERATE_DEBATE', 'REVIEW_ARGUMENTS'] },
  { id: 'design', title: '실험 설계', actions: ['DESIGN_EXPERIMENT', 'AUDIT_SEVERITY'] },
  { id: 'experiment', title: '실험 실행', actions: ['RUN_EXPERIMENT', 'RUN_PRESET_TRIAL'] },
  { id: 'validation', title: '검증과 결론', actions: ['VALIDATE_RESULT', 'VALIDATE_PRESET_TRIAL',
    'REFINE_HYPOTHESES', 'REVIEW_PROGRAMME', 'COMPLETE'] },
] as const satisfies readonly { id: string; title: string; actions: readonly Action[] }[];

type StageStatus = 'RUNNING' | 'NEEDS_HUMAN_APPROVAL' | 'READY' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'DONE' | 'PARTIAL' | 'NOT_STARTED' | 'NOT_RUN';
type PendingProposal = { id: string; decision: string; payload: Proposal };

export function buildResearchFlow(plan: Plan, status: RunStatus, tasks: readonly Task[], proposals: readonly PendingProposal[]) {
  const supported = availableActions(plan).filter(action => action !== 'REPLAN' || plan.strategy !== 'deterministic');
  const byId = new Map(tasks.map(task => [task.id, task]));
  const pending = proposals.filter(proposal => proposal.decision === 'NEEDS_HUMAN_APPROVAL');
  const reviewable = ['ACTIVE', 'PAUSED', 'NEEDS_HUMAN'].includes(status);
  const finished = !reviewable;
  const output = stages.flatMap(({ id, title, actions }) => {
    const belongs = (action: Action) => (actions as readonly Action[]).includes(action);
    const expected = supported.filter(belongs);
    const registered = tasks.filter(task => belongs(task.action));
    if (!expected.length && !registered.length) return [];
    const approvals = reviewable ? pending.filter(item => belongs(item.payload.action_type)) : [];
    const done = registered.filter(task => task.status === 'DONE').length;
    const queued = registered.filter(task => task.status === 'QUEUED');
    const waiting = queued.flatMap(task => {
      const blockers = task.proposal.dependencies.filter(id => byId.get(id)?.status !== 'DONE');
      return blockers.length ? [{ task: task.id, blockers }] : [];
    });
    const unresolved = registered.filter(task => ['FAILED', 'CANCELLED'].includes(task.status)
      && !registered.some(other => other.action === task.action && other.status === 'DONE'));
    let stageStatus: StageStatus;
    if (registered.some(task => task.status === 'RUNNING')) stageStatus = 'RUNNING';
    else if (approvals.length) stageStatus = 'NEEDS_HUMAN_APPROVAL';
    else if (queued.length > waiting.length) stageStatus = 'READY';
    else if (waiting.length) stageStatus = 'BLOCKED';
    else if (unresolved.some(task => task.status === 'FAILED')) stageStatus = 'FAILED';
    else if (unresolved.length) stageStatus = 'CANCELLED';
    else if (done && expected.every(action => registered.some(task => task.action === action && task.status === 'DONE'))) stageStatus = 'DONE';
    else if (done) stageStatus = 'PARTIAL';
    else stageStatus = finished ? 'NOT_RUN' : 'NOT_STARTED';
    return [{ id, title, status: stageStatus, taskIds: registered.map(task => task.id), approvalIds: approvals.map(item => item.id), done, waiting }];
  });
  const stageTaskIds = new Set(output.flatMap(stage => stage.taskIds));
  const stageApprovals = new Set(output.flatMap(stage => stage.approvalIds));
  const supportTaskIds = tasks.filter(task => !stageTaskIds.has(task.id)).map(task => task.id);
  const supportApprovalIds = reviewable ? pending.filter(item => !stageApprovals.has(item.id)).map(item => item.id) : [];
  const priority: StageStatus[] = ['RUNNING', 'NEEDS_HUMAN_APPROVAL', 'READY', 'FAILED', 'BLOCKED', 'CANCELLED', 'PARTIAL', 'NOT_STARTED'];
  const preferred = priority.map(state => output.find(stage => stage.status === state)).find(Boolean);
  return { stages: output, current: (finished ? output.findLast(stage => stage.taskIds.length) : preferred)?.id ?? output.at(-1)?.id,
    supportTaskIds, supportApprovalIds };
}
