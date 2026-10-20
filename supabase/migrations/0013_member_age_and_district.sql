-- ---------------------------------------------------------------------------
-- 0013_member_age_and_district.sql
--
-- Registration no longer requires a date of birth (age is what the ID card and
-- the dashboard actually use), and members now record their district so the
-- address on the card can name it. This file adds the two columns, teaches the
-- registration function to accept them, and keeps duplicate detection working
-- now that a date of birth may be absent.
-- ---------------------------------------------------------------------------

alter table public.members add column if not exists age integer;
alter table public.members add column if not exists district_id uuid;

-- Date of birth is optional now, so the column must stop requiring a value.
alter table public.members alter column date_of_birth drop not null;

comment on column public.members.age is
  'Age in whole years, supplied by the member. Always present; date of birth is optional.';
comment on column public.members.district_id is
  'Reference to public.districts, printed in the ID card address.';

do $$ begin
  alter table public.members add constraint members_age_range
    check (age is null or (age >= 1 and age <= 120));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.members add constraint members_district_fk
    foreign key (district_id) references public.districts (id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists members_age_idx on public.members (age);
create index if not exists members_district_idx on public.members (district_id);

-- The previous signature did not carry age or district; PostgREST resolves an
-- RPC by its named arguments, so the old overload is retired rather than left
-- to shadow the new one.
drop function if exists public.submit_registration_v2(text, date, text, text, text, text, text, text, text, text, text, text, text);

-- The member list and CSV export share this function, so age and district are
-- added to it too. SECURITY INVOKER is deliberate: the caller's Row Level
-- Security still applies, exactly as if the panel had issued the filters.
drop function if exists public.filter_members(text, text, text, text, text, text, date, date, date, date, boolean, text, text, integer, integer);

create or replace function public.filter_members(
  p_search text default null,
  p_status text default null,
  p_gender text default null,
  p_blood_group text default null,
  p_state text default null,
  p_country text default null,
  p_dob_from date default null,
  p_dob_to date default null,
  p_registered_from date default null,
  p_registered_to date default null,
  p_donated boolean default null,
  p_sort text default 'created_at',
  p_direction text default 'desc',
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  registration_number text,
  full_name text,
  normalized_full_name text,
  father_name text,
  age integer,
  gender public.gender_t,
  blood_group public.blood_group_t,
  date_of_birth date,
  village text,
  district_id uuid,
  district_name text,
  state_code text,
  country_code char(2),
  phone_country_code text,
  mobile_number text,
  normalized_mobile text,
  email text,
  designation text,
  profile_photo_url text,
  status text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_term text := nullif(trim(coalesce(p_search, '')), '');
  v_direction text := case when lower(coalesce(p_direction, 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 10000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  return query execute format(
    'select m.id, m.registration_number, m.full_name, m.normalized_full_name,
            m.father_name, m.age, m.gender, m.blood_group, m.date_of_birth, m.village,
            m.district_id, d.name as district_name,
            m.state_code, m.country_code, m.phone_country_code, m.mobile_number,
            m.normalized_mobile, m.email, m.designation, m.profile_photo_url,
            m.status::text, m.notes, m.created_at, m.updated_at,
            count(*) over() as total_count
       from public.members m
       left join public.districts d on d.id = m.district_id
      where ($1 is null or (
              m.registration_number ilike ''%%'' || $1 || ''%%''
           or m.full_name ilike ''%%'' || $1 || ''%%''
           or coalesce(m.father_name, '''') ilike ''%%'' || $1 || ''%%''
           or coalesce(m.village, '''') ilike ''%%'' || $1 || ''%%''
           or m.mobile_number ilike ''%%'' || $1 || ''%%''
           or coalesce(m.email, '''') ilike ''%%'' || $1 || ''%%''))
        and ($2 is null or m.status::text = $2)
        and ($3 is null or m.gender::text = $3)
        and ($4 is null or m.blood_group::text = $4)
        and ($5 is null or m.state_code = $5)
        and ($6 is null or m.country_code = $6)
        and ($7 is null or m.date_of_birth >= $7)
        and ($8 is null or m.date_of_birth <= $8)
        and ($9 is null or m.created_at >= $9::timestamptz)
        and ($10 is null or m.created_at < ($10::date + 1)::timestamptz)
        and ($11 is null or ($11 and exists (
              select 1 from public.donations dn
                join public.donors o on o.id = dn.donor_id
               where o.member_id = m.id or o.mobile_number = m.mobile_number
            )) or (not $11 and not exists (
              select 1 from public.donations dn
                join public.donors o on o.id = dn.donor_id
               where o.member_id = m.id or o.mobile_number = m.mobile_number
            )))
      order by %s %s, m.registration_number asc
      limit %s offset %s',
    case coalesce(p_sort, 'created_at')
      when 'full_name' then 'm.full_name'
      when 'village' then 'm.village'
      when 'registration_number' then 'm.registration_number'
      when 'date_of_birth' then 'm.date_of_birth'
      else 'm.created_at'
    end,
    v_direction,
    v_limit,
    v_offset
  )
  using v_term,
        nullif(p_status, ''), nullif(p_gender, ''), nullif(p_blood_group, ''),
        nullif(p_state, ''), nullif(p_country, ''),
        p_dob_from, p_dob_to, p_registered_from, p_registered_to,
        p_donated;
end;
$$;

revoke all on function public.filter_members(text, text, text, text, text, text, date, date, date, date, boolean, text, text, integer, integer) from public;
grant execute on function public.filter_members(text, text, text, text, text, text, date, date, date, date, boolean, text, text, integer, integer) to authenticated;

-- The unique key on name + date of birth cannot work when the date is optional:
-- Postgres treats NULLs as distinct, so the same person could be registered twice.
-- Duplicate detection therefore falls back to name + age when no date is given.
-- Duplicate detection therefore falls back to name + age when no date is given.
create or replace function public.submit_registration_v2(
  p_full_name text,
  p_date_of_birth date,
  p_father_name text,
  p_gender text,
  p_blood_group text,
  p_state_code text,
  p_country_code text,
  p_village text,
  p_mobile_number text,
  p_phone_country_code text,
  p_profile_photo_url text,
  p_email text,
  p_age integer,
  p_district_id uuid,
  p_rate_key text default null
)
returns table (
  result_code text,
  registration_number text,
  full_name text,
  date_of_birth date,
  village text,
  registered_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_name text := trim(coalesce(p_full_name, ''));
  v_father text := trim(coalesce(p_father_name, ''));
  v_village text := nullif(trim(coalesce(p_village, '')), '');
  v_mobile text := public.normalize_mobile(p_mobile_number);
  v_normalized text := public.normalize_name(v_name);
  v_country char(2) := upper(coalesce(nullif(trim(coalesce(p_country_code, '')), ''), 'IN'));
  v_dial text := nullif(trim(coalesce(p_phone_country_code, '')), '');
  v_group public.blood_group_t;
  v_sex public.gender_t;
  v_number text;
  v_row public.members%rowtype;
begin
  if p_rate_key is not null and not public.rate_limit_hit('register:' || p_rate_key, 8, 3600) then
    raise exception 'RATE_LIMITED';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 120 then raise exception 'INVALID_NAME'; end if;
  if p_date_of_birth is not null and (p_date_of_birth > current_date
     or p_date_of_birth < current_date - interval '120 years') then raise exception 'INVALID_DOB'; end if;
  if v_mobile is null or v_mobile !~ '^[0-9]{10}$' then raise exception 'INVALID_MOBILE'; end if;
  if v_village is not null and char_length(v_village) > 120 then raise exception 'INVALID_VILLAGE'; end if;

  if char_length(v_father) < 2 or char_length(v_father) > 120 then raise exception 'INVALID_FATHER_NAME'; end if;
  if not exists (select 1 from public.countries c where c.iso_code = v_country and c.is_active) then
    raise exception 'INVALID_COUNTRY';
  end if;

  begin
    v_group := p_blood_group::public.blood_group_t;
  exception when others then
    raise exception 'INVALID_BLOOD_GROUP';
  end;

  if p_gender is not null and trim(p_gender) <> '' then
    begin
      v_sex := p_gender::public.gender_t;
    exception when others then
      raise exception 'INVALID_GENDER';
    end;
  end if;

  if p_state_code is not null and trim(p_state_code) <> ''
     and not exists (select 1 from public.states s where s.code = upper(trim(p_state_code))) then
    raise exception 'INVALID_STATE';
  end if;

  if p_age is null or p_age < 1 or p_age > 120 then raise exception 'INVALID_AGE'; end if;

  if p_district_id is not null
     and not exists (select 1 from public.districts d where d.id = p_district_id and d.is_active) then
    raise exception 'INVALID_DISTRICT';
  end if;

  if v_dial is null or v_dial !~ '^[0-9]{1,4}$' then
    select c.phone_code into v_dial from public.countries c where c.iso_code = v_country;
  end if;

  if exists (
    select 1 from public.members m
    where m.normalized_full_name = v_normalized
      and (
        (p_date_of_birth is not null and m.date_of_birth = p_date_of_birth)
        or (p_date_of_birth is null and m.age = p_age)
      )
  ) then
    return query select 'already_registered', null::text, null::text, null::date, null::text, null::timestamptz;
    return;
  end if;

  v_number := public.next_registration_number();
  begin
    insert into public.members (
      registration_number, full_name, date_of_birth, village, mobile_number, email,
      father_name, gender, blood_group, state_code, country_code,
      phone_country_code, profile_photo_url, age, district_id
    )
    values (
      v_number, v_name, p_date_of_birth, v_village, v_mobile,
      nullif(trim(coalesce(p_email, '')), ''),
      v_father, v_sex, v_group,
      nullif(upper(trim(p_state_code)), ''), v_country,
      v_dial, nullif(trim(coalesce(p_profile_photo_url, '')), ''),
      p_age, p_district_id
    )
    returning * into v_row;
  exception when unique_violation then
    return query select 'already_registered', null::text, null::text, null::date, null::text, null::timestamptz;
    return;
  end;

  return query select 'created', v_row.registration_number, v_row.full_name, v_row.date_of_birth,
    v_row.village, v_row.created_at;
end;
$$;

revoke all on function public.submit_registration_v2(text, date, text, text, text, text, text, text, text, text, text, text, integer, uuid, text) from public;
grant execute on function public.submit_registration_v2(text, date, text, text, text, text, text, text, text, text, text, text, integer, uuid, text) to anon, authenticated;