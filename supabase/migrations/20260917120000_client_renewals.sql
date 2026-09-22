-- Knowing when a client is next charged, and whether we actually turned it off.
--
-- Matthew's ask, 2026-09-16: "tracking of the payment renewal dates for all of our clients,
-- so we can immediately flag if someone's recurring stripe payment didn't go through" --
-- and, the sharper half, "this has been an issue recently where a client has canceled and
-- they still have been charged."
--
-- Those are two different failures. A payment that fails costs a chase. A payment that
-- succeeds after the client has left costs a refund and an apology, and it is the one that
-- has actually happened. Both need the same missing fact: WHEN IS THIS CLIENT NEXT CHARGED,
-- and is that before or after the day their work with us ends.
--
-- Stripe cannot answer that here yet. STRIPE_WEBHOOK_SECRET is unset, so the webhook fails
-- closed and records nothing; no client carries a stripe_customer_id and there is not one
-- invoice row in the database. So these are fields a person fills in, and they are worth
-- having on their own: the failure being described is not Stripe going wrong, it is nobody
-- knowing a subscription was still live. A date somebody typed answers that.
--
-- They are also the shape Stripe would fill in later: next_charge_on is
-- subscription.current_period_end, and ends_on is cancel_at. When the integration comes
-- back, this becomes a sync rather than a rewrite.

-- The last day we are working with this client. Null means no end is planned.
alter table public.clients add column if not exists ends_on date;

-- The next recurring charge. A real date, not a day-of-month: pay_day cannot say WHICH
-- month, and "the 2nd" is exactly the ambiguity that lets a charge land after the last day.
alter table public.clients add column if not exists next_charge_on date;

-- "It would be great to know for sure that we have turned off their Stripe payment."
-- A tick with a name and a time against it, rather than someone's memory of a conversation.
alter table public.clients add column if not exists billing_off_at timestamptz;
alter table public.clients add column if not exists billing_off_by uuid references public.profiles(id) on delete set null;

-- What the board sorts and warns on, so the scan is an index and not 51 rows every render.
create index if not exists idx_clients_next_charge on public.clients (next_charge_on)
  where next_charge_on is not null;
create index if not exists idx_clients_ends_on on public.clients (ends_on)
  where ends_on is not null;

-- No new policies: clients already has clients_select_team / clients_select_own for reading
-- and clients_update_mgr for writing, and these columns inherit all three. A client account
-- can read its own row, which now includes the date it is next charged -- that is a fact
-- about them and one they are entitled to.
