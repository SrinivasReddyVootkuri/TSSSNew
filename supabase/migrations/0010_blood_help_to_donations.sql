-- ---------------------------------------------------------------------------
-- 0010_blood_help_to_donations.sql
--
-- Content rename: the emergency request vertical is now called
-- "Blood Donations" instead of "Blood Help". Only stored content changes
-- here; routes, labels and docs change in the application code.
-- ---------------------------------------------------------------------------

update public.blogs set category = 'Blood Donations' where category = 'Blood Help';
