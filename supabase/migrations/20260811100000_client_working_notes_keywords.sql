-- Add Working Notes (free text) and Keywords & Needs (tags) to clients,
-- for the Chat 2.0 Client Hub Overview tab (Workspace Clients reference-design parity).
alter table public.clients
  add column if not exists working_notes text null,
  add column if not exists keywords text[] null;
