// Database schema definitions for RIWS
// IMPORTANT: Do not modify column names without updating all query files.

export const SCHEMA_VERSION = 1;

export const CREATE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  event_code TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('AUTHORIZED_ENTRY','UNAUTHORIZED_APPROACH','RUNWAY_INCURSION','SYSTEM_FAULT','CAMERA_FAULT')),
  severity TEXT NOT NULL CHECK(severity IN ('INFO','YELLOW','RED')),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','ACKNOWLEDGED','CLOSED')),
  taxiway_id TEXT,
  target_id TEXT,
  target_type TEXT CHECK(target_type IN ('VEHICLE','PERSON','AIRCRAFT','ANIMAL','UNKNOWN') OR target_type IS NULL),
  camera_id TEXT,
  confidence REAL,
  authorization_state TEXT,
  detected_at TEXT NOT NULL,
  acknowledged_at TEXT,
  closed_at TEXT,
  operator_name TEXT,
  resolution_note TEXT,
  stm_state TEXT,
  runway_state TEXT,
  taxiway_state_at_detection TEXT,
  latest_vlm_analysis_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export const CREATE_EVENT_TIMELINE_TABLE = `
CREATE TABLE IF NOT EXISTS event_timeline (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('SYSTEM','OPERATOR','AI','DEVICE','VLM')),
  operator_name TEXT,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT
)`;

export const CREATE_EVENT_MEDIA_TABLE = `
CREATE TABLE IF NOT EXISTS event_media (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK(media_type IN ('PRE_EVENT_IMAGE','DETECTION_IMAGE','POST_EVENT_IMAGE','EVENT_VIDEO','ANNOTATED_VIDEO')),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  camera_id TEXT,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

export const CREATE_AUDIT_LOGS_TABLE = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  operator_name TEXT,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  previous_state TEXT,
  new_state TEXT,
  result TEXT NOT NULL DEFAULT 'SUCCESS' CHECK(result IN ('SUCCESS','FAILED','BLOCKED')),
  source_ip TEXT,
  session_id TEXT,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT
)`;

export const CREATE_EVENT_VLM_ANALYSES_TABLE = `
CREATE TABLE IF NOT EXISTS event_vlm_analyses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  request_id TEXT,
  provider TEXT,
  model_name TEXT,
  prompt_version TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('NOT_REQUESTED','QUEUED','PROCESSING','COMPLETED','FAILED','TIMEOUT')),
  summary TEXT,
  observed_target_type TEXT,
  observed_action TEXT,
  observed_direction TEXT,
  observed_taxiway TEXT,
  runway_entry_observed TEXT CHECK(runway_entry_observed IN ('YES','NO','UNCERTAIN') OR runway_entry_observed IS NULL),
  risk_assessment TEXT CHECK(risk_assessment IN ('LOW','MEDIUM','HIGH','CRITICAL','UNCERTAIN') OR risk_assessment IS NULL),
  confidence REAL,
  recommended_action TEXT,
  limitations_json TEXT,
  evidence_json TEXT,
  request_payload_json TEXT,
  response_payload_json TEXT,
  error_message TEXT,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  processing_time_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export const CREATE_SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
)`;

// Single-row table (id is always 1) holding the RIWS-POC detector's zone/mask
// layout. This is the shared source of truth between the web "偵測器後台管理"
// editor and the Python detector (see RIWS-POC/src/riws_bridge.py fetch_config /
// push_config). Stored as one JSON blob rather than normalized columns because
// the shape (zone count, mask count) is edited freely from the UI and mirrors
// the POC's own layout.json structure — normalizing it would just add joins
// with no query benefit, since it's always read/written as a whole document.
export const CREATE_DETECTOR_CONFIG_TABLE = `
CREATE TABLE IF NOT EXISTS detector_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export const ALL_TABLES = [
  CREATE_SCHEMA_VERSION_TABLE,
  CREATE_EVENTS_TABLE,
  CREATE_EVENT_TIMELINE_TABLE,
  CREATE_EVENT_MEDIA_TABLE,
  CREATE_AUDIT_LOGS_TABLE,
  CREATE_EVENT_VLM_ANALYSES_TABLE,
  CREATE_DETECTOR_CONFIG_TABLE,
];
