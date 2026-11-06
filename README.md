# 15×15 온라인 오목

Supabase(DB + Realtime)와 Render(정적 사이트)로 동작하는 1대1 온라인 오목입니다. 컴퓨터와 대전하는 모드도 들어 있습니다.

## 구조

```
index.html   화면 (홈 / 로비 / 게임)
style.css    스타일
app.js       게임 로직, Supabase 통신, AI
config.js    Supabase URL과 publishable 키
schema.sql   DB 스키마 (이미 Supabase 프로젝트 omok-online에 적용됨)
render.yaml  Render 배포 설정
```

## 동작 방식

- **rooms 테이블**: 판 상태(225글자 문자열), 차례, 승자를 저장합니다. 누구나 읽을 수만 있고 직접 수정할 수는 없습니다.
- **착수와 입장은 모두 RPC 함수로 처리합니다** (`make_move`, `join_room` 등). 차례, 빈칸, 5목 판정을 서버에서 검사하므로 클라이언트를 조작해도 반칙할 수 없습니다.
- **플레이어 토큰**: 탭마다 무작위 토큰을 만들어 비공개 스키마(`private.room_players`)에 저장합니다. 새로고침해도 같은 방, 같은 색으로 돌아옵니다.
- **Realtime**: `postgres_changes`로 상대의 수를 즉시 받고, `presence`로 상대가 접속해 있는지와 로비에 표시할 방을 판단합니다.
- 재대결을 하면 흑백이 바뀝니다. 대기 중인 방은 2시간 뒤에, 나머지 방은 1일 뒤에 자동으로 정리됩니다.

## 로컬에서 실행

```bash
npx serve .        # 또는 python -m http.server
```

브라우저 탭 두 개를 열면 혼자서도 1대1을 테스트할 수 있습니다. 탭마다 다른 플레이어로 인식됩니다.

## Render 배포

1. 이 폴더를 GitHub 저장소에 푸시합니다.
2. Render 대시보드에서 **New → Blueprint**를 선택하고 저장소를 연결합니다. `render.yaml`이 자동으로 인식됩니다.
   - 직접 설정하려면 **New → Static Site**를 선택하고 Build Command는 비워 두고 Publish Directory에 `.`을 입력합니다.
3. 배포가 끝나면 `https://omok-online-xxxx.onrender.com` 형식의 주소가 나옵니다. 정적 사이트는 무료 플랜에서도 잠들지 않습니다.
