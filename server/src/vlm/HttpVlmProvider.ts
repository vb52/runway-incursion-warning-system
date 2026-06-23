import { VlmAnalysisProvider } from './VlmAnalysisProvider';
import {
  VlmAnalysisRequest,
  VlmAnalysisResult,
  VlmHealthStatus,
  VlmProviderInfo,
} from '../types';
import { nowIso } from '../utils/datetime';
import { logger } from '../utils/logger';

// INTEGRATION: Real HTTP VLM provider.
// Configure via environment variables:
//   VLM_API_URL   - Base URL for the VLM REST API
//   VLM_API_KEY   - API authentication key (never hardcode)
//   VLM_MODEL     - Model identifier
//   VLM_TIMEOUT_MS - Request timeout in milliseconds

// SECURITY: API key must come from environment, never from request payload or hardcoded.

export class HttpVlmProvider implements VlmAnalysisProvider {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor() {
    this.apiUrl = process.env.VLM_API_URL ?? '';
    // SECURITY: Never log or expose this key
    this.apiKey = process.env.VLM_API_KEY ?? '';
    this.model = process.env.VLM_MODEL ?? '';
    this.timeoutMs = parseInt(process.env.VLM_TIMEOUT_MS ?? '15000', 10);

    if (!this.apiUrl || !this.apiKey || !this.model) {
      logger.warn('[VLM-HTTP] Missing VLM_API_URL, VLM_API_KEY, or VLM_MODEL. Provider will fail.');
    }
  }

  async analyzeEvent(request: VlmAnalysisRequest): Promise<VlmAnalysisResult> {
    const startTime = Date.now();
    logger.info(`[VLM-HTTP] Sending analysis request for event ${request.eventId}...`);

    // TODO: Implement actual HTTP call to VLM API
    // The implementation will depend on the specific VLM provider being used.
    // Example structure:
    //
    // const payload = {
    //   model: this.model,
    //   messages: [
    //     {
    //       role: 'user',
    //       content: [
    //         { type: 'text', text: this.buildPrompt(request) },
    //         ...mediaUrls.map(url => ({ type: 'image_url', image_url: { url } }))
    //       ]
    //     }
    //   ],
    //   max_tokens: 1000,
    // };
    //
    // const response = await fetch(`${this.apiUrl}/chat/completions`, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'Authorization': `Bearer ${this.apiKey}`,
    //   },
    //   body: JSON.stringify(payload),
    //   signal: AbortSignal.timeout(this.timeoutMs),
    // });

    throw new Error(
      'HttpVlmProvider is not implemented. Configure VLM_PROVIDER=mock or implement this provider.'
    );
  }

  async healthCheck(): Promise<VlmHealthStatus> {
    const startTime = Date.now();
    try {
      // TODO: Implement actual health check
      throw new Error('HttpVlmProvider health check not implemented.');
    } catch (err) {
      return {
        healthy: false,
        provider: 'http',
        model: this.model,
        error: err instanceof Error ? err.message : 'Unknown error',
        latency_ms: Date.now() - startTime,
        checked_at: nowIso(),
      };
    }
  }

  getProviderInfo(): VlmProviderInfo {
    return {
      name: 'HTTP VLM Provider',
      mode: 'HTTP',
      model: this.model,
      version: '1.0.0',
    };
  }

  private buildPrompt(request: VlmAnalysisRequest): string {
    const event = request.event;
    return `You are an AI assistant for an Airport Runway Incursion Warning System (RIWS).

Analyze the provided runway surveillance camera images and answer the following:

Event Context:
- Event ID: ${event.event_code}
- Event Type: ${event.event_type}
- Severity: ${event.severity}
- Taxiway: ${event.taxiway_id ?? 'Unknown'}
- Target ID: ${event.target_id ?? 'Unknown'}
- Target Type: ${event.target_type ?? 'Unknown'}
- Detected At: ${event.detected_at}
- Camera: ${event.camera_id ?? 'Unknown'}

Please provide a structured analysis including:
1. Observed target type and description
2. Target action and movement direction
3. Whether runway entry was observed
4. Risk assessment (LOW/MEDIUM/HIGH/CRITICAL)
5. Recommended immediate action
6. Evidence supporting your assessment
7. Limitations of this analysis

Respond in Traditional Chinese (繁體中文).`;
  }
}
