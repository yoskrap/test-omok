-- =====================================================
--  온라인 오목 DB 스키마 (Supabase 프로젝트 omok-online 에 적용 완료)
--  새 프로젝트에 다시 만들 때 SQL Editor 에 그대로 붙여넣으면 됩니다.
-- =====================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- 방 (모두 읽기 가능, 쓰기는 RPC 함수로만)
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 20),
  status text not null default 'waiting' check (status in ('waiting','playing','finished','closed')),
  board text not null default repeat('0', 225) check (char_length(board) = 225), -- 0 빈칸, 1 흑, 2 백
  turn smallint not null default 1 check (turn in (1,2)),
  winner smallint not null default 0 check (winner in (0,1,2,3)), -- 3 = 무승부
  end_reason text check (end_reason in ('five','draw','resign','left')),
  last_move smallint,
  move_count smallint not null default 0,
  black_name text,
  white_name text,
  rematch_black boolean not null default false,
  rematch_white boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rooms_status_created_idx on public.rooms (status, created_at desc);

alter table public.rooms enable row level security;
create policy "rooms are readable by everyone" on public.rooms
  for select to anon, authenticated using (true);
revoke insert, update, delete on public.rooms from anon, authenticated;

-- 플레이어 토큰 (API 로 노출되지 않는 private 스키마)
create table private.room_players (
  room_id uuid not null references public.rooms(id) on delete cascade,
  color smallint not null check (color in (1,2)),
  token text not null,
  primary key (room_id, color),
  unique (room_id, token)
);

alter publication supabase_realtime add table public.rooms;

-- ---------- 내부 함수 ----------
CREATE OR REPLACE FUNCTION private.check_five(b text, idx integer, col text)
 RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path TO ''
AS $function$
declare
  r int := idx / 15; c int := idx % 15;
  dr int[] := array[1,0,1,1]; dc int[] := array[0,1,1,-1];
  k int; sg int; i int; y int; x int; cnt int;
begin
  for k in 1..4 loop
    cnt := 1;
    foreach sg in array array[-1,1] loop
      i := 1;
      loop
        y := r + dr[k]*i*sg; x := c + dc[k]*i*sg;
        exit when y < 0 or y > 14 or x < 0 or x > 14;
        exit when substr(b, y*15 + x + 1, 1) <> col;
        cnt := cnt + 1; i := i + 1;
      end loop;
    end loop;
    if cnt >= 5 then return true; end if;
  end loop;
  return false;
end $function$;

CREATE OR REPLACE FUNCTION private.player_color(p_room uuid, p_token text)
 RETURNS smallint LANGUAGE sql STABLE SET search_path TO ''
AS $function$
  select color from private.room_players where room_id = p_room and token = p_token
$function$;

-- ---------- 공개 RPC ----------
CREATE OR REPLACE FUNCTION public.create_room(p_name text, p_nickname text, p_token text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_id uuid;
begin
  p_name := trim(p_name); p_nickname := trim(p_nickname);
  if char_length(p_name) not between 1 and 20 then raise exception '방 이름은 1~20자로 입력해주세요.'; end if;
  if char_length(p_nickname) not between 1 and 12 then raise exception '닉네임은 1~12자로 입력해주세요.'; end if;
  if p_token is null or char_length(p_token) not between 16 and 100 then raise exception '잘못된 요청입니다.'; end if;

  -- 오래된 방 정리
  delete from public.rooms where updated_at < now() - interval '1 day'
     or (status = 'waiting' and updated_at < now() - interval '2 hours');

  insert into public.rooms (name, black_name) values (p_name, p_nickname) returning id into v_id;
  insert into private.room_players (room_id, color, token) values (v_id, 1, p_token);
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.join_room(p_room uuid, p_nickname text, p_token text)
 RETURNS smallint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_room public.rooms; v_color smallint;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found then raise exception '방이 존재하지 않습니다.'; end if;

  v_color := private.player_color(p_room, p_token);
  if v_color is not null then return v_color; end if; -- 재접속

  if v_room.status <> 'waiting' then raise exception '이미 게임이 시작된 방입니다.'; end if;
  p_nickname := trim(p_nickname);
  if char_length(p_nickname) not between 1 and 12 then raise exception '닉네임은 1~12자로 입력해주세요.'; end if;
  if p_token is null or char_length(p_token) not between 16 and 100 then raise exception '잘못된 요청입니다.'; end if;

  insert into private.room_players (room_id, color, token) values (p_room, 2, p_token);
  update public.rooms set white_name = p_nickname, status = 'playing', updated_at = now() where id = p_room;
  return 2;
end $function$;

CREATE OR REPLACE FUNCTION public.make_move(p_room uuid, p_token text, p_idx integer)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_room public.rooms; v_color smallint; v_board text; v_ch text;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found then raise exception '방이 존재하지 않습니다.'; end if;
  v_color := private.player_color(p_room, p_token);
  if v_color is null then raise exception '이 방의 플레이어가 아닙니다.'; end if;
  if v_room.status <> 'playing' then raise exception '진행 중인 게임이 아닙니다.'; end if;
  if v_room.turn <> v_color then raise exception '상대 차례입니다.'; end if;
  if p_idx is null or p_idx < 0 or p_idx > 224 then raise exception '잘못된 위치입니다.'; end if;
  if substr(v_room.board, p_idx + 1, 1) <> '0' then raise exception '이미 돌이 있는 자리입니다.'; end if;

  v_ch := v_color::text;
  v_board := overlay(v_room.board placing v_ch from p_idx + 1 for 1);

  if private.check_five(v_board, p_idx, v_ch) then
    update public.rooms set board = v_board, last_move = p_idx, move_count = move_count + 1,
      status = 'finished', winner = v_color, end_reason = 'five', updated_at = now() where id = p_room;
  elsif v_room.move_count + 1 >= 225 then
    update public.rooms set board = v_board, last_move = p_idx, move_count = move_count + 1,
      status = 'finished', winner = 3, end_reason = 'draw', updated_at = now() where id = p_room;
  else
    update public.rooms set board = v_board, last_move = p_idx, move_count = move_count + 1,
      turn = 3 - v_color, updated_at = now() where id = p_room;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.resign(p_room uuid, p_token text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_room public.rooms; v_color smallint;
begin
  select * into v_room from public.rooms where id = p_room for update;
  v_color := private.player_color(p_room, p_token);
  if v_color is null then raise exception '이 방의 플레이어가 아닙니다.'; end if;
  if v_room.status <> 'playing' then return; end if;
  update public.rooms set status = 'finished', winner = 3 - v_color, end_reason = 'resign', updated_at = now()
   where id = p_room;
end $function$;

CREATE OR REPLACE FUNCTION public.leave_room(p_room uuid, p_token text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_room public.rooms; v_color smallint;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found then return; end if;
  v_color := private.player_color(p_room, p_token);
  if v_color is null then return; end if;

  if v_room.status = 'waiting' then
    delete from public.rooms where id = p_room;
  elsif v_room.status = 'playing' then
    update public.rooms set status = 'closed', winner = 3 - v_color, end_reason = 'left',
      rematch_black = false, rematch_white = false, updated_at = now() where id = p_room;
  else
    update public.rooms set status = 'closed', rematch_black = false, rematch_white = false,
      updated_at = now() where id = p_room;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.request_rematch(p_room uuid, p_token text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_room public.rooms; v_color smallint; v_b text; v_w text;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found then raise exception '방이 존재하지 않습니다.'; end if;
  v_color := private.player_color(p_room, p_token);
  if v_color is null then raise exception '이 방의 플레이어가 아닙니다.'; end if;
  if v_room.status = 'closed' then raise exception '상대가 방을 나갔습니다.'; end if;
  if v_room.status <> 'finished' then return; end if;

  if v_color = 1 then v_room.rematch_black := true; else v_room.rematch_white := true; end if;

  if v_room.rematch_black and v_room.rematch_white then
    -- 둘 다 동의 → 흑백 교대 후 새 판
    select token into v_b from private.room_players where room_id = p_room and color = 1;
    select token into v_w from private.room_players where room_id = p_room and color = 2;
    delete from private.room_players where room_id = p_room;
    insert into private.room_players (room_id, color, token) values (p_room, 1, v_w), (p_room, 2, v_b);
    update public.rooms set
      black_name = v_room.white_name, white_name = v_room.black_name,
      board = repeat('0', 225), turn = 1, winner = 0, end_reason = null,
      last_move = null, move_count = 0, status = 'playing',
      rematch_black = false, rematch_white = false, updated_at = now()
    where id = p_room;
  else
    update public.rooms set rematch_black = v_room.rematch_black, rematch_white = v_room.rematch_white,
      updated_at = now() where id = p_room;
  end if;
end $function$;

revoke all on function public.create_room(text,text,text), public.join_room(uuid,text,text),
  public.make_move(uuid,text,int), public.resign(uuid,text), public.leave_room(uuid,text),
  public.request_rematch(uuid,text) from public;
grant execute on function public.create_room(text,text,text), public.join_room(uuid,text,text),
  public.make_move(uuid,text,int), public.resign(uuid,text), public.leave_room(uuid,text),
  public.request_rematch(uuid,text) to anon, authenticated;
