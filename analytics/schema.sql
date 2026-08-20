-- One row per reported event. See docs in the repo README ("Usage counts") for
-- the contract this table is allowed to hold: no IP, no filenames, no paths, no
-- message text -- only the columns below.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,  -- YYYY-MM-DD, stamped by the server, not the client
  event      TEXT NOT NULL,  -- app_launch | dub_success | dub_failure | install_failure
  os         TEXT NOT NULL,  -- mac | windows
  version    TEXT NOT NULL,  -- e.g. 0.3.2
  device     TEXT NOT NULL,  -- random install id, 32 hex chars
  error_code TEXT            -- failure events only; NULL otherwise
);

CREATE INDEX IF NOT EXISTS idx_events_day    ON events (day);
CREATE INDEX IF NOT EXISTS idx_events_device ON events (device);
