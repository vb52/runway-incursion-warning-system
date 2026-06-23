import { VlmAnalysisRequest, VlmAnalysisResult, VlmHealthStatus, VlmProviderInfo } from '../types';

// INTEGRATION: Implement this interface to connect a real VLM (Vision Language Model).
// The MockVlmProvider implements this for demo purposes.
// The HttpVlmProvider implements this for production REST API calls.

export interface VlmAnalysisProvider {
  analyzeEvent(request: VlmAnalysisRequest): Promise<VlmAnalysisResult>;
  healthCheck(): Promise<VlmHealthStatus>;
  getProviderInfo(): VlmProviderInfo;
}
