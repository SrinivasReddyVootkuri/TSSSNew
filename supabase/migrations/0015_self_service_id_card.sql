-- ---------------------------------------------------------------------------
-- 0015_self_service_id_card.sql
--
-- Members can download their own ID card from the photo booth page by giving
-- their registration number and full name. Both must match an APPROVED
-- (active) member: the name is compared with the database's own name
-- normalisation, so case and punctuation differences do not block the real
-- member while making guessing harder.
--
-- The rate limit lives inside the function, so it is durable across
-- serverless instances. Failure codes are deliberately coarse: a wrong name
-- and an unknown number return the same code, so probing numbers reveals
-- nothing about who is registered.
--
-- Along the way this fixes normalize_name itself: it replaced punctuation
-- with spaces but never collapsed the result, so "Srinivas! Paka" stored
-- "srinivas!  paka" quirks like doubled spaces and a trailing space that made
-- duplicate detection and this lookup miss obvious matches. Existing rows are
-- re-normalised with the corrected function.
-- ---------------------------------------------------------------------------

create or replace function public.normalize_name(input text)
returns text language sql immutable as $$
  -- Replace each ASCII punctuation character with a space, then lower and
  -- collapse the whitespace. translate() is per-character, so non-ASCII
  -- letters (Telugu and other scripts) pass through untouched.
  select regexp_replace(
           trim(
             lower(
               translate(
                 trim(coalesce(input, '')),
                 '!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~',
                 repeat(' ', 32)
               )
             )
           ),
           '\s+',
           ' ',
           'g'
         );
$$;

-- normalized_full_name is GENERATED ALWAYS from full_name, so existing rows
-- are re-normalised by touching the source column, which re-evaluates the
-- generated expression with the corrected function.
update public.members set full_name = full_name;

create or replace function public.lookup_member_id_card(
  p_registration_number text,
  p_full_name text,
  p_rate_key text default null
)
returns table (
  result_code text,
  registration_number text,
  full_name text,
  father_name text,
  designation text,
  date_of_birth date,
  age integer,
  gender public.gender_t,
  blood_group public.blood_group_t,
  mobile_number text,
  phone_country_code text,
  village text,
  district_id uuid,
  district_name text,
  state_code text,
  country_code char(2),
  profile_photo_url text
)
language plpgsql security definer set search_path = public as $$
declare
  v_number text := upper(trim(coalesce(p_registration_number, '')));
  v_name text := public.normalize_name(coalesce(p_full_name, ''));
begin
  if p_rate_key is not null and not public.rate_limit_hit('idcard:' || p_rate_key, 10, 3600) then
    return query select 'rate_limited',
      null::text, null::text, null::text, null::text, null::date, null::integer,
      null::public.gender_t, null::public.blood_group_t, null::text, null::text,
      null::text, null::uuid, null::text, null::text, null::char(2), null::text;
    return;
  end if;

  if v_number !~ '^TSSS[0-9]{6}$' or v_name = '' then
    return query select 'not_found',
      null::text, null::text, null::text, null::text, null::date, null::integer,
      null::public.gender_t, null::public.blood_group_t, null::text, null::text,
      null::text, null::uuid, null::text, null::text, null::char(2), null::text;
    return;
  end if;

  return query
    select 'found'::text,
           m.registration_number, m.full_name, m.father_name, m.designation,
           m.date_of_birth, m.age, m.gender, m.blood_group, m.mobile_number,
           m.phone_country_code, m.village, m.district_id, d.name,
           m.state_code, m.country_code, m.profile_photo_url
      from public.members m
      left join public.districts d on d.id = m.district_id
     where m.registration_number = v_number
       and m.normalized_full_name = v_name
       and m.status = 'active'
     limit 1;

  if not found then
    -- One code for "no such member", "name does not match" and "still pending"
    -- so a probe cannot distinguish them.
    return query select 'not_found',
      null::text, null::text, null::text, null::text, null::date, null::integer,
      null::public.gender_t, null::public.blood_group_t, null::text, null::text,
      null::text, null::uuid, null::text, null::text, null::char(2), null::text;
  end if;
end;
$$;

revoke all on function public.lookup_member_id_card(text, text, text) from public;
grant execute on function public.lookup_member_id_card(text, text, text) to anon, authenticated;