-- Training had the five tabs but nothing in them: an empty plan and an empty watch list.
--
-- THE PLAN IS PER REP, so it cannot simply be seeded once -- a shared checklist would mean
-- one person ticking a box for everybody. The three day plan Luke wrote is stored here as a
-- TEMPLATE, and a rep gets their own copy of it the first time they open Training. After
-- that it is theirs: they can edit the text, move the dates, add and delete.
--
-- THE WATCH LIST IS SHARED, so it is seeded directly. These are the real calls from Luke's
-- artifact, with the tags and outcomes he wrote against them.

insert into public.growth_settings (key, value) values
  ('training_plan', jsonb_build_object('tasks', jsonb_build_array(
     jsonb_build_object('t','Read the pricing and packages (Pricing tab)','d',0),
     jsonb_build_object('t','Listen to 4 Fathom calls (Calls to watch tab)','d',0),
     jsonb_build_object('t','Write 3 lines per call: what they wanted, what we asked, why they did or did not buy','d',0),
     jsonb_build_object('t','One hour of Meta basics','d',0),
     jsonb_build_object('t','Get set up in Claude and the Call Ledger','d',0),
     jsonb_build_object('t','Sit in on 2 or 3 live calls, silent, taking notes','d',1),
     jsonb_build_object('t','10 minute debrief after each call','d',1),
     jsonb_build_object('t','Run a mock call with Luke as the client','d',1),
     jsonb_build_object('t','Record a Loom of your pitch','d',1),
     jsonb_build_object('t','Write follow up emails from the Fathom notes','d',1),
     jsonb_build_object('t','Take 1 or 2 real calls with Luke listening','d',2),
     jsonb_build_object('t','Get one keep and one fix after each call','d',2),
     jsonb_build_object('t','Send follow ups, Luke reviews first','d',2),
     jsonb_build_object('t','Re-record the Loom pitch and compare','d',2))))
on conflict (key) do nothing;

insert into public.growth_watch_calls (title, call_date, url, tags, outcome, position) values
  ('Amy N Neighbors', '2025-11-25', 'https://fathom.video/share/qFzdWW8pGaYxqDQbJnLji9HRvkurDpxe',
   array['Google Ads','SEO','Web design'], 'Pitched $2.5k to $3k ad spend + $14k branding', 0),
  ('Michael Cash', '2026-10-19', '',
   array['Google Ads'], 'Proposal sent, $1,000/mo management', 1),
  ('Cesar Diaz', '2026-10-13', '',
   array['Google Ads'], 'Proposal sent', 2),
  ('Mike Worden', '2026-09-21', '',
   array['Google Ads','Meta Ads'], 'Proposal sent, $750 Google + $1,500 Meta spend', 3),
  ('Ali Kamel', '2026-09-18', '',
   array['Google Ads'], 'Moved to onboarding', 4),
  ('Kushal Barnwal', '2026-09-07', '',
   array['SEO','AI search'], 'Follow up sent', 5)
on conflict do nothing;

-- The one line description under each call name, which the artifact carried separately.
update public.growth_watch_calls set note = x.note from (values
  ('Amy N Neighbors', 'HR and training consultant. Meta ads wrecked by bots, moved to Google Ads and SEO plus a $14k branding and web project.'),
  ('Michael Cash',    'Garage door installer, $1,000 a month Google Ads budget, burned by past agencies.'),
  ('Cesar Diaz',      'Costa Rica luxury real estate brokerage, high end developer inventory.'),
  ('Mike Worden',     'Youth sports organization, local area, tight margins.'),
  ('Ali Kamel',       'Google Ads restore and scale, $28k a month at 4x ROAS.'),
  ('Kushal Barnwal',  'Wedding and event business in Kolkata, growth from referrals only.')
) as x(title, note)
where public.growth_watch_calls.title = x.title
  and coalesce(public.growth_watch_calls.note, '') = '';
