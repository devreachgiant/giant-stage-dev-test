-- Managers read clients through a view, and the renewal dates were not in it.
--
-- The Clients module serves an owner from public.clients and everybody else from
-- clients_manager or clients_public. So adding ends_on and next_charge_on to the table put
-- them in front of owners only -- and a manager is precisely who chases a renewal and
-- turns a subscription off. The feature would have looked broken for the people it is for.
--
-- Dates, and only dates. mrr_cents is deliberately still absent from this view: what a
-- client pays is owner-only, and that stays true. When a client is next charged, and when
-- their work with us ends, are operational facts a manager has to act on.
--
-- clients_public is left alone. It backs the lowest-privilege path, and nothing there needs
-- to know a billing date.

create or replace view public.clients_manager as
 SELECT id,
    name,
    slug,
    initial,
    avatar_bg,
    avatar_fg,
    status,
    owner_id,
    started_at,
    notes,
    created_at,
    updated_at,
    company_website,
    industry,
    address,
    timezone,
    logo_url,
    services,
    custom_fields,
    onboarding_submitted_at,
    onboarding_sent_at,
    contact_name,
    contact_email,
    contact_phone,
    phone,
    email,
    -- new: the two dates the Renewals board is built on, plus who confirmed the billing off
    ends_on,
    next_charge_on,
    billing_off_at,
    billing_off_by
   FROM clients;
