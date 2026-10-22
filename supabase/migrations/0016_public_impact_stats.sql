-- ---------------------------------------------------------------------------
-- 0016_public_impact_stats.sql
--
-- The home page's impact counters were structurally broken for two of the six
-- figures: the public (anon) client cannot read `members` or
-- `blood_help_requests` at all -- Row Level Security keeps both tables
-- admin-only because they hold personal data. So "Registered Members" and
-- "Blood Assistance" always rendered 0, no matter what was recorded.
--
-- This aggregate returns only the six numbers the home page shows. It runs as
-- security definer, so it sees past RLS, but no personal row ever escapes:
-- the caller receives six integers and nothing else.
-- ---------------------------------------------------------------------------

create or replace function public.trust_impact_stats()
returns table (
  registered_members bigint,
  events_conducted bigint,
  upcoming_events bigint,
  blood_assistance bigint,
  community_stories bigint,
  service_categories bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.members where status <> 'disabled'),
    (select count(*) from public.events where is_published),
    (select count(*) from public.events where is_published and event_date >= current_date),
    (select count(*) from public.blood_help_requests),
    (select count(*) from public.blogs where status = 'approved'),
    (select count(*) from public.event_categories where is_active);
$$;

revoke all on function public.trust_impact_stats() from public;
grant execute on function public.trust_impact_stats() to anon, authenticated;
