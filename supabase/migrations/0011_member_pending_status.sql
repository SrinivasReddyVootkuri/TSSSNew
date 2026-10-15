-- ---------------------------------------------------------------------------
-- 0011_member_pending_status.sql
--
-- Members now wait for administrator approval: registrations enter as
-- `pending` and become `active` only when approved, at which point the ID
-- card is emailed. This file holds a single statement because
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- ---------------------------------------------------------------------------

alter type public.member_status add value 'pending';
