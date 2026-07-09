-- ============================================================================
-- Yanna's Cafe — Loyalty points system
-- Run in Supabase → SQL Editor (project dgjtpxdbztnokfbmfjbw). Safe to re-run.
--
-- Rules (baked into loyalty_earn — change the divisor there if this changes):
--   • Earn: 1 point per ₱20 spent
--   • Redeem: fixed reward tiers, edit/add rows in loyalty_rewards any time
--   • Customer identity = phone number (no login), matching the pattern
--     already used for drive_thru_orders. Loyalty is opt-in — the app only
--     calls loyalty_earn when a customer chooses to join on that order.
-- ============================================================================

-- 0) Walk-in orders (POS terminal) don't capture customer identity today.
-- Add nullable columns so staff can optionally attach a phone for loyalty.
alter table public.orders add column if not exists customer_phone text;
alter table public.orders add column if not exists customer_name  text;

-- 1) Tables -------------------------------------------------------------------
create table if not exists public.loyalty_customers (
  phone      text primary key,
  name       text,
  points     int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.loyalty_transactions (
  id            bigint generated always as identity primary key,
  phone         text not null references public.loyalty_customers(phone),
  order_number  text,
  points_change int not null,
  reason        text not null,           -- 'earn' | 'redeem' | 'adjust'
  created_at    timestamptz not null default now()
);

create table if not exists public.loyalty_rewards (
  id              bigint generated always as identity primary key,
  label           text not null,
  points_required int not null,
  discount_value  numeric not null,  -- peso amount deducted from the order total when redeemed (capped at subtotal by the app)
  active          boolean not null default true,
  sort_order      int not null default 0
);

-- Starter reward tiers — edit points_required/label any time, or add more rows.
-- Based on the current menu (Black/Milk Coffee ~₱120-130, Salted Cream/Egg/
-- Coconut Coffee ~₱160-185). Adjust freely, this is just a sensible default.
insert into public.loyalty_rewards (label, points_required, discount_value, sort_order)
select * from (values
  ('₱50 Off Any Order', 50, 50, 1),
  ('Free Regular Coffee (Black or Milk Coffee)', 100, 130, 2),
  ('Free Specialty Drink (Salted Cream, Egg, or Coconut Coffee)', 200, 185, 3)
) as v(label, points_required, discount_value, sort_order)
where not exists (select 1 from public.loyalty_rewards);

-- 2) Row-level security ---------------------------------------------------
alter table public.loyalty_customers    enable row level security;
alter table public.loyalty_transactions enable row level security;
alter table public.loyalty_rewards      enable row level security;

-- Staff (POS, logged in) get full access to all 3 tables.
drop policy if exists loyalty_customers_staff_all on public.loyalty_customers;
create policy loyalty_customers_staff_all on public.loyalty_customers
  for all to authenticated using (true) with check (true);

drop policy if exists loyalty_transactions_staff_all on public.loyalty_transactions;
create policy loyalty_transactions_staff_all on public.loyalty_transactions
  for all to authenticated using (true) with check (true);

drop policy if exists loyalty_rewards_staff_all on public.loyalty_rewards;
create policy loyalty_rewards_staff_all on public.loyalty_rewards
  for all to authenticated using (true) with check (true);

-- Customers (anon, order app / kiosk) can only read the active reward list
-- directly. Balance lookup/earn/redeem always go through the RPCs below, never
-- direct table access, so a customer can't read or edit another phone's points.
drop policy if exists loyalty_rewards_anon_read on public.loyalty_rewards;
create policy loyalty_rewards_anon_read on public.loyalty_rewards
  for select to anon using (active = true);

-- 3) RPC functions (security definer, same pattern as decrement_stock /
--    verify_manager_pin already used in this project) ----------------------

-- Look up a customer's name + balance by phone. Returns no rows if unknown.
create or replace function public.loyalty_lookup(p_phone text)
returns table(name text, points int)
language sql security definer set search_path = public as $$
  select name, points from public.loyalty_customers where phone = p_phone;
$$;
revoke all on function public.loyalty_lookup(text) from public;
grant execute on function public.loyalty_lookup(text) to anon, authenticated;

-- Credit points for a paid order. 1 point per ₱20 (floor). Upserts the
-- customer row (first-time phone = new member) and logs a ledger entry.
-- Returns the new balance.
create or replace function public.loyalty_earn(p_phone text, p_name text, p_amount numeric, p_order_number text)
returns int language plpgsql security definer set search_path = public as $$
declare pts int; new_balance int;
begin
  pts := floor(greatest(p_amount, 0) / 20)::int;
  if pts <= 0 then
    select points into new_balance from public.loyalty_customers where phone = p_phone;
    return coalesce(new_balance, 0);
  end if;

  insert into public.loyalty_customers (phone, name, points)
    values (p_phone, nullif(p_name, ''), pts)
    on conflict (phone) do update
      set points     = public.loyalty_customers.points + pts,
          name       = coalesce(nullif(excluded.name, ''), public.loyalty_customers.name),
          updated_at = now()
    returning points into new_balance;

  insert into public.loyalty_transactions (phone, order_number, points_change, reason)
    values (p_phone, p_order_number, pts, 'earn');

  return new_balance;
end;
$$;
revoke all on function public.loyalty_earn(text,text,numeric,text) from public;
grant execute on function public.loyalty_earn(text,text,numeric,text) to anon, authenticated;

-- Redeem a reward tier. Fails (raises) if the phone doesn't have enough
-- points, so the caller should catch the error and show "not enough points".
-- Returns the new balance on success.
create or replace function public.loyalty_redeem(p_phone text, p_reward_id bigint, p_order_number text)
returns int language plpgsql security definer set search_path = public as $$
declare req int; bal int; new_balance int;
begin
  select points_required into req from public.loyalty_rewards where id = p_reward_id and active = true;
  if req is null then
    raise exception 'Reward not found or inactive';
  end if;

  select points into bal from public.loyalty_customers where phone = p_phone for update;
  if bal is null or bal < req then
    raise exception 'Not enough points';
  end if;

  update public.loyalty_customers set points = points - req, updated_at = now()
    where phone = p_phone
    returning points into new_balance;

  insert into public.loyalty_transactions (phone, order_number, points_change, reason)
    values (p_phone, p_order_number, -req, 'redeem');

  return new_balance;
end;
$$;
revoke all on function public.loyalty_redeem(text,bigint,text) from public;
grant execute on function public.loyalty_redeem(text,bigint,text) to anon, authenticated;

-- ============================================================================
-- Done. Run this once in Supabase (project dgjtpxdbztnokfbmfjbw). Both the POS
-- and both customer-facing apps (order-app, pos-app/customer-app.html) call
-- these same 3 functions against the same tables, so a customer's points are
-- shared no matter where they order.
-- ============================================================================
