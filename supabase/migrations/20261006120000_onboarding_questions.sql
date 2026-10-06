-- The onboarding form's questions become data, so the form can be changed without a deploy.
--
-- Luke's ask is that this replaces the Asana form. An Asana form is editable by whoever owns
-- it; this one had twenty-one questions written into index.html, so changing a word meant a
-- developer, a branch and a release. That is the whole gap.
--
-- Seeded with exactly the questions the form asks today, in the order it asks them. Day one
-- looks identical -- that is the point. Nothing about an existing client's answers changes,
-- because answers are keyed by `name` and every name here is the one already in use.
--
-- `name` is unique and is the key into clients.onboarding_answers. Renaming one would orphan
-- every answer already given under the old key, so the editor does not offer it: you add a
-- question or you remove one.
--
-- anon can SELECT. The form is public by design -- it is opened from an emailed link with no
-- session -- and the questions are what that page displays anyway. Writes are manager-level,
-- the same floor as the rest of the app's structural changes.

create table if not exists public.onboarding_questions (
  id          uuid primary key default gen_random_uuid(),
  section     text not null,
  label       text not null,
  name        text not null unique,
  type        text not null default 'text'
              check (type in ('text','textarea','email','tel','select','checkbox')),
  options     jsonb not null default '[]'::jsonb,
  helper      text,
  required    boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists idx_onboarding_questions_position
  on public.onboarding_questions (position);

alter table public.onboarding_questions enable row level security;

drop policy if exists onboarding_questions_read on public.onboarding_questions;
create policy onboarding_questions_read on public.onboarding_questions
  for select to anon, authenticated using (true);

drop policy if exists onboarding_questions_write on public.onboarding_questions;
create policy onboarding_questions_write on public.onboarding_questions
  for all to authenticated
  using (public.is_manager_or_owner())
  with check (public.is_manager_or_owner());

-- The form as it stands today, so the editor opens on what people already see.
insert into public.onboarding_questions (section, label, name, type, options, helper, required, position)
values
  ('Company Overview','Business Name','business_name','text','[]',null,true,10),
  ('Company Overview','Business Website URL','website_url','text','[]','Please share ''Admin'' access with Support@ReachGiant.com.',false,20),
  ('Company Overview','Business Address','address','text','[]',null,false,30),
  ('Company Overview','Employer Identification Number (EIN)','ein','text','[]',null,false,40),

  ('Primary Contact','Name','contact_name','text','[]',null,true,50),
  ('Primary Contact','Email','contact_email','email','[]',null,true,60),
  ('Primary Contact','Phone Number','phone','tel','[]',null,true,70),

  ('Access Required','Google Ads 10-digit ID','google_ads_id','text','[]','We will request access — no need to share login.',false,80),
  ('Access Required','Facebook Page or Business Manager link','meta_page','text','[]','If you don''t know, we will get you connected on a Zoom call.',false,90),
  ('Access Required','Meta Ad Account ID (if available)','meta_ad_account','text','[]',null,false,100),
  ('Access Required','Website platform','website_platform','select',
     '["WordPress","Webflow","Shopify","Wix","Squarespace","Custom build","Other / not sure"]',null,false,110),

  ('Campaign Details','Customer Challenges and Solutions','challenges_solutions','textarea','[]',
     'Describe the challenges your customers face and how your business addresses & resolves them.',false,120),
  ('Campaign Details','Monthly Ad Budget Range','budget','select',
     '["Under $1,500","$1,500 – $3,000","$3,000 – $5,000","$5,000 – $10,000","$10,000 – $25,000","$25,000+"]',
     'Total monthly ad budget across all platforms.',false,130),
  ('Campaign Details','What products or services do you offer?','products_services','textarea','[]',null,false,140),
  ('Campaign Details','Who is your ideal customer?','ideal_customer','textarea','[]',null,false,150),
  ('Campaign Details','Target locations','target_locations','text','[]',null,false,160),
  ('Campaign Details','Primary Goal for Leads — where should leads go, or what action should they take?','primary_goals','checkbox',
     '["Phone Calls","Form Submissions","Purchases","Bookings or Appointments","Email Enquiries","Automated Meeting Booking","Email List Signups","Other"]',
     null,true,170),
  ('Campaign Details','Where should leads be sent?','leads_destination','textarea','[]',
     'Lead email address, lead phone number, CRM login or invite email, booking/calendar link, any other notes.',false,180),
  ('Campaign Details','Advertising Schedule Preferences','ad_schedule','textarea','[]',
     'Any specific times & days that you may or may not want to run ads on.',false,190),
  ('Campaign Details','Anything we should avoid or be aware of?','avoid_notes','textarea','[]',null,false,200),
  ('Campaign Details','Additional Information','additional_info','textarea','[]',
     'Any other details that could improve campaign effectiveness.',false,210)
on conflict (name) do nothing;
