import { diagram, el } from './diagrams.js';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const notice = $('#notice');
const folderDialog = $('#workspace-dialog');
const createDialog = $('#research-dialog');
const names = {
  mock: '합성 데이터 · 목업 에이전트', router: 'Router', gjc: 'GJC SDK',
  ACTIVE: '실행 가능', RUNNING: '실행 중', PAUSED: '일시정지', SUCCESS: '완료', NEEDS_HUMAN: '검토 필요',
  FAILED: '실패', EXHAUSTED: '작업 소진', INCONCLUSIVE: '판단 보류', BUDGET_EXCEEDED: '작업 한도 도달',
  DONE: '완료', QUEUED: '대기', CANCELLED: '취소', CREATED: '준비', IDLE: '대기',
  READY: '실행 대기', BLOCKED: '선행 작업 대기', PARTIAL: '일부 완료', NOT_STARTED: '시작 전', NOT_RUN: '미실행',
  APPROVED: '승인', REJECTED: '거절', NEEDS_REVISION: '수정 필요', NEEDS_HUMAN_APPROVAL: '사용자 승인 대기',
  PASS: '통과', FAIL: '미충족', NOT_EVALUATED: '미평가', NOT_APPLICABLE: '적용 제외',
  BASELINE: '초기 기준', EMPIRICALLY_PROGRESSIVE: '경험적으로 확인된 진전', TESTABLE_PROGRESS: '검증 가능한 진전',
  POST_HOC_ONLY: '사후 수정', NO_NEW_PREDICTION: '신규 예측 없음',
  'hybrid-adaptive': '적응형 Director', deterministic: '고정 정책', 'cognitive-director': '직렬 Director', 'evolutionary-hybrid': '진화형 정책',
  both: '개인 + 공유', private: '개인만', shared: '공유만', none: '사용 안 함',
  INVESTIGATE: '근거 조사', CHECK_DATA_QUALITY: '데이터 품질 확인', GENERATE_HYPOTHESES: '가설 생성', CRITIQUE: '가설 비판',
  REVIEW_ARGUMENTS: '논증 검토', DESIGN_EXPERIMENT: '실험 설계', RUN_EXPERIMENT: '실험 실행', VALIDATE_RESULT: '결과 검증',
  REFINE_HYPOTHESES: '가설 수정', REPLAN: '연구 계획 갱신', REQUEST_EVOLUTION: '진화 평가 요청', COMPLETE: '연구 완료 검토',
  CONSTRUCT_ARGUMENTS: 'Toulmin 논증 구성', OPEN_DEBATE: '토론 쟁점과 기준 확정', MODERATE_DEBATE: '토론 종결',
  AUDIT_SEVERITY: '실험 엄격성 감사', REVIEW_PROGRAMME: '연구 프로그램 평가',
  REVIEW_STAGNATION: '정체 원인과 재계획 검토', 'meta-reviewer': 'Meta-Reviewer', TASK_DELEGATED: '작업 위임', TASK_RESULT: '결과 통지',
  PLAN_PRESET_STUDY: '연구 유형별 계획', RUN_PRESET_TRIAL: '등록 실험 실행', VALIDATE_PRESET_TRIAL: '등록 실험 재검증',
  COLLECT_ML_DATA: '등록 데이터 수집', PROFILE_ML_DATA: '데이터 품질과 분할 점검',
  'data-collector': '데이터 수집', 'data-quality': '데이터 품질',
  classification: '이진 분류', regression: '수치 회귀', grouped: '그룹 단위 무작위', ordered: '파일 순서 유지',
  BALANCED_ACCURACY: '균형 정확도', MEAN_ABSOLUTE_ERROR: '평균 절대 오차',
  DELEGATE_NATIVE_REVIEW: 'GJC Native 검토',
  'causal-discovery': '제조 공정 연관성', 'ml-optimization': '합성 분류 모델 비교', 'algorithm-research': '정렬 알고리즘 비교',
  'tabular-ml': '등록 데이터 ML 연구',
  'idea-discovery': '아이디어 및 반증 설계', 'custom-research': '사용자 연구 설계',
  SINGLE_AGENT: '단일 에이전트', PARALLEL_INDEPENDENT: '독립 병렬', HIERARCHICAL: '계층 위임', SCIENTIFIC_DEBATE: '과학 토론', DEPENDENCY_DAG: '작업 의존성',
  director: 'Director', evidence: '근거 조사', hypothesis: '가설 연구', skeptic: '비판 검토', methodology: '방법론', experiment: '실험', evolution: '진화',
  argumentation: 'Toulmin 논증', moderator: '변증법 진행', severity: '엄격성 감사', programme: '연구 프로그램',
  'research.created': '연구 생성', 'research.status': '연구 상태 변경', 'task.claimed': '작업 시작', 'task.settled': '작업 결과 저장',
  'research.branched': '기존 가설에서 연구 분기',
  'task.cancelled': '작업 취소', 'task.lease_expired': '중단된 작업 복구', 'agent.delegated': '에이전트 위임',
  'proposal.decided': '제안에 대한 정책 결정', 'proposal.human_review': '사용자 승인 검토', 'topology.selected': '실행 구조 결정', 'stagnation.detected': '진행 정체 감지',
};
const tabs = { overview: '진행 개요', flow: '연구 흐름', experiments: '실험 흐름', lineage: '연구 진화', evolution: '에이전트 진화',
  council: '가설과 논증', agents: '에이전트', orchestration: '작업 및 승인' };
const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
let context = null;
let switching = false;
let pickerAvailable = false;

const label = value => names[value] ?? value ?? '—';
function badge(status) {
  const tone = ['DONE', 'SUCCESS', 'PASS', 'APPROVED'].includes(status) ? 'good'
    : ['PAUSED', 'BLOCKED', 'NEEDS_HUMAN', 'NEEDS_HUMAN_APPROVAL', 'NEEDS_REVISION'].includes(status) ? 'attention'
      : ['FAILED', 'REJECTED', 'FAIL'].includes(status) ? 'failed' : status === 'RUNNING' ? 'running' : '';
  return el('span', label(status), `badge ${tone}`);
}

function button(text, action, className) {
  const item = el('button', text, className);
  item.type = 'button';
  item.addEventListener('click', () => { void Promise.resolve().then(action).catch(report); });
  return item;
}

function report(error) { notice.textContent = error.message; }

async function api(path, input) {
  const response = await fetch(path, input === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '요청에 실패했습니다.');
  return result;
}

const scoped = (state, path, data) => api(`/api/workspaces/${state.workspace.id}${path}`, data);

function panel(title, ...items) {
  const section = el('section', undefined, 'panel');
  section.append(el('h2', title), ...items);
  return section;
}

function table(headers, rows, empty = '아직 기록이 없습니다.') {
  if (!rows.length) return el('p', empty, 'muted');
  const wrapper = el('div', undefined, 'table');
  const t = el('table');
  const header = t.createTHead().insertRow();
  for (const title of headers) {
    const cell = el('th', title);
    cell.scope = 'col';
    header.append(cell);
  }
  const body = t.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) {
      const cell = tr.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? '—';
    }
  }
  wrapper.append(t);
  return wrapper;
}

function details(title, payload) {
  const box = el('details');
  box.append(el('summary', title), el('pre', JSON.stringify(payload, null, 2)));
  return box;
}

function settings(plan) {
  const list = el('dl', undefined, 'settings');
  const entries = [['연구 유형', label(plan.researchType)], ['모델 연결', plan.runtime === 'mock' ? '목업 에이전트' : label(plan.runtime)], ['오케스트레이션', label(plan.strategy)], ['메모리', label(plan.memory)],
    ['실험 시드', plan.seed], ['작업 / 병렬 한도', `${plan.maxTasks} / ${plan.maxParallel}`], ['작업 제한 시간', `${plan.timeoutMs / 1000}초`]];
  for (const [key, value] of entries) {
    const row = el('div');
    row.append(el('dt', key), el('dd', value));
    list.append(row);
  }
  return list;
}

function showEmpty(connected = false) {
  const box = el('section', undefined, 'panel empty');
  box.append(el('h1', connected ? '연구를 시작하세요' : '작업 폴더를 연결하세요'),
    el('p', connected ? '연구 목표와 실행 설정을 지정하면 이 폴더에서 실험과 에이전트 작업을 추적할 수 있습니다.'
      : '연구 기록이 있는 폴더를 다시 열거나, 새로 사용할 Windows 폴더를 지정하세요.'),
    button(connected ? '새 연구' : '작업 폴더 열기', connected ? openNewRun : openFolderDialog, 'primary'));
  content.replaceChildren(box);
}

function readRecent() {
  try {
    const items = JSON.parse(localStorage.getItem('gajae-workspaces') ?? '[]');
    return Array.isArray(items) ? items.filter(item => typeof item?.root === 'string' && typeof item?.name === 'string').slice(0, 8) : [];
  } catch { return []; }
}

function remember(workspace) {
  if (workspace.root) {
    const recent = [{ root: workspace.root, name: workspace.name }, ...readRecent().filter(item => item.root !== workspace.root)].slice(0, 8);
    try { localStorage.setItem('gajae-workspaces', JSON.stringify(recent)); } catch { /* research records are stored separately */ }
  }
}

function openFolderDialog() {
  const recent = readRecent();
  $('#recent-section').hidden = !recent.length;
  $('#recent-folders').replaceChildren(...recent.map(item => {
    const entry = button('', () => connect(() => api('/api/workspaces/connect', { path: item.root })));
    entry.append(el('strong', item.name), el('span', item.root, 'workspace-path'));
    return entry;
  }));
  $('#native-picker').hidden = !pickerAvailable;
  $('#folder-error').textContent = '';
  if (!folderDialog.open) folderDialog.showModal();
}

async function connect(load) {
  if (switching) return;
  switching = true;
  const controls = [...folderDialog.querySelectorAll('button, input')];
  controls.forEach(control => { control.disabled = true; });
  $('#folder-error').textContent = '';
  try {
    const next = await load();
    if (!next) return;
    await activate(next);
    if (folderDialog.open) folderDialog.close();
  } catch (error) { $('#folder-error').textContent = error.message; }
  finally {
    switching = false;
    controls.forEach(control => { control.disabled = false; });
  }
}

async function activate(workspace) {
  const state = { workspace, selected: null, comparison: null, diagramSelection: {}, tab: 'overview', page: 'research',
    pending: false, signature: '', runs: [], listSignature: '' };
  const listing = await scoped(state, '/research');
  state.defaults = listing.defaults;
  state.datasets = listing.datasets ?? [];
  state.mlDatasets = listing.mlDatasets ?? [];
  context = state;
  remember(workspace);
  notice.textContent = '';
  $('#workspace-name').textContent = workspace.name;
  $('#workspace-path').textContent = workspace.root ?? 'LAB_DB에 지정된 기록';
  $('#runtime').textContent = label(workspace.runtime);
  $('#new-run').disabled = false;
  $('#register-ml-data').disabled = false;
  $('#comparisons').disabled = false;
  showEmpty(true);
  updateRuns(state, listing.runs);
  if (listing.runs.length) await openRun(state, listing.runs[0].id);
}

function updateRuns(state, runs) {
  if (context !== state) return;
  state.runs = runs;
  const signature = JSON.stringify([state.selected, runs]);
  if (signature === state.listSignature) return;
  state.listSignature = signature;
  const items = runs.map(run => {
    const item = button('', () => openRun(state, run.id), 'run-item');
    item.append(el('strong', run.objective), badge(run.status));
    if (state.selected === run.id) item.setAttribute('aria-current', 'true');
    return item;
  });
  $('#runs').replaceChildren(...(items.length ? items : [el('p', '저장된 연구가 없습니다.', 'muted')]));
}

function openNewRun() {
  if (!context) return openFolderDialog();
  const form = $('#create-form');
  const defaults = context.defaults;
  for (const field of ['researchType', 'strategy', 'memory', 'seed', 'maxTasks', 'maxParallel', 'evolution']) form.elements[field].value = defaults[field];
  const datasets = form.elements.dataset;
  datasets.replaceChildren(new Option('합성 제조 데이터', ''), ...context.datasets.map(row => new Option(`${row.row_count}개 관측 · ${row.id.slice(0, 12)}`, row.id)));
  const mlDatasets = form.elements.mlDataset;
  mlDatasets.replaceChildren(new Option(context.mlDatasets.length ? '데이터셋 선택' : '작업 폴더에서 ML 데이터를 먼저 등록하세요', ''),
    ...context.mlDatasets.map(row => new Option(`${row.target} · ${label(row.kind)} · ${row.row_count}행 · ${row.id.slice(0, 8)}`, row.id)));
  updateDatasetFields();
  form.elements.timeout.value = defaults.timeoutMs / 1000;
  $('#research-location').textContent = context.workspace.root ?? context.workspace.name;
  $('#create-error').textContent = '';
  createDialog.showModal();
}

function updateDatasetFields() {
  const { researchType, dataset, mlDataset } = $('#create-form').elements;
  const manufacturing = researchType.value === 'causal-discovery';
  const ml = researchType.value === 'tabular-ml';
  $('#manufacturing-data-field').hidden = dataset.disabled = !manufacturing;
  $('#ml-dataset-field').hidden = mlDataset.disabled = !ml;
  mlDataset.required = ml;
}

function progressPanel(view) {
  const p = view.progressLedger;
  const closed = view.tasks.filter(task => ['DONE', 'FAILED', 'CANCELLED'].includes(task.status)).length;
  const current = view.tasks.find(task => task.status === 'RUNNING') ?? view.tasks.filter(task => task.status === 'DONE').at(-1);
  const title = el('div', undefined, 'progress-top');
  title.append(el('strong', `${closed} / ${view.tasks.length}개 등록 작업 종료`), badge(view.execution.running ? 'RUNNING' : view.run.status));
  const meter = el('progress');
  meter.max = Math.max(1, view.tasks.length);
  meter.value = closed;
  meter.setAttribute('aria-label', '등록 작업 진행률');
  const metrics = el('div', undefined, 'metrics');
  for (const [key, value] of [['완료', p.completed], ['대기·진행', p.pending], ['실패', p.failed]]) {
    const item = el('div', undefined, 'metric');
    item.append(el('strong', value), el('span', key));
    metrics.append(item);
  }
  return panel('연구 진행률', title, meter, metrics,
    el('p', current ? `${current.status === 'RUNNING' ? '현재 작업' : '최근 완료'} · ${label(current.action)} · ${label(current.role)}` : '실행을 시작하면 작업 일정이 표시됩니다.'),
    el('span', p.topology?.topology ? `실행 구조 · ${label(p.topology.topology)}` : '실행 구조 미정', 'caption'));
}

function timeline(view) {
  const list = el('ul', undefined, 'timeline');
  for (const event of view.events.slice(-7).reverse()) {
    const item = el('li');
    const timeNode = el('time', time.format(event.created_at));
    timeNode.dateTime = new Date(event.created_at).toISOString();
    item.append(timeNode, el('span', label(event.kind)));
    list.append(item);
  }
  return list;
}

function overview(state, view) {
  const { researchLedger: research, progressLedger: progress } = view;
  const top = el('div', undefined, 'overview-grid');
  const progressSection = progressPanel(view);
  const flowLink = el('div', undefined, 'flow-overview-link');
  flowLink.append(button('연구 흐름 보기', () => selectResearchTab(state, view, 'flow')));
  progressSection.append(flowLink);
  top.append(progressSection, panel('연구 설정', settings(view.run.plan)));
  const lower = el('div', undefined, 'detail-grid');
  if (view.run.plan.mlDataset) {
    const profile = research.dataProfile;
    const rows = [['데이터 버전', view.run.plan.mlDataset.id]];
    if (research.dataCollection) rows.push(['등록 행', research.dataCollection.rows]);
    else rows.push(['데이터 수집', '실행 대기']);
    if (profile) rows.push(['과제', label(profile.task)], ['분할', label(profile.split)], ['학습 / 개발 / 보류',
      `${profile.trainingRows} / ${profile.developmentRows} / ${profile.heldOutRows}`], ['수치 특성', profile.features], ['학습 구간 상수 특성', profile.constants.length]);
    const { experiment, validation } = progress;
    const experimentPanel = experiment ? panel('ML 모델 비교', el('p', `개발 세트에서 선택 · ${experiment.selected} · ${label(experiment.metric)}`),
      table(['모델', '개발 점수', '보류 점수'], experiment.results.map(row => [row.candidate, row.developmentScore.toFixed(4), row.heldOutScore?.toFixed(4)])),
      el('p', '보류 점수는 선택된 모델과 기준선에만 표시합니다.', 'muted'),
      ...(validation ? [el('p', `재계산 ${label(validation.independentReproducibility)}`)] : []))
      : panel('ML 모델 비교', el('p', '실험이 완료되면 비교 결과가 표시됩니다.'));
    lower.append(panel('데이터 수집과 품질', table(['기록', '값'], rows)), experimentPanel);
    return [top, lower];
  }
  if (research.presetStudy) {
    const experiment = progress.experiment;
    const formatScore = score => Number.isInteger(score) ? score : score?.toFixed(3);
    const section = experiment ? panel('등록된 실험과 재검증', el('p', `개발 자료에서 선택한 후보 · ${experiment.selected ?? '없음'}`),
      table(['후보', '개발 세트', '보류 세트'], experiment.results.map(row => [row.candidate, formatScore(row.developmentCost ?? row.developmentAccuracy),
        formatScore(row.heldOutCost ?? row.heldOutAccuracy)])), ...(progress.validation ? [el('p', `재현 ${label(progress.validation.independentReproducibility)}`)] : []))
      : panel('연구 설계', el('p', research.presetStudy.question), table(['가설', '반증 조건'], research.presetStudy.ideas.map(idea => [idea.claim, idea.falsifier])),
        ...(research.presetStudy.candidates.length ? [el('p', research.presetStudy.candidates.join(', '))] : []));
    lower.append(section, panel('최근 활동', timeline(view)));
    return [top, lower];
  }
  lower.append(panel('실험 및 검증', table(['가설', '위험차', '판정'], (progress.experiment?.observed ?? []).map(row =>
    [row.hypothesisId, typeof row.effect === 'number' ? `${(row.effect * 100).toFixed(2)}%p` : null, badge(row.outcome)]), '실험이 완료되면 결과가 표시됩니다.'),
  ...(progress.validation ? [el('p', `독립 재현 ${label(progress.validation.independentReproducibility)} · 인과 식별 ${label(progress.validation.causalIdentification)}`)] : []),
  ...(progress.experiment?.artifact ? [details('실험 산출물 해시', progress.experiment.artifact)] : []),
  ...(research.plan ? [details('근거 및 사전 등록', { evidence: research.evidence, plan: research.plan })] : [])), panel('최근 활동', timeline(view)));
  return [top, lower];
}

function researchFlowPage(state, view) {
  const flow = view.researchFlow;
  const byId = new Map(view.tasks.map(task => [task.id, task]));
  const byProposal = new Map(view.proposals.map(item => [item.id, item]));
  const lastFailure = new Map(view.events.filter(event => event.kind === 'task.settled' && event.payload.reason)
    .map(event => [event.payload.id, event.payload.reason]));
  const byStage = new Map(flow.stages.map(stage => [stage.id, stage]));
  const current = byStage.get(flow.current);
  const stages = el('ol', undefined, 'research-stage-track');
  stages.setAttribute('aria-label', '연구 단계');
  const controls = new Map();
  const inspector = el('div', undefined, 'research-stage-inspector');
  inspector.setAttribute('aria-live', 'polite');

  for (const stage of flow.stages) {
    const entry = el('li', undefined, `research-stage stage-${stage.status.toLowerCase()}`);
    const control = button('', () => {
      state.diagramSelection.flow = stage.id;
      inspect(stage);
    }, 'research-stage-button');
    const caption = stage.taskIds.length ? `등록 작업 ${stage.done}/${stage.taskIds.length} 완료` : '등록된 작업 없음';
    control.append(el('strong', stage.title), badge(stage.status), el('span', caption, 'caption'));
    if (stage.id === current?.id) control.setAttribute('aria-current', 'step');
    controls.set(stage.id, control);
    entry.append(control);
    stages.append(entry);
  }

  function inspect(stage) {
    for (const [id, control] of controls) control.setAttribute('aria-pressed', String(id === stage.id));
    const tasks = stage.taskIds.map(id => byId.get(id));
    const waiting = new Map(stage.waiting.map(item => [item.task, item.blockers]));
    const heading = el('div', undefined, 'progress-top');
    heading.append(el('h3', stage.title), badge(stage.status));
    const rows = tasks.map(task => {
      const blockers = (waiting.get(task.id) ?? []).map(id => label(byId.get(id)?.action ?? id));
      return [label(task.action), label(task.role), badge(task.status),
        blockers.length ? blockers.join(', ') : task.status === 'FAILED' ? lastFailure.get(task.id) : null];
    });
    const actions = el('div', undefined, 'actions');
    if (stage.id === 'hypotheses') actions.append(button('가설과 논증 열기', () => selectResearchTab(state, view, 'council')));
    if (['design', 'experiment', 'validation'].includes(stage.id) && tasks.length) actions.append(button('실험 흐름 열기', () => {
      state.diagramSelection.experiment = (tasks.find(task => task.status === 'RUNNING') ?? tasks.at(-1)).id;
      selectResearchTab(state, view, 'experiments');
    }));
    if (stage.approvalIds.length) actions.append(button('대기 중인 승인 보기', () => selectResearchTab(state, view, 'orchestration'), 'primary'));
    const approvals = stage.approvalIds.map(id => byProposal.get(id)).filter(Boolean);
    inspector.replaceChildren(heading,
      table(['작업', '담당 Agent', '상태', '선행 대기 또는 실패 원인'], rows, '이 단계에 등록된 작업이 없습니다.'),
      ...(approvals.length ? [table(['승인 대기 작업', '제안자'], approvals.map(item => [label(item.payload.action_type), label(item.payload.proposer_agent_id)]))] : []),
      ...(actions.childElementCount ? [actions] : []));
  }
  const initial = byStage.get(state.diagramSelection.flow) ?? current;
  if (initial) inspect(initial);

  const stagePanel = panel('연구 흐름', stages, inspector);
  const context = el('div', undefined, 'research-flow-context');
  const approvalCount = flow.supportApprovalIds.length + flow.stages.reduce((sum, stage) => sum + stage.approvalIds.length, 0);
  const running = view.tasks.filter(task => task.status === 'RUNNING');
  if (view.run.status === 'PAUSED') context.append(el('p', '연구가 일시정지되었습니다.'));
  else if (running.length) context.append(el('p', `실행 중 · ${running.map(task => label(task.action)).join(', ')}`));
  else if (current) {
    const closed = !['ACTIVE', 'PAUSED', 'NEEDS_HUMAN'].includes(view.run.status);
    context.append(el('p', `${closed ? '마지막 기록 단계' : '진행 지점'} · ${current.title}`));
  }
  if (approvalCount) context.append(button(`승인 대기 ${approvalCount}건`, () => selectResearchTab(state, view, 'orchestration'), 'subtle'));
  stagePanel.insertBefore(context, stages);

  const support = flow.supportTaskIds.map(id => byId.get(id));
  const pending = flow.supportApprovalIds.map(id => byProposal.get(id)).filter(Boolean);
  const approvalOrSupport = support.length || pending.length ? [panel('연구 지원 작업',
    table(['작업', '담당', '상태'], [...support.map(task => [task.proposal.native_review ?? label(task.action), label(task.role), badge(task.status)]),
      ...pending.map(item => [item.payload.native_review ?? label(item.payload.action_type), label(item.payload.proposer_agent_id), badge(item.decision)])]),
    button('작업 및 승인 열기', () => selectResearchTab(state, view, 'orchestration')))] : [];
  const { validation, experiment } = view.progressLedger;
  const resultRows = [];
  if (experiment?.selected !== undefined) resultRows.push(['선택 후보', experiment.selected ?? '없음']);
  if (experiment?.kind === 'REGISTERED_TABULAR_ML') {
    const selected = experiment.results.find(row => row.candidate === experiment.selected);
    resultRows.push(['보류 세트 · ' + label(experiment.metric), selected?.heldOutScore?.toFixed(4)]);
  }
  if (experiment?.observed) resultRows.push(['사전 기준 충족', `${experiment.observed.filter(item => item.outcome === 'PASS').length}/${experiment.observed.length}개 가설`]);
  if (validation?.independentReproducibility) resultRows.push(['독립 재계산', badge(validation.independentReproducibility)]);
  if (view.researchLedger.programme) resultRows.push(['연구 프로그램 판정', label(view.researchLedger.programme.classification)]);
  return [stagePanel, ...(resultRows.length ? [panel('실험과 검증 요약', table(['기록', '결과'], resultRows))] : []), ...approvalOrSupport];
}

function council(view) {
  const research = view.researchLedger;
  const reasoning = research.arguments;
  const graph = research.argumentGraph;
  const validation = view.progressLedger.validation;
  const gates = (reasoning?.reviews ?? []).map(row => [row.hypothesisId, badge(row.gates.A.status), badge(row.gates.B.status),
    badge(row.gates.C.status), badge(row.gates.D.status), badge(research.severity?.gate.status ?? 'NOT_EVALUATED'),
    badge(validation?.scientific?.[row.hypothesisId]?.status ?? 'NOT_EVALUATED')]);
  return [panel('가설 및 수정 이력', table(['가설', '주장', '이전 가설', '판정'], (research.hypotheses?.hypotheses ?? [])
    .map(h => [h.id, h.claim, h.parentIds.join(', ') || '초기', badge(h.status ?? 'QUEUED')]))),
  ...(gates.length ? [panel('과학 검증 Gates', table(['가설', 'A 완전성', 'B 일관성', 'C 반증', 'D 근거', 'E 엄격성', '경험적 판정'], gates),
    details('기호 검증, 자연어 매핑 및 근거 상세', reasoning.reviews))] : []),
  panel('논증과 비판', table(['주장', '정당화', '반증 조건'], (reasoning?.arguments ?? []).map(a => [a.claim, a.warrant, a.falsificationConditions.join(', ')])),
  ...(reasoning ? [el('p', reasoning.critic.critique), details('공격 관계와 Dung 수용 집합', { attacks: reasoning.attacks, accepted: reasoning.accepted })] : []),
  ...(reasoning?.debate ? [details('대립·개시·논증·종결 기록', reasoning.debate)] : []),
  ...(graph ? [details(`근거 그래프 · 노드 ${graph.nodes.length}개, 관계 ${graph.edges.length}개`, graph)] : [])),
  ...(research.programme ? [panel('연구 프로그램 평가', badge(research.programme.gate.status),
    el('p', `${label(research.programme.classification)} · 새 예측 ${research.programme.novelPredictions.length}건 · 독립 확인 ${research.programme.independentlyConfirmedPredictions.length}건`),
    details('미해결 쟁점과 다음 연구', { unresolved: validation?.unresolved, programme: research.programme }))] : []),
  ...(view.scientificSim?.findings.length ? [panel('Self-Improvement Memory', table(['작업', '검출 유형', '대상'],
    view.scientificSim.findings.map(item => [item.task_id, item.category, item.subject])),
    ...(view.scientificSim.harnessCandidates.length ? [details('독립 검증 대기 Harness 개선 후보', view.scientificSim.harnessCandidates)] : []))] : [])];
}

function experimentFlow(state, view) {
  const { tasks, events, researchLedger, progressLedger } = view;
  const clockEvents = events.filter(event => ['task.claimed', 'task.settled', 'task.cancelled', 'task.lease_expired'].includes(event.kind));
  const byTask = Map.groupBy(clockEvents, event => event.payload.id);
  const nodes = tasks.map(task => ({
    id: task.id, title: label(task.action), caption: label(task.role), parents: task.proposal.dependencies, badge: badge(task.status), task,
  }));
  const volume = el('div', undefined, 'diagram-counts');
  for (const [name, count] of [['완료', progressLedger.completed], ['실행·대기', progressLedger.pending], ['실패', progressLedger.failed]]) {
    volume.append(el('span', name + ' ' + count));
  }
  const graph = nodes.length ? diagram(nodes, '실험 작업 의존성', state.diagramSelection.experiment,
    id => { state.diagramSelection.experiment = id; }, ({ task }) => {
      const info = el('div');
      const taskNames = new Map(tasks.map(item => [item.id, label(item.action)]));
      const events = byTask.get(task.id) ?? [];
      info.append(el('h3', label(task.action)), el('p', task.proposal.objective),
        table(['담당', '선행 작업', '실행 시도', '상태'], [[label(task.role),
          task.proposal.dependencies.map(id => taskNames.get(id) ?? id).join(', ') || '없음', task.attempt, badge(task.status)]]));
      if (events.length) info.append(table(['시간', '이벤트', '결과'], events.map(event => [
        time.format(event.created_at), label(event.kind), event.payload.reason ?? (event.payload.status ? label(event.payload.status) : null),
      ])));
      if (task.result != null) info.append(details('저장된 작업 결과', task.result));
      return info;
    }) : el('p', '연구를 실행하면 작업 의존성이 여기에 표시됩니다.', 'muted');
  const phases = [
    ['계획과 근거', ['COLLECT_ML_DATA', 'PROFILE_ML_DATA', 'REPLAN', 'INVESTIGATE', 'CHECK_DATA_QUALITY', 'PLAN_PRESET_STUDY']],
    ['가설과 검토', ['GENERATE_HYPOTHESES', 'CRITIQUE', 'CONSTRUCT_ARGUMENTS', 'OPEN_DEBATE', 'MODERATE_DEBATE', 'REVIEW_ARGUMENTS']],
    ['실험 설계와 실행', ['DESIGN_EXPERIMENT', 'AUDIT_SEVERITY', 'RUN_EXPERIMENT', 'RUN_PRESET_TRIAL']],
    ['검증과 수정', ['VALIDATE_RESULT', 'VALIDATE_PRESET_TRIAL', 'REFINE_HYPOTHESES', 'REVIEW_PROGRAMME', 'COMPLETE']],
  ];
  const stages = el('div', undefined, 'diagram-stages');
  const graphRegion = graph.querySelector('.diagram-viewport');
  for (const [name, actions] of phases) {
    const matches = tasks.filter(task => actions.includes(task.action));
    if (!matches.length) continue;
    const target = matches.find(task => task.status !== 'DONE') ?? matches.at(-1);
    const control = button(name, () => {
      const node = graphRegion.querySelector(`[data-node-id="${CSS.escape(target.id)}"]`);
      node.click();
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    control.append(el('span', ` · ${matches.filter(task => task.status === 'DONE').length}/${matches.length}`));
    stages.append(control);
  }
  const provenance = [];
  if (researchLedger.plan?.digest) provenance.push(['실험 사전등록', researchLedger.plan.digest]);
  const dataset = researchLedger.plan?.datasetVersion ?? view.run.plan.dataset ?? view.run.plan.mlDataset?.id;
  if (dataset) provenance.push(['데이터 버전', dataset]);
  if (progressLedger.experiment?.artifact?.sha256) provenance.push(['실험 산출물 SHA-256', progressLedger.experiment.artifact.sha256]);
  if (progressLedger.validation) provenance.push(['독립 재현', badge(progressLedger.validation.independentReproducibility)]);
  return [panel('실험 작업 흐름', volume, ...(stages.childElementCount ? [stages] : []),
    el('p', '화살표는 저장된 선행 작업 관계입니다. 작업을 선택하면 실행 기록을 볼 수 있습니다.', 'muted'), graph),
    ...(provenance.length ? [panel('데이터와 검증 기록', table(['기록', '값'], provenance))] : [])];
}

function researchEvolution(state, view) {
  const { run, researchRelations, researchLedger, branch } = view;
  const { parent, children } = researchRelations;
  const scope = item => item.independent_partition ? '별도 합성 데이터 분할' : '같은 승인 데이터 사용';
  const neighbours = [...(parent ? [parent] : []), ...children];
  const lineage = diagram([
    ...(parent ? [{ id: parent.id, title: parent.objective, caption: '상위 연구', parents: [], badge: badge(parent.status) }] : []),
    { id: run.id, title: run.objective, caption: '현재 연구', parents: parent ? [parent.id] : [], badge: badge(run.status) },
    ...children.map(child => ({ id: child.id, title: child.objective, caption: '분기 연구', parents: [run.id], badge: badge(child.status) })),
  ], '연구 분기 계보', state.diagramSelection.research ?? run.id, id => { state.diagramSelection.research = id; }, node => {
    const relation = neighbours.find(item => item.id === node.id);
    const info = el('div');
    info.append(el('h3', node.title));
    if (relation) info.append(el('p', scope(relation)), button('이 연구 열기', () => openRun(state, relation.id, 'lineage')));
    else if (branch) info.append(el('p', branch.independentPartition ? '상위 연구와 별도 합성 데이터 분할' : '상위 연구와 같은 승인 데이터 사용'));
    else if (!children.length) info.append(el('p', '연결된 분기 연구가 없습니다.', 'muted'));
    return info;
  });
  const histories = view.tasks.filter(task => task.status === 'DONE' && ['GENERATE_HYPOTHESES', 'REFINE_HYPOTHESES'].includes(task.action));
  const hypotheses = [...new Map(histories.flatMap(task => (task.result?.hypotheses ?? []).map(h => [h.id, h]))).values()];
  const graph = hypotheses.length ? diagram(hypotheses.map(h => ({
    id: h.id, title: h.id, caption: h.assessmentOnly ? '판정 갱신' : h.parentIds.length ? '수정 가설' : '초기 가설',
    parents: h.parentIds, badge: h.status ? badge(h.status) : null, hypothesis: h,
  })), '가설 버전 계보', state.diagramSelection.hypothesis, id => { state.diagramSelection.hypothesis = id; }, ({ hypothesis: h }) => {
    const info = el('div');
    info.append(el('h3', h.id), el('p', h.claim),
      ...(h.assessmentOnly ? [el('p', '실험 후 과학적 판정 갱신', 'muted')] : []), details('예측과 반증 조건', h));
    return info;
  }) : el('p', '저장된 가설 수정 이력이 없습니다.', 'muted');
  const programme = researchLedger.programme;
  return [panel('연구 분기', lineage), panel('가설 버전', graph),
    ...(programme ? [panel('새 예측과 독립 확인', badge(programme.gate.status), el('p',
      `${label(programme.classification)} · 새 예측 ${programme.novelPredictions.length}건 · 독립 확인 ${programme.independentlyConfirmedPredictions.length}건`),
    details('연구 프로그램 평가', programme))] : []),
    ...(branch?.hypotheses?.length ? [panel('비교에 사용한 상위 가설', table(['가설', '주장'], branch.hypotheses.map(h => [h.id, h.claim])))] : [])];
}

function agentEvolution(state, view) {
  const picker = el('select');
  picker.setAttribute('aria-label', '진화를 볼 에이전트');
  for (const agent of view.residents) {
    const option = el('option', label(agent.role));
    option.value = agent.role;
    picker.append(option);
  }
  const requested = state.diagramSelection.agent;
  if (view.residents.some(agent => agent.role === requested)) picker.value = requested;
  else if (view.residents.some(agent => agent.role === 'hypothesis')) picker.value = 'hypothesis';
  const field = el('label', '에이전트 역할', 'diagram-field');
  field.append(picker);
  const body = el('div');
  const render = () => {
    const agent = view.residents.find(item => item.role === picker.value);
    if (!agent) return;
    state.diagramSelection.agent = agent.role;
    const seed = agent.seed?.id ?? `seed-v1:${agent.role}`;
    const lineage = agent.role === 'hypothesis' ? view.genomeLineage : [];
    const nodes = [{ id: seed, parents: [], title: '기본 Seed', caption: seed }];
    for (const revision of lineage) nodes.push({
      id: revision.id, parents: [revision.parent_id ?? seed], title: revision.id.slice(0, 12),
      caption: `Genome 코드 ${revision.code}`, revision,
    });
    if (!nodes.some(node => node.id === agent.genome)) nodes.push({ id: agent.genome, parents: [], title: agent.genome, caption: '연구에 고정된 Genome' });
    nodes.find(node => node.id === agent.genome).badge = el('span', '이 연구에 적용', 'badge good');
    const owned = new Set(view.tasks.filter(task => task.role === agent.role).map(task => task.id));
    const findings = (view.scientificSim?.findings ?? []).filter(item => owned.has(item.task_id));
    body.replaceChildren(diagram(nodes, '에이전트 Genome 계보', state.diagramSelection.genome ?? agent.genome,
      id => { state.diagramSelection.genome = id; }, node => {
        const info = el('div');
        info.append(el('h3', node.title));
        if (node.revision) info.append(el('p', `승인 ${dateTime.format(node.revision.created_at)}`),
          button('이 버전의 평가 열기', () => openComparison(state, node.revision.benchmark_id)));
        else info.append(el('p', `연구에 고정된 값 · ${agent.genome}`));
        return info;
      }), el('h3', '작업에서 남긴 개선 근거'),
    table(['검출 유형', '대상'], findings.map(item => [label(item.category), item.subject]), '이 역할에 연결된 개선 근거가 없습니다.'));
  };
  picker.addEventListener('change', () => { state.diagramSelection.genome = null; render(); });
  render();
  return [panel('에이전트별 Genome 계보', field, body), panel('후보 비교 평가',
    el('p', '후보 Genome의 세대별 점수와 MAP-Elites 아카이브는 작업 폴더의 평가 기록에서 볼 수 있습니다.'),
    button('진화 평가 열기', () => openComparison(state)))];
}

function workflow(state, view) {
  const native = (view.nativeReviewOptions ?? []).map(option => {
    const previous = view.proposals.findLast(p => p.payload.native_review === option.name);
    const task = previous && view.tasks.find(item => item.id === previous.id);
    const hasNewEvidence = previous && JSON.stringify(previous.payload.dependencies) !== JSON.stringify(option.dependencies);
    const pending = previous?.decision === 'NEEDS_HUMAN_APPROVAL' || ['QUEUED', 'RUNNING'].includes(task?.status);
    const canRequest = view.run.status === 'ACTIVE' && (!previous || (hasNewEvidence && !pending));
    const action = canRequest ? button(`${option.name} 요청`, async () => {
      await scoped(state, `/research/${view.run.id}/native-review`, { name: option.name });
      await refresh(state, true);
    }) : '—';
    return [option.name, `${option.phase}${option.recommended ? ' · 현재 단계 권장' : ''}`, option.description,
      task ? badge(task.status) : previous ? badge(previous.decision) : '—', action];
  });
  const advisories = view.tasks.filter(task => task.action === 'DELEGATE_NATIVE_REVIEW' && task.status === 'DONE').map(task => {
    const item = el('div');
    item.append(el('h3', task.result.name), el('p', task.result.summary));
    if (task.result.steps?.length > 1) item.append(table(['검토 역할', '자문'], task.result.steps.map(step => [step.agent, step.summary])));
    return item;
  });
  const approvals = view.proposals.filter(p => p.decision === 'NEEDS_HUMAN_APPROVAL').map(proposal => {
    const row = el('div', undefined, 'inline');
    const review = async approve => {
      const outcome = await scoped(state, `/research/${view.run.id}/review-proposal`, { proposal: proposal.id, approve });
      if (context === state) notice.textContent = `${label(outcome.decision)} · ${outcome.reason}`;
      await refresh(state, true);
    };
    const purpose = proposal.payload.native_review ? `${proposal.payload.native_review} · ${proposal.payload.objective}` : proposal.payload.objective;
    row.append(el('p', purpose), button('승인', () => review(true)), button('거절', () => review(false)));
    return row;
  });
  const byId = new Map(view.tasks.map(task => [task.id, task]));
  return [...(native.length ? [panel('GJC 읽기 전용 검토', table(['역할', '연구 단계', '검토 내용', '상태', '조치'], native))] : []),
    ...(approvals.length ? [panel('승인 대기', ...approvals)] : []), ...(advisories.length ? [panel('Subagent 자문 결과', ...advisories)] : []),
    panel('작업 및 의존성', table(['작업', '담당', '선행 작업', '상태', '조치'], view.tasks.map(task => [label(task.action), label(task.role),
      task.proposal.dependencies.map(id => label(byId.get(id)?.action ?? id)).join(', '), badge(task.status),
      ['QUEUED', 'RUNNING'].includes(task.status) ? button('취소', () => change(state, view.run.id, 'cancel-task', { task: task.id })) : null]))),
    panel('제안 및 결정', table(['작업', '제안자', '결정', '근거'], view.proposals.map(proposal => [label(proposal.payload.action_type),
      label(proposal.payload.proposer_agent_id), badge(proposal.decision), proposal.reason])), details('전체 이벤트', view.events))];
}

function selectResearchTab(state, view, tab) {
  state.tab = tab;
  state.signature = '';
  paint(state, view, renderResearch);
}

function renderResearch(state, view) {
  const actions = el('div', undefined, 'actions');
  const id = view.run.id;
  if (view.run.status === 'ACTIVE') {
    const start = button(view.execution.running ? '실행 중…' : '연구 실행', () => change(state, id, 'run'), 'primary');
    start.disabled = view.execution.running;
    actions.append(start, button('일시정지', () => change(state, id, 'pause')));
  } else if (view.run.status === 'PAUSED') actions.append(button('재개', async () => {
    await change(state, id, 'resume');
    await change(state, id, 'run');
  }, 'primary'));
  if (view.run.plan.reasoning && view.researchLedger.hypotheses && view.run.status !== 'ACTIVE' && !view.execution.running) {
    actions.append(button('가설 분기 연구', async () => {
      const child = await scoped(state, `/research/${id}/branch`, {});
      await openRun(state, child.id);
    }));
  }
  const heading = el('div', undefined, 'page-header');
  const title = el('div', undefined, 'title-group');
  title.append(el('h1', view.run.objective), badge(view.execution.running ? 'RUNNING' : view.run.status));
  if (view.branch) {
    const lineage = el('div', undefined, 'inline');
    lineage.append(el('p', view.branch.independentPartition ? '상위 가설 비교 · 별도 합성 데이터 분할' : '상위 가설 비교 · 같은 승인 데이터 사용'),
      button('상위 연구 열기', () => openRun(state, view.branch.parent)));
    title.append(lineage);
  }
  heading.append(title, actions);
  const nav = el('nav', undefined, 'tabs');
  nav.setAttribute('aria-label', '연구 상세');
  for (const [tab, name] of Object.entries(tabs)) {
    const link = button(name, () => selectResearchTab(state, view, tab));
    link.setAttribute('aria-pressed', String(state.tab === tab));
    nav.append(link);
  }
  const sections = state.tab === 'overview' ? overview(state, view) : state.tab === 'flow' ? researchFlowPage(state, view) : state.tab === 'council' ? council(view)
    : state.tab === 'experiments' ? experimentFlow(state, view) : state.tab === 'lineage' ? researchEvolution(state, view)
    : state.tab === 'evolution' ? agentEvolution(state, view)
    : state.tab === 'orchestration' ? workflow(state, view)
      : [panel('에이전트 세션', table(['역할', 'Identity', '상태', 'Genome', '개인 기억', 'SDK 세션'], view.residents.map(agent =>
        [label(agent.role), agent.agent_id?.slice(0, 8), badge(agent.lifecycle), agent.genome, agent.privateMemory, agent.sessionBound ? '연결됨' : '미연결']))),
      panel('에이전트 간 메시지', table(['보낸 역할', '받는 역할', '유형', '작업'], (view.messages ?? []).map(message =>
        [label(message.sender), label(message.recipient), label(message.kind), message.task_id])))];
  content.replaceChildren(heading, nav, ...(view.execution.error ? [el('p', view.execution.error, 'notice')] : []), ...sections);
}

function evolutionArchive(state, evolution, reportId) {
  const trials = evolution.conditions.flatMap(condition => (condition.runs ?? [])
    .filter(run => run.history?.length).map(run => ({ id: `${condition.condition}/${run.seed}`, condition: condition.condition, run })));
  const chooser = el('select');
  const field = el('label', '평가 조건과 시드', 'diagram-field');
  field.append(chooser);
  for (const trial of trials) {
    const option = el('option', `${trial.condition} · 시드 ${trial.run.seed}`);
    option.value = trial.id;
    chooser.append(option);
  }
  const selection = state.archive?.reportId === reportId ? state.archive
    : { reportId, trialId: trials.find(trial => trial.condition === 'map-elites-sim')?.id ?? trials[0].id };
  state.archive = selection;
  chooser.value = selection.trialId;
  const body = el('div');
  const percent = score => new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 1 }).format(score);

  function showTrial() {
    selection.trialId = chooser.value;
    const { condition, run } = trials.find(trial => trial.id === chooser.value);
    const scores = el('ol', undefined, 'generation-list');
    for (const [generation, candidates] of run.history.entries()) {
      if (!candidates.length) continue;
      const score = Math.max(...candidates.map(candidate => candidate.fitness));
      const meter = el('meter');
      meter.value = score;
      meter.setAttribute('aria-label', `세대 ${generation} 개발 최고 점수`);
      const row = el('li');
      row.append(el('span', `세대 ${generation}`), meter, el('strong', percent(score)));
      scores.append(row);
    }
    body.replaceChildren(el('h3', '세대별 최고 개발 점수'), scores, el('p',
      `선택된 Genome의 보류 세트 정확도 ${percent(run.heldOut)} · 기본 Seed ${percent(run.baseline)} · 전이 세트 ${percent(run.transfer)}`));

    const cells = Object.entries(run.archive ?? {});
    const genomes = new Map((run.lineage ?? []).map(genome => [genome.revision, genome]));
    function showGenome(genomeId) {
      const ancestors = new Set();
      function trace(id) {
        if (!genomes.has(id) || ancestors.has(id)) return;
        ancestors.add(id);
        genomes.get(id).parents.forEach(trace);
      }
      trace(genomeId);
      const path = [...ancestors].map(id => {
        const item = genomes.get(id);
        return { id, parents: item.parents, title: id.slice(0, 12), caption: `세대 ${item.generation} · 코드 ${item.code}`,
          badge: id === run.selected.revision ? el('span', '평가에서 선택', 'badge good') : null, item };
      });
      const graph = el('div');
      graph.append(el('h3', genomeId === run.selected.revision ? '선택된 Genome 계보' : '아카이브 Genome 계보'));
      if (path.length) graph.append(diagram(path, '평가 Genome 계보', genomeId, null, ({ item }) => {
        const info = el('div');
        info.append(el('p', `Genome ${item.revision}`));
        if (item.parents.length) info.append(el('p', `부모 ${item.parents.map(id => id.slice(0, 12)).join(', ')}`));
        return info;
      }));
      return graph;
    }
    const lineage = el('div');
    const cellsById = new Map(cells);
    const cellControls = new Map();
    function highlight(cellId) {
      selection.cell = cellId;
      const cell = cellsById.get(cellId);
      for (const [id, control] of cellControls) control.setAttribute('aria-pressed', String(id === cellId));
      lineage.replaceChildren(...(cell ? [el('p', `선택한 셀의 개발 점수 ${percent(cell.fitness)} · Genome 코드 ${cell.code}`)] : []),
        showGenome(cell?.revision ?? run.selected.revision));
    }
    if (condition === 'map-elites-sim' && cells.length) {
      const grid = el('div', undefined, 'archive-grid');
      const xAxis = Array.from({ length: 7 }, (_, index) => index);
      const yAxis = Array.from({ length: 4 }, (_, index) => index);
      grid.append(table(['활성 핵심 신호 수 ↓ / 보정 가중치 합 →', ...xAxis], yAxis.map(y => [y, ...xAxis.map(x => {
        const id = `${y}:${x}`;
        const cell = cellsById.get(id);
        if (!cell) return '—';
        const control = button(percent(cell.fitness), () => highlight(id), cell.fitness >= 0.9 ? 'archive-cell high' : 'archive-cell');
        control.setAttribute('aria-label', `활성 핵심 신호 ${y}, 보정 가중치 합 ${x}, 개발 점수 ${percent(cell.fitness)}`);
        cellControls.set(id, control);
        return control;
      })])));
      body.append(el('h3', 'MAP-Elites 행동 아카이브'), el('p', '채워진 셀은 해당 특성 조합에서 기록된 최고 개발 점수입니다.'), grid,
        button('선택된 Genome 보기', () => highlight(null)));
    }
    highlight(cellsById.has(selection.cell) ? selection.cell : null);
    body.append(lineage);
  }

  chooser.addEventListener('change', () => { selection.cell = null; showTrial(); });
  showTrial();
  return panel('합성 대리 평가 · Genome 탐색', field, body);
}

function routerGenomeTree(result) {
  const development = result.genomeDevelopment ?? [];
  if (!development.length) return null;
  const parent = development[0].parent;
  const selected = result.candidates.genome.configuration.code;
  const idFor = code => String(code);
  const nodes = [{ id: idFor(parent), title: `기준 Genome ${parent}`, parents: [] },
    ...development.map(candidate => ({
      id: idFor(candidate.code), title: `후보 Genome ${candidate.code}`, parents: [idFor(candidate.parent)],
      caption: candidate.code === result.guided?.code ? 'Router 제안' : '개발 후보',
      badge: el('span', candidate.clean ? '개발 실행 재현' : '개발 실행 검토', `badge ${candidate.clean ? 'good' : 'attention'}`),
      candidate,
    }))];
  return panel('Router Genome 개발 비교', diagram(nodes, 'Router Genome 후보 계보', idFor(selected), null, node => {
    const info = el('div');
    info.append(el('h3', node.title));
    if (Number(node.id) === selected) info.append(el('p', `보류 평가에 사용 · ${result.candidates.genome.evaluation.eligible ? '적용 후보' : '적용 보류'}`));
    if (node.candidate) info.append(table(['개발 시드', '논증·실험 점수', '재현'], node.candidate.rows.map(row => [
      row.seed, row.quality, badge(row.validated ? 'PASS' : 'FAIL'),
    ])));
    return info;
  }));
}

function renderComparisons(state, response) {
  const result = response.results[0]?.payload;
  const header = el('div', undefined, 'page-header');
  const title = el('div', undefined, 'title-group');
  const connectedResult = result?.kind === 'ROUTER_CONNECTED_SYNTHETIC_STUDY';
  title.append(el('h1', '진화 및 비교 평가'), el('p', connectedResult ? '구성된 Router 모델을 합성 제조 연구에서 비교했습니다.' : '이 작업 폴더의 합성 연구 평가 기록입니다.'));
  const actions = el('div', undefined, 'actions');
  const showComparison = id => openComparison(state, id);
  if (state.comparison) actions.append(button('최신 평가 보기', () => showComparison(null)));
  for (const [name, full] of [['빠른 평가', false], ['전체 평가', true]]) {
    const start = button(name, async () => { await scoped(state, '/comparisons', { full }); await showComparison(null); }, full ? undefined : 'primary');
    start.disabled = response.workspace.benchmarkRunning;
    actions.append(start);
  }
  if (state.workspace.runtime === 'router') {
    const start = button('Router 모델 비교', async () => { await scoped(state, '/comparisons', { connected: true }); await showComparison(null); });
    start.disabled = response.workspace.benchmarkRunning;
    actions.append(start);
  }
  const active = ['policy', 'genome'].filter(kind => response.revisions?.[kind]).map(kind => {
    const revision = response.revisions[kind];
    return [kind === 'policy' ? '오케스트레이션 정책' : '가설 Agent Genome', revision.id.slice(0, 12), button('이전 버전으로 복원', async () => {
      await scoped(state, '/revisions', { kind, action: 'rollback', id: revision.id });
      await refresh(state, true);
    })];
  });
  const candidates = connectedResult ? ['policy', 'genome'].map(kind => {
    const item = result.candidates[kind];
    return [kind === 'policy' ? '오케스트레이션 정책' : '가설 Agent Genome', item.evaluation.eligible ? '독립 평가 통과' : '보류',
      item.evaluation.delta.mean ?? '—', item.evaluation.eligible ? button('새 연구에 적용', async () => {
        await scoped(state, '/revisions', { kind, action: 'activate', id: response.results[0].id });
        await refresh(state, true);
      }) : '—'];
  }) : [];
  header.append(title, actions);
  const sections = result ? [
    panel('오케스트레이션', table(['정책', '평균 배치 수', '재현율'], result.orchestration.map(row =>
      [label(row.strategy), row.batches.mean, row.validationRate.mean == null ? null : `${(100 * row.validationRate.mean).toFixed(0)}%`])),
      details('정책 선택 근거', result.policyRevision ?? result.policyDevelopment)),
    ...(result.evolution ? [panel('에이전트 진화', table(['조건', '평가 정확도', '기준 대비 차이', '회귀율'], result.evolution.conditions.map(row =>
      [row.condition, row.heldOut.mean?.toFixed(3), row.pairedDelta.mean?.toFixed(3), row.regressionRate?.toFixed(3)])), details('Genome 계보, SIM 및 아카이브', result.evolution)),
      ...(result.evolution.conditions.some(row => row.runs?.some(run => run.history?.length)) ? [evolutionArchive(state, result.evolution, response.results[0].id)] : [])] :
      [panel('승인 대기 후보', table(['대상', '판정', '평균 개선', '적용'], candidates), details('Genome 개발 평가와 모델 제안',
        { development: result.genomeDevelopment, guided: result.guided })),
      ...(result.genomeDevelopment?.length ? [routerGenomeTree(result)] : []),
      ...(result.agentConditions ? [panel('진화 조건별 Router 재평가', table(['조건', 'Genome', '평균 품질 점수'], result.agentConditions.map(row =>
        [row.condition, row.code, row.quality.mean?.toFixed(2)])))] : [])]),
    ...(active.length ? [panel('적용 중인 버전', table(['대상', '버전', '작업'], active))] : []),
    panel('메모리 비교', table(['메모리 설정', '평균 배치 수'], result.memory.map(row => [label(row.mode), row.batches.mean])),
      ...(result.evolution?.simAblation ? [details('SIM 조건별 평가 결과', result.evolution.simAblation.map(row => ({ condition: row.condition, heldOut: row.heldOut })))] : [])),
    ...(response.history.length > 1 ? [panel('저장된 평가 이력', table(['실행 시간', '유형', '결과 ID', '보기'], response.history
      .map(record => [new Date(record.created_at).toLocaleString('ko-KR'), record.scope, record.id,
        record.id === response.results[0]?.id ? '표시 중' : button('결과 열기', () => showComparison(record.id))])))] : []),
  ] : [panel('저장된 평가', el('p', '평가를 실행하면 결과와 진화 기록이 이 폴더에 저장됩니다.'))];
  content.replaceChildren(header, ...(response.workspace.benchmarkRunning ? [el('p', '비교 평가 실행 중…', 'notice')] : []),
    ...(response.workspace.benchmarkError ? [el('p', response.workspace.benchmarkError, 'notice')] : []), ...sections);
}

function paint(state, value, render) {
  if (context !== state) return;
  const signature = JSON.stringify([state.page, state.tab, state.comparison, value]);
  if (signature === state.signature) return;
  const openDetails = new Set([...content.querySelectorAll('details[open] > summary')].map(node => node.textContent));
  const activeButton = content.contains(document.activeElement) ? document.activeElement.textContent : null;
  const scrolls = new Map([...content.querySelectorAll('.diagram-viewport')].map(node => [node.getAttribute('aria-label'), node.scrollLeft]));
  state.signature = signature;
  render(state, value);
  for (const summary of content.querySelectorAll('details > summary')) if (openDetails.has(summary.textContent)) summary.parentElement.open = true;
  for (const node of content.querySelectorAll('.diagram-viewport')) node.scrollLeft = scrolls.get(node.getAttribute('aria-label')) ?? 0;
  if (activeButton) [...content.querySelectorAll('button')].find(item => item.textContent === activeButton)?.focus({ preventScroll: true });
}

async function refresh(state, force = false) {
  if (context !== state || (state.pending && !force)) return;
  const request = Symbol();
  state.pending = request;
  const { page, selected } = state;
  try {
    const reportPath = page === 'comparisons' ? `/comparisons${state.comparison ? `?id=${encodeURIComponent(state.comparison)}` : ''}`
      : selected ? `/research/${selected}` : null;
    const [listing, view] = await Promise.all([scoped(state, '/research'), reportPath ? scoped(state, reportPath) : null]);
    if (context !== state || state.pending !== request) return;
    state.nextPoll = Date.now() + (view?.execution?.running || view?.workspace?.benchmarkRunning ? 1100 : 3800);
    updateRuns(state, listing.runs);
    state.datasets = listing.datasets ?? [];
    state.mlDatasets = listing.mlDatasets ?? [];
    if (view) paint(state, view, page === 'comparisons' ? renderComparisons : renderResearch);
  } finally { if (state.pending === request) state.pending = false; }
}

async function openRun(state, id, tab = 'overview') {
  if (context !== state) return;
  if (state.selected !== id) state.diagramSelection = {};
  if (state.selected !== id || state.page !== 'research') state.tab = tab;
  state.selected = id;
  state.page = 'research';
  state.signature = '';
  await refresh(state, true);
}

async function openComparison(state, id = null) {
  if (context !== state) return;
  state.page = 'comparisons';
  state.selected = null;
  state.comparison = id;
  await refresh(state, true);
}

async function change(state, id, action, input = {}) {
  await scoped(state, `/research/${id}/${action}`, input);
  if (context === state) await refresh(state, true);
}

for (const selector of ['#open-workspaces', '#change-workspace']) $(selector).addEventListener('click', openFolderDialog);
for (const control of document.querySelectorAll('[data-close]')) control.addEventListener('click', () => document.getElementById(control.dataset.close).close());
$('#native-picker').addEventListener('click', () => { void connect(async () => (await api('/api/workspaces/pick', {})).workspace); });
$('#connect-form').addEventListener('submit', event => {
  event.preventDefault();
  void connect(() => api('/api/workspaces/connect', { path: $('#folder').value }));
});
$('#new-run').addEventListener('click', openNewRun);
$('#create-form').elements.researchType.addEventListener('change', updateDatasetFields);
$('#register-ml-data').addEventListener('click', () => {
  if (!context) return;
  $('#ml-data-error').textContent = '';
  $('#ml-data-dialog').showModal();
});
$('#ml-data-form').addEventListener('submit', async event => {
  event.preventDefault();
  const state = context;
  if (!state) return;
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const errorField = $('#ml-data-error');
  errorField.textContent = '';
  submit.disabled = true;
  try {
    const fields = new FormData(form);
    const file = fields.get('file');
    const format = file.name.split('.').at(-1).toLowerCase();
    if (!['csv', 'json'].includes(format) || file.size > 1000000) throw new Error('1MB 이하의 CSV 또는 JSON 파일을 선택하세요.');
    const entry = await scoped(state, '/ml-datasets', { format, content: await file.text(), kind: fields.get('kind'),
      target: fields.get('target'), features: fields.get('features').split(',').map(name => name.trim()), group: fields.get('group'),
      split: fields.get('split'), delimiter: fields.get('delimiter') });
    if (context !== state) return;
    form.reset();
    $('#ml-data-dialog').close();
    await refresh(state, true);
    notice.textContent = `데이터 ${entry.target} · ${entry.rows}행 등록 완료`;
  } catch (error) { errorField.textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#comparisons').addEventListener('click', () => {
  if (context) void openComparison(context).catch(report);
});
$('#create-form').addEventListener('submit', event => {
  event.preventDefault();
  const state = context;
  if (!state) return;
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  $('#create-error').textContent = '';
  const fields = new FormData(form);
  const settings = Object.fromEntries(['researchType', 'strategy', 'memory', 'evolution'].map(name => [name, fields.get(name)]));
  for (const name of ['seed', 'maxTasks', 'maxParallel']) settings[name] = Number(fields.get(name));
  settings.timeoutMs = Math.round(Number(fields.get('timeout')) * 1000);
  void scoped(state, '/research', { objective: fields.get('objective'), settings, dataset: fields.get('dataset'), mlDataset: fields.get('mlDataset') }).then(run => {
    if (context !== state) return;
    createDialog.close();
    form.reset();
    return openRun(state, run.id);
  }).catch(error => { $('#create-error').textContent = error.message; }).finally(() => { submit.disabled = false; });
});

showEmpty();
void api('/api/workspaces').then(async info => {
  pickerAvailable = info.picker;
  $('#native-picker').hidden = !pickerAvailable;
  if (info.initial) await activate(info.initial);
  else if (readRecent().length) {
    try { await activate(await api('/api/workspaces/connect', { path: readRecent()[0].root })); }
    catch { /* recent folders remain available for manual reconnection */ }
  }
}).catch(report);
setInterval(() => { if (context && !document.hidden && Date.now() >= (context.nextPoll ?? 0)) void refresh(context).catch(report); }, 1250);
