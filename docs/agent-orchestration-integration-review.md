# Research Lab 통합 검토

2026-11-22 · Windows x64 · Phase 0 부분 완료

## 기존 코드 조사

작업 시작 시 `AgentResearchLab` 디렉터리에는 소스와 `.git`이 없었다. 현재 채팅에 연결된 worktree도 없었다. 인접 `AgentDeck` 프로젝트, 로컬 개발 폴더, GJC 설치 및 캐시에서 기존 Research Lab 소스를 찾지 못했다. 기존 런, Preset, DB, API의 실제 위치와 호환성을 확인하려면 원본 체크아웃이 필요하다.

| 구성 요소 | 판정 | 위치와 근거 |
| --- | --- | --- |
| Research Orchestrator, State Machine | DEFER | 기존 소스 미확보. 현재 LLM 호출 여부와 고정 판단 규칙도 미확인. 원본 확보 후 작업 실행 및 상태 전이 경로 조사. |
| Agent Registry, ResearchPreset, Preset Compiler | DEFER | 기존 소스 미확보. 역할 등록 및 구버전 Preset 로딩 경로 조사 필요. |
| GJC Runtime Adapter | DEFER | 기존 Lab 어댑터 미확보. 정상 SDK 실행이 입증되면 기존 경계에 추가. |
| Session Manager | REUSE 후보 | 공개 SDK의 `packages/coding-agent/src/session/session-manager.ts`. 프로젝트별 저장·복원 검증 필요. |
| Research Memory, Private Agent Memory, Shared Evidence Store | DEFER | 기존 저장소·권한 모델 미확인. Ledger의 저장 및 조회 경계 확인 필요. |
| Experiment Engine, Scientific Validation, Philosophy Registry | DEFER | 기존 소스·스키마 미확보. 원본 확보 후 실행기, 검증 및 방법론 등록 경로 조사. |
| SIM, Evolution Engine | DEFER | 기존 소스·평가 데이터 미확보. 저장 형식과 Revision 모델 조사 필요. |
| Existing UI / API | DEFER | 기존 소스 미확보. 라우팅과 기존 응답 계약 확인 전 변경 없음. |
| Windows 호환성 진단 | NEW | `scripts/gjc-windows-compat.mjs`와 스크립트 자동 테스트. Lab 런타임과 독립 실행. |

## 공개 SDK와 로컬 설치

공개 릴리스 후보는 GJC `v0.22.0`, 태그 커밋 `22d6c082ce454f496b5f2561c307d1786059814b`다. NPM `latest`에서 확인한 `@gajae-code/coding-agent` 버전은 `0.22.0`이며, 매니페스트는 Bun `>=1.4.0`과 `@gajae-code/natives@0.22.0`을 명시한다. Windows x64 선택적 패키지 역시 `0.22.0`이다. 태그 커밋은 공개 Git 태그의 값이다. NPM 매니페스트에는 `gitHead`가 없다. [GitHub 릴리스](https://github.com/Yeachan-Heo/gajae-code/releases/tag/v0.22.0)

| 배포 파일 | SHA-512 SRI | 확인 범위 |
| --- | --- | --- |
| `@gajae-code/coding-agent@0.22.0` | `sha512-mkhWjm6H6a5Dk+5rjRQNZXBr8hA0BAe0E0OTQES25ddqkRY2Rw0txxP+j1dVL6YiXVP4j9V+Qw4zdPZH8jW8Ng==` | 임시로 받은 아카이브 바이트와 레지스트리 값이 일치. 배포 타입 선언 확인. |
| `@gajae-code/natives@0.22.0` | `sha512-392n/A/jh57KuR+dL2g5OBqJdLx9mHQPiXUL/aYwnhbMR83FeHQIXjGVKLYK8bCT+EMaD0bbQs90vrGGGHHxyA==` | 레지스트리 메타데이터 확인. |
| `@gajae-code/natives-win32-x64@0.22.0` | `sha512-0Oo3u4NXRryOa0RM/uSJjmKq7AE2NDqke5/mqMEwIynVIyJU/Sm7a8tOwZllXymHNkXe48tE5Uz45Oipnat2GQ==` | 레지스트리 메타데이터 확인. |

`./sdk`에서 `createAgentSession`을, 패키지 루트에서 `SessionManager`를 가져오는 구조를 확인했다. 타입 선언에 `SessionManager.create/open`, `session.prompt/subscribe`, `systemPrompt`, `customTools`가 있다. 네이티브 Task, 실제 이벤트 전달, 세션 파일 저장과 재개는 실행 검증이 필요하다. [릴리스 SDK 진입점](https://github.com/Yeachan-Heo/gajae-code/blob/v0.22.0/packages/coding-agent/src/sdk/index.ts) · [릴리스 패키지 루트](https://github.com/Yeachan-Heo/gajae-code/blob/v0.22.0/packages/coding-agent/src/index.ts) · [Embedding SDK 문서](https://github.com/Yeachan-Heo/gajae-code/blob/v0.22.0/docs/sdk-embedding.md)

이 머신에 Node `24.22.3`과 `gjc 0.18.12`가 있다. 독립 Bun 실행 파일과 완전한 승인 SDK 번들은 발견하지 못했다. 로컬 GJC 캐시에는 `0.10.2`, `0.18.12`, `0.20.0` Windows 네이티브 파일이 있다. 최신 SDK와 네이티브 파일을 설치하거나 로드한 이력은 없다.

## Windows 진단

- 격리된 임시 작업 경로, 초기화한 프로필 환경 변수, 10초 제한으로 로컬 `gjc.exe --version`을 실행했다. 출력은 `gjc/0.18.12`, 종료 코드는 `0`이었다. 실행 파일 SHA-256은 `511563b8187484078239de2b4dcf57e48b6c9bd5188a57cf9365bd36d4d4fc80`이다.
- 이 호출에서 Stack Overflow는 재현되지 않았다. 최근 60일의 Windows Application Error 이벤트에서 해당 실행 파일을 찾지 못했고, 기본 사용자 CrashDumps 경로에도 `gjc.exe` 덤프가 없었다. 최초 재현 명령, 종료 코드, 오류 모듈은 미확인이다.
- 버전 조회 이후의 CLI 시작 경로와 네이티브 로드를 각각 조사 대상으로 남긴다. SDK 로드와 네이티브 로드를 서로 다른 자식 프로세스로 구분한다. SDK import 자체도 네이티브 로드를 거칠 수 있으므로, 독립 네이티브 단계의 결과와 함께 해석한다.

### 진단 실행

Windows x64의 외부망 접근이 차단된 검증 환경에서 승인된 Bun 실행 파일과 의존성이 풀려 있는 번들 루트를 지정한다. `--bundle`은 `node_modules/@gajae-code`가 있는 폴더다. 진단기는 자동 설치와 `.env` 로딩을 끄고, 자식 프로세스의 출력을 그대로 기록하지 않는다. OS의 네트워크 정책은 검증 환경에서 적용한다. [Bun 런타임 옵션](https://bun.com/docs/runtime)

```powershell
node scripts/gjc-windows-compat.mjs --bun $approvedBunExe --bundle $approvedBundleRoot
node --test scripts/gjc-windows-compat.test.mjs
```

`--legacy-version-probe`에 기존 실행 파일의 절대 경로를 주면 명시적으로 `--version` 진단을 추가한다. 이 옵션을 생략하면 SDK 진단에서 `gjc.exe`를 호출하지 않는다.

| 검증 단계 | 이번 실행 |
| --- | --- |
| 진단기 구문 검사와 누락된 런타임·잘못된 런타임 테스트 | 통과, 자동 테스트 2건 |
| 로컬 GJC 버전 조회 | 통과, Stack Overflow 미재현 |
| Bun, SDK import, 네이티브 로드, SessionManager, 단일 Session 생성 | 미실행, 승인된 런타임 및 번들 미확보 |
| 도구 없는 LLM 호출, 이벤트, 제한된 도구, 저장·복원, 복수 세션, 네이티브 Subagent | 미실행, 실제 통합 필요 |
| Coordinator MCP 및 관리형 대체 경로 | 미검증. 현재 Windows에서 바이너리 기반 자동 폴백 미구성. |

## 남은 통합 범위

1. 기존 체크아웃에서 Run과 Preset의 정상 진입점을 찾아 회귀 테스트를 먼저 실행한다. 현재 LLM과 고정 규칙의 위치, 데이터 소유자 및 마이그레이션 경계를 위 표에 반영한다.
2. 승인 번들에서 기동 단계를 실행하고, 같은 SDK·Bun·네이티브 조합에서 사내 LLM을 사용하는 검증을 이어간다. 패키지 해시와 버전을 실제 실행 결과에 결합한 후 기존 어댑터의 `IN_PROCESS_SDK` 기본값 적용 여부를 결정한다.
3. 기존 런에 Proposal 검증과 실행 이력을 연결한다. 두 Resident Agent의 독립 세션 및 프로젝트별 접근 제어를 추가하고, 승인된 작업 실행 후 Ledger 갱신과 Director의 다음 결정을 통합 테스트한다.

Research Director, Control Plane, Resident Agent 협업, Adaptive Orchestration, Research Ledger 및 Progress Ledger의 실제 통합은 미구현이다. Scientific Council, Agent Evolution, Orchestration Evolution, UI 변경, 비교 벤치마크도 실행 결과가 없다. 사내 LLM 호출 및 기존 Research Lab 회귀 테스트는 미실행이다.
