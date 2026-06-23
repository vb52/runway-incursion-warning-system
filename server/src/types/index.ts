// IMPORTANT: These types are shared between client and server.
// Any changes must be coordinated across both.

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
export type AuditResult = 'SUCCESS' | 'FAILED' | 'BLOCKED';

// Taxiway IDs: 1N-6N (north), 1S-6S (south)
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

export interface AuditLog {
  id: string;
  operator_name?: string;
  action_type: string;
  target_type?: string;
  target_id?: string;
  previous_state?: string;
  new_state?: string;
  result: AuditResult;
  source_ip?: string;
  session_id?: string;
  occurred_at: string;
  metadata_json?: string;
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

// Socket.IO event payloads
export interface SocketSystemStateUpdated {
  systemState: SystemState;
}

export interface SocketEventCreated {
  event: RiwsEvent;
}

export interface SocketEventUpdated {
  event: RiwsEvent;
}

export interface SocketVlmUpdated {
  eventId: string;
  analysis: VlmAnalysis;
}

// VLM Analysis types
export interface VlmAnalysisRequest {
  eventId: string;
  analysisId: string;
  event: RiwsEvent;
  mediaFiles: EventMedia[];
  promptVersion: string;
}

export interface VlmAnalysisResult {
  success: boolean;
  summary?: string;
  observed_target_type?: string;
  observed_action?: string;
  observed_direction?: string;
  observed_taxiway?: string;
  runway_entry_observed?: 'YES' | 'NO' | 'UNCERTAIN';
  risk_assessment?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNCERTAIN';
  confidence?: number;
  recommended_action?: string;
  limitations?: string[];
  evidence?: string[];
  model_name?: string;
  provider?: string;
  response_payload?: unknown;
  error_message?: string;
  processing_time_ms?: number;
}

export interface VlmHealthStatus {
  healthy: boolean;
  provider: string;
  model?: string;
  latency_ms?: number;
  error?: string;
  checked_at: string;
}

export interface VlmProviderInfo {
  name: string;
  mode: 'MOCK' | 'HTTP';
  model?: string;
  version?: string;
}

// Pagination
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Event filters
export interface EventFilters {
  severity?: EventSeverity;
  status?: EventStatus;
  taxiway_id?: string;
  target_type?: TargetType;
  event_type?: EventType;
  vlm_status?: VlmAnalysisStatus;
  date_from?: string;
  date_to?: string;
  page?: number;
  pageSize?: number;
}
