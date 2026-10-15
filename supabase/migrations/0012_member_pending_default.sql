-- ---------------------------------------------------------------------------
-- 0012_member_pending_default.sql
--
-- New members enter as `pending` until an administrator approves them.
-- Approval flips the status to `active` and emails the ID card. Changing the
-- column default (rather than each insert) covers every registration path,
-- including the legacy submit_registration function.
-- ---------------------------------------------------------------------------

alter table public.members alter column status set default 'pending';
