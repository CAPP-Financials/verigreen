-- Day-7: Review queue columns for HITL workflow.
--
-- validations.status is TEXT (not an enum), so no enum alterations needed.
-- Values added by application code: human_approved, human_rejected.
--
-- Adds:
--   assigned_to   — analyst the item is assigned to for review
--   reviewed_at   — when the review decision was made
-- Adds indexes for queue filtering by status and assignment.

ALTER TABLE public.validations
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- Index for review queue listing (status filter is the hot path)
CREATE INDEX IF NOT EXISTS idx_validations_status
  ON public.validations (org_id, status);

-- Partial index for assigned items (small fraction of total)
CREATE INDEX IF NOT EXISTS idx_validations_assigned
  ON public.validations (assigned_to)
  WHERE assigned_to IS NOT NULL;
