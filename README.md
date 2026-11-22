# Gajae Autonomous Research Lab

Windows에서 연구를 설정하고 실험과 Agent 평가를 실행하는 로컬 연구실입니다. 선택한 작업 폴더의 SQLite에 Run, Proposal, Task DAG, Agent별 기억, 실험 및 비교 결과를 저장합니다. 브라우저 대시보드는 `127.0.0.1`에 바인딩됩니다.

## Windows에서 작업 폴더 열기

파일 탐색기에서 **`Start Lab.cmd`**를 더블 클릭하면 로컬 대시보드가 기본 브라우저에서 열립니다. 터미널에서는 `node apps/lab/main.ts open`으로 열 수 있습니다.

1. **작업 폴더 열기**에서 기존 Windows 폴더를 지정합니다. Rust 실행 파일에 폴더 선택 기능이 있으면 Windows 폴더 선택창도 사용할 수 있습니다.
2. **새 연구**에서 목표, 연구 유형, 오케스트레이션, 메모리, 시드와 작업 한도를 선택합니다. 제조 공정 연관성, 합성 분류 모델 비교, 정렬 알고리즘 비교에는 실행 가능한 등록 실험이 있습니다. 아이디어 및 사용자 연구 설계는 반증 계획을 저장하고 결론을 보류합니다. 생성 당시 설정은 해당 연구에 고정됩니다.
3. **연구 실행**을 누르면 **진행 개요**에 작업 진행률과 실험·재검증 결과가 표시됩니다. 가설이 있는 종료 또는 일시정지 연구에서 **가설 분기 연구**를 눌러 상위 가설과 예측을 비교할 수 있습니다. **진화 및 비교 평가**에서 평가를 실행하고 같은 폴더의 과거 결과를 다시 열 수 있습니다.

- **연구 흐름**에서는 연구 계획부터 결론까지 각 단계의 진행 상태, 대기 중인 승인과 선행 작업, 검증 요약을 한 화면에서 확인합니다. 단계를 선택하면 작업 목록과 상세 화면을 열 수 있습니다.
- **실험 흐름**에서 작업을 선택하면 담당 Agent, 선행 의존성, 실행 이력과 결과를 볼 수 있습니다. 단계별 보기와 실험 기록은 [The AI Scientist-v2](https://arxiv.org/abs/2504.08066)의 단계적 탐색 및 [W3C PROV-DM](https://www.w3.org/TR/prov-dm/)의 출처 추적 방식을 참고했습니다.
- **연구 진화**는 상위·분기 연구와 가설 버전의 실제 연결을 표시합니다. 분기 간 데이터 재사용 여부와 새 예측의 독립 검증 여부도 확인할 수 있습니다.
- **에이전트 진화**에서는 역할별로 이 연구에 고정된 Seed 또는 승인 Genome과 해당 작업의 개선 근거를 확인합니다. **진화 및 비교 평가**에는 합성 평가의 세대별 개발 점수, 선택 Genome 계보, 행동 특성 조합별 [MAP-Elites](https://arxiv.org/abs/1504.04909) 셀이 표시됩니다.

선택한 폴더의 기록은 다음과 같이 함께 보관됩니다.

```text
선택한 작업 폴더/
└─ .gajae-lab/
   ├─ lab.sqlite      연구 설정, 에이전트 기억, 작업, 실험 및 진화 평가
   ├─ artifacts/      실험 산출물
   └─ sessions/       GJC 호스트 사용 시 세션 저장 위치
```

폴더를 바꿔도 기존 폴더에서 실행 중인 연구는 원래 폴더에 계속 저장됩니다. 다른 위치에서 이어보려면 Lab 실행을 종료한 뒤 `.gajae-lab` 전체를 포함해 작업 폴더를 이동하거나 복사하고, 그 위치를 다시 선택하세요. SQLite 기록, 실험 파일과 비교 평가가 함께 열립니다. 실제 GJC 세션의 다른 경로 복원은 승인 SDK 환경에서 별도 검증이 필요합니다. Router 인증 정보는 작업 폴더에 복사되지 않습니다.

## 터미널 실행

외부 JavaScript 의존성은 없습니다. 현재 검증된 실행 경로는 Node 24와 내장 SQLite를 사용합니다. `data/`는 최초 실행 시 생성됩니다.

```powershell
node apps/lab/main.ts demo
node apps/lab/main.ts benchmark --full
node apps/lab/main.ts serve
```

CLI에서도 폴더를 고정하려면 `LAB_WORKSPACE`에 기존 폴더의 절대 경로를 지정합니다. `benchmark --full` 결과는 같은 작업 폴더의 **진화 및 비교 평가** 화면에 표시됩니다. 작업 폴더 설정 없이 `LAB_DB`를 쓰던 기존 기록은 해당 환경 변수로 대시보드를 실행하면 별도 기록으로 열립니다. 중단된 비교 실행은 동일한 명령으로 완료된 실험을 재사용합니다. 진화 평가 도중에 중단되면 해당 진화 묶음을 다시 계산합니다.

```powershell
node --test tests/*.test.ts scripts/*.test.mjs
cargo test --offline --locked
./scripts/smoke.ps1
```

MSVC 링커가 없는 Windows x64에서는 설치된 Rust GNU 도구 체인과 자체 링커를 사용할 수 있습니다. 빌드한 실행 파일을 지정하면 Dung 계산과 Genome 교차·변이를 Rust에서 실행합니다.

```powershell
$env:RUSTFLAGS = '-C linker=rust-lld -C link-self-contained=yes'
cargo +stable-x86_64-pc-windows-gnu build --offline --locked
cargo +stable-x86_64-pc-windows-gnu test --offline --locked
$env:LAB_RUST_BIN = (Resolve-Path target/debug/gajae-research-kernel.exe).Path
node apps/lab/main.ts demo
```

대시보드는 새로 빌드한 `target/debug` 또는 `target/release`의 Windows 실행 파일을 찾으면 폴더 선택 버튼을 표시합니다. 실행 파일이 없는 환경에서는 폴더 경로를 직접 입력할 수 있습니다.

설정은 프로세스 환경에서 읽습니다. `LAB_DB`로 DB 경로를 변경하고 `LAB_PORT`로 로컬 포트를 변경할 수 있습니다.

## 승인된 제조 데이터 사용

측정값 JSON 배열에 `hour`, `batch`, `phase`, `temperature`, `pressure`, `load`, `defect`를 넣습니다. 시간순으로 정렬된 80~10,000행, 연속된 배치 그룹 4개 이상, 이진 `defect` 값이 필요합니다.

```powershell
$env:LAB_WORKSPACE = 'C:\Research\ProcessQuality'
$env:LAB_APPROVED_DATA_FILE = 'C:\Research\approved\measurements.json'
node apps/lab/main.ts inspect-data
node apps/lab/main.ts import-data
```

등록 후 **새 연구**에서 해당 데이터의 해시 버전을 선택합니다. CLI `demo`에서는 `LAB_DATASET_ID`에 등록 결과의 ID를 설정합니다. Lab은 데이터를 작업 폴더에 보관하고 배치 경계에서 개발·평가 구간을 나눕니다. Agent에 제공되는 데이터 정보는 메타데이터와 개발 요약으로 한정됩니다. 같은 승인 데이터로 분기한 연구는 그 결과를 독립 검증으로 집계할 수 없습니다.

## 등록 데이터로 ML 연구 실행

1. 작업 폴더에서 **ML 데이터 등록**을 누르고 UTF-8 CSV 또는 JSON 레코드 배열을 선택합니다. 파일은 최대 1MB, 60~10,000행입니다. 이진 분류 또는 수치 회귀를 고르고 대상 열과 수치 특성 열 1~24개를 지정합니다.
2. 같은 사람·장비·배치의 반복 관측이 있다면 그룹 열을 지정합니다. 시간 순서가 중요한 연구는 사전에 시간순으로 정렬한 파일과 **파일 순서 유지**를 선택합니다. 동일 그룹이나 특성 조합이 서로 다른 구간에 걸치거나 구간의 표본이 부족하면 등록에 실패합니다.
3. **새 연구 → 등록 데이터 ML 연구**에서 데이터셋을 선택하고 실행합니다. 데이터 수집 Agent가 이 폴더에 등록된 버전을 확인하고, 품질 Agent가 학습·개발·보류 구간과 수치 특성을 점검합니다. 모델에는 집계된 학습·개발 프로필만 전달됩니다.
4. 모델은 학습 구간에서 적합하고 개발 구간에서 선택합니다. 보류 구간에서는 선택 모델과 사전 지정 기준선만 비교합니다. 분류는 균형 정확도, 회귀는 평균 절대 오차를 사용합니다. 재계산 통과는 같은 데이터와 설정에서 결과가 재현됐음을 나타냅니다.

터미널에서도 같은 작업 폴더와 입력 파일을 사용할 수 있습니다.

```powershell
$env:LAB_WORKSPACE = 'C:\Research\ModelStudy'
$env:LAB_APPROVED_DATA_FILE = 'C:\Research\measurements.csv'
$env:LAB_ML_KIND = 'regression'
$env:LAB_ML_TARGET = 'outcome'
$env:LAB_ML_FEATURES = 'feature_a,feature_b'
$registration = node apps/lab/main.ts import-ml-data | ConvertFrom-Json
$env:LAB_ML_DATASET_ID = $registration.id
node apps/lab/main.ts run-ml
```

필요하면 `LAB_ML_GROUP`에 그룹 열을 지정하고, `LAB_ML_SPLIT=ordered`로 파일 순서를 유지하거나 `LAB_ML_DELIMITER=';'`로 세미콜론 CSV를 읽습니다. 새로운 외부 데이터에 일반화되는지 판단하려면 별도의 데이터를 수집해 검증해야 합니다.

## AgentDeck 형식 Router 실행

AgentDeck Router와 같은 필드를 가진 JSON 객체 하나를 사용합니다. `configs/router.local.example.json`을 복사하고 Router 주소, 포트, 프로토콜 경로와 모델 ID를 설정합니다. `openai`는 `/chat/completions`, `anthropic`은 `/v1/messages` 리소스를 사용합니다. 비루프백 접속은 프로필의 `allow_remote: true` 설정이 필요합니다. `authentication`이 `bearer`이면 실행 환경에 `LAB_ROUTER_TOKEN`을 주입합니다. 프로필 파일이나 DB에 토큰을 저장할 필요는 없습니다.

```powershell
$env:LAB_ROUTER_PROFILE = 'C:/approved/router-profile.json'
$env:LAB_ROUTER_PROTOCOL = 'openai'
$env:LAB_ROUTER_TIMEOUT_MS = '60000'
node apps/lab/main.ts router-probe
node apps/lab/main.ts demo
node apps/lab/main.ts benchmark --connected
node apps/lab/main.ts serve
```

`router-probe`는 `PONG`만 요청하며 연구 데이터는 전송하지 않습니다. `demo`는 합성 제조 연구에서 Director, Hypothesis Scientist, Skeptic의 판단을 설정한 Router에 요청합니다. `LAB_ROUTER_MODEL`로 프로필 모델을 덮어쓸 수 있습니다. 이 HTTP 경로에 Bun과 GJC는 필요 없으며, Lab이 SQLite에 연구 상태와 Agent 기억을 유지합니다. 모델·경로·프로토콜 바인딩은 Run을 만들 때 고정합니다. 기존 Mock Run과 함께 사용할 경우 새 Router Run을 생성하세요.

```powershell
node --test tests/router.test.ts
```

로컬 목업 테스트는 OpenAI 및 Anthropic 호환 요청, CLI 연결 검사, 응답 검증, Proposal 권한, 연구 완료와 실험 재현을 확인합니다. 실제 사내 Router나 Codex 호출은 이 테스트에 포함되지 않습니다.

연결 비교 평가는 같은 Router 모델에서 오케스트레이션, 메모리, Genome 후보를 비교합니다. 구성과 평가 조건을 재확인하고 개선 문턱을 통과한 후보만 대시보드에서 운영자가 적용하거나 되돌릴 수 있습니다. 새 제조 연구에서 **진화형 정책** 또는 **승인된 Genome 사용**을 선택하면 해당 설정이 생성 시점에 고정됩니다.

## Bun과 GJC 실행 조건

`bun apps/lab/main.ts demo`와 `bun apps/lab/main.ts serve`가 Bun 진입점입니다. Bun `>=1.4.0`과 `0.22.0`으로 맞춘 GJC SDK 및 Windows 네이티브 패키지는 승인된 오프라인 번들로 공급합니다. 프로젝트 락파일은 외부 의존성이 없는 기본 워크스페이스를 정의합니다. SDK 번들의 락파일과 해시는 별도로 관리합니다.

```powershell
node scripts/gjc-windows-compat.mjs --bun $approvedBunExe --bundle $approvedBundleRoot
node scripts/gjc-windows-compat.mjs --bun $approvedBunExe --bundle $approvedBundleRoot --provider-module $approvedProviderModule
```

기동 진단 후 실제 사내 모델을 연결하려면 승인된 호스트에서 다음 환경 변수를 설정합니다.

| 변수 | 값 |
| --- | --- |
| `LAB_GJC_BUNDLE` | `node_modules/@gajae-code`가 있는 승인된 번들 루트의 절대 경로 |
| `LAB_APPROVED_PROVIDER` | `getApprovedBinding()`을 내보내는 운영자 작성 모듈. 반환값은 사내 모델로 고정한 SDK `model`, `modelRegistry`, `authStorage` 객체 |
| `LAB_GJC_SESSION_ROOT` | 작업 폴더를 선택하지 않은 기존 `LAB_DB` 모드의 세션 저장 폴더. 작업 폴더 연결 모드는 해당 폴더의 `.gajae-lab/sessions/` 사용 |
| `LAB_GJC_NATIVE_REVIEW` | `1`이면 기본 읽기 전용 연구 검토를 활성화. Provider가 자체 검토 어댑터를 제공하면 그 어댑터가 우선 |

운영자 모듈과 SDK는 신뢰된 호스트 코드입니다. 사내 모델만 접근 가능한 OS 네트워크 정책을 이 호스트에 적용하고, SDK 세션 디렉터리를 한 GJC 호스트 프로세스에서 사용합니다. 자격증명은 운영자 모듈이 관리합니다. 실제 진단에 필요하면 `--env-name LAB_APPROVED_...`으로 전달할 환경 변수 이름을 지정합니다. Windows x64에서 Bun 1.4.5와 GJC SDK 0.22.0을 로컬 Router 목업에 연결해 SDK 응답, 이벤트, 세션 복원, 병렬 세션 및 합성 제조 연구를 검증했습니다. 실제 사내 Provider 검증은 남아 있습니다.

`LAB_GJC_NATIVE_REVIEW=1`을 설정한 뒤 새 연구의 **작업 및 승인**에서 단계별 검토를 요청합니다. 요청 당시 완료된 관련 작업을 근거로 고정하며, 실행에는 운영자 승인이 필요합니다.

| 검토 역할 | 연구 단계와 산출물 |
| --- | --- |
| `deep-interview` | 초기 질문 구체화. 내장 Planner가 미확정 대상·비교군·측정값·반증 조건에 대한 질문을 제안 |
| `planner` | 가설 이후 실험 계획, 기준선, 개발·보류 데이터 분할을 검토 |
| `architect` | 실험 설계의 데이터 경계와 재현성 점검 |
| `critic` | 대안 설명, 측정 신뢰성, 검정력과 반증 기준 점검 |
| `ralplan` | Planner → Architect → Critic 순서로 계획을 검토하고 각 자문을 기록 |

검토 결과는 자문으로 저장됩니다. 실험 전 자문은 관련 Agent의 계획과 논증에 참고로 전달합니다. 실험 재검증 후에 작성된 자문은 별도 기록에서 확인할 수 있습니다. 새 근거가 쌓이면 같은 역할로 검토를 다시 요청할 수 있습니다.

[Agent Lab 구축 후속 검토](docs/agent-lab-build-review.md) · [초기 설계 및 검증](docs/implementation-and-verification.md) · [과학 추론 Council](docs/scientific-reasoning.md) · [SDK 사전 조사](docs/agent-orchestration-integration-review.md)
