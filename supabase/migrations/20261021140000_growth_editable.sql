-- Growth, part two: make it all operable rather than read-only.
--
-- 20261021120000 brought the pipeline in. Everything a rep actually DOES day to day still
-- had nowhere to live: their own training plan, the calls they have been told to watch,
-- and the shared content behind Training. Settings could be read but not changed, which
-- meant a stage could not be renamed without a deploy.
--
-- WHO WRITES WHAT, continuing the same two tiers:
--
--   a rep   their own training tasks; adds a call to the shared watch list; everything
--           on their own clients
--   staff   all of that, plus stages, templates, discount codes and the Training content
--
-- The watch list is deliberately shared-write. It is a reading list, not a record: Luke
-- adds one for everybody, a rep adds one they found. Shared-read-only would mean a rep has
-- to ask for a link to be added, which is how a list stops being used.

-- ---------------------------------------------------------------- a rep's own plan

create table if not exists public.growth_tasks (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  text       text not null,
  due_on     date,
  done       boolean not null default false,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists growth_tasks_owner_idx on public.growth_tasks(owner_id, position);

-- ---------------------------------------------------------------- calls to watch

create table if not exists public.growth_watch_calls (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  call_date  date,
  url        text default '',
  tags       text[] not null default '{}',
  outcome    text default '',
  note       text default '',
  position   integer not null default 0,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- discount codes
-- Their own table rather than a jsonb blob in settings, because the composer reads them
-- on every open and a blob makes "which codes exist" a parse rather than a query.

create table if not exists public.growth_discounts (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  label      text not null default '',
  colour     text not null default '#D00400',
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.growth_tasks       enable row level security;
alter table public.growth_watch_calls enable row level security;
alter table public.growth_discounts   enable row level security;

-- Clients of the agency stay out, restrictively so it ANDs rather than being OR'd away.
do $$
declare t text;
begin
  foreach t in array array['growth_tasks','growth_watch_calls','growth_discounts']
  loop
    execute format(
      'drop policy if exists %1$s_no_clients on public.%1$s;
       create policy %1$s_no_clients on public.%1$s
         as restrictive for all to authenticated
         using ((select public.growth_is_client()) = false)
         with check ((select public.growth_is_client()) = false);', t);
  end loop;
end $$;

-- A rep owns their plan. Staff can see everyone's, which is the point of a training plan.
drop policy if exists growth_tasks_rw on public.growth_tasks;
create policy growth_tasks_rw on public.growth_tasks
  for all to authenticated
  using      ((select public.growth_is_staff()) or owner_id = (select auth.uid()))
  with check ((select public.growth_is_staff()) or owner_id = (select auth.uid()));

-- Shared reading list: everyone reads, everyone adds, only staff and the person who added
-- it can remove one. Letting anybody delete anybody's would make it unusable the first
-- time somebody tidied up.
drop policy if exists growth_watch_read on public.growth_watch_calls;
create policy growth_watch_read on public.growth_watch_calls
  for select to authenticated using (true);
drop policy if exists growth_watch_insert on public.growth_watch_calls;
create policy growth_watch_insert on public.growth_watch_calls
  for insert to authenticated with check (added_by = (select auth.uid()) or (select public.growth_is_staff()));
drop policy if exists growth_watch_change on public.growth_watch_calls;
create policy growth_watch_change on public.growth_watch_calls
  for update to authenticated
  using      ((select public.growth_is_staff()) or added_by = (select auth.uid()))
  with check ((select public.growth_is_staff()) or added_by = (select auth.uid()));
drop policy if exists growth_watch_delete on public.growth_watch_calls;
create policy growth_watch_delete on public.growth_watch_calls
  for delete to authenticated
  using ((select public.growth_is_staff()) or added_by = (select auth.uid()));

-- Discount codes are money. Everyone reads them to put one in an email; only staff invent one.
drop policy if exists growth_discounts_read on public.growth_discounts;
create policy growth_discounts_read on public.growth_discounts
  for select to authenticated using (true);
drop policy if exists growth_discounts_write on public.growth_discounts;
create policy growth_discounts_write on public.growth_discounts
  for all to authenticated
  using ((select public.growth_is_staff())) with check ((select public.growth_is_staff()));

revoke all on public.growth_tasks, public.growth_watch_calls, public.growth_discounts from anon;

-- ---------------------------------------------------------------- columns the UI needs

alter table public.growth_clients add column if not exists first_email_on date;

-- ---------------------------------------------------------------- seed

insert into public.growth_discounts (code, label, colour, position) values
  ('RG250',  'Get $250 off each month',   '#D91F0F', 0),
  ('RG500',  'Get $500 off each month',   '#E8590C', 1),
  ('RG1000', 'Get $1,000 off each month', '#7048E8', 2)
on conflict do nothing;

-- The Training content Luke wrote, so the screens are not empty on first open. All of it
-- is editable in Settings afterwards; none of it is hard-coded in the page.
insert into public.growth_settings (key, value) values
  ('philosophy', jsonb_build_object('tips', jsonb_build_array(
     jsonb_build_object('h','They want to trust you, but their survival brain is on alert','t','Be calm, confident and honest. Do not oversell. Trust is earned by how you show up, not what you say.'),
     jsonb_build_object('h','They want to feel heard and understood','t','Ask thoughtful questions and really listen. Echo their words. Validate their concerns. Make them feel seen.'),
     jsonb_build_object('h','They want someone who can lead','t','Guide the conversation with clarity. Have a plan, and help them feel they are in good hands.'),
     jsonb_build_object('h','They want someone real','t','Do not try too hard. Be human. People buy from people, not perfect pitches.'),
     jsonb_build_object('h','They want to say yes, they are just checking it feels right','t','Remove doubt by being transparent, helpful and easy to talk with.'),
     jsonb_build_object('h','They want to know we are a smart company','t','Share quick, relevant examples. Speak with authority and answer their questions.')),
   'checklist', jsonb_build_array(
     'Stay calm, honest, and do not oversell','Listen and ask thoughtful questions',
     'Be real, not scripted or salesy','Make things easy to trust and say yes',
     'Give smart insights, just a little'))),

  ('script', jsonb_build_object(
   'flow', jsonb_build_array(
     jsonb_build_object('h','Open','t','Warm hello. Say how long you have. Ask what made them book.'),
     jsonb_build_object('h','Listen','t','Ask about the business, what they run now, and what has gone wrong. Let them talk. Repeat their words back.'),
     jsonb_build_object('h','Find the worry','t','Budget, long contracts, past agencies, downtime. Name it out loud so it feels safe.'),
     jsonb_build_object('h','Offer','t','Say the plan in plain words: what we do, what it costs, the 3 month minimum and 10 day exit.'),
     jsonb_build_object('h','Email in 10 minutes','t','Send the recap and offer while the call is fresh. Ask for a clear yes.')),
   'worries', jsonb_build_array(
     jsonb_build_object('q','Is it worth it at my budget?','a','Start small, fix tracking first, and only grow when it works. Small teams give small accounts real attention.'),
     jsonb_build_object('q','I do not want a long contract.','a','No annual lock in. 3 month minimum and a 10 day exit.'),
     jsonb_build_object('q','Past agencies let me down.','a','Small client roster, daily work, a team that answers. Show the plan before asking for the yes.'),
     jsonb_build_object('q','Google keeps pausing my ads.','a','We help with verification and policy flags, and we watch the account daily so downtime stays short.')))),

  ('pricing', jsonb_build_object(
   'packs', jsonb_build_array(
     jsonb_build_object('tag','Pack 1','name','Paid Ads Volt','price','$3,000','inc','Google Ads + Meta Ads','txt','Full management across Search, Instagram and Facebook. Clear benchmarks, controlled spend, steady lead flow.','link','https://buy.stripe.com/aFacN67Ay9yE7VzarIeIw1P','top',false),
     jsonb_build_object('tag','Pack 2','name','Google Powerhouse','price','$3,000','inc','Google Ads + SEO','txt','Paid and organic working together. Ads bring results now, SEO builds demand over time.','link','https://buy.stripe.com/aFa5kEbQOaCI7Vz8jAeIw1Q','top',true),
     jsonb_build_object('tag','Pack 3','name','Rocket Fuel','price','$5,000','inc','All services','txt','Landing pages plus Google Ads and paid media to scale fast, with more testing and faster learning.','link','https://buy.stripe.com/aFa28s7Ayh16dfTgQ6eIw1W','top',false)),
   'services', jsonb_build_array(
     jsonb_build_object('n','Google Ads','p','$1,500','w','Clicks but not enough real leads. Wants buyers, clear tracking, weekly improvements.','l','https://buy.stripe.com/3cI14o8EC9yE6RvarIeIw1S'),
     jsonb_build_object('n','Meta Ads','p','$2,000','w','Wants steady leads or sales from Facebook and Instagram.','l','https://buy.stripe.com/9B6dRa8ECcKQ7Vz1VceIw1U'),
     jsonb_build_object('n','SEO Management','p','$2,500','w','Wants inbound leads without paying for every click.','l','https://buy.stripe.com/8x28wQ0866ms1xb43keIw1V'),
     jsonb_build_object('n','Klaviyo Email','p','$3,500','w','Wants more from leads they already have.','l',''),
     jsonb_build_object('n','Website Design','p','Custom','w','Site no longer fits the business, or visitors are unsure what to do next.','l','')),
   'notes', jsonb_build_array(
     'Ad spend: packages cover up to $15,000 a month in ad spend. Above that there is a fixed scale fee by spend level, not a percentage.',
     'Terms we have used on calls: no annual lock in, 3 month minimum, 10 day exit. Ask before quoting below list.'))),

  ('signature', jsonb_build_object('name','','title','ReachGiant','phone','','email','','site','reachgiant.com'))
on conflict (key) do nothing;
