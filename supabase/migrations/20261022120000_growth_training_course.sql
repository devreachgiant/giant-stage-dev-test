-- Training, rebuilt as the sales course Luke actually teaches.
--
-- The Training screen had a personal task list, a philosophy page and a call script.
-- Useful, but none of it was a COURSE: there was no order, no "you are 3 of 7 through
-- this", and no way for Luke to see who had done what. The design he has been working
-- from is seven short lessons with progress per person, plus the reference material the
-- lessons point at. This brings the content in.
--
-- WHO MAY CHANGE WHAT. This is the whole point of the migration, so it is enforced here
-- rather than only in the page:
--
--   owner / manager / inhouse_dev   write the lessons, the answers, the Q&A, the calls
--   member (a sales rep)            reads all of it, and marks their OWN lessons done
--   client                          nothing, as everywhere else in Growth
--
-- growth_settings already does the first two lines: read to everyone, write to staff
-- (20261021120000). So the lesson content, the clear answers and the Q&A go in there and
-- inherit the rule. What was missing is somewhere a REP can write, because a rep marking
-- their own lesson done is not an edit of shared content -- it is their own row.
-- growth_course_done is that table, and it is the only new one.

-- ---------------------------------------------------------------- per rep progress

create table if not exists public.growth_course_done (
  id        uuid primary key default gen_random_uuid(),
  owner_id  uuid not null references public.profiles(id) on delete cascade,
  lesson_id text not null,
  done_on   date not null default current_date,
  unique (owner_id, lesson_id)
);
create index if not exists growth_course_done_owner_idx on public.growth_course_done(owner_id);

alter table public.growth_course_done enable row level security;

-- Clients of the agency stay out, restrictively so it ANDs rather than being OR'd away.
-- 20261012130000 is the migration that taught us a permissive policy cannot take access
-- away: two permissive policies OR together, so a "clients can't" rule sitting next to a
-- "staff can" rule let clients straight through.
drop policy if exists growth_course_done_no_clients on public.growth_course_done;
create policy growth_course_done_no_clients on public.growth_course_done
  as restrictive for all to authenticated
  using ((select public.growth_is_client()) = false)
  with check ((select public.growth_is_client()) = false);

-- Staff see everyone's progress, which is the point of running a course. A rep writes
-- only their own row: with check pins owner_id to them, so "mark Luke's lesson done"
-- is refused even from the console.
drop policy if exists growth_course_done_read on public.growth_course_done;
create policy growth_course_done_read on public.growth_course_done
  for select to authenticated
  using ((select public.growth_is_staff()) or owner_id = (select auth.uid()));

drop policy if exists growth_course_done_write on public.growth_course_done;
create policy growth_course_done_write on public.growth_course_done
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on public.growth_course_done from anon;

-- ---------------------------------------------------------------- the course
-- Lessons are stored as blocks rather than as HTML, so Settings can edit them without
-- anybody pasting markup into a database and without the page trusting what comes back.
--   p  = a paragraph        h  = a small heading
--   ul = a bullet list      b  = a bolded point with a line under it

insert into public.growth_settings (key, value) values
('course', jsonb_build_object('lessons', jsonb_build_array(

  jsonb_build_object('id','open','t','Open relaxed and curious',
    'g','Be like water. Listen first and let them talk.','min',6,
    'blocks', jsonb_build_array(
      jsonb_build_object('k','p','t','Be yourself. Be like water: adapt to the conversation instead of forcing a script. Take your time, listen, and let the conversation breathe. The aim is to understand their business, their needs, and what matters to them.'),
      jsonb_build_object('k','h','t','Questions to explore'),
      jsonb_build_object('k','ul','items', jsonb_build_array(
        'Could you walk me through your website and what you offer?',
        'Who are your main customers?',
        'How is your team set up?',
        'What are you doing for marketing at the moment?',
        'What is working, and what would you like to improve?',
        'What made you look for help now?',
        'What would a successful outcome look like for you?')),
      jsonb_build_object('k','p','t','Follow interesting answers with: Tell me more about that.')),
    'do','Ask one question at a time. After every answer say: Tell me more about that.',
    'go', jsonb_build_array()),

  jsonb_build_object('id','why','t','Understand why people buy',
    'g','This is the key to selling.','min',5,
    'blocks', jsonb_build_array(
      jsonb_build_object('k','b','h','They want to trust you, but their survival brain is on alert','t','Be calm, confident and honest. Do not oversell. Trust is earned by how you show up, not what you say.'),
      jsonb_build_object('k','b','h','They want to feel heard and understood','t','Ask thoughtful questions and really listen. Echo their words. Validate their concerns. Make them feel seen and respected.'),
      jsonb_build_object('k','b','h','They want someone who can lead','t','Guide the conversation with clarity and confidence. Have a plan, and help them feel they are in good hands.'),
      jsonb_build_object('k','b','h','They want someone real','t','Do not try too hard. Be human. People buy from people, not perfect pitches.'),
      jsonb_build_object('k','b','h','They want to say yes, they are just checking it feels right','t','Remove doubt by being transparent, helpful and easy to talk with. Confidence is built through calm clarity, real connection and leading with honesty.'),
      jsonb_build_object('k','b','h','They want to know we are a smart and thoughtful company','t','Share quick, relevant examples. Speak with authority and answer their questions.')),
    'do','On your next call, learn what they want before you say a word about what you sell.',
    'go', jsonb_build_array(jsonb_build_array('See the principles','phil'))),

  jsonb_build_object('id','clear','t','Have clear answers ready',
    'g','Short, natural answers to the questions everyone asks.','min',8,
    'blocks', jsonb_build_array(
      jsonb_build_object('k','p','t','Know these well enough to say them without sounding rehearsed.'),
      jsonb_build_object('k','ul','items', jsonb_build_array(
        'What does ReachGiant do?','What services do you offer?','Why should I choose you?',
        'How do you communicate?','How much does it cost?','How long does it take?',
        'How do I move forward?','Is there a long contract?','Can you guarantee results?',
        'Who will actually work on my account?'))),
    'do','Say How do I move forward? out loud, three times.',
    'go', jsonb_build_array(jsonb_build_array('Open Clear answers','clear'))),

  jsonb_build_object('id','voice','t','Delivery and vocabulary',
    'g','Sound calm, clear and confident.','min',5,
    'blocks', jsonb_build_array(
      jsonb_build_object('k','h','t','Delivery'),
      jsonb_build_object('k','ul','items', jsonb_build_array(
        'Replace um with a short pause.',
        'Ask one question at a time.',
        'Let the prospect finish before responding.',
        'Stay flexible rather than following a rigid sequence.',
        'Summarise what you heard: So your main priority is this, and the biggest obstacle is that. Have I understood it correctly?')),
      jsonb_build_object('k','h','t','Words that help'),
      jsonb_build_object('k','ul','items', jsonb_build_array(
        'Elucidate: make something clear. Let me elucidate how that would work.',
        'Minutiae: small details. Before we get into the minutiae, let us agree on the main goal.',
        'Synthesize: combine information into a clear understanding. Let me synthesize what you have shared.',
        'Synthesis: the resulting combined understanding. Here is my synthesis of what you need.')),
      jsonb_build_object('k','p','t','Use a few useful words when they fit. Clarity comes first. Use familiar language whenever it feels more natural.')),
    'do','On your next call, swap every um for a short pause.',
    'go', jsonb_build_array()),

  jsonb_build_object('id','offer','t','Know the offer',
    'g','Prices, the three month minimum and the 10 day exit.','min',5,
    'blocks', jsonb_build_array(
      jsonb_build_object('k','p','t','Learn the packages and what each one includes, then say the same plain line every time.'),
      jsonb_build_object('k','ul','items', jsonb_build_array(
        'Three month minimum, billed one month at a time',
        '10 day exit, and the client owns every account',
        'Ad spend is on top and paid straight to Google or Meta',
        'Never promise results. Promise daily work and honesty.'))),
    'do','Say the price, what is included, and the exit in one breath.',
    'go', jsonb_build_array(jsonb_build_array('Open Pricing','pricing'))),

  jsonb_build_object('id','close','t','Handle worries and ask for the yes',
    'g','Name the worry, answer it, then make the next step small.','min',8,
    'blocks', jsonb_build_array(
      jsonb_build_object('k','b','h','1. Open','t','Warm hello. Say how long you have. Ask what made them book.'),
      jsonb_build_object('k','b','h','2. Listen','t','Ask about the business, what they run now, and what has gone wrong. Let them talk. Repeat their words back.'),
      jsonb_build_object('k','b','h','3. Find the worry','t','Budget, long contracts, past agencies, downtime. Name it out loud so it feels safe.'),
      jsonb_build_object('k','b','h','4. Offer','t','Say the plan in plain words: what we do, what it costs, the 3 month minimum and 10 day exit.'),
      jsonb_build_object('k','b','h','5. Email in 10 minutes','t','Send the recap and offer while the call is fresh. Ask for a clear yes.')),
    'do','Send the recap and offer within ten minutes of the call.',
    'go', jsonb_build_array(jsonb_build_array('See the questions','qa'), jsonb_build_array('Call script','script'))),

  jsonb_build_object('id','review','t','Review every call',
    'g','Turn each call into a lesson.','min',5,
    'blocks', jsonb_build_array(
      jsonb_build_object('k','p','t','Just understand what you did right and what you did wrong.'),
      jsonb_build_object('k','ul','items', jsonb_build_array(
        'What questions did the prospect ask?',
        'Which questions come up again and again?',
        'Where did I hesitate or give an unclear answer?',
        'Did I explore their answer or move on too quickly?',
        'Did I understand their main need before offering a solution?',
        'Was the next step clear?'))),
    'do','After your next call, answer two questions: what went right, and what went wrong?',
    'go', jsonb_build_array())
))),

-- ---------------------------------------------------------------- the clear answers

('clear', jsonb_build_object('items', jsonb_build_array(
  jsonb_build_object('id','what','theme','Services and fit','q','What does ReachGiant do?',
    'a','ReachGiant helps customers find you and choose you. We run Google Ads, Facebook and Instagram ads, and SEO. We also do AI search, so you show up when people ask ChatGPT or Perplexity. And we build your brand and your website, so people land on you, trust you, and buy.'),
  jsonb_build_object('id','services','theme','Services and fit','q','What services do you offer?',
    'a','Google Ads, Meta ads, SEO, AI search, branding, and web development. Most people start with one thing that fits, then add more once it is working.'),
  jsonb_build_object('id','choose','theme','Proof and experience','q','Why should I choose you?',
    'a','We are an incredible team, and we do excellent work. Our reputation speaks for itself.'),
  jsonb_build_object('id','talk','theme','How it works','q','How do you communicate?',
    'a','We cater to you. We communicate over email, Zoom, and Loom videos, and whatever you need, we do. Communication is our biggest strength.'),
  jsonb_build_object('id','cost','theme','Pricing and budget','q','How much does it cost?',
    'a','Everything is on our pricing page at reachgiant.com/pricing. Take a look, and I can walk you through what fits your goals.'),
  jsonb_build_object('id','long','theme','Results and timeline','q','How long does it take?',
    'a','Setup takes about 7 days. Once you say yes, we get everything ready in that time, and you see the full plan before anything goes live.'),
  jsonb_build_object('id','forward','theme','How it works','q','How do I move forward?',
    'a','It is three simple steps. First, I send you a payment link. Second, you fill in a short onboarding form, about 15 minutes. Third, Matthew calls you and we get started. You can start with one channel and add more later.'),
  jsonb_build_object('id','contract','theme','Contracts and commitment','q','Is there a long contract?',
    'a','No. It is a three month minimum, billed one month at a time. If it is not right for you, you can leave with 10 days notice. The ad accounts stay in your name the whole time.'),
  jsonb_build_object('id','guarantee','theme','Results and timeline','q','Can you guarantee results?',
    'a','No, and I will not promise a number, because anyone who does is guessing. What I can promise is daily work and full honesty. If something is not working after about two weeks, I will tell you straight and change the plan.'),
  jsonb_build_object('id','team','theme','Who does the work','q','Who will actually work on my account?',
    'a','You get a team. Matthew Overbay leads it. Behind him are Google and Meta specialists, a designer for the ads, and a developer who sets up the tracking, so the work is never on one person.')
))),

-- ---------------------------------------------------------------- questions people ask
-- Seeded from the worries that actually came up on calls. Staff add to it as more land.

('qa', jsonb_build_object('items', jsonb_build_array(
  jsonb_build_object('id','q-budget','theme','Pricing and budget','q','Is it worth it at my budget?',
    'feel','They are afraid of spending money and getting nothing back.',
    'better','Start small, fix the tracking first, and only grow when it works. A small team gives a small account real attention.',
    'why','Answer the fear, not the number. Smallness is the reason it works, not an apology.',
    'tricks', jsonb_build_array('Name the fear out loud','Make the first step small')),
  jsonb_build_object('id','q-lock','theme','Contracts and commitment','q','I do not want a long contract.',
    'feel','They have been trapped before and want a way out.',
    'better','No annual lock in. Three month minimum, billed monthly, and a 10 day exit. Every account stays in your name.',
    'why','Say the exit before they ask for it. It costs nothing and buys the whole conversation.',
    'tricks', jsonb_build_array('Offer the exit first','Ownership stays with them')),
  jsonb_build_object('id','q-burned','theme','Proof and experience','q','Past agencies let me down.',
    'feel','They expect to be sold to and then ignored.',
    'better','Small client roster, daily work, and a team that answers. I will show you the plan before I ask for a yes.',
    'why','Do not argue with the last agency. Show the plan instead, because that is the thing they never got.',
    'tricks', jsonb_build_array('Plan before the ask','Name the roster size')),
  jsonb_build_object('id','q-paused','theme','Services and fit','q','Google keeps pausing my ads.',
    'feel','They think the problem is unfixable and nobody will own it.',
    'better','We help with verification and policy flags, and we watch the account daily, so downtime stays short.',
    'why','Say who watches it and how often. Vague reassurance sounds like every other agency.',
    'tricks', jsonb_build_array('Say the frequency','Own the boring part')),
  jsonb_build_object('id','q-guarantee','theme','Results and timeline','q','Can you guarantee results?',
    'feel','They are testing whether you will say anything to close them.',
    'better','No, and I will not promise a number, because anyone who does is guessing. I promise daily work and full honesty. If it is not working after two weeks, I tell you straight and change the plan.',
    'why','Refusing to guarantee is the most persuasive thing you can say here.',
    'tricks', jsonb_build_array('Refuse the promise','Give a review date')),
  jsonb_build_object('id','q-who','theme','Who does the work','q','Who will actually work on my account?',
    'feel','They are worried they will be handed to a junior after the call.',
    'better','Matthew Overbay leads your team. Behind him are Google and Meta specialists, a designer, and a developer for the tracking. The work is never on one person.',
    'why','Name a real person. A name is worth more than the word team.',
    'tricks', jsonb_build_array('Name the lead','List the bench'))
)))

on conflict (key) do nothing;
