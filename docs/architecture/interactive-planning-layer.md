# 인터랙티브 플래닝 레이어 설계

## 목표

SpecRail을 다음 상태에서:
- 파일 기반 실행 제어 플레인

다음 상태로 확장하는 방법을 정의한다:
- 사용자와 코딩 에이전트가 여러 차례 상호작용하며 계획을 다듬을 수 있는 시스템
- OpenSpec 같은 외부 스펙 시스템을 수용할 수 있는 시스템
- speckit 스타일의 GitHub 중심 spec/review 흐름을 수용할 수 있는 시스템

이 문서가 다루는 핵심은 다음 사이에 비어 있는 계층이다:
- `spec.md`, `plan.md`, `tasks.md` 같은 지속 가능한 아티팩트
- 실행 수명주기 오케스트레이션
- 실제 다회차 질의응답, 정제, 검토, 승인 흐름

핵심 판단은 다음과 같다:
- 현재 MVP는 실행 제어 플레인으로서는 유용하다
- 하지만 인터랙티브 플래닝 시스템으로는 아직 부족하다
- SpecRail은 `Track`, `Run`, 원시 이벤트 로그만으로 이 문제를 억지로 풀기보다 명시적인 플래닝 레이어를 추가해야 한다

---

## 왜 필요한가

OpenSpec과 speckit 스타일 워크플로우는 모두 다음을 전제로 한다:
- 사용자와 코딩 에이전트가 문제 정의를 반복적으로 다듬을 수 있어야 한다
- 질문, 가정, 정제 사항이 지속적으로 남아야 한다
- 계획은 여러 세션에 걸쳐 이어질 수 있어야 한다
- 아티팩트는 한 번 생성하고 끝나는 것이 아니라 수정 이력을 가져야 한다
- 승인은 단순 상태값이 아니라 특정 변경안과 연결되어야 한다

현재 SpecRail MVP가 지원하는 것은 다음이다:
- `Track` 생성
- 초기 `spec.md`, `plan.md`, `tasks.md` 생성
- `Run` 시작, 재개, 취소
- 실행 이벤트와 요약 저장
- 상위 수준 워크플로우 상태 갱신

이 구조로 충분한 것은 다음이다:
- spec -> run -> inspect -> retry

하지만 다음에는 부족하다:
- 실행 전에 요구사항을 정제하기
- 구조화된 후속 질문을 남기기
- 사용자 결정 사항과 미해결 항목을 보존하기
- 아티팩트 변경안을 제안하고 명시적으로 승인하기
- 실행 stdout/stderr와 분리된 계획 문맥을 유지하기

즉, 현재 구조만으로는 OpenSpec이나 speckit 스타일 시스템이 기대하는 플래닝 워크플로우를 안정적으로 수용하기 어렵다.

---

## 현재 설계의 강점

현재 시스템에는 유지해야 할 기반이 이미 있다.

### 1. 안정적인 제어 플레인 식별자
- `Project`, `Track`, `Execution`이 지속 가능한 식별자를 제공한다
- `Track`은 플래닝 상태의 기준 축으로 적절하다
- `Execution`은 코딩 에이전트 실행 시도의 기준 축으로 적절하다

### 2. 지속 가능한 아티팩트
- `spec.md`, `plan.md`, `tasks.md`가 이미 파일로 남는다
- 이 아티팩트들은 여전히 좋은 검토 표면이 될 수 있다

### 3. 지속 가능한 실행 이력
- 정규화된 실행 이벤트가 이미 존재한다
- SSE와 JSON API로 실행 가시성을 제공한다
- 실행 요약도 이미 계산된다

### 4. 제어 플레인과 실행 플레인의 분리
- 현재도 워크플로우 상태와 실행 런타임이 구분되어 있다
- 플래닝이 인터랙티브해져도 이 분리는 유지해야 한다

---

## 현재 설계의 문제점

### 1. 아티팩트는 생성되지만 협상되지는 않는다

현재 `spec.md`, `plan.md`, `tasks.md`는 초기 결과물로 생성된다.
하지만 모델에는 다음이 없다:
- 변경 제안
- 초안 revision
- 승인된 revision
- 거절된 revision
- 특정 섹션과 연결된 질문

즉, 현재 아티팩트는 수명주기를 가진 계획 객체라기보다 한 번 생성되는 문서에 가깝다.

### 2. 명시적인 대화 모델이 없다

현재 이벤트 모델은 실행 중심이다.
저장하는 것은 주로 다음이다:
- shell command
- 실행 수명주기 이벤트
- stdout/stderr 성격의 메시지

하지만 다음은 모델링하지 않는다:
- 사용자가 에이전트에게 준 플래닝 피드백
- 에이전트가 사용자에게 던지는 clarifying question
- 결정 사항
- 리뷰 코멘트
- 미해결 discussion thread

이 때문에 플래닝 대화를 실행 텔레메트리와 분리할 수 없다.

### 3. 승인 모델이 지나치게 거칠다

현재 승인 관련 상태는 사실상 다음뿐이다:
- `specStatus`
- `planStatus`

이 값들은 요약으로는 유용하지만 인터랙티브 플래닝에는 부족하다.
현재 구조로는 다음을 답할 수 없다:
- 정확히 무엇이 승인되었는가?
- 어떤 revision이 거절되었는가?
- 누가 언제 리뷰를 요청했는가?
- 다음 진행을 막고 있는 질문은 무엇인가?

### 4. 플래닝 전용 세션이 없다

OpenSpec과 speckit 스타일 워크플로우는 종종 다음에 걸친다:
- 여러 번의 프롬프트
- 여러 차례의 리뷰 루프
- 여러 날에 걸친 논의
- 여러 실행 시도

현재 SpecRail에 있는 것은:
- `Track`
- `Run`

하지만 실행과 독립적으로 유지되는 플래닝 전용 세션이나 스레드는 없다.

### 5. 가정과 미해결 질문을 다룰 구조가 없다

인터랙티브 플래닝은 불확실성을 명시적으로 다뤄야 한다.
현재 모델에는 다음이 없다:
- 가정
- 오픈 질문
- 결정 기록
- 플래닝 레이어에서의 blocked-by-review 상태

그 결과 이런 정보는 자유형 markdown 수정이나 실행 이벤트 속에 묻혀 버린다.

### 6. 플래닝 시스템 추상화가 없다

향후 SpecRail은 다음을 수용할 수 있어야 한다:
- native SpecRail 아티팩트
- OpenSpec
- speckit 스타일 저장소 워크플로우

하지만 현재 설계에는 프로젝트나 트랙이 어떤 플래닝 시스템을 쓰는지 명시적으로 선택하는 추상화가 없다.

---

## 설계 원칙

SpecRail은 현재 역할을 유지해야 한다:
- 실행 제어 플레인

그리고 다음 역할을 새로 가져야 한다:
- 인터랙티브 플래닝 조정자

하지만 다음이 되어서는 안 된다:
- 완전한 채팅 제품
- GitHub 대체제
- 외부 스펙 스키마의 소유자

적절한 경계는 다음과 같다:
- 외부 시스템은 스펙 형식과 저장 위치를 가질 수 있다
- SpecRail은 아이디어 -> 정제된 계획 -> 승인된 아티팩트 -> 실행으로 이어지는 플래닝 상태를 소유한다

---

## 제안 아키텍처

`Track`과 `Execution` 사이에 명시적인 인터랙티브 플래닝 레이어를 추가한다.

### 갱신된 멘탈 모델

- `Track` = 작업 항목의 정체성과 상위 워크플로우 상태
- `PlanningSession` = 해당 트랙에 대한 인터랙티브 플래닝 스레드
- `ArtifactRevision` = `spec.md`, `plan.md`, `tasks.md`에 대한 제안/확정 변경안
- `Decision` / `Question` / `ApprovalRequest` = 구조화된 플래닝 상호작용
- `Execution` = 승인된 계획을 기준으로 실행된 코딩 시도

요약하면:
- `Track`은 "이 일이 무엇인가?"를 담당하고
- 플래닝 레이어는 "무엇이 아직 논의 중이고, 무엇이 제안되었고, 무엇이 승인 대기인가?"를 담당하며
- `Execution`은 "현재 계획 기준으로 어떤 구현 시도가 실행되었는가?"를 담당한다

---

## 제안 데이터 모델

### 플래닝 시스템 선택

프로젝트와 트랙은 어떤 플래닝 시스템을 사용하는지 선언할 수 있어야 한다.

```ts
export type PlanningSystem = "native" | "openspec" | "speckit";
```

권장 필드:

```ts
interface Project {
  ...
  defaultPlanningSystem?: PlanningSystem;
}

interface Track {
  ...
  planningSystem?: PlanningSystem;
}
```

이 필드는 시스템 전체 동작을 뒤집는 용도가 아니다.
트랙별로 적절한 어댑터와 아티팩트 규약을 선택하기 위한 기준점이다.

### PlanningSession

트랙에 대한 다회차 플래닝 스레드를 나타낸다.

```ts
interface PlanningSession {
  id: string;
  trackId: string;
  status: "active" | "waiting_user" | "waiting_agent" | "approved" | "archived";
  createdAt: string;
  updatedAt: string;
  latestRevisionId?: string;
}
```

### PlanningMessage

실행 이벤트와 섞이지 않아야 하는 사용자/에이전트 발화를 나타낸다.

```ts
interface PlanningMessage {
  id: string;
  planningSessionId: string;
  authorType: "user" | "agent" | "system";
  kind: "message" | "question" | "decision" | "note";
  body: string;
  relatedArtifact?: "spec" | "plan" | "tasks";
  createdAt: string;
}
```

### PlanningQuestion

플래닝을 막거나 정제하는 clarifying question을 나타낸다.

```ts
interface PlanningQuestion {
  id: string;
  planningSessionId: string;
  artifactType?: "spec" | "plan" | "tasks";
  prompt: string;
  status: "open" | "answered" | "dismissed";
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}
```

### ArtifactRevision

플래닝 아티팩트 변경 제안을 나타낸다.

```ts
interface ArtifactRevision {
  id: string;
  trackId: string;
  artifactType: "spec" | "plan" | "tasks";
  status: "proposed" | "approved" | "rejected" | "superseded";
  baseVersion: number;
  version: number;
  authorType: "user" | "agent" | "system";
  summary: string;
  content: string;
  createdAt: string;
}
```

### ApprovalRequest

특정 revision 또는 decision에 대한 승인 요청을 나타낸다.

```ts
interface ApprovalRequest {
  id: string;
  trackId: string;
  planningSessionId: string;
  targetType: "artifact_revision" | "decision";
  targetId: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: "user" | "agent" | "system";
  resolutionComment?: string;
  createdAt: string;
  resolvedAt?: string;
}
```

### DecisionRecord

실행이 끝난 뒤에도 남아야 하는 플래닝 결정을 나타낸다.

```ts
interface DecisionRecord {
  id: string;
  trackId: string;
  planningSessionId: string;
  category: "scope" | "design" | "workflow" | "integration" | "testing";
  summary: string;
  rationale?: string;
  decidedBy: "user" | "agent" | "system";
  createdAt: string;
}
```

---

## 아티팩트 모델 변경

기존 파일은 유지한다:
- `spec.md`
- `plan.md`
- `tasks.md`

하지만 이 파일들의 의미는 다음으로 바뀌어야 한다:
- 현재 승인된 결과물의 뷰
- 플래닝 상태 전체를 담는 유일한 저장소는 아님

권장 구조:

```text
.specrail/
  tracks/
    <trackId>/
      spec.md
      plan.md
      tasks.md
      planning/
        session.json
        messages.jsonl
        questions.json
        approvals.json
        decisions.json
        revisions/
          spec-v1.md
          spec-v2.md
          plan-v1.md
          tasks-v1.md
      integrations/
        openspec.json
        speckit.json
```

이 구조를 쓰면 다음을 동시에 얻을 수 있다:
- 현재 승인본을 쉽게 리뷰할 수 있음
- 플래닝 이력을 내구성 있게 보존할 수 있음
- 외부 연동 상태를 런타임 이벤트 로그와 분리할 수 있음

---

## API 추가안

현재 API는 실행 중심이다.
인터랙티브 플래닝 레이어에는 별도 API 표면이 필요하다.

### Planning session
- `POST /tracks/:trackId/planning-sessions`
- `GET /tracks/:trackId/planning-sessions`
- `GET /planning-sessions/:sessionId`
- `PATCH /planning-sessions/:sessionId`

### Planning message
- `POST /planning-sessions/:sessionId/messages`
- `GET /planning-sessions/:sessionId/messages`

### 질문과 응답
- `POST /planning-sessions/:sessionId/questions`
- `POST /planning-questions/:questionId/answer`
- `PATCH /planning-questions/:questionId`

### Artifact revision
- `POST /tracks/:trackId/artifacts/:artifactType/revisions`
- `GET /tracks/:trackId/artifacts/:artifactType/revisions`
- `POST /artifact-revisions/:revisionId/approve`
- `POST /artifact-revisions/:revisionId/reject`

### Decision
- `POST /planning-sessions/:sessionId/decisions`
- `GET /tracks/:trackId/decisions`

### 플래닝 시스템 및 연동 선택
- `GET /planning-systems`
- `PATCH /projects/:projectId/planning-system`
- `PATCH /tracks/:trackId/planning-system`
- `POST /integrations/openspec/import`
- `POST /integrations/openspec/export`
- `POST /integrations/speckit/import`
- `POST /integrations/speckit/export`

---

## Run과의 관계

플래닝 레이어는 Run을 대체하지 않는다.
대신 Run을 통제하고 문맥화한다.

### 권장 규칙

각 실행은 어떤 플래닝 문맥을 기준으로 수행되었는지 참조해야 한다.

권장 필드:

```ts
interface Execution {
  ...
  planningSessionId?: string;
  specRevisionId?: string;
  planRevisionId?: string;
  tasksRevisionId?: string;
}
```

이렇게 해야 SpecRail이 다음을 답할 수 있다:
- 이 실행은 어떤 계획 revision을 기준으로 수행되었는가?
- 질문 응답 전/후 어느 시점의 계획을 사용했는가?
- 이후 revision 승인으로 인해 실행 문맥이 stale해졌는가?

### 권장 실행 정책

초기 정책:
- 최신 승인 revision 기준으로만 Run을 허용한다
- 승인 대기 중인 변경이 있으면 명시적 override 없이 실행하지 않는다
- 실행 도중 중요한 revision이 승인되면 해당 Run의 문맥을 stale로 표시한다

---

## OpenSpec 지원 방식

OpenSpec은 스펙과 변경안이 세션을 넘어 지속되는 구조에 강하다.

제안한 플래닝 레이어는 이를 다음 방식으로 지원한다:
- 플래닝 대화와 실행 로그를 분리한다
- 아티팩트 revision을 명시적으로 저장한다
- revision 경계에서 import/export를 수행할 수 있다
- 트랙이 어떤 planning system을 쓰는지 선언할 수 있다

OpenSpec 전용 어댑터의 역할은 다음에 집중해야 한다:
- OpenSpec change 또는 spec package를 `PlanningSession`으로 가져오기
- proposal/design/tasks/spec delta를 revision과 decision으로 매핑하기
- 승인된 revision을 OpenSpec-compatible 형식으로 내보내기
- 출처 참조와 sync metadata를 유지하기

중요한 점은 다음이다:
- OpenSpec을 단순 markdown 파일 세트로 다루면 안 된다
- 플래닝 레이어 위에 얹힌 어댑터로 다뤄야 한다

---

## speckit 스타일 지원 방식

speckit 스타일 워크플로우는 OpenSpec보다 실행과 더 가깝고, clarifying interaction과 저장소 리뷰 흐름이 강하다.

제안한 플래닝 레이어는 이를 다음 방식으로 지원한다:
- 에이전트가 clarifying question을 구조적으로 올릴 수 있다
- 실행 전에 review 가능한 artifact revision을 만들 수 있다
- 트랙이 `planningSystem = "speckit"`을 선택할 수 있다
- 플래닝 대화와 구현 실행을 분리할 수 있다

speckit 전용 어댑터의 역할은 다음에 집중해야 한다:
- clarify/plan/tasks 상호작용을 planning message와 revision으로 매핑하기
- 승인된 계획 산출물을 저장소 가시 아티팩트로 동기화하기
- 필요하면 GitHub issue/PR 논의와 연결하기

중요한 점은 다음이다:
- speckit을 단순 템플릿 추가 수준으로 구현하면 안 된다
- speckit도 구조화된 플래닝 상호작용을 필요로 한다

---

## 주요 위험

### 1. 플래닝 상호작용을 실행 이벤트에 섞어 넣는 경우

플래닝 상호작용을 실행 이벤트로 저장하면 다음이 한곳에 섞인다:
- 플래닝 대화
- 실행 텔레메트리
- 리뷰 액션

이 구조는 곧 잡음이 많아지고 질의가 어려워진다.

### 2. markdown 파일만 상태로 취급하는 경우

`spec.md`, `plan.md`, `tasks.md`만이 유일한 상태 저장소로 남으면 다음을 답할 수 없다:
- 누가 제안했는가?
- 무엇이 바뀌었는가?
- 무엇이 아직 미해결인가?
- 어떤 revision이 승인되었는가?

### 3. 공통 플래닝 모델 없이 provider 지원을 붙이는 경우

OpenSpec과 speckit 연동을 현재 아티팩트에 직접 덧붙이면 각 어댑터가 각자 암묵적 규칙을 만들어 내게 된다.
그 결과 시스템이 쉽게 드리프트하고 취약해진다.

### 4. 너무 이른 시점에 협업 제품 전체를 만들려는 경우

플래닝 레이어는 얇아야 한다.
초기 버전에 필요한 것은:
- 지속 가능한 플래닝 상호작용
- revision 이력
- 승인 연결

초기에 필요하지 않은 것은:
- 풍부한 채팅 UI
- 실시간 공동 편집
- 복잡한 권한 모델

---

## 대응 전략

### 1단계. 플래닝 도메인 기본 객체 추가
- `PlanningSession`, `PlanningMessage`, `PlanningQuestion`, `ArtifactRevision`, `ApprovalRequest`, `DecisionRecord` 추가
- 이들에 대한 파일 기반 repository 추가
- 기존 `Track`, `Execution` 모델은 최대한 유지

### 2단계. revision-aware artifact 도입
- `spec.md`, `plan.md`, `tasks.md`는 승인된 최신 뷰로 유지
- revision 이력은 별도로 저장
- 제안, 승인, 거절 API 추가

### 3단계. Run을 승인된 계획 문맥에 연결
- 각 Run이 어떤 revision을 기준으로 시작되었는지 기록
- 플래닝 변경 후 실행 문맥이 stale해졌는지 판단

### 4단계. planning system 선택 도입
- 프로젝트/트랙 단위 `planningSystem` 추가
- 기존 동작도 먼저 `native` provider를 통해 새 추상화 위로 올림

### 5단계. 외부 어댑터 추가
- OpenSpec import/export를 planning revision 기준으로 추가
- speckit 스타일 import/export를 planning revision 기준으로 추가
- GitHub sync는 플래닝 모델이 안정된 뒤 추가

---

## 권장 초기 범위

가장 먼저 해야 할 일은 OpenSpec 또는 speckit을 바로 붙이는 것이 아니다.
먼저 필요한 것은 다음 네 가지다.

1. planning session 모델 도입
2. artifact revision 도입
3. revision 기준 approval request 도입
4. Run을 승인된 planning context에 연결

이 네 가지가 있어야 외부 연동이 단순해진다.

반대로 이것이 없으면 SpecRail은 계속 에이전트를 실행할 수는 있어도, 외부 스펙 시스템이 기대하는 인터랙티브 플래닝 워크플로우는 제대로 수용하지 못한다.

---

## 결론

SpecRail은 OpenSpec이나 speckit과의 깊은 통합에 앞서 명시적인 인터랙티브 플래닝 레이어를 먼저 추가해야 한다.

현재 MVP는 실행 제어 플레인으로서는 강하다.
하지만 플래닝 워크스페이스로서는 아직 불충분하다.

가장 안전한 경로는 다음과 같다.
1. 현재 제어 플레인과 실행 플레인의 강점을 유지한다
2. 실행 이벤트를 과적재하지 말고 구조화된 플래닝 객체를 추가한다
3. 아티팩트를 revision-aware하게 만든다
4. 실행을 승인된 계획 상태와 연결한다
5. 그 위에 OpenSpec과 speckit 어댑터를 얹는다

이 순서가 되어야 SpecRail이 외부 워크플로우를 현재 MVP 형태에 억지로 끼워 맞추지 않고, 일관된 인터랙티브 플래닝 기반 위에서 수용할 수 있다.
