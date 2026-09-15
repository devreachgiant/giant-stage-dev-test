-- Everything on the pod board that was a constant in the page.
--
-- Three tabs read from three different places, and two of them were not places at all:
--
--   Rates          pod_rates -- already a table, already right, but read-only in the page
--   The team       CAPS = { 'PAID ADS': { ideal: 15, max: 20 }, ... } -- a JS object
--   How it works   ROLES, LIMITS, GROWTH and four paragraphs -- all literals
--
-- The rate card was made a table in the first place because "rates are reviewed every 90
-- days, and a review that needs a developer is a review that does not happen". That
-- argument applies with equal force to the capacity a specialist is held to and to the
-- description of what each role is responsible for. Both were still literals.

-- ── capacity belongs to the department ───────────────────────────────────────
-- Not a table of its own: the cap is a fact about a department, the page already looks a
-- person's department up to find their cap, and the old JS object was keyed by department
-- name -- which quietly meant renaming a department silently removed everybody's cap.
alter table public.pay_departments add column if not exists ideal_accounts smallint;
alter table public.pay_departments add column if not exists max_accounts smallint;
-- What to call somebody in this department on the capacity line: "Google Ads specialist",
-- not "PAID ADS". Null falls back to the department name.
alter table public.pay_departments add column if not exists cap_label text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='pay_departments_caps_check') then
    alter table public.pay_departments add constraint pay_departments_caps_check
      check ((ideal_accounts is null or ideal_accounts >= 0)
         and (max_accounts is null or max_accounts >= 0)
         and (ideal_accounts is null or max_accounts is null or ideal_accounts <= max_accounts));
  end if;
end $$;

-- The three the page had hard-coded, matched to the departments that actually exist. Set
-- by name because that is the key the old object used, and only where nothing is set yet.
update public.pay_departments set ideal_accounts = 15, max_accounts = 20,
       cap_label = 'Google Ads specialist'
 where upper(name) = 'PAID ADS' and ideal_accounts is null and max_accounts is null;
update public.pay_departments set ideal_accounts = 10, max_accounts = 10,
       cap_label = 'SEO specialist'
 where upper(name) = 'PRODUCTION' and ideal_accounts is null and max_accounts is null;
update public.pay_departments set ideal_accounts = 15, max_accounts = 20,
       cap_label = 'Pod Leader'
 where upper(name) = 'MANAGERS' and ideal_accounts is null and max_accounts is null;

-- ── the words on How it works ────────────────────────────────────────────────
-- One row per block rather than one row per sentence: the blocks are edited as units, and
-- a table with a column per paragraph would need a migration every time the page gained
-- one. jsonb because two of the four are lists whose length is not fixed.
create table if not exists public.pod_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- Seeded with exactly what the page said before this migration, so applying it changes
-- nothing anybody can see. That is the point: the words move, they do not change.
insert into public.pod_settings (key, value) values
('intro', jsonb_build_object(
  'title', 'The Pod Leader owns the clients. Specialists deliver the work.',
  'body',  'One pod holds up to 20 clients under one Pod Leader. Each client counts as one '
        || 'relationship, no matter how many services they receive. Specialists are paid per '
        || 'active account they manage; dev and design are shared across the pod. When a pod '
        || 'fills, we recruit the next Account Manager and open the next pod.')),

('roles', jsonb_build_array(
  jsonb_build_object('key','lead','label','POD LEADER',
    'does','Owns all client relationships and client health. Handles communication, calls, and escalations. Sets account priorities and oversees delivery. Holds specialists accountable. Manages retention.',
    'note','Sends a weekly client-health report: green/amber/red per client, results, overdue work, concerns, retention risks, specialist issues, next week''s priorities, decisions needed.'),
  jsonb_build_object('key','google_ads','label','GOOGLE ADS',
    'does','Campaign builds, optimisations, budget management, conversion tracking, search terms / keywords / audiences, testing, reporting. Flag problems early and recommend improvements.',
    'note','Ideal 10-15 accounts, max 20. Paid per account by tier. Can support clients across pods.'),
  jsonb_build_object('key','seo','label','SEO & AI SEARCH',
    'does','SEO strategy, technical SEO, keyword targeting, content planning and QA, internal linking, GSC / GA checks, rankings, reporting, recommendations. Coordinates with dev when fixes are needed.',
    'note','1 SEO lead owns each account - agents support the lead. Content creation automated with Scriptor/AI. Max 10 accounts initially.'),
  jsonb_build_object('key','meta_ads','label','META ADS',
    'does','Campaign builds, optimisation, budgets, tracking, and reporting for Meta accounts. Supports SEO / AI Search work alongside the SEO lead.',
    'note','Paid per account. Meta rates provisional - reviewed as volume grows.'),
  jsonb_build_object('key','web','label','WEB & DESIGN',
    'does','Essential development inside client retainers, coordinating technical SEO fixes with the SEO lead. Design covered alongside, with AI for simple creative.',
    'note','No free website work beyond retainer essentials. Larger dev or design projects are scoped, white-labelled, and quoted separately. Shared across the pod rather than paid per account.'))),

('growth', jsonb_build_array(
  jsonb_build_object('range','1-20',  'what','One Pod Leader owns all client relationships'),
  jsonb_build_object('range','20-25', 'what','Begin recruiting Account Manager #2 ($3,000-$4,500/mo)'),
  jsonb_build_object('range','25-40', 'what','Two AMs · roughly 15-20 clients each'),
  jsonb_build_object('range','40-60', 'what','Third AM · Pod Leader leads Client Services'),
  jsonb_build_object('range','60+',   'what','Pod Leader manages the AMs, fewer direct clients'))),

('notes', jsonb_build_array(
  jsonb_build_object('label','HOW PAY WORKS',
    'body','Payments apply only to active, assigned accounts and end when an account is lost or reassigned. Account losses are reviewed for cause. Large or unusually complex accounts are priced separately. Rates reviewed every 90 days.'),
  jsonb_build_object('label','PERFORMANCE = MORE ACCOUNTS',
    'body','Good work earns more accounts, and more accounts mean more pay. Every specialist is reviewed every 90 days on results, quality, deadlines, reporting, early problem-spotting, communication, reliability, and retention. Underperformance leads to training, reassignment, or replacement.'))),

('rates_note', to_jsonb('Same rate card in every location. Pay applies to active, assigned accounts only. Large or unusually complex accounts priced separately. Rates reviewed every 90 days.'::text))
on conflict (key) do nothing;

-- ── who may read and change it ───────────────────────────────────────────────
-- The same split as the rest of the board: the team reads it, managers write it. None of
-- it is money, and a specialist is held to the capacity and the role description on this
-- page, so being unable to read them would be the odd choice.
alter table public.pod_settings enable row level security;

drop policy if exists pod_settings_team_select on public.pod_settings;
create policy pod_settings_team_select on public.pod_settings
  for select to authenticated
  using (auth.uid() is not null and not public.is_client_user());

drop policy if exists pod_settings_manager_write on public.pod_settings;
create policy pod_settings_manager_write on public.pod_settings
  for all to authenticated
  using (public.is_manager_or_owner()) with check (public.is_manager_or_owner());

grant select on public.pod_settings to authenticated;
grant insert, update, delete on public.pod_settings to authenticated;
