// API service for RIWS client
// All API calls go through these helpers

import { DetectorConfig } from '../types';

const BASE_URL = '/api';

async function apiCall<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }

  return data;
}

// ── System API ─────────────────────────────────────────────────────────────

export const systemApi = {
  getState: () => apiCall<{ success: boolean; data: unknown }>('/system/state'),
  start: (operatorName = 'ATC-01') =>
    apiCall('/system/start', {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
  stop: (operatorName = 'ATC-01') =>
    apiCall('/system/stop', {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
};

// ── Runway API ─────────────────────────────────────────────────────────────

export const runwayApi = {
  enable: (operatorName = 'ATC-01') =>
    apiCall('/runway/enable', {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
  disable: (operatorName = 'ATC-01') =>
    apiCall('/runway/disable', {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
};

// ── Taxiway API ────────────────────────────────────────────────────────────

export const taxiwayApi = {
  getAll: () => apiCall('/taxiways'),
  authorize: (id: string, operatorName = 'ATC-01') =>
    apiCall(`/taxiways/${id}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
  revoke: (id: string, operatorName = 'ATC-01') =>
    apiCall(`/taxiways/${id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
  reset: (id: string, operatorName = 'ATC-01') =>
    apiCall<{ success: boolean; alreadyCleared?: boolean; message?: string }>(`/taxiways/${id}/reset`, {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
};

// ── Events API ─────────────────────────────────────────────────────────────

export interface EventsQuery {
  severity?: string;
  status?: string;
  taxiway_id?: string;
  target_type?: string;
  event_type?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  pageSize?: number;
}

export const eventsApi = {
  getAll: (query: EventsQuery = {}) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== '' && v !== 'ALL') {
        params.append(k, String(v));
      }
    });
    const qs = params.toString();
    return apiCall(`/events${qs ? `?${qs}` : ''}`);
  },
  getById: (id: string) => apiCall(`/events/${id}`),
  acknowledge: (id: string, operatorName: string) =>
    apiCall(`/events/${id}/acknowledge`, {
      method: 'PATCH',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
  close: (id: string, operatorName: string, resolutionNote: string) =>
    apiCall(`/events/${id}/close`, {
      method: 'PATCH',
      body: JSON.stringify({ operator_name: operatorName, resolution_note: resolutionNote }),
    }),
  addTimeline: (id: string, entry: {
    action_type: string;
    description: string;
    source_type: string;
    operator_name?: string;
    metadata?: unknown;
  }) =>
    apiCall(`/events/${id}/timeline`, {
      method: 'POST',
      body: JSON.stringify(entry),
    }),
  getMedia: (id: string) => apiCall(`/events/${id}/media`),
  // Attaches media that can only be captured AFTER the event exists — the
  // delayed 事後影像 frame and the 事件影片 clip. Server restricts media_type
  // to those two slots (see eventRoutes) so a late call can never overwrite
  // the frame the incursion was actually judged on.
  attachMedia: (id: string, payload: {
    media_type: 'POST_EVENT_IMAGE' | 'EVENT_VIDEO';
    base64: string;
    camera_id?: string;
    captured_at?: string;
  }) =>
    apiCall(`/events/${id}/media`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

// ── VLM API ────────────────────────────────────────────────────────────────

export const vlmApi = {
  analyze: (eventId: string, operatorName = 'ATC-01') =>
    apiCall(`/events/${eventId}/vlm/analyze`, {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
  getAnalyses: (eventId: string) => apiCall(`/events/${eventId}/vlm`),
  getAnalysis: (eventId: string, analysisId: string) =>
    apiCall(`/events/${eventId}/vlm/${analysisId}`),
  retry: (eventId: string, operatorName = 'ATC-01') =>
    apiCall(`/events/${eventId}/vlm/retry`, {
      method: 'POST',
      body: JSON.stringify({ operator_name: operatorName }),
    }),
  health: () => apiCall('/vlm/health'),
  // Note: VLM health is at /api/vlm/health
};

// ── Audit API ──────────────────────────────────────────────────────────────

export const auditApi = {
  getLogs: (page = 1, pageSize = 50) =>
    apiCall(`/audit-logs?page=${page}&pageSize=${pageSize}`),
};

// ── Demo API ───────────────────────────────────────────────────────────────

export const demoApi = {
  triggerScenario: (scenarioId: string) =>
    apiCall(`/demo/scenarios/${scenarioId}/trigger`, {
      method: 'POST',
      body: JSON.stringify({ operator_name: 'DEMO-OPERATOR' }),
    }),
  detect: (params: {
    taxiway_id: string;
    target_id?: string;
    target_type?: string;
    camera_id?: string;
    confidence?: number;
    entering_runway?: boolean;
    // Real camera frame (base64 JPEG or data: URI) captured at the moment of
    // detection — see ZoneConfig.tsx's incursion-line scanning. Becomes
    // the event's real DETECTION_IMAGE instead of the generated placeholder.
    snapshot_base64?: string;
    // A real frame from a few seconds BEFORE the detection, out of
    // ZoneConfig.tsx's rolling pre-event buffer — becomes the event's
    // PRE_EVENT_IMAGE instead of the drawn placeholder. Absent when the
    // buffer had nothing trustworthy to offer (it is cleared on video
    // seek/RESET).
    pre_snapshot_base64?: string;
    // When that frame was grabbed (ISO) — deliberately earlier than the
    // event's own detected_at, which is why it travels separately.
    pre_snapshot_captured_at?: string;
    // The client-generated alertEventId (see aiDetectionStateStore's
    // buildAlertEventId) that triggered this call — carried through purely
    // for backend audit traceability (see demoRoutes.ts). The client
    // correlates it with the returned eventId itself; the backend never
    // needs to echo it back for that to work.
    alert_event_id?: string;
  }) =>
    // isNew distinguishes a freshly-opened event from a dedup hit on an
    // existing open one — the client only schedules 事後影像/事件影片 capture
    // for the former, so a later aircraft can't overwrite an earlier one's
    // aftermath. See SimulationEngine's ScenarioResult.
    apiCall<{ success: boolean; message?: string; data?: { eventId?: string; eventCode?: string; actions?: string[]; isNew?: boolean } }>('/demo/detect', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  reset: () =>
    apiCall('/demo/reset', {
      method: 'POST',
    }),
};

// ── Detector API (RIWS-POC integration) ───────────────────────────────────
// Reads/writes the zone & mask layout shared with the Python detector.
// See client/src/pages/ZoneConfig.tsx and RIWS-POC/src/riws_bridge.py.

export const detectorApi = {
  getConfig: () => apiCall<{ success: boolean; data: DetectorConfig }>('/detector/config'),
  updateConfig: (config: Omit<DetectorConfig, 'updated_at'>) =>
    apiCall<{ success: boolean; data: DetectorConfig }>('/detector/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  // Arms (or extends) the server-owned runway auto-alert window — see
  // DetectorAlertService. Broadcasts 'detector:alert-armed' to all clients.
  // mayCreate=false (default true) — only extends an already-active alert,
  // never starts a fresh one; see ZoneConfig.tsx's Z1-creates/Z2-Z3-extends
  // rule.
  armAlert: (durationMs: number, mayCreate = true) =>
    apiCall<{ success: boolean; data: { alertUntil: number | null } }>('/detector/alert/arm', {
      method: 'POST',
      body: JSON.stringify({ duration_ms: durationMs, may_create: mayCreate }),
    }),
  // Manual early-clear of the alert window — see DetectorAlertService.clear().
  clearAlert: () =>
    apiCall<{ success: boolean; data: { alertUntil: number | null } }>('/detector/alert/clear', {
      method: 'POST',
    }),
};
