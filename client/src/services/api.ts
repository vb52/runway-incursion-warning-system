// API service for RIWS client
// All API calls go through these helpers

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
    apiCall(`/taxiways/${id}/reset`, {
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
  }) =>
    apiCall('/demo/detect', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  reset: () =>
    apiCall('/demo/reset', {
      method: 'POST',
    }),
};
