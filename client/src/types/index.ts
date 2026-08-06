// Client-side types (mirrors server types)

export type SystemPowerState = 'OFF' | 'INITIALIZING' | 'ACTIVE' | 'FAULT' | 'SHUTTING_DOWN';
export type RunwayProtectionState = 'OFF' | 'ON';
export type TaxiwayControlState = 'OFF' | 'GUARDED' | 'AUTHORIZED' | 'INCURSION_LATCHED' | 'FAULT';
export type EventSeverity = 'INFO' | 'YELLOW' | 'RED';
export type EventStatus = 'NEW' | 'ACKNOWLEDGED' | 'CLOSED';
export type EventType =
  | 'AUTHORIZED_ENTRY'
  | 'UNAUTHORIZED_APPROACH'
  | 'RUNWAY_INCURSION'
  | 'SYSTEM_FAULT'
  | 'CAMERA_FAULT';
export type TargetType = 'VEHICLE' | 'PERSON' | 'AIRCRAFT' | 'ANIMAL' | 'UNKNOWN';
export type VlmAnalysisStatus =
  | 'NOT_REQUESTED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT';
export type TimelineSourceType = 'SYSTEM' | 'OPERATOR' | 'AI' | 'DEVICE' | 'VLM';
export type MediaType =
  | 'PRE_EVENT_IMAGE'
  | 'DETECTION_IMAGE'
  | 'POST_EVENT_IMAGE'
  | 'EVENT_VIDEO'
  | 'ANNOTATED_VIDEO';

export type TaxiwayId =
  | '1N' | '2N' | '3N' | '4N' | '5N' | '6N'
  | '1S' | '2S' | '3S' | '4S' | '5S' | '6S';

export const ALL_TAXIWAY_IDS: TaxiwayId[] = [
  '1N', '2N', '3N', '4N', '5N', '6N',
  '1S', '2S', '3S', '4S', '5S', '6S',
];

export interface TaxiwayState {
  id: TaxiwayId;
  state: TaxiwayControlState;
}

export interface SystemState {
  powerState: SystemPowerState;
  runwayProtectionState: RunwayProtectionState;
  taxiways: TaxiwayState[];
  startedAt?: string;
  updatedAt: string;
}

export interface RiwsEvent {
  id: string;
  event_code: string;
  event_type: EventType;
  severity: EventSeverity;
  status: EventStatus;
  taxiway_id?: string;
  target_id?: string;
  target_type?: TargetType;
  camera_id?: string;
  confidence?: number;
  authorization_state?: string;
  detected_at: string;
  acknowledged_at?: string;
  closed_at?: string;
  operator_name?: string;
  resolution_note?: string;
  stm_state?: string;
  runway_state?: string;
  taxiway_state_at_detection?: string;
  latest_vlm_analysis_id?: string;
  created_at: string;
  updated_at: string;
}

export interface EventTimeline {
  id: string;
  event_id: string;
  action_type: string;
  description: string;
  source_type: TimelineSourceType;
  operator_name?: string;
  occurred_at: string;
  metadata_json?: string;
}

export interface EventMedia {
  id: string;
  event_id: string;
  media_type: MediaType;
  file_name: string;
  file_path: string;
  camera_id?: string;
  captured_at: string;
  created_at: string;
}

export interface VlmAnalysis {
  id: string;
  event_id: string;
  request_id?: string;
  provider?: string;
  model_name?: string;
  prompt_version?: string;
  status: VlmAnalysisStatus;
  summary?: string;
  observed_target_type?: string;
  observed_action?: string;
  observed_direction?: string;
  observed_taxiway?: string;
  runway_entry_observed?: 'YES' | 'NO' | 'UNCERTAIN';
  risk_assessment?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNCERTAIN';
  confidence?: number;
  recommended_action?: string;
  limitations_json?: string;
  evidence_json?: string;
  request_payload_json?: string;
  response_payload_json?: string;
  error_message?: string;
  queued_at?: string;
  started_at?: string;
  completed_at?: string;
  processing_time_ms?: number;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  operator_name?: string;
  action_type: string;
  target_type?: string;
  target_id?: string;
  previous_state?: string;
  new_state?: string;
  result: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  source_ip?: string;
  session_id?: string;
  occurred_at: string;
  metadata_json?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  duration?: number;
  // Fired when the user explicitly closes this toast via its X button —
  // e.g. an incursion alert's toast uses this to stop its sound and mark
  // the eventId locally dismissed (see dismissAlertLocally). Never used to
  // call a server API directly; that stays a separate, explicit action.
  onDismiss?: () => void;
}

// ── Detector config (RIWS-POC integration) ──────────────────────────────────
// Mirrors server/src/types/index.ts. Zone A/B/C are the RIWS-POC detector's
// screen regions (pixel rects on a frame_w x frame_h frame), NOT TaxiwayId —
// the Python detector maps zone -> taxiway itself (see RIWS-POC/src/
// riws_bridge.py ZONE_TAXIWAY_MAP) before calling the main /api/demo/detect
// endpoint. This page only edits the zone layout, not the mapping.
export type DetectorZoneId = 'A' | 'B' | 'C';

export interface DetectorRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DetectorConfig {
  frame_w: number;
  frame_h: number;
  zones: Record<DetectorZoneId, DetectorRect>;
  masks: DetectorRect[];
  // Looping demo camera clip (GET /api/detector/video) stands in for a live
  // feed. ZoneConfig.tsx reports "a plane appeared" to
  // POST /api/demo/detect (for video_trigger_taxiway_id) from three
  // independent sources: TensorFlow.js + COCO-SSD object detection, simple
  // frame-diff motion detection, and operator-marked timestamps
  // (video_trigger_seconds, seconds into the loop).
  video_trigger_taxiway_id: string;
  video_trigger_seconds: number[];
  // Intrinsic pixel size of the detector video that motion_zones and
  // incursion_line were drawn against — ZoneConfig.tsx sizes its drawing
  // canvas to video.videoWidth/videoHeight (see ensureRegionCanvasSized), so
  // that is the space their rects live in, NOT frame_w/frame_h. Those belong
  // to zones/masks (RIWS-POC's YOLO regions) and are overwritten by the
  // Python detector with its own stream resolution, so the two legitimately
  // differ. 0 = never recorded.
  //
  // Exists so swapping the demo clip for a different resolution is
  // detectable instead of silently re-aiming every zone and the incursion
  // line at the wrong pixels. Mismatch is surfaced as a warning on this
  // page; nothing is auto-rescaled.
  motion_frame_w: number;
  motion_frame_h: number;
  // Operator-drawn motion-detection zones (pixel rects in
  // motion_frame_w x motion_frame_h space — see above). Each zone is
  // independently frame-diffed and
  // maps to its own taxiway, so e.g. Z1 over one taxiway mouth and Z2 over
  // another each report to the right taxiway instead of everything funneling
  // through one shared video_trigger_taxiway_id. Empty array = no motion
  // zones configured (motion detection has nothing to scan). See
  // ZoneConfig.tsx's zone drawing UI.
  motion_zones: DetectorMotionZone[];
  // Fraction-of-pixels-changed (0-1) that counts as "something moved" in a
  // motion zone — shared across every zone, not per-zone. Persisted (rather
  // than local React state) so it survives a reload and so the live score
  // meter and the zone-calibration UI (both on ZoneConfig.tsx now) agree.
  motion_threshold: number;
  // Runway boundary trigger — a single region (drawn/edited on
  // ZoneConfig.tsx, same rect shape as a motion zone) representing where an
  // aircraft physically crosses onto the runway. Separate from motion_zones
  // — those feed the Z1/Z2/Z3 ground-sim projection, this one feeds real
  // incursion evidence: crossing it reports a detection the same way any
  // zone does (the backend already checks real authorization state and only
  // latches INCURSION_LATCHED if unauthorized), plus attaches a real video
  // frame snapshot to the resulting event instead of a placeholder image.
  // null = not configured, nothing scanned.
  incursion_line: DetectorMotionZone | null;
  updated_at: string;
}

export interface DetectorMotionZone {
  id: string; // e.g. 'Z1', 'Z2' — display label, also the frame-diff baseline's cache key
  rect: DetectorRect;
  taxiway_id: string;
  // Per-zone override for DetectorConfig.motion_threshold (0-1, same
  // fraction-of-pixels-changed scale). undefined = use the shared default.
  // See ZoneConfig.tsx's per-zone threshold control.
  threshold?: number;
}
