-- Where the guest opened the booking link from.
--
-- Shown to the host and nothing else. It decides NOTHING -- in particular it does not pick
-- the timezone, which comes from the guest's own device and can now be overridden by hand
-- on the booking page. That separation is deliberate: an IP is the part most likely to be
-- wrong (a VPN, a corporate proxy, a phone on a foreign carrier), so it must not be allowed
-- near the one fact that has to be right, which is when the meeting actually is.
--
-- One jsonb column rather than three text ones: it is a single fact from a single source
-- (Netlify's x-nf-geo header, present on every request to the deployed site), and the shape
-- Netlify sends will grow. Coarse by nature -- country, city, region -- and never more
-- precise than that.
--
-- Null is the normal state for anything booked before this, and for local development,
-- where Netlify injects no geo header at all. Every reader has to treat it as optional.

alter table public.bookings
  add column if not exists guest_geo jsonb;

comment on column public.bookings.guest_geo is
  'Coarse location of the guest when they booked, from Netlify edge geo: '
  '{country, countryCode, city, region, timezone}. Display only -- never used to decide the '
  'meeting time, which comes from the guest device and their own choice on the page. Null '
  'for bookings made before this column, and for anything booked on localhost.';
