// =====================================================
//  15×15 오목 — 온라인 1:1 (Supabase Realtime) + 컴퓨터 대전
// =====================================================
const { SUPABASE_URL, SUPABASE_KEY } = window.OMOK_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const N = 15;
const SIZE = N * N;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const $ = (id) => document.getElementById(id);
const COLOR_NAME = { 1: '흑', 2: '백' };

// ---------- 플레이어 식별 ----------
// 탭마다 다른 토큰(sessionStorage) → 같은 브라우저 두 탭으로도 테스트 가능, 새로고침해도 유지
function makeToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
const token = sessionStorage.getItem('omok.token') || makeToken();
sessionStorage.setItem('omok.token', token);

let nickname = localStorage.getItem('omok.nick') || '';
let mode = null; // 'online' | 'ai' | null

// ---------- 공통 UI ----------
function show(view) {
  for (const id of ['homeView', 'lobbyView', 'gameView']) $(id).hidden = id !== view;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function errMsg(error) {
  return error?.message || '요청을 처리하지 못했습니다.';
}

function showResult(text) {
  $('resultText').textContent = text;
  $('result').hidden = false;
}
function hideResult() {
  $('result').hidden = true;
}
$('result').addEventListener('click', hideResult);

// ---------- 바둑판 ----------
const cells = [];
(function buildBoard() {
  const boardEl = $('board');
  for (let i = 0; i < SIZE; i++) {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.setAttribute('aria-label', `${Math.floor(i / N) + 1}행 ${(i % N) + 1}열`);
    const ghost = document.createElement('span');
    const stone = document.createElement('span');
    cell.append(ghost, stone);
    cell.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(cell);
    cells.push({ cell, ghost, stone });
  }
})();

function drawBoard(arr, last, canPlay, myColor) {
  const ghostClass = 'ghost ' + (myColor === 2 ? 'white' : 'black');
  for (let i = 0; i < SIZE; i++) {
    const { cell, ghost, stone } = cells[i];
    const v = arr[i];
    const playable = canPlay && v === 0;
    cell.disabled = !playable;
    cell.classList.toggle('playable', playable);
    cell.classList.toggle('last', i === last);
    ghost.className = playable ? ghostClass : '';
    stone.className = v ? 'stone ' + (v === 1 ? 'black' : 'white') : '';
  }
}

function setPlayers(black, white, turn) {
  $('blackName').textContent = black.name;
  $('blackTag').textContent = black.tag || '';
  $('blackTag').className = 'tag' + (black.off ? ' off' : '');
  $('whiteName').textContent = white.name;
  $('whiteTag').textContent = white.tag || '';
  $('whiteTag').className = 'tag' + (white.off ? ' off' : '');
  document.querySelectorAll('.player').forEach((el) => {
    el.classList.toggle('turn', Number(el.dataset.color) === turn);
  });
}

function onCellClick(i) {
  if (mode === 'online') onlineMove(i);
  else if (mode === 'ai') aiPlayerMove(i);
}

function isWin(arr, idx, p) {
  const r = Math.floor(idx / N), c = idx % N;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    for (const s of [-1, 1]) {
      for (let k = 1; k < 5; k++) {
        const y = r + dr * k * s, x = c + dc * k * s;
        if (y < 0 || y >= N || x < 0 || x >= N || arr[y * N + x] !== p) break;
        count++;
      }
    }
    if (count >= 5) return true;
  }
  return false;
}

// =====================================================
//  홈
// =====================================================
$('nickname').value = nickname;

function readNickname() {
  const v = $('nickname').value.trim();
  if (v.length < 1 || v.length > 12) {
    toast('닉네임을 1~12자로 입력해주세요.');
    $('nickname').focus();
    return false;
  }
  nickname = v;
  localStorage.setItem('omok.nick', v);
  return true;
}

$('goOnline').addEventListener('click', () => readNickname() && enterLobby());
$('goAi').addEventListener('click', () => readNickname() && enterAi());
$('nickname').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && readNickname()) enterLobby();
});

function goHome() {
  mode = null;
  show('homeView');
}

// =====================================================
//  로비
// =====================================================
let lobbyRoomsChannel = null;
let lobbyHostsChannel = null;
let lobbyRooms = [];
let loadTimer = null;

async function enterLobby() {
  mode = null;
  show('lobbyView');
  $('lobbyNick').textContent = `${nickname} 님`;
  $('roomName').value = $('roomName').value || `${nickname}의 방`;

  lobbyRoomsChannel = sb
    .channel('lobby-rooms')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, scheduleLoadRooms)
    .subscribe();

  // 방장이 접속해 있는 방만 보여주기 위해 방장 presence 를 함께 구독
  lobbyHostsChannel = sb
    .channel('lobby-hosts')
    .on('presence', { event: 'sync' }, renderRooms)
    .subscribe();

  await loadRooms();
}

async function leaveLobby() {
  const chs = [lobbyRoomsChannel, lobbyHostsChannel].filter(Boolean);
  lobbyRoomsChannel = lobbyHostsChannel = null;
  await Promise.all(chs.map((ch) => sb.removeChannel(ch)));
}

function scheduleLoadRooms() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(loadRooms, 250);
}

async function loadRooms() {
  const { data, error } = await sb
    .from('rooms')
    .select('id,name,black_name,created_at')
    .eq('status', 'waiting')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return toast(errMsg(error));
  lobbyRooms = data;
  renderRooms();
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

function renderRooms() {
  const online = new Set();
  if (lobbyHostsChannel) {
    for (const metas of Object.values(lobbyHostsChannel.presenceState())) {
      for (const m of metas) online.add(m.room);
    }
  }
  // 막 만들어진 방은 presence 반영 전이라도 표시
  const visible = lobbyRooms.filter(
    (r) => online.has(r.id) || Date.now() - new Date(r.created_at).getTime() < 20000
  );

  const list = $('roomList');
  list.innerHTML = '';
  for (const r of visible) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'room-info';
    const b = document.createElement('b');
    b.textContent = r.name;
    const span = document.createElement('span');
    span.textContent = `방장 ${r.black_name} · ${timeAgo(r.created_at)}`;
    info.append(b, span);
    const btn = document.createElement('button');
    btn.className = 'action';
    btn.textContent = '입장';
    btn.addEventListener('click', () => joinRoom(r.id, btn));
    li.append(info, btn);
    list.appendChild(li);
  }
  $('roomEmpty').hidden = visible.length > 0;
}

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('roomName').value.trim();
  if (!name) return toast('방 이름을 입력해주세요.');
  const btn = e.submitter;
  btn.disabled = true;
  const { data, error } = await sb.rpc('create_room', { p_name: name, p_nickname: nickname, p_token: token });
  btn.disabled = false;
  if (error) return toast(errMsg(error));
  enterRoom(data, 1);
});

async function joinRoom(id, btn) {
  btn.disabled = true;
  const { data, error } = await sb.rpc('join_room', { p_room: id, p_nickname: nickname, p_token: token });
  btn.disabled = false;
  if (error) {
    toast(errMsg(error));
    return loadRooms();
  }
  enterRoom(id, data);
}

$('lobbyBack').addEventListener('click', async () => {
  await leaveLobby();
  goHome();
});

// =====================================================
//  온라인 대국
// =====================================================
let room = null;
let roomId = null;
let myColor = null;
let roomChannel = null;
let hostChannel = null;
let opponentOnline = false;
let moving = false;

async function enterRoom(id, color) {
  await leaveLobby();
  mode = 'online';
  roomId = id;
  myColor = color;
  room = null;
  sessionStorage.setItem('omok.room', id);

  show('gameView');
  $('onlineControls').hidden = false;
  $('aiControls').hidden = true;
  hideResult();

  roomChannel = sb
    .channel(`room-${id}`, { config: { presence: { key: token } } })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` },
      (p) => applyRoom(p.new))
    .on('presence', { event: 'sync' }, () => {
      opponentOnline = Object.keys(roomChannel.presenceState()).some((k) => k !== token);
      renderOnline();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await roomChannel.track({ at: Date.now() });
        refreshRoom(); // 구독 전 놓친 변경 반영
      }
    });

  await refreshRoom();
}

async function cleanupOnline() {
  const chs = [roomChannel, hostChannel].filter(Boolean);
  roomChannel = hostChannel = null;
  room = roomId = myColor = null;
  opponentOnline = false;
  sessionStorage.removeItem('omok.room');
  await Promise.all(chs.map((ch) => sb.removeChannel(ch)));
}

async function refreshRoom() {
  if (!roomId) return;
  const id = roomId;
  const { data, error } = await sb.from('rooms').select('*').eq('id', id).maybeSingle();
  if (id !== roomId) return;
  if (error) return toast(errMsg(error));
  if (!data) {
    toast('방이 사라졌습니다.');
    await cleanupOnline();
    return enterLobby();
  }
  applyRoom(data);
}

async function applyRoom(r) {
  if (!roomId || r.id !== roomId) return;
  const prev = room;
  room = r;

  // 재대결로 새 판이 시작되면 흑백이 바뀌므로 서버에서 내 색을 다시 확인
  if (prev && prev.status === 'finished' && r.status === 'playing') {
    const { data } = await sb.rpc('join_room', { p_room: r.id, p_nickname: nickname, p_token: token });
    if (data) myColor = data;
    hideResult();
    toast(`새 게임! 이번엔 ${COLOR_NAME[myColor]}돌입니다.`);
  }

  const ended = r.status === 'finished' || r.status === 'closed';
  if (ended && (!prev || prev.status === 'playing')) showResult(resultMessage());
  if (r.status === 'playing') {
    if (prev && prev.status === 'waiting') toast('상대가 입장했습니다. 게임 시작!');
  }

  syncHostPresence();
  renderOnline();
}

// 대기 중인 방장은 로비 목록에 보이도록 presence 등록
function syncHostPresence() {
  const shouldHost = room && room.status === 'waiting' && myColor === 1;
  if (shouldHost && !hostChannel) {
    hostChannel = sb.channel('lobby-hosts', { config: { presence: { key: token } } });
    const id = roomId;
    hostChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') hostChannel?.track({ room: id });
    });
  } else if (!shouldHost && hostChannel) {
    sb.removeChannel(hostChannel);
    hostChannel = null;
  }
}

function resultMessage() {
  const { winner, end_reason: reason } = room;
  if (winner === 3) return '무승부입니다.';
  if (winner === myColor) {
    if (reason === 'resign') return '상대 기권! 승리!';
    if (reason === 'left') return '상대가 나갔습니다. 승리!';
    return '이겼습니다!';
  }
  if (reason === 'resign') return '기권패';
  return '패배하셨습니다.';
}

function renderOnline() {
  if (mode !== 'online' || !room) return;
  const arr = Array.from(room.board, Number);
  const playing = room.status === 'playing';
  const myTurn = playing && room.turn === myColor;
  drawBoard(arr, room.last_move, myTurn && !moving, myColor);

  $('gameTitle').textContent = room.name;
  const player = (color) => {
    const name = color === 1 ? room.black_name : room.white_name;
    if (!name) return { name: '대기 중…' };
    if (color === myColor) return { name, tag: '나' };
    return opponentOnline ? { name, tag: '' } : { name, tag: '연결 끊김', off: true };
  };
  setPlayers(player(1), player(2), playing ? room.turn : 0);

  // 상태 문구
  let status;
  const oppRematch = myColor === 1 ? room.rematch_white : room.rematch_black;
  const myRematch = myColor === 1 ? room.rematch_black : room.rematch_white;
  if (room.status === 'waiting') {
    status = '상대를 기다리는 중입니다…';
  } else if (playing) {
    status = myTurn ? `내 차례입니다 (${COLOR_NAME[myColor]}돌)` : '상대 차례입니다…';
    if (!opponentOnline) status += ' · 상대 연결 끊김';
  } else if (room.status === 'closed') {
    status = room.end_reason === 'left' ? resultMessage() : '상대가 방을 나갔습니다.';
  } else {
    status = resultMessage();
    if (oppRematch && !myRematch) status += ' · 상대가 재대결을 원합니다!';
    else if (myRematch) status += ' · 상대 응답 대기 중…';
  }
  $('status').textContent = status;

  // 버튼
  const rematchBtn = $('rematch');
  rematchBtn.hidden = !(room.status === 'finished' || room.status === 'closed');
  rematchBtn.disabled = room.status !== 'finished' || myRematch;
  rematchBtn.textContent = myRematch ? '응답 대기 중…' : oppRematch ? '재대결 수락' : '재대결 요청 (흑백 교대)';
  $('resign').hidden = !playing;
}

async function onlineMove(i) {
  if (!room || moving || room.status !== 'playing' || room.turn !== myColor) return;
  if (room.board[i] !== '0') return;

  // 낙관적 반영: 바로 돌을 그리고, 서버 결과로 다시 맞춤
  moving = true;
  const before = room;
  room = { ...room, board: room.board.slice(0, i) + myColor + room.board.slice(i + 1), last_move: i, turn: 3 - myColor };
  renderOnline();

  const { error } = await sb.rpc('make_move', { p_room: roomId, p_token: token, p_idx: i });
  moving = false;
  if (error) {
    room = before;
    toast(errMsg(error));
  }
  await refreshRoom();
}

$('resign').addEventListener('click', async () => {
  if (!confirm('정말 기권하시겠습니까?')) return;
  const { error } = await sb.rpc('resign', { p_room: roomId, p_token: token });
  if (error) toast(errMsg(error));
  refreshRoom();
});

$('rematch').addEventListener('click', async () => {
  $('rematch').disabled = true;
  const { error } = await sb.rpc('request_rematch', { p_room: roomId, p_token: token });
  if (error) toast(errMsg(error));
  refreshRoom();
});

$('leave').addEventListener('click', async () => {
  if (room && room.status === 'playing' && !confirm('게임 중에 나가면 패배 처리됩니다. 나가시겠습니까?')) return;
  const id = roomId;
  await cleanupOnline();
  await sb.rpc('leave_room', { p_room: id, p_token: token });
  enterLobby();
});

// =====================================================
//  컴퓨터 대전
// =====================================================
let aiBoard = new Array(SIZE).fill(0);
let aiLast = null;
let aiBusy = true;
let aiOver = false;
let level = 'normal';
const LEVEL_NAME = { easy: '하수', normal: '중수', hard: '고수' };

function enterAi() {
  mode = 'ai';
  show('gameView');
  $('onlineControls').hidden = true;
  $('aiControls').hidden = false;
  $('gameTitle').textContent = '컴퓨터 대전';
  resetAi(false);
}

function resetAi(start) {
  aiBoard = new Array(SIZE).fill(0);
  aiLast = null;
  aiBusy = !start;
  aiOver = false;
  hideResult();
  $('aiStart').textContent = start ? '다시하기' : '게임 시작';
  $('status').textContent = start ? '내 차례입니다. 흑돌을 놓아주세요.' : '게임 시작 버튼을 눌러주세요.';
  renderAi();
}

function renderAi() {
  if (mode !== 'ai') return;
  drawBoard(aiBoard, aiLast, !aiBusy && !aiOver, 1);
  setPlayers(
    { name: nickname, tag: '나' },
    { name: '컴퓨터', tag: LEVEL_NAME[level] },
    aiOver || (aiBusy && aiLast === null) ? 0 : aiBusy ? 2 : 1
  );
}

function finishAi(text) {
  aiOver = true;
  aiBusy = true;
  $('status').textContent = text;
  showResult(text);
  renderAi();
}

function aiPlayerMove(i) {
  if (aiBusy || aiOver || aiBoard[i] !== 0) return;
  aiBoard[i] = 1;
  aiLast = i;
  if (isWin(aiBoard, i, 1)) return finishAi('이겼습니다!');
  if (aiBoard.every(Boolean)) return finishAi('무승부입니다.');

  aiBusy = true;
  $('status').textContent = '컴퓨터가 생각 중입니다…';
  renderAi();
  setTimeout(aiMove, 300);
}

function candidates() {
  const empty = aiBoard.every((v) => v === 0);
  const arr = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (aiBoard[r * N + c] !== 0) continue;
      if (empty) { arr.push(r * N + c); continue; }
      let near = false;
      for (let y = Math.max(0, r - 2); y <= Math.min(N - 1, r + 2) && !near; y++) {
        for (let x = Math.max(0, c - 2); x <= Math.min(N - 1, c + 2); x++) {
          if (aiBoard[y * N + x] !== 0) { near = true; break; }
        }
      }
      if (near) arr.push(r * N + c);
    }
  }
  return arr;
}

function scoreForMove(idx, player) {
  const r = Math.floor(idx / N), c = idx % N;
  let score = 0;
  for (const [dr, dc] of DIRS) {
    let length = 1;
    let open = 0;
    for (const sign of [-1, 1]) {
      for (let i = 1; i < 6; i++) {
        const y = r + dr * i * sign, x = c + dc * i * sign;
        if (y < 0 || y >= N || x < 0 || x >= N) break;
        const v = aiBoard[y * N + x];
        if (v === player) length++;
        else { if (v === 0) open++; break; }
      }
    }
    if (length >= 5) score += 100000;
    else if (length === 4) score += open === 2 ? 10000 : 1000;
    else if (length === 3) score += open === 2 ? 500 : 80;
    else if (length === 2) score += open === 2 ? 30 : 8;
  }
  return score;
}

function aiMove() {
  if (mode !== 'ai' || aiOver) return;
  const possible = candidates();
  if (possible.length === 0) return finishAi('무승부입니다.');

  let pick = possible[0];
  if (level === 'easy') {
    pick = possible[Math.floor(Math.random() * possible.length)];
  } else {
    let best = -Infinity;
    for (const idx of possible) {
      const v = scoreForMove(idx, 2) * (level === 'hard' ? 1.35 : 1.15)
              + scoreForMove(idx, 1) * (level === 'hard' ? 1.15 : 1);
      if (v > best) { best = v; pick = idx; }
    }
  }

  aiBoard[pick] = 2;
  aiLast = pick;
  if (isWin(aiBoard, pick, 2)) return finishAi('패배하셨습니다.');
  if (aiBoard.every(Boolean)) return finishAi('무승부입니다.');

  aiBusy = false;
  $('status').textContent = '내 차례입니다. 흑돌을 놓아주세요.';
  renderAi();
}

document.querySelectorAll('[data-level]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-level]').forEach((el) => el.classList.remove('on'));
    button.classList.add('on');
    level = button.dataset.level;
    resetAi(false);
  });
});
$('aiStart').addEventListener('click', () => resetAi(true));
$('aiHome').addEventListener('click', goHome);

// =====================================================
//  시작: 새로고침 전에 있던 방이 있으면 다시 입장
// =====================================================
(async function boot() {
  const saved = sessionStorage.getItem('omok.room');
  if (saved && nickname) {
    const { data, error } = await sb.rpc('join_room', { p_room: saved, p_nickname: nickname, p_token: token });
    if (!error && data) return enterRoom(saved, data);
    sessionStorage.removeItem('omok.room');
  }
  show('homeView');
})();
