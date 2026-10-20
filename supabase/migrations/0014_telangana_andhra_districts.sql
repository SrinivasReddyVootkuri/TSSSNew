-- ---------------------------------------------------------------------------
-- 0014_telangana_andhra_districts.sql
--
-- The registration form's district dropdown offered eight seed districts.
-- These are the complete official lists for the two states the trust works
-- in: Telangana (33) and Andhra Pradesh (27, as enumerated by the trust).
--
-- Districts gain a state link so the dropdown can follow the state the
-- member selects. Existing rows keep their identity: blood-help routing and
-- any member already pointing at one are untouched.
-- ---------------------------------------------------------------------------

alter table public.districts add column if not exists state_code text;

comment on column public.districts.state_code is
  'State this district belongs to (public.states.code), e.g. TS.';

do $$ begin
  alter table public.districts add constraint districts_state_fk
    foreign key (state_code) references public.states (code);
exception when duplicate_object then null; end $$;

create index if not exists districts_state_idx on public.districts (state_code);

-- Every seeded district so far is in Telangana.
update public.districts set state_code = 'TS' where state_code is null;

-- ---------------------------------------------------------------------------
-- Telangana - 33 districts, official order.
-- ---------------------------------------------------------------------------

with d (name, slug, ord) as (
  values
    ('Adilabad', 'adilabad', 1),
    ('Bhadradri Kothagudem', 'bhadradri-kothagudem', 2),
    ('Hanumakonda', 'hanumakonda', 3),
    ('Hyderabad', 'hyderabad', 4),
    ('Jagtial', 'jagtial', 5),
    ('Jangaon', 'jangaon', 6),
    ('Jayashankar Bhupalpally', 'jayashankar-bhupalpally', 7),
    ('Jogulamba Gadwal', 'jogulamba-gadwal', 8),
    ('Kamareddy', 'kamareddy', 9),
    ('Karimnagar', 'karimnagar', 10),
    ('Khammam', 'khammam', 11),
    ('Kumuram Bheem Asifabad', 'kumuram-bheem-asifabad', 12),
    ('Mahabubabad', 'mahabubabad', 13),
    ('Mahabubnagar', 'mahabubnagar', 14),
    ('Mancherial', 'mancherial', 15),
    ('Medak', 'medak', 16),
    ('Medchal–Malkajgiri', 'medchal-malkajgiri', 17),
    ('Mulugu', 'mulugu', 18),
    ('Nagarkurnool', 'nagarkurnool', 19),
    ('Nalgonda', 'nalgonda', 20),
    ('Narayanpet', 'narayanpet', 21),
    ('Nirmal', 'nirmal', 22),
    ('Nizamabad', 'nizamabad', 23),
    ('Peddapalli', 'peddapalli', 24),
    ('Rajanna Sircilla', 'rajanna-sircilla', 25),
    ('Rangareddy', 'rangareddy', 26),
    ('Sangareddy', 'sangareddy', 27),
    ('Siddipet', 'siddipet', 28),
    ('Suryapet', 'suryapet', 29),
    ('Vikarabad', 'vikarabad', 30),
    ('Wanaparthy', 'wanaparthy', 31),
    ('Warangal', 'warangal', 32),
    ('Yadadri Bhuvanagiri', 'yadadri-bhuvanagiri', 33)
)
insert into public.districts (name, slug, state_code, display_order, is_active)
select d.name, d.slug, 'TS', d.ord, true
from d
on conflict (slug) do update
  set name = excluded.name,
      state_code = 'TS',
      display_order = excluded.display_order,
      is_active = true;

-- ---------------------------------------------------------------------------
-- Andhra Pradesh - 27 districts as enumerated by the trust.
-- ---------------------------------------------------------------------------

with d (name, slug, ord) as (
  values
    ('Alluri Sitharama Raju', 'alluri-sitharama-raju', 101),
    ('Anakapalli', 'anakapalli', 102),
    ('Ananthapuramu', 'ananthapuramu', 103),
    ('Annamayya', 'annamayya', 104),
    ('Bapatla', 'bapatla', 105),
    ('Chittoor', 'chittoor', 106),
    ('Dr. B. R. Ambedkar Konaseema', 'dr-b-r-ambedkar-konaseema', 107),
    ('East Godavari', 'east-godavari', 108),
    ('Eluru', 'eluru', 109),
    ('Guntur', 'guntur', 110),
    ('Kakinada', 'kakinada', 111),
    ('Krishna', 'krishna', 112),
    ('Kurnool', 'kurnool', 113),
    ('Markapuram', 'markapuram', 114),
    ('Nandyal', 'nandyal', 115),
    ('NTR', 'ntr', 116),
    ('Palnadu', 'palnadu', 117),
    ('Parvathipuram Manyam', 'parvathipuram-manyam', 118),
    ('Polavaram', 'polavaram', 119),
    ('Prakasam', 'prakasam', 120),
    ('Sri Potti Sriramulu Nellore', 'sri-potti-sriramulu-nellore', 121),
    ('Sri Sathya Sai', 'sri-sathya-sai', 122),
    ('Srikakulam', 'srikakulam', 123),
    ('Tirupati', 'tirupati', 124),
    ('Visakhapatnam', 'visakhapatnam', 125),
    ('Vizianagaram', 'vizianagaram', 126),
    ('West Godavari', 'west-godavari', 127)
)
insert into public.districts (name, slug, state_code, display_order, is_active)
select d.name, d.slug, 'AP', d.ord, true
from d
on conflict (slug) do update
  set name = excluded.name,
      state_code = 'AP',
      display_order = excluded.display_order,
      is_active = true;
