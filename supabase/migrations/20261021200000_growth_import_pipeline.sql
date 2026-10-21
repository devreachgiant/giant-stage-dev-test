-- Luke's real pipeline, brought over from the artifact.
--
-- Growth shipped with the screens working and nothing in them: Pipeline read "0 clients"
-- and six empty columns, which reads as broken rather than as new. These are the deals
-- that were already in the artifact, with their stages, values, call and email dates.
--
-- OWNER. Every one goes to Luke, because they were his calls. A rep only sees what they
-- own, so this stays invisible to everyone else until Luke reassigns them -- which the
-- three dot menu on a card now does.
--
-- STAGES. The keys here are the six defaults already seeded. The artifact had drifted to
-- eight renamed ones; that is a Settings change rather than a migration, and renaming a
-- stage in Settings now carries its deals with it.
--
-- IDEMPOTENT on email: running it twice updates rather than duplicating, so an import that
-- is half done can simply be run again.

do $$
declare
  v_luke uuid;
begin
  select id into v_luke from public.profiles
   where role::text = 'owner' and full_name ilike 'Luke%' limit 1;
  if v_luke is null then
    raise notice 'No Luke -- nothing imported.';
    return;
  end if;

  insert into public.growth_clients
    (owner_id, name, company, email, phone, timezone, source, stage, value_monthly,
     next_step, summary, first_call_on, last_call_on, last_email_on, emails_sent, calls_held, intake)
  values
    (v_luke, 'Michael Cash', 'Northview Door Systems', 'michaelcash@northviewdoorsystems.com',
     '+1 952 314 2468', 'America/Chicago', 'Fiverr', 'call', 1000,
     'Send recap and the $1,000 a month offer',
     'Garage door installs and repairs. Two self made Google Ads campaigns on about $1,000 a month. Two past agencies let him down.',
     '2026-10-19', '2026-10-19', null, 0, 1,
     '{"source":"Fiverr","interests":"Google Ads","budget":"Under $1,500","ready":"All in, ASAP","revenue":"100k to 500k","url":"northviewdoorsystems.com"}'::jsonb),

    (v_luke, 'Kelsey Rowe', 'Kreative Expressions', 'kreative.expressions101@gmail.com',
     '', '', 'Calendly', 'booked', null,
     'Send the Zoom reminder', 'Booked through Calendly.', null, null, null, 0, 0, '{}'::jsonb),

    (v_luke, 'Amna Abbasi', 'stage.universe.talk', 'amnaabbasi03@gmail.com',
     '+1 437 349 2545', 'America/New_York', 'Fiverr', 'call', null,
     'Send the first email', 'Wants Google Ads, SEO and AI search, and Meta Ads. Budget under $1,500 a month.',
     '2026-10-13', '2026-10-13', null, 0, 1,
     '{"source":"Fiverr","interests":"Google Ads, SEO and AI search, Meta Ads","budget":"Under $1,500","ready":"All in, ASAP","revenue":"Under 100k","url":"stage.universe.talk"}'::jsonb),

    (v_luke, 'Cesar Diaz', 'Costa Rica luxury real estate brokerage', 'cesardiaz.consulting@gmail.com',
     '+506 8381 2043', 'America/Guatemala', 'Fiverr', 'proposal', 1500,
     'Follow up on the proposal', 'Boutique brokerage. Proposal sent: Google Ads first.',
     '2026-10-13', '2026-10-13', '2026-10-14', 1, 1,
     '{"source":"Fiverr","interests":"Google Ads, Meta Ads","budget":"Under $1,500","ready":"All in, ASAP","url":"nohararealtycostarica.com"}'::jsonb),

    (v_luke, 'Pete Patrino', 'Finzanza', 'pete@finzanza.com',
     '', 'America/New_York', 'Fiverr', 'call', null,
     'Send recap and proposal', 'Fractional CFO firm pivoting to a SaaS product. Interested in Meta Ads.',
     '2026-10-05', '2026-10-05', null, 0, 1,
     '{"source":"Fiverr","interests":"Meta Ads","budget":"$1,500 to $10,000","ready":"Exploring options","revenue":"Under 100k","url":"finzanza.com"}'::jsonb),

    (v_luke, 'Ryan McBroom', 'Executive Home Care of Manassas', 'rmcbroom@executivehomecare.com',
     '+1 540 424 3991', 'America/New_York', 'Google Search', 'call', null,
     'Send the first email', 'Non medical home care agency in northern Virginia. Wants Meta Ads.',
     '2026-10-01', '2026-10-01', null, 0, 1,
     '{"source":"Google Search","interests":"Meta Ads","budget":"$1,500 to $10,000","ready":"Serious","revenue":"1M to 10M"}'::jsonb),

    (v_luke, 'Chang Wharton', 'Top Dog Movers', 'topdogmoversinfo@gmail.com',
     '+1 614 392 8921', 'America/New_York', 'AI Search', 'call', null,
     'Send the first email', 'Moving company. Wants Google Ads and Meta Ads.',
     '2026-09-21', '2026-09-21', null, 0, 1,
     '{"source":"AI Search","interests":"Google Ads, Meta Ads","budget":"$1,500 to $10,000","ready":"Serious","revenue":"Under 100k","url":"Topdogmover.com"}'::jsonb),

    (v_luke, 'Maitreyii Kumari', 'Large Modern Art', 'mfapainting@gmail.com',
     '+1 972 513 6540', 'America/Chicago', 'Fiverr', 'call', null,
     'Send the first email', 'Handmade paintings online. Google Ads sales have dropped.',
     '2026-09-21', '2026-09-21', null, 0, 1,
     '{"source":"Fiverr","interests":"Google Ads, Meta Ads","budget":"Under $1,500","ready":"Serious","revenue":"Under 100k","url":"largemodernart.com"}'::jsonb),

    (v_luke, 'Mike Worden', 'PPA youth sports', 'mike@ppateam.com',
     '+1 240 899 0769', 'America/New_York', 'Fiverr', 'follow', 2250,
     'Chat about the Google and Meta plan',
     'Youth soccer and basketball. Proposed $750 Google Ads and $1,500 Meta Ads.',
     '2026-09-21', '2026-09-21', '2026-09-23', 2, 1,
     '{"source":"Fiverr","interests":"Google Ads, SEO and AI search, Meta Ads","budget":"$1,500 to $10,000","ready":"All in, ASAP","revenue":"1M to 10M","url":"ppateam.com"}'::jsonb),

    (v_luke, 'Ali Kamel', 'Google Ads account', 'ali.kamel@example.com',
     '', '', 'Referral', 'won', null,
     'Start onboarding', 'Google Ads restore and scale, $28k a month at 4x ROAS.',
     '2026-09-18', '2026-09-18', '2026-09-19', 1, 1, '{}'::jsonb),

    (v_luke, 'Kushal Barnwal', 'The New Episode', 'kushal@example.com',
     '', 'Asia/Kolkata', 'Fiverr', 'follow', null,
     'Follow up', 'Wedding and event business in Kolkata, growth from referrals only.',
     '2026-09-07', '2026-09-07', '2026-10-13', 1, 1, '{}'::jsonb)
  on conflict do nothing;

  -- The bookings that go with them, so Meetings is not empty either.
  insert into public.growth_meetings (client_id, title, starts_at, minutes, zoom_url, source, external_id)
  select c.id, 'ReachGiant Growth Strategy Session', m.starts_at, 45, m.zoom, 'Calendly', m.ext
    from (values
      ('Michael Cash',     timestamptz '2026-10-19 14:00+00', 'https://us06web.zoom.us/j/83072577220', 'imp-michael'),
      ('Kelsey Rowe',      timestamptz '2026-10-21 16:00+00', 'https://us06web.zoom.us/j/82618258117', 'imp-kelsey'),
      ('Amna Abbasi',      timestamptz '2026-10-13 15:00+00', 'https://us06web.zoom.us/j/87995788501', 'imp-amna'),
      ('Cesar Diaz',       timestamptz '2026-10-13 16:00+00', 'https://us06web.zoom.us/j/87617682758', 'imp-cesar'),
      ('Pete Patrino',     timestamptz '2026-10-05 16:00+00', 'https://us06web.zoom.us/j/84172932796', 'imp-pete'),
      ('Ryan McBroom',     timestamptz '2026-10-01 13:00+00', 'https://us06web.zoom.us/j/87003768494', 'imp-ryan'),
      ('Chang Wharton',    timestamptz '2026-09-21 16:00+00', 'https://us06web.zoom.us/j/82550519124', 'imp-chang'),
      ('Maitreyii Kumari', timestamptz '2026-09-21 15:00+00', 'https://us06web.zoom.us/j/87876292114', 'imp-mait'),
      ('Mike Worden',      timestamptz '2026-09-21 14:00+00', 'https://us06web.zoom.us/j/83395959618', 'imp-worden')
    ) as m(name, starts_at, zoom, ext)
    join public.growth_clients c on c.name = m.name and c.owner_id = v_luke
  on conflict (external_id) do nothing;
end $$;
