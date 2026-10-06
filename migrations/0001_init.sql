-- One site per deploy; site_id is always 1 and is kept so the schema matches the hosted version.

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,          -- 'pageview' | 'event'
  name TEXT,                   -- custom event name
  path TEXT NOT NULL,
  referrer_host TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  country TEXT,                -- ISO code from Cloudflare
  visitor_hash TEXT NOT NULL,  -- rotates daily; no IP or user agent is stored
  props_json TEXT,
  browser TEXT,
  os TEXT
);
CREATE INDEX events_site_ts ON events(site_id, ts);
CREATE INDEX events_site_type_ts ON events(site_id, type, ts);
CREATE INDEX events_site_campaign ON events(site_id, utm_campaign, ts) WHERE utm_campaign IS NOT NULL;
CREATE INDEX events_site_visitor_ts ON events(site_id, visitor_hash, ts) WHERE type = 'event';

CREATE TABLE rollup_hourly (
  site_id INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  metric TEXT NOT NULL,
  dim TEXT NOT NULL,
  value INTEGER NOT NULL,
  visitors INTEGER NOT NULL,
  PRIMARY KEY (site_id, hour, metric, dim)
);

CREATE TABLE annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL
);
CREATE INDEX annotations_site_ts ON annotations(site_id, ts);

CREATE TABLE spikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  magnitude REAL NOT NULL,
  top_causes_json TEXT NOT NULL
);
CREATE UNIQUE INDEX spikes_site_start ON spikes(site_id, start_ts);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  url TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX campaigns_site ON campaigns(site_id, created_at);

CREATE TABLE funnels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX funnels_site_name ON funnels(site_id, name);
