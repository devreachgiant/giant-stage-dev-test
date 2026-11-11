-- Adding people to a group DM.
--
-- Until now channel_members could only be written by the person themselves
-- (profile_id = auth.uid(), which is how Leave works) or by owner/manager/
-- inhouse_dev/admin. A group DM therefore had no way to gain a member after it was
-- created: the "Invite people" item in the sidebar menu opened a form, and the insert
-- behind it would have been refused for everybody else in the company.
--
-- A group conversation is not an administered space. The people in it are the ones who
-- know who else belongs in it, so membership is what grants the right to add, the same
-- way it already grants the right to read. Scoped tightly:
--
--   is_dm, and a group  -- a one-to-one has no third seat, and a CHANNEL is still a
--                          manager's call; this policy does not touch either
--   and I am in it      -- an outsider cannot add anybody, nor add themselves
--
-- "A group" is is_group OR more than two members, which is the same test the sidebar
-- already applies when it decides which card a conversation belongs under. Keying the
-- policy on is_group alone would be correct against today's data and would still be the
-- wrong shape: the moment a conversation carried three people and an unset flag, the
-- menu would offer the add and the database would refuse it, which arrives as a toast
-- saying "could not add" and no way to tell why. A one-to-one has exactly two members,
-- so the second clause cannot open one.
--
-- Dry-run on production, each inside a rolled-back transaction, as the authenticated
-- role with request.jwt.claims set:
--
--   without it, a member adds to their own group            -> 42501 refused
--   with it,    a member adds to their own group            -> 1 row
--   with it,    a NON-member adds to that group             -> 42501 refused
--   with it,    a member adds a 3rd person to a 1:1 DM      -> 42501 refused
--   with it,    a non-member adds to a private CHANNEL of 3 -> 42501 refused
--   with it,    a MEMBER of that channel adds somebody      -> 42501 refused
--
-- The first line is the one that matters: it proves this policy is what allows the add
-- rather than an existing policy having allowed it all along. The last two are the
-- count-of-members clause being kept out of channels, which it would otherwise reach.
--
-- One of these was first written as an INSERT ... SELECT over "a private channel I am
-- not in", and came back 0 rows -- which looked like a refusal and was not one. As that
-- caller, channels_select hides the channel, so the SELECT found nothing and there was
-- no insert for the policy to judge. Rewritten against a channel id read as a privileged
-- role, it refuses for the reason it is supposed to.
--
-- Production today: 99 DM channels, 70 one-to-one (is_group false, <=2 members) and 29
-- groups (is_group true, >=3 members). The two clauses agree on every one of them, so
-- nothing is left behind and nothing new is opened.
--
-- Removing somebody is deliberately NOT opened up. channel_members_delete_self_or_mgr
-- still limits a member to deleting their own row, which is Leave. Taking another person
-- out of a conversation stays with the roles that administer the workspace.

create policy "channel_members_group_dm_invite"
  on public.channel_members
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.channels c
       where c.id = channel_members.channel_id
         and c.is_dm is true
         and (
           c.is_group is true
           or (select count(*) from public.channel_members n where n.channel_id = c.id) > 2
         )
         and exists (
           select 1
             from public.channel_members mine
            where mine.channel_id = c.id
              and mine.profile_id = auth.uid()
         )
    )
  );
