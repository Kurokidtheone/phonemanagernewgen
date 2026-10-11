-- Phone Store Manager: mailbox for outside access.
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It is safe to run again.
--
-- The tables hold only encrypted text. The public (anon) key cannot read or
-- write them directly: Row Level Security is on and there are no policies.
-- All access goes through the mb_* functions below. Knowing a mailbox name is
-- what grants access, so never log or show it.

create table if not exists public.shops (
  mailbox    text primary key,
  shop_id    text,
  name       text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  blocked    boolean not null default false
);

create table if not exists public.mailbox_messages (
  id         bigint generated always as identity primary key,
  mailbox    text not null,
  dir        smallint not null check (dir in (0, 1)),  -- 0 = to the PC, 1 = to the phone
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists mailbox_messages_lookup on public.mailbox_messages (mailbox, dir, id);
create index if not exists mailbox_messages_age on public.mailbox_messages (created_at);
create index if not exists shops_first_seen on public.shops (first_seen);

alter table public.shops enable row level security;
alter table public.mailbox_messages enable row level security;
-- No policies on purpose.
revoke all on table public.shops from anon, authenticated;
revoke all on table public.mailbox_messages from anon, authenticated;

-- Mailbox names are exactly 43 base64url characters.
create or replace function public.mb_valid(p_mailbox text) returns boolean
language sql immutable set search_path = ''
as $$ select p_mailbox is not null and p_mailbox ~ '^[A-Za-z0-9_-]{43}$' $$;

-- The PC calls this every 20 seconds. Returns true when the shop is blocked.
create or replace function public.mb_beat(p_mailbox text, p_shop_id text, p_name text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_blocked boolean;
begin
  if not public.mb_valid(p_mailbox) then
    raise exception 'bad_mailbox';
  end if;

  select blocked into v_blocked from public.shops where mailbox = p_mailbox;
  if found then
    update public.shops
       set last_seen = now(),
           shop_id = left(coalesce(p_shop_id, shop_id), 100),
           name = left(coalesce(p_name, name), 200)
     where mailbox = p_mailbox;
    return v_blocked;
  end if;

  -- At most 200 new shops per hour in total.
  if (select count(*) from public.shops where first_seen > now() - interval '1 hour') >= 200 then
    raise exception 'too_many_new_shops';
  end if;
  insert into public.shops (mailbox, shop_id, name)
  values (p_mailbox, left(p_shop_id, 100), left(p_name, 200))
  on conflict (mailbox) do update set last_seen = now();
  return false;
end $$;

-- Seconds since the PC's last beat, or null when the mailbox is unknown.
create or replace function public.mb_seen(p_mailbox text) returns integer
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_last timestamptz;
begin
  if not public.mb_valid(p_mailbox) then
    raise exception 'bad_mailbox';
  end if;
  select last_seen into v_last from public.shops where mailbox = p_mailbox;
  if v_last is null then
    return null;
  end if;
  return greatest(0, extract(epoch from (now() - v_last))::integer);
end $$;

-- Puts one message in a mailbox and sends a tiny wake-up (no data in it).
create or replace function public.mb_send(p_mailbox text, p_dir smallint, p_body text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_blocked boolean;
  v_id bigint;
begin
  if not public.mb_valid(p_mailbox) then
    raise exception 'bad_mailbox';
  end if;
  if p_dir is null or p_dir not in (0, 1) then
    raise exception 'bad_dir';
  end if;
  select blocked into v_blocked from public.shops where mailbox = p_mailbox;
  if not found then
    raise exception 'mailbox_unknown';
  end if;
  if v_blocked then
    raise exception 'mailbox_blocked';
  end if;
  if p_body is null or length(p_body) > 350000 then
    raise exception 'body_too_large';
  end if;
  if (select count(*) from public.mailbox_messages
       where mailbox = p_mailbox and dir = p_dir) >= 500 then
    raise exception 'mailbox_full';
  end if;

  insert into public.mailbox_messages (mailbox, dir, body)
  values (p_mailbox, p_dir, p_body)
  returning id into v_id;

  -- The wake-up is only a hint: clients also poll mb_fetch.
  begin
    perform realtime.send(jsonb_build_object('dir', p_dir), 'wake', 'mb:' || p_mailbox, false);
  exception when others then
    null;
  end;
  return v_id;
end $$;

-- Up to 50 waiting messages, oldest first, after the given id.
create or replace function public.mb_fetch(p_mailbox text, p_dir smallint, p_after_id bigint)
returns table (id bigint, body text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.mb_valid(p_mailbox) then
    raise exception 'bad_mailbox';
  end if;
  return query
    select m.id, m.body
      from public.mailbox_messages m
     where m.mailbox = p_mailbox and m.dir = p_dir and m.id > coalesce(p_after_id, 0)
     order by m.id
     limit 50;
end $$;

-- Deletes delivered messages up to and including the given id.
create or replace function public.mb_ack(p_mailbox text, p_dir smallint, p_up_to_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.mb_valid(p_mailbox) then
    raise exception 'bad_mailbox';
  end if;
  delete from public.mailbox_messages
   where mailbox = p_mailbox and dir = p_dir and id <= p_up_to_id;
end $$;

-- Only the five public functions are callable with the anon key.
revoke all on function public.mb_valid(text) from public, anon, authenticated;
revoke all on function public.mb_beat(text, text, text) from public, anon, authenticated;
revoke all on function public.mb_seen(text) from public, anon, authenticated;
revoke all on function public.mb_send(text, smallint, text) from public, anon, authenticated;
revoke all on function public.mb_fetch(text, smallint, bigint) from public, anon, authenticated;
revoke all on function public.mb_ack(text, smallint, bigint) from public, anon, authenticated;
grant execute on function public.mb_beat(text, text, text) to anon;
grant execute on function public.mb_seen(text) to anon;
grant execute on function public.mb_send(text, smallint, text) to anon;
grant execute on function public.mb_fetch(text, smallint, bigint) to anon;
grant execute on function public.mb_ack(text, smallint, bigint) to anon;

-- Messages older than 3 days are deleted every day at 03:00 UTC.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'mb-cleanup',
  '0 3 * * *',
  $job$ delete from public.mailbox_messages where created_at < now() - interval '3 days' $job$
);
