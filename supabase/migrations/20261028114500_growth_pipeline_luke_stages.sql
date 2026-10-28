-- Growth Pipeline: Luke's stages, from his board.
--
-- "Booked" becomes "Upcoming meetings", "Asked to Book Another Meeting" is new, and the
-- colours come from his own swatch row (PL_SWATCH), not from reading a screenshot.
--
-- TWO STAGES GO. Deals move FIRST, then the stage is dropped -- the other order strands
-- a deal in a column that no longer exists, which is how a deal disappears off a board
-- while still sitting in the table.
--
--   following up -> proposal sent   (2 deals; Luke's own board merges these two)
--   lost         -> nothing to move (0 deals today)
--
-- Lost is removed on Nishchay's call, to match Luke exactly. Worth knowing: a deal that
-- dies now has nowhere to go but deletion, and the reason goes with it.

update growth_clients set stage = 'proposal' where stage = 'follow';

update growth_settings set value = jsonb_set(value, '{stages}', $json$[
  {"key":"booked",   "label":"Upcoming meetings",           "color":"#6D5BD0"},
  {"key":"call",     "label":"Call done",                   "color":"#2B7BB9"},
  {"key":"asked",    "label":"Asked to Book Another Meeting","color":"#D9467A"},
  {"key":"proposal", "label":"Proposal sent",               "color":"#E08A1E"},
  {"key":"won",      "label":"Won",                         "color":"#1F9D63"}
]$json$::jsonb), updated_at = now()
where key = 'pipeline';
