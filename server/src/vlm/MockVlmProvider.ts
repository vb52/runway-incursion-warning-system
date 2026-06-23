import { VlmAnalysisProvider } from './VlmAnalysisProvider';
import {
  VlmAnalysisRequest,
  VlmAnalysisResult,
  VlmHealthStatus,
  VlmProviderInfo,
} from '../types';
import { nowIso } from '../utils/datetime';
import { logger } from '../utils/logger';

// MOCK: Simulates a VLM analysis with realistic delays and results.
// INTEGRATION: Replace with HttpVlmProvider for production use.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export class MockVlmProvider implements VlmAnalysisProvider {
  async analyzeEvent(request: VlmAnalysisRequest): Promise<VlmAnalysisResult> {
    const startTime = Date.now();
    logger.info(`[VLM-MOCK] Analyzing event ${request.eventId}...`);

    // Simulate VLM processing time (2-4 seconds)
    const delay = Math.round(randomBetween(2000, 4000));
    await sleep(delay);

    const event = request.event;
    const targetType = event.target_type ?? 'UNKNOWN';
    const taxiwayId = event.taxiway_id ?? 'N/A';
    const confidence = parseFloat((randomBetween(0.78, 0.97)).toFixed(2));
    const isIncursion = event.event_type === 'RUNWAY_INCURSION';
    const isApproach = event.event_type === 'UNAUTHORIZED_APPROACH';

    // Generate realistic analysis based on event data
    const targetLabels: Record<string, string> = {
      VEHICLE: '地面服務車輛',
      PERSON: '地勤人員',
      AIRCRAFT: '小型航空器',
      ANIMAL: '野生動物（疑似鳥類）',
      UNKNOWN: '未知目標',
    };

    const targetLabel = targetLabels[targetType] ?? targetType;

    const observedActions: Record<string, string> = {
      RUNWAY_INCURSION: '目標已進入跑道保護區域',
      UNAUTHORIZED_APPROACH: '目標接近跑道邊緣，尚未進入',
      AUTHORIZED_ENTRY: '目標依授權進行滑行',
    };

    const observedAction = observedActions[event.event_type] ?? '目標在跑道附近移動';

    const directions = ['由西向東', '由東向西', '由北向南', '由南向北'];
    const observedDirection = directions[Math.floor(Math.random() * directions.length)];

    const riskLevels: Record<string, 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = {
      RUNWAY_INCURSION: 'CRITICAL',
      UNAUTHORIZED_APPROACH: 'HIGH',
      AUTHORIZED_ENTRY: 'LOW',
      CAMERA_FAULT: 'MEDIUM',
      SYSTEM_FAULT: 'MEDIUM',
    };

    const riskAssessment = riskLevels[event.event_type] ?? 'MEDIUM';

    const summaries: Record<string, string> = {
      RUNWAY_INCURSION: `影像分析確認${targetLabel}（${event.target_id ?? 'TGT'}）已越越聯絡道 ${taxiwayId} 進入跑道保護區域，方向為${observedDirection}。依據移動軌跡研判，目標可能與預定降落航班發生衝突，風險等級極高。建議立即通知塔台並啟動跑道中斷程序。`,
      UNAUTHORIZED_APPROACH: `影像分析顯示${targetLabel}正接近聯絡道 ${taxiwayId} 之跑道邊緣，目前尚未跨越保護邊界。目標移動速度約 15-25 km/h，${observedDirection}行進。應即時確認是否有授權文件，並警告相關人員。`,
      AUTHORIZED_ENTRY: `影像確認${targetLabel}正依授權於聯絡道 ${taxiwayId} 進行作業，移動軌跡正常，無異常行為。`,
      CAMERA_FAULT: `影像品質異常，畫面存在嚴重干擾，無法有效辨識目標。建議立即檢查 ${event.camera_id ?? 'CAM'} 攝影機連線狀態及鏡頭清潔度。`,
    };

    const summary = summaries[event.event_type] ?? `偵測到${targetLabel}於聯絡道 ${taxiwayId} 附近，需進一步評估。`;

    const recommendedActions: Record<string, string> = {
      RUNWAY_INCURSION: '1. 立即通知塔台執行跑道中斷程序\n2. 廣播所有航空器暫停降落\n3. 派遣地面管制員至現場確認\n4. 啟動機場緊急應變程序',
      UNAUTHORIZED_APPROACH: '1. 通知地面管制確認目標身份\n2. 發出警告廣播\n3. 若目標持續接近，升級至跑道入侵警報',
      AUTHORIZED_ENTRY: '持續監控，無需立即行動',
      CAMERA_FAULT: '派遣技術人員至 ' + (event.camera_id ?? 'CAM') + ' 位置進行設備檢查',
    };

    const recommendedAction = recommendedActions[event.event_type] ?? '持續監控並評估情況';

    const processingTimeMs = Date.now() - startTime;

    const result: VlmAnalysisResult = {
      success: true,
      summary,
      observed_target_type: targetLabel,
      observed_action: observedAction,
      observed_direction: observedDirection,
      observed_taxiway: taxiwayId,
      runway_entry_observed: isIncursion ? 'YES' : isApproach ? 'UNCERTAIN' : 'NO',
      risk_assessment: riskAssessment,
      confidence,
      recommended_action: recommendedAction,
      limitations: [
        '本分析基於靜態影像，動態行為推斷可能存在誤差',
        '夜間或惡劣天氣條件下辨識精度下降約 15-25%',
        '影像解析度限制可能影響遠距離目標的精確辨識',
      ],
      evidence: [
        `目標形態特徵與 ${targetLabel} 一致（信心度 ${Math.round(confidence * 100)}%）`,
        `邊界框定位於聯絡道 ${taxiwayId} 跑道保護區域邊緣`,
        `移動向量分析顯示目標${observedDirection}移動`,
        isIncursion ? '目標質心已超越跑道邊界標線' : '目標質心尚在跑道保護邊界外',
      ],
      model_name: 'RIWS-Mock-VLM-v1.0',
      provider: 'mock',
      response_payload: {
        mock: true,
        model: 'RIWS-Mock-VLM-v1.0',
        event_id: request.eventId,
        processed_images: request.mediaFiles.length,
      },
      processing_time_ms: processingTimeMs,
    };

    logger.info(`[VLM-MOCK] Analysis complete for ${request.eventId} in ${processingTimeMs}ms (risk: ${riskAssessment})`);
    return result;
  }

  async healthCheck(): Promise<VlmHealthStatus> {
    return {
      healthy: true,
      provider: 'mock',
      model: 'RIWS-Mock-VLM-v1.0',
      latency_ms: 5,
      checked_at: nowIso(),
    };
  }

  getProviderInfo(): VlmProviderInfo {
    return {
      name: 'Mock VLM Provider',
      mode: 'MOCK',
      model: 'RIWS-Mock-VLM-v1.0',
      version: '1.0.0',
    };
  }
}
