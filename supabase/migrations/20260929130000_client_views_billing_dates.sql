-- The Clients list shows when a client next pays, and the view members read did not carry
-- the column -- so the query 400s for anyone below manager.
--
-- clients_manager already has contact_name, next_charge_on and ends_on; it was only ever
-- clients_public that was short. So this appends two columns there and nothing else.
--
-- next_charge_on and ends_on, and NOT contact_name or mrr_cents. That is the line these two
-- views exist to draw: when a client pays is operational and helps anybody planning work
-- around a renewal; who is on the card is contact information, which is the manager tier;
-- what they are worth is owner-only. A specialist gains the date and learns nothing about
-- the money or the person.
--
-- create or replace view can only APPEND columns -- dropping or reordering is rejected with
-- "cannot drop columns from view" -- so the existing twenty are restated in their exact
-- original order and the two new ones go on the end.
--
-- Safe to widen now in a way it was not this morning: 20260929120000 gave these views
-- security_invoker, so they are evaluated as the caller. Before that, a column added here
-- was a column handed to anonymous visitors, which is how the leak that migration closed
-- came about in the first place.

create or replace view public.clients_public as
  select id, name, slug, initial, avatar_bg, avatar_fg, status, owner_id, started_at, notes,
         created_at, updated_at, company_website, industry, address, timezone, logo_url,
         services, custom_fields, onboarding_submitted_at,
         next_charge_on, ends_on
    from public.clients;

-- create or replace resets these, so they are restated rather than assumed. Without
-- security_invoker the view goes straight back to bypassing row level security.
alter view public.clients_public set (security_invoker = true);
revoke all on public.clients_public from anon;
revoke insert, update, delete, truncate on public.clients_public from authenticated;
grant select on public.clients_public to authenticated;
