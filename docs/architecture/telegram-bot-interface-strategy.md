# 텔레그램 봇 인터페이스 연동 전략

## 목표

`SpecRail`이 이미 갖고 있는 run orchestration 역할을 유지한 채,
텔레그램을 새로운 인터페이스 채널로 추가하는 전략을 정의한다.

이 문서는 다음을 다룬다:
- `yoophi/claude-code-telegram-bot` 저장소 분석 결과
- 현재 텔레그램 봇 구조의 강점과 한계
- `SpecRail`과 역할이 겹치는 지점
- `SpecRail`의 interface plane에 텔레그램 봇을 추가하는 권장 아키텍처
- 단계별 구현 전략

전제는 다음과 같다:
- `SpecRail`은 실행 제어 플레인이다
- 텔레그램 봇은 사용자의 입력/출력 채널이어야 한다
- 실행 상태, 승인 상태, 세션 상태, 이벤트 저장의 최종 소유권은 `SpecRail`이 가져야 한다

---

## 조사 대상

분석한 저장소:
- `yoophi/claude-code-telegram-bot`

확인한 주요 파일:
- `README.md`
- `CLAUDE.md`
- `telegram_bot.py`
- `telegram_listener.py`
- `telegram_sender.py`
- `process_telegram.py`
- `mybot_autoexecutor.bat`

---

## 텔레그램 봇 구조 요약

현재 봇은 대략 다음 파이프라인으로 동작한다.

1. 텔레그램 메시지 수집
2. 허용 사용자 검증
3. 첨부파일 다운로드
4. 최근 대화 컨텍스트 구성
5. 미처리 메시지 합산
6. 로컬 잠금 파일 생성
7. 로컬 메모리 로드
8. Claude CLI 직접 실행
9. 중간 진행 상황을 텔레그램으로 회신
10. 최종 결과와 파일을 텔레그램으로 전송
11. 메시지를 처리 완료 상태로 변경

핵심 모듈 역할은 다음과 같다.

### `telegram_listener.py`
- 텔레그램 Bot API를 폴링한다
- 허용된 사용자 메시지만 저장한다
- 이미지, 문서, 비디오, 오디오, 위치 정보를 수집한다
- 첨부파일을 `tasks/msg_<message_id>/` 아래에 저장한다

### `telegram_bot.py`
- `telegram_messages.json`을 기준으로 미처리 메시지를 조회한다
- 최근 24시간 대화 문맥을 만든다
- 여러 메시지를 하나의 작업으로 합산한다
- `working.json`으로 동시 작업을 막는다
- `tasks/` 기반 메모리를 읽고 쓴다
- 최종 결과를 텔레그램으로 보내고 메모리에 반영한다

### `telegram_sender.py`
- 텔레그램으로 텍스트와 파일을 전송한다
- 긴 메시지를 잘라서 보낸다
- 중간 진행 메시지 전송 시 새 메시지 확인과 활동 시각 갱신을 함께 처리한다

### `mybot_autoexecutor.bat`
- 실제로 Claude CLI를 직접 실행한다
- `claude -p -c`로 이전 세션 재개를 시도한다
- 새 메시지가 없으면 빠르게 종료한다
- lock 파일과 프로세스 확인으로 중복 실행을 막는다

---

## 현재 봇 구조의 강점

### 1. 인터페이스 경험이 단순하고 즉각적이다
- 사용자는 텔레그램으로 자연스럽게 요청을 보낼 수 있다
- 즉시 답장, 중간 경과 보고, 최종 결과 전송 패턴이 이미 잘 정리되어 있다

### 2. 멀티모달 입력 처리가 실용적이다
- 이미지, 문서, 비디오, 오디오, 위치 정보를 지원한다
- 첨부파일을 로컬에 내려받아 후속 실행에 활용할 수 있다

### 3. 대화 문맥 유지에 대한 감각이 좋다
- 최근 24시간의 사용자 메시지와 봇 응답을 함께 참조한다
- "거기", "방금 만든 것" 같은 후속 지시를 처리하기 위한 기반이 있다

### 4. 단일 사용자 또는 소규모 운영에는 충분히 실용적이다
- `.env` 기반 인증
- 파일 기반 상태
- Windows 스케줄러 기반 폴링

즉, 이 저장소는 텔레그램을 통해 AI 작업을 받아 처리하는 사용자 경험 측면에서는 이미 좋은 패턴을 갖고 있다.

---

## 현재 봇 구조의 한계

하지만 이 구조를 그대로 `SpecRail`에 붙이면 문제가 생긴다.

### 1. 봇이 직접 오케스트레이션을 소유하고 있다

현재 봇은 단순 채널이 아니다.
실제로 다음까지 직접 수행한다:
- 작업 큐 판단
- 동시성 잠금
- 세션 재개
- 실행 진입점 구성
- 메모리 관리
- 결과 저장

이 역할은 `SpecRail`이 이미 지향하는 control plane / execution plane 역할과 겹친다.

### 2. 상태 소유권이 텔레그램 쪽 파일로 분산되어 있다

현재 봇이 소유하는 상태는 다음과 같다.
- `telegram_messages.json`
- `working.json`
- `new_instructions.json`
- `tasks/`
- `index.json`
- `claude_task.log`

반면 `SpecRail`도 이미 다음 상태를 갖고 있다.
- `Track`
- `Execution`
- 이벤트 로그
- 세션 메타데이터
- 아티팩트

이 구조를 그대로 합치면 두 시스템이 같은 문제를 서로 다른 파일 형식으로 따로 풀게 된다.

### 3. 실행기와 채널이 강하게 결합되어 있다

현재 설계는 텔레그램 입력이 곧바로 Claude CLI 실행으로 연결된다.
즉:
- 텔레그램 채널
- 로컬 파일 큐
- 실행기
- 세션 재개 정책

이것들이 한 프로젝트 안에 묶여 있다.

이 구조는 다른 채널을 추가하거나 `SpecRail`의 API 기반 오케스트레이션으로 전환하기 어렵게 만든다.

### 4. 중간 진행 메시지가 실행 상태의 공식 기록이 아니다

텔레그램으로 전송되는 진행 상황은 유용하지만, 현재는 봇이 즉석에서 생성해 보내는 수준이다.
이 상태는 `SpecRail`의 실행 이벤트와 일관되게 연결되지 않는다.

### 5. interactive planning 상태를 제대로 수용하기 어렵다

현재 봇은 대화 문맥은 유지하지만, 다음을 구조적으로 다루지는 않는다:
- clarification question
- approval request
- artifact revision
- planning session
- decision record

즉, 텔레그램을 인터랙티브 플래닝 채널로 쓰기에는 모델이 아직 얕다.

---

## SpecRail과 역할이 겹치는 지점

현재 `SpecRail`은 이미 다음 역할을 가진다.
- `Track` 생성과 워크플로우 상태 관리
- `Run` 시작, 재개, 취소
- 세션 메타데이터 저장
- 실행 이벤트 저장
- JSON / SSE API 제공

이 점을 기준으로 보면 현재 텔레그램 봇의 다음 역할은 `SpecRail`로 이관되어야 한다.

### SpecRail이 가져야 하는 것
- 실행 시작과 재개 정책
- 세션 식별자와 resume 기준
- 작업 상태 저장
- 이벤트 저장과 요약
- 승인 상태와 플래닝 상태
- 첨부파일 메타데이터와 artifact 연계

### 텔레그램 어댑터가 맡아야 하는 것
- 텔레그램 업데이트 수집
- 사용자 인증
- 텔레그램 메시지와 파일을 `SpecRail` 요청으로 변환
- `SpecRail` 이벤트를 텔레그램 메시지로 렌더링
- 사용자의 질문 응답, 승인 응답을 다시 `SpecRail`에 전달

핵심 원칙은 다음이다.

**텔레그램 봇은 실행기가 아니라 채널 어댑터여야 한다.**

---

## 권장 아키텍처

### 상위 구조

```text
Telegram User
  -> Telegram Adapter
    -> SpecRail API
      -> Planning Layer
      -> Run Orchestration
      -> Executor Adapter
    <- SpecRail Events / Status
  <- Telegram Message / File / Progress Update
```

### 역할 분리

#### 1. SpecRail
- `Track`, `PlanningSession`, `Run`, `Approval`, `ArtifactRevision`의 최종 상태 저장소
- 실행 오케스트레이션
- 세션 재개 / 취소
- 첨부파일 메타데이터 관리
- 이벤트 스트림 제공

#### 2. Telegram Adapter
- Telegram polling 또는 webhook 처리
- chat/thread를 `Track` 또는 `PlanningSession`에 연결
- 첨부파일 업로드 후 `SpecRail`에 전달
- 진행 상황과 질문, 승인 요청을 텔레그램 메시지로 번역

#### 3. Executor
- 현재와 동일하게 실제 코딩 에이전트 실행 담당
- 단, Telegram Adapter가 직접 실행하지 않고 `SpecRail`을 통해 간접 호출

---

## 왜 이 구조가 맞는가

### 1. 상태의 단일 소유권을 만든다

실행 상태를 `SpecRail`이 소유하면 다음이 쉬워진다.
- 텔레그램 외에 Web UI, Slack, Email 같은 채널 추가
- 한 Run의 상태를 여러 채널에서 동일하게 보기
- 승인, 질문, 결과 요약을 하나의 모델로 관리하기

### 2. 텔레그램 봇을 얇게 유지할 수 있다

현재 텔레그램 저장소의 가장 가치 있는 부분은 다음이다.
- 즉시 응답 패턴
- 진행 경과 보고 패턴
- 첨부파일/위치 수집
- 대화 문맥 유지

반대로 `SpecRail`이 가져가야 하는 것은 다음이다.
- 오케스트레이션
- 세션
- 상태 저장
- 승인/플래닝 모델

### 3. interactive planning layer와 자연스럽게 맞물린다

앞서 정의한 인터랙티브 플래닝 레이어가 있으면 텔레그램은 단순 실행 채널을 넘어서:
- clarification question 채널
- approval 요청 채널
- revision 검토 채널

로 확장될 수 있다.

---

## 제안 인터페이스 모델

텔레그램 연동을 위해 `SpecRail`에 외부 채널 바인딩 개념이 필요하다.

### ChannelBinding

```ts
interface ChannelBinding {
  id: string;
  projectId: string;
  channelType: "telegram";
  externalChatId: string;
  externalThreadId?: string;
  externalUserId?: string;
  trackId?: string;
  planningSessionId?: string;
  createdAt: string;
  updatedAt: string;
}
```

### AttachmentReference

```ts
interface AttachmentReference {
  id: string;
  sourceType: "telegram";
  externalFileId: string;
  fileName?: string;
  mimeType?: string;
  localPath?: string;
  trackId?: string;
  planningSessionId?: string;
  uploadedAt: string;
}
```

### TelegramInboundMessage

이것은 영구 저장이 아니라 어댑터 내부 DTO로 충분하다.

```ts
interface TelegramInboundMessage {
  chatId: string;
  messageId: string;
  userId: string;
  text?: string;
  replyToMessageId?: string;
  attachments?: AttachmentReference[];
  location?: {
    latitude: number;
    longitude: number;
  };
  receivedAt: string;
}
```

---

## 필요한 SpecRail API 추가안

현재 API만으로는 텔레그램을 제대로 연결하기 어렵다.
최소한 다음 계층이 추가되어야 한다.

### 1. 채널 바인딩 API
- `POST /channels/telegram/bind`
- `GET /channels/telegram/:chatId`

목적:
- 텔레그램 chat이 어느 `Track` 또는 `PlanningSession`과 연결되는지 찾기

### 2. 외부 메시지 수신 API
- `POST /channels/telegram/messages`

목적:
- 텔레그램 메시지를 `SpecRail` 내부 planning message 또는 track action으로 변환

### 3. 첨부파일 등록 API
- `POST /attachments`

목적:
- 텔레그램에서 받은 파일을 `SpecRail` artifact/input reference로 등록

### 4. 진행 상황 구독 API
- 기존 `GET /runs/:runId/events/stream` 활용 가능
- 장기적으로는 planning event까지 포함한 통합 스트림 필요

### 5. planning layer API

텔레그램을 인터랙티브 채널로 쓰려면 결국 다음이 필요하다.
- `POST /tracks/:trackId/planning-sessions`
- `POST /planning-sessions/:sessionId/messages`
- `POST /planning-sessions/:sessionId/questions`
- `POST /planning-questions/:questionId/answer`
- `POST /artifact-revisions/:revisionId/approve`
- `POST /artifact-revisions/:revisionId/reject`

---

## 권장 사용자 흐름

### 흐름 A: 새 요청이 들어온 경우

1. 사용자가 텔레그램으로 새 요청 전송
2. Telegram Adapter가 chat binding 조회
3. 연결된 `Track`이 없으면 새 `Track` 생성
4. 새 `PlanningSession`을 열거나 기존 session에 메시지 추가
5. `SpecRail`이 즉시 응답 메시지용 상태를 반환
6. Telegram Adapter가 "작업을 시작했습니다"를 전송
7. `SpecRail`이 실행 시작 또는 질문 생성 여부를 판단

### 흐름 B: 진행 중 Run의 중간 상태 전송

1. `SpecRail`이 run event 생성
2. Telegram Adapter가 SSE 또는 폴링으로 이벤트 구독
3. 중요 이벤트만 요약해 텔레그램으로 전달
4. 텔레그램 사용자는 진행 상황을 확인

### 흐름 C: 에이전트가 질문을 던지는 경우

1. `SpecRail` planning layer가 `PlanningQuestion` 생성
2. Telegram Adapter가 질문을 텔레그램 메시지로 전송
3. 사용자가 답장
4. Telegram Adapter가 해당 답장을 `answer` API로 전달
5. `SpecRail`이 planning state를 갱신하고 필요 시 Run 재개

### 흐름 D: 결과 전달

1. `Run` 완료
2. `SpecRail`이 결과 요약과 산출물 메타데이터를 준비
3. Telegram Adapter가 텍스트 요약 + 파일 전송
4. 텔레그램 메시지는 단순 결과 뷰이고, 공식 상태는 `SpecRail`에 남는다

---

## 현재 텔레그램 저장소에서 재사용할 것

다음은 아이디어 또는 일부 코드 수준에서 재사용 가치가 높다.

### 1. 텔레그램 입력 처리 패턴
- 허용 사용자 필터링
- 텍스트 + caption + 파일 + 위치 추출
- 긴 메시지 처리

### 2. 즉시 응답 / 중간 경과 / 최종 결과 패턴
- 사용자 경험 측면에서 매우 유용하다
- `SpecRail` 이벤트를 텔레그램 메시지로 번역할 때 그대로 활용 가능하다

### 3. 첨부파일 다운로드 흐름
- 텔레그램 파일을 먼저 로컬 임시 경로에 받은 뒤 후속 업로드/등록 처리

### 4. reply context 처리 감각
- `reply_to_message_id`
- 최근 대화 컨텍스트
- 후속 지시 처리

이 부분들은 `apps/telegram-bot` 구현 시 좋은 참고가 된다.

---

## 현재 텔레그램 저장소에서 그대로 가져오면 안 되는 것

다음은 `SpecRail` 구조와 충돌하므로 직접 이식하면 안 된다.

### 1. `working.json`
- 동시성 잠금은 `SpecRail`의 `Run` / `PlanningSession` 상태로 대체해야 한다

### 2. `telegram_messages.json`
- 텔레그램 수신 로그의 영구 source of truth가 되어서는 안 된다
- 외부 입력 기록이 필요하다면 `SpecRail`의 channel message 저장 구조로 통합해야 한다

### 3. `tasks/` 메모리 구조
- 과거 작업 메모리는 `Track`, `PlanningSession`, 아티팩트, 이벤트 조회로 대체해야 한다

### 4. `mybot_autoexecutor.bat`의 직접 CLI 실행
- `SpecRail`이 이미 run orchestration을 담당하므로 텔레그램 앱이 Claude/Codex CLI를 직접 실행하면 안 된다

---

## 구현 위치 제안

`SpecRail` 저장소 안에 별도 앱으로 두는 것이 가장 자연스럽다.

권장 위치:

```text
apps/
  api/
  telegram-bot/
packages/
  core/
  adapters/
  config/
  integrations/
```

### `apps/telegram-bot` 역할
- Telegram API polling 또는 webhook
- `SpecRail` API client
- SSE event consumer
- 텔레그램 메시지 포맷터

### `packages/integrations` 역할
- Telegram DTO 변환
- channel binding 로직
- 첨부파일 reference 변환

---

## 단계별 대응 전략

### 1단계. 얇은 Telegram front-end 도입

범위:
- 텔레그램 메시지를 받아 `Track` 생성 또는 기존 `Track` 조회
- `POST /runs` 호출
- `GET /runs/:runId/events/stream` 구독 후 텔레그램 진행 메시지 전송

장점:
- 현재 `SpecRail` API만으로도 가장 빠르게 가치 확인 가능

제약:
- interactive planning은 아직 부족
- 단순 실행형 요청 위주

### 2단계. chat-to-track binding 도입

범위:
- chat/thread와 `Track` 연결
- 후속 메시지를 기존 트랙 문맥으로 라우팅
- 첨부파일 등록 지원

장점:
- "방금 만든 것 수정해줘" 같은 흐름이 살아남

### 3단계. planning session 연동

범위:
- 텔레그램 메시지를 `PlanningSession` / `PlanningMessage`로 저장
- 질문/응답/승인 흐름 추가
- Run 시작을 planning state와 연결

장점:
- 텔레그램이 단순 실행 채널을 넘어 인터랙티브 플래닝 채널이 됨

### 4단계. 외부 spec 시스템과 연결

범위:
- OpenSpec / speckit adapter와 planning layer 통합
- 텔레그램 답변이 외부 spec workflow에 반영될 수 있게 함

장점:
- 텔레그램, GitHub, OpenSpec이 하나의 planning substrate 위에서 동작

---

## 설계 판단

가장 중요한 판단은 다음이다.

`SpecRail`에 텔레그램 봇을 붙이는 작업은
**"텔레그램으로 Claude를 실행하는 봇을 이식하는 일"이 아니라**
**"텔레그램을 SpecRail의 interface plane에 추가하는 일"이어야 한다.**

즉:
- 텔레그램은 입력/출력 채널
- `SpecRail`은 상태와 오케스트레이션
- interactive planning layer는 질문/승인/정제 흐름의 중심

이렇게 분리해야만:
- 다른 채널 추가가 쉬워지고
- 상태 중복이 없어지고
- OpenSpec / speckit 같은 외부 워크플로우와도 충돌 없이 연결할 수 있다

---

## 권장 다음 작업

우선순위는 다음 순서가 적절하다.

1. `SpecRail`에 channel binding 개념 추가
2. `apps/telegram-bot` 앱 추가
3. 텔레그램 메시지 -> `Track` / `Run` 연결 최소 흐름 구현
4. 첨부파일 등록 API 추가
5. planning session API 추가
6. 질문/응답/승인 흐름을 텔레그램까지 확장

---

## 결론

현재 조사한 텔레그램 봇 저장소는 사용자 경험 측면에서는 매우 좋은 참고 사례다.
하지만 현재 구조는 봇이 직접 실행과 상태를 소유하는 방식이라 `SpecRail`과 그대로 결합하면 역할 충돌이 난다.

따라서 가장 올바른 전략은 다음이다.

1. 텔레그램 봇을 채널 어댑터로 축소한다
2. run orchestration과 상태 소유권은 `SpecRail`로 집중시킨다
3. interactive planning layer를 추가해 텔레그램이 질문/승인 채널까지 담당하도록 확장한다
4. 이후 OpenSpec과 speckit 같은 외부 플래닝 시스템을 같은 기반 위에 연결한다

이 방향이 `SpecRail`의 현재 아키텍처와 가장 잘 맞고, 장기적으로도 가장 확장 가능하다.
