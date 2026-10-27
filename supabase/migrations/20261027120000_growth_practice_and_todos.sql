-- Practice calls, and a to-do list on a client.
--
-- TWO THINGS FROM LUKE'S DESIGN THAT HAD NOWHERE TO LIVE.
--
-- 1. PRACTICE. The course teaches and the Q and A answers, but neither makes anybody say
--    the words out loud. The design is a practice CALL: pick what you want to work on,
--    Claude plays a named prospect for three exchanges, then you get a score and what to
--    change. The scoring is only worth having if it is kept -- "start me on my weakest
--    area" is the whole point, and that needs yesterday's runs.
--
--    WHERE EACH HALF LIVES, and why they are not the same place:
--      the scenarios   growth_settings key 'practice'   shared, staff write  (as 'course')
--      a person's runs growth_practice_runs             their own row, they write it
--
--    This is the split 20261022120000 arrived at for the course, for the same reason: a
--    rep finishing a practice call is not editing shared content, it is their own row.
--    Reusing the shape means one rule to understand rather than two.
--
-- 2. TO-DOS ON A CLIENT. "Send the case study" is about one deal and belongs on that
--    deal. growth_tasks is a person's own list and deliberately has no client_id -- it is
--    the training plan -- so putting deal work there would mix two lists that are read at
--    different moments.
--
--    jsonb on the client rather than a child table, the reasoning of 20261022190000: a
--    to-do has no life away from its client, is only ever read with it, and is written by
--    whoever may already write the client. A table would need policies to say exactly
--    that and nothing more, which is a copy of growth_clients' policies waiting to drift.
--
--      [{ "id": "t17...", "text": "Send the case study", "done": false, "done_on": null }]

-- ---------------------------------------------------------------- to-dos on a client

alter table public.growth_clients
  add column if not exists todos jsonb not null default '[]'::jsonb;

comment on column public.growth_clients.todos is
  'Work owed on this deal: [{id, text, done, done_on}]. Not growth_tasks, which is the training plan.';

-- ---------------------------------------------------------------- practice runs

create table if not exists public.growth_practice_runs (
  id        uuid primary key default gen_random_uuid(),
  owner_id  uuid not null references public.profiles(id) on delete cascade,
  area      text not null,                          -- which area of the call
  score     numeric(3,1) not null,                  -- 0.0 to 10.0
  skills    jsonb not null default '[]'::jsonb,     -- [{name, score}]
  went_well jsonb not null default '[]'::jsonb,     -- ["...", "..."]
  to_change jsonb not null default '[]'::jsonb,
  better    text default '',                        -- a stronger way to have said it
  opener    text default '',                        -- the prospect line it started from
  ran_at    timestamptz not null default now()
);
create index if not exists growth_practice_runs_owner_idx
  on public.growth_practice_runs(owner_id, ran_at desc);

alter table public.growth_practice_runs enable row level security;

-- Clients of the agency stay out, restrictively so it ANDs rather than being OR'd away.
-- 20261012130000 is the migration that taught us a permissive policy cannot take access
-- away: two permissive policies OR together, so a "clients can't" rule sitting beside a
-- "staff can" rule lets clients straight through.
drop policy if exists growth_practice_runs_no_clients on public.growth_practice_runs;
create policy growth_practice_runs_no_clients on public.growth_practice_runs
  as restrictive for all to authenticated
  using ((select public.growth_is_client()) = false)
  with check ((select public.growth_is_client()) = false);

-- Staff see everyone's, which is how coaching happens. A rep sees their own.
drop policy if exists growth_practice_runs_read on public.growth_practice_runs;
create policy growth_practice_runs_read on public.growth_practice_runs
  for select to authenticated
  using ((select public.growth_is_staff()) or owner_id = (select auth.uid()));

-- A rep writes only their own row: with check pins owner_id, so filing a run against
-- somebody else is refused even from the console.
drop policy if exists growth_practice_runs_write on public.growth_practice_runs;
create policy growth_practice_runs_write on public.growth_practice_runs
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on public.growth_practice_runs from anon;

-- ---------------------------------------------------------------- the scenarios
-- Four areas, each with three openers. `p` is what the prospect says; `b` is a strong
-- reply, shown only AFTER the call is scored -- showing it first turns practice into
-- reading. Staff edit these on Training the same way they edit a lesson.

insert into public.growth_settings (key, value) values
('practice', jsonb_build_object('areas', jsonb_build_array(

  jsonb_build_object('id','open','t','Opening the call',
    'who','Dana, owner of a busy home services business. Guarded and short on time.',
    'goal','Build trust in the first minute and find out what they want.',
    's', jsonb_build_array(
      jsonb_build_object('p','Hi, I have about ten minutes. What is this call about?',
        'b','Thanks for making the time. Before I say anything, what made you book this, and what would a good outcome look like for you?'),
      jsonb_build_object('p','So you run an agency. What makes you different from the last ten I talked to?',
        'b','That is a fair question. Tell me a bit about your business first, so I can tell you honestly if we are the right fit.'),
      jsonb_build_object('p','Before we start, what do you actually want from this?',
        'b','Good question. I want this call to be useful for you. What is the one thing you need to leave with today?'))),

  jsonb_build_object('id','worry','t','Handling worries',
    'who','Marcus, who is comparing your price with another quote.',
    'goal','Name the worry, answer it calmly, and keep the door open.',
    's', jsonb_build_array(
      jsonb_build_object('p','Your fee is more than another agency quoted me.',
        'b','That makes sense to check. Can I ask what that other quote included? Then we can see what is really different, and what fits your budget.'),
      jsonb_build_object('p','I need to think about it and talk to my partner.',
        'b','Of course, that is a big decision. What would your partner most want to know? I can send you a short summary you can share together.'),
      jsonb_build_object('p','I got burned by an agency last year. Why would you be different?',
        'b','I hear you, and you are right to be careful. Your ad accounts stay in your name, you can leave on 10 days notice, and you can read our reviews first. What went wrong last time?'))),

  jsonb_build_object('id','offer','t','Explaining the offer',
    'who','Priya, a small business owner who wants a plain explanation.',
    'goal','Explain the offer simply and tie it to what they want.',
    's', jsonb_build_array(
      jsonb_build_object('p','What exactly do you do for a business like mine?',
        'b','We help businesses get more customers online, with Google Ads, Meta ads, SEO, AI search, and branding and web development. For a business like yours I would start with the one that brings buyers fastest. Which matters most to you right now?'),
      jsonb_build_object('p','How long before I see anything?',
        'b','We are usually set up in about 7 days after you say yes. Results take a little longer, and most businesses know within the first month or two if it is working.'),
      jsonb_build_object('p','What does the three month minimum mean in plain words?',
        'b','It means we need three months to set things up and test properly. You pay one month at a time, and if it is not right, you can leave with 10 days notice.'))),

  jsonb_build_object('id','yes','t','Asking for the yes',
    'who','Tom, who is interested but not sure what happens next.',
    'goal','Make the next step small, clear and easy to say yes to.',
    's', jsonb_build_array(
      jsonb_build_object('p','Okay, this sounds good. What do I do next?',
        'b','Great. Next I send you a payment link and a short onboarding form. We are set up in about 7 days. Shall I send it now?'),
      jsonb_build_object('p','Send me something and I will take a look.',
        'b','Happy to. I will send the plan and next steps today. Can we book 15 minutes this week so I can answer any questions?'),
      jsonb_build_object('p','I am interested, but I am not ready to pay today.',
        'b','That is fair. What would need to be true for you to feel ready? If it helps, we can start with one channel and build from there.')))
)))
on conflict (key) do nothing;
