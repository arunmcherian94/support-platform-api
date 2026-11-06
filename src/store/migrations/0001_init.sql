-- Initial schema. Times are RFC 3339 UTC text; JSON columns hold JSON text.

CREATE TABLE idempotency_keys (
  client_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_flight', 'completed')),
  response_status INTEGER,
  response_headers TEXT,
  response_body TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (client_id, sub, endpoint, key)
) STRICT;

CREATE INDEX idx_idempotency_expires_at ON idempotency_keys (expires_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  actor_agent TEXT,
  actor_client TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  args_redacted TEXT,
  outcome TEXT NOT NULL,
  latency_ms INTEGER
) STRICT;

CREATE INDEX idx_audit_resource ON audit_log (resource_type, resource_id, at);
CREATE INDEX idx_audit_actor_sub ON audit_log (actor_sub, at);
CREATE INDEX idx_audit_actor_agent ON audit_log (actor_agent, at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  event_types TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  disabled_reason TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions (id),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'dead')),
  next_attempt_at TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
) STRICT;

CREATE INDEX idx_deliveries_status_next ON webhook_deliveries (status, next_attempt_at);
