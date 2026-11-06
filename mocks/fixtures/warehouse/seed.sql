-- Usage warehouse seed (mock of a Snowflake table). Monthly grain.
-- No rows for ACC-015 or ACC-021: "no usage data" is distinct from "warehouse down".
-- The last three closed months at the fixture clock (2026-11-06): Aug-Oct.
-- ACC-007 2026-09 matches the sample row in the scenario.
CREATE TABLE monthly_usage (
  account_id   TEXT    NOT NULL,
  month        TEXT    NOT NULL, -- YYYY-MM
  protected_tb REAL    NOT NULL,
  api_calls    INTEGER NOT NULL,
  active_users INTEGER NOT NULL,
  PRIMARY KEY (account_id, month)
);

INSERT INTO monthly_usage (account_id, month, protected_tb, api_calls, active_users) VALUES
  ('ACC-007', '2026-08', 398.0,  1150200, 85),
  ('ACC-007', '2026-09', 412.5,  1203331, 87),
  ('ACC-007', '2026-10', 426.0,  1251900, 89),
  ('ACC-012', '2026-08', 126.5,   415800, 33),
  ('ACC-012', '2026-09', 131.0,   430120, 34),
  ('ACC-012', '2026-10', 134.5,   441300, 35),
  ('ACC-030', '2026-08', 205.5,   628300, 54),
  ('ACC-030', '2026-09', 199.0,   610750, 52),
  ('ACC-030', '2026-10', 192.5,   598200, 50),
  ('ACC-042', '2026-08',  70.5,   225400, 19),
  ('ACC-042', '2026-09',  77.25,  240900, 21),
  ('ACC-042', '2026-10',  83.0,   256100, 22);
