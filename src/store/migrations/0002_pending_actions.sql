-- Actions an agent proposed that a human must approve before they run (S5 §2.4).
-- The agent writes `pending`; only the approve command moves a row on.
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('escalate')),
  case_id TEXT NOT NULL,
  -- The exact arguments that will run on approval (reason, note).
  args TEXT NOT NULL,
  -- The case version the proposal was made against; sent as If-Match on approval.
  etag TEXT NOT NULL,
  proposed_by_sub TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  -- `ok`, or the problem type the API answered on approval.
  result TEXT
) STRICT;

CREATE INDEX idx_pending_actions_status ON pending_actions (status, expires_at);
CREATE INDEX idx_pending_actions_case ON pending_actions (case_id, status);
