import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, CheckCircle, XCircle, Brain, RefreshCw, Download,
  Code, Clock, Camera, AlertTriangle, Info, ChevronDown, ChevronUp
} from 'lucide-react';
import { eventsApi, vlmApi } from '../services/api';
import { RiwsEvent, EventTimeline, EventMedia, VlmAnalysis } from '../types';
import { formatDisplay, formatRelative } from '../utils/datetime';
import { useAppStore } from '../stores/appStore';

interface EventDetailData {
  event: RiwsEvent;
  timeline: EventTimeline[];
  media: EventMedia[];
}

function SectionCard({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-4">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <h3 className="font-medium text-gray-200 text-sm">{title}</h3>
        {open ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
      </button>
      {open && <div className="px-4 pb-4 border-t border-gray-800 pt-3">{children}</div>}
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex items-start gap-4 py-1.5 border-b border-gray-800/50 last:border-0">
      <span className="text-xs text-gray-500 w-36 flex-shrink-0">{label}</span>
      <span className={`text-xs text-gray-200 ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</span>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    INFO: 'bg-blue-900/60 text-blue-300 border-blue-700',
    YELLOW: 'bg-yellow-900/60 text-yellow-300 border-yellow-700',
    RED: 'bg-red-900/60 text-red-300 border-red-700',
  };
  return <span className={`px-2 py-0.5 rounded border text-xs font-mono font-bold ${styles[severity] ?? ''}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    NEW: 'bg-blue-900/60 text-blue-300 border-blue-700',
    ACKNOWLEDGED: 'bg-green-900/60 text-green-300 border-green-700',
    CLOSED: 'bg-gray-800/60 text-gray-500 border-gray-700',
  };
  const labels: Record<string, string> = { NEW: '新事件', ACKNOWLEDGED: '已確認', CLOSED: '已關閉' };
  return <span className={`px-2 py-0.5 rounded border text-xs font-mono ${styles[status] ?? ''}`}>{labels[status] ?? status}</span>;
}

function VlmStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    NOT_REQUESTED: 'bg-gray-800 text-gray-500 border-gray-700',
    QUEUED: 'bg-blue-900/60 text-blue-300 border-blue-700',
    PROCESSING: 'bg-yellow-900/60 text-yellow-300 border-yellow-700',
    COMPLETED: 'bg-green-900/60 text-green-300 border-green-700',
    FAILED: 'bg-red-900/60 text-red-300 border-red-700',
    TIMEOUT: 'bg-orange-900/60 text-orange-300 border-orange-700',
  };
  const labels: Record<string, string> = {
    NOT_REQUESTED: '未請求',
    QUEUED: '佇列中',
    PROCESSING: '分析中',
    COMPLETED: '已完成',
    FAILED: '失敗',
    TIMEOUT: '逾時',
  };
  return <span className={`px-2 py-0.5 rounded border text-xs font-mono ${styles[status] ?? ''}`}>{labels[status] ?? status}</span>;
}

function TimelineSourceIcon({ source }: { source: string }) {
  const colors: Record<string, string> = {
    SYSTEM: 'text-blue-400',
    OPERATOR: 'text-green-400',
    AI: 'text-purple-400',
    DEVICE: 'text-yellow-400',
    VLM: 'text-cyan-400',
  };
  const icons: Record<string, string> = {
    SYSTEM: '⚙',
    OPERATOR: '👤',
    AI: '🤖',
    DEVICE: '📡',
    VLM: '🧠',
  };
  return (
    <span className={`text-sm ${colors[source] ?? 'text-gray-400'}`}>
      {icons[source] ?? '○'}
    </span>
  );
}

function MediaTypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    PRE_EVENT_IMAGE: '事前影像',
    DETECTION_IMAGE: '偵測影像',
    POST_EVENT_IMAGE: '事後影像',
    EVENT_VIDEO: '事件影片',
    ANNOTATED_VIDEO: '標記影片',
  };
  return <span className="text-xs text-gray-400">{labels[type] ?? type}</span>;
}

// Close Event Dialog
function CloseEventDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (operatorName: string, note: string) => void;
  onCancel: () => void;
}) {
  const [operatorName, setOperatorName] = useState('ATC-01');
  const [note, setNote] = useState('');

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-96">
        <h3 className="font-bold text-white mb-4">關閉事件</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">操作員名稱</label>
            <input
              value={operatorName}
              onChange={(e) => setOperatorName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm"
              placeholder="ATC-01"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">處置說明 (必填)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm h-24 resize-none"
              placeholder="請輸入事件處置結果說明..."
            />
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-4">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">
            取消
          </button>
          <button
            onClick={() => note.trim() && onConfirm(operatorName, note)}
            disabled={!note.trim()}
            className="px-4 py-2 bg-red-900/60 border border-red-700 text-red-300 rounded text-sm hover:bg-red-800/60 transition-colors disabled:opacity-50"
          >
            確認關閉
          </button>
        </div>
      </div>
    </div>
  );
}

export function EventDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { addToast } = useAppStore();

  const [data, setData] = useState<EventDetailData | null>(null);
  const [vlmAnalyses, setVlmAnalyses] = useState<VlmAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [eventData, vlmData] = await Promise.all([
        eventsApi.getById(id) as Promise<{ success: boolean; data: EventDetailData }>,
        vlmApi.getAnalyses(id) as Promise<{ success: boolean; data: VlmAnalysis[] }>,
      ]);
      setData(eventData.data);
      setVlmAnalyses(vlmData.data ?? []);
    } catch (err) {
      addToast({ type: 'error', title: '載入失敗', message: err instanceof Error ? err.message : '未知錯誤' });
    } finally {
      setLoading(false);
    }
  }, [id, addToast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAcknowledge = async () => {
    if (!id) return;
    setActionLoading('ack');
    try {
      await eventsApi.acknowledge(id, 'ATC-01');
      addToast({ type: 'success', title: '事件已確認' });
      fetchData();
    } catch (err) {
      addToast({ type: 'error', title: '確認失敗', message: err instanceof Error ? err.message : '未知錯誤' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleClose = async (operatorName: string, note: string) => {
    if (!id) return;
    setActionLoading('close');
    setShowCloseDialog(false);
    try {
      await eventsApi.close(id, operatorName, note);
      addToast({ type: 'success', title: '事件已關閉' });
      fetchData();
    } catch (err) {
      addToast({ type: 'error', title: '關閉失敗', message: err instanceof Error ? err.message : '未知錯誤' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleVlmAnalyze = async () => {
    if (!id) return;
    setActionLoading('vlm');
    try {
      await vlmApi.analyze(id);
      addToast({ type: 'info', title: 'VLM 分析已加入佇列', message: '分析結果將在 2-4 秒後顯示' });
      setTimeout(fetchData, 3000);
      setTimeout(fetchData, 6000);
    } catch (err) {
      addToast({ type: 'error', title: 'VLM 分析請求失敗', message: err instanceof Error ? err.message : '未知錯誤' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleExportJson = () => {
    if (!data) return;
    const json = JSON.stringify({ ...data, vlmAnalyses }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.event.event_code}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    if (!data) return;
    const event = data.event;
    const csv = [
      ['欄位', '值'],
      ['事件代碼', event.event_code],
      ['事件類型', event.event_type],
      ['嚴重程度', event.severity],
      ['狀態', event.status],
      ['聯絡道', event.taxiway_id ?? ''],
      ['目標ID', event.target_id ?? ''],
      ['目標類型', event.target_type ?? ''],
      ['攝影機', event.camera_id ?? ''],
      ['信心度', event.confidence ? `${Math.round(event.confidence * 100)}%` : ''],
      ['偵測時間', formatDisplay(event.detected_at)],
      ['確認時間', event.acknowledged_at ? formatDisplay(event.acknowledged_at) : ''],
      ['關閉時間', event.closed_at ? formatDisplay(event.closed_at) : ''],
      ['操作員', event.operator_name ?? ''],
      ['處置說明', event.resolution_note ?? ''],
    ].map((row) => row.map((v) => `"${v}"`).join(',')).join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${event.event_code}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-500" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6">
        <div className="text-gray-500">事件不存在</div>
      </div>
    );
  }

  const { event, timeline, media } = data;
  const latestVlm = vlmAnalyses[0];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {showCloseDialog && (
        <CloseEventDialog
          onConfirm={handleClose}
          onCancel={() => setShowCloseDialog(false)}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-start gap-3">
          <Link to="/events" className="mt-1 text-gray-500 hover:text-gray-300 transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-mono text-xl font-bold text-yellow-400">{event.event_code}</h1>
              <SeverityBadge severity={event.severity} />
              <StatusBadge status={event.status} />
            </div>
            <p className="text-sm text-gray-500 mt-1">
              偵測時間：{formatDisplay(event.detected_at)} ({formatRelative(event.detected_at)})
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {event.status === 'NEW' && (
            <button
              onClick={handleAcknowledge}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-900/50 border border-green-700 text-green-300 rounded text-xs hover:bg-green-800/50 transition-colors disabled:opacity-50"
            >
              <CheckCircle className="w-3.5 h-3.5" />
              確認事件
            </button>
          )}
          {event.status !== 'CLOSED' && (
            <button
              onClick={() => setShowCloseDialog(true)}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-900/50 border border-red-700 text-red-300 rounded text-xs hover:bg-red-800/50 transition-colors disabled:opacity-50"
            >
              <XCircle className="w-3.5 h-3.5" />
              關閉事件
            </button>
          )}
          <button
            onClick={handleVlmAnalyze}
            disabled={actionLoading !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-900/50 border border-blue-700 text-blue-300 rounded text-xs hover:bg-blue-800/50 transition-colors disabled:opacity-50"
          >
            <Brain className="w-3.5 h-3.5" />
            {latestVlm?.status === 'COMPLETED' ? '重新分析' : '執行VLM分析'}
          </button>
          <button
            onClick={() => setShowRawJson(!showRawJson)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded text-xs hover:bg-gray-700 transition-colors"
          >
            <Code className="w-3.5 h-3.5" />
            原始JSON
          </button>
          <button
            onClick={handleExportJson}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded text-xs hover:bg-gray-700 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            匯出JSON
          </button>
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded text-xs hover:bg-gray-700 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            匯出CSV
          </button>
        </div>
      </div>

      {/* Raw JSON */}
      {showRawJson && (
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 mb-4 overflow-auto max-h-64">
          <pre className="text-xs text-green-400 font-mono whitespace-pre">
            {JSON.stringify({ event, timeline, media, vlmAnalyses }, null, 2)}
          </pre>
        </div>
      )}

      {/* A. 事件基本資料 */}
      <SectionCard title="A. 事件基本資料">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <div>
            <InfoRow label="事件代碼" value={event.event_code} mono />
            <InfoRow label="事件類型" value={event.event_type} mono />
            <InfoRow label="嚴重程度" value={event.severity} mono />
            <InfoRow label="狀態" value={event.status} mono />
            <InfoRow label="位置 (聯絡道)" value={event.taxiway_id} mono />
            <InfoRow label="攝影機" value={event.camera_id} mono />
          </div>
          <div>
            <InfoRow label="目標 ID" value={event.target_id} mono />
            <InfoRow label="目標類型" value={event.target_type} mono />
            <InfoRow label="授權狀態" value={event.authorization_state} mono />
            <InfoRow label="AI 信心度" value={event.confidence ? `${Math.round(event.confidence * 100)}%` : undefined} />
            <InfoRow label="偵測時間" value={formatDisplay(event.detected_at)} mono />
            <InfoRow label="確認時間" value={event.acknowledged_at ? formatDisplay(event.acknowledged_at) : undefined} mono />
            <InfoRow label="關閉時間" value={event.closed_at ? formatDisplay(event.closed_at) : undefined} mono />
          </div>
        </div>
        {event.resolution_note && (
          <div className="mt-3 p-3 bg-gray-800/50 rounded border border-gray-700">
            <div className="text-xs text-gray-500 mb-1">處置說明</div>
            <div className="text-sm text-gray-300">{event.resolution_note}</div>
          </div>
        )}
      </SectionCard>

      {/* B. 即時辨識結果 */}
      <SectionCard title="B. 即時辨識結果">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <InfoRow label="STM 狀態" value={event.stm_state} mono />
          <InfoRow label="RWY 保護狀態" value={event.runway_state} mono />
          <InfoRow label="聯絡道偵測時狀態" value={event.taxiway_state_at_detection} mono />
          <InfoRow label="AI 信心度" value={event.confidence ? `${Math.round(event.confidence * 100)}%` : undefined} />
        </div>
      </SectionCard>

      {/* C. 規則引擎判定 */}
      <SectionCard title="C. 規則引擎判定">
        <div className="space-y-2">
          {[
            { rule: 'STM 狀態檢查', pass: event.stm_state === 'ACTIVE', desc: `STM ${event.stm_state ?? 'N/A'} → ${event.stm_state === 'ACTIVE' ? '✓ 通過' : '✗ 未達條件'}` },
            { rule: 'RWY 保護狀態', pass: event.runway_state === 'ON', desc: `RWY ${event.runway_state ?? 'N/A'} → ${event.runway_state === 'ON' ? '✓ 已啟動' : '✗ 未啟動'}` },
            { rule: '聯絡道狀態', pass: true, desc: `偵測時聯絡道 ${event.taxiway_id ?? ''} 狀態為 ${event.taxiway_state_at_detection ?? 'N/A'}` },
            { rule: '授權核驗', pass: event.authorization_state === 'AUTHORIZED', desc: event.authorization_state === 'AUTHORIZED' ? '✓ 目標持有有效授權' : '✗ 目標未持有授權' },
            { rule: '嚴重程度判定', pass: true, desc: `依規則判定為 ${event.severity} 等級事件` },
          ].map(({ rule, pass, desc }) => (
            <div key={rule} className="flex items-start gap-3 p-2 rounded bg-gray-800/30">
              <span className={`text-sm font-mono mt-0.5 ${pass ? 'text-green-400' : 'text-red-400'}`}>
                {pass ? '✓' : '✗'}
              </span>
              <div>
                <div className="text-xs font-medium text-gray-300">{rule}</div>
                <div className="text-xs text-gray-500 mt-0.5">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* D. VLM 語意分析 */}
      <SectionCard title="D. VLM 語意分析">
        {!latestVlm ? (
          <div className="text-center py-6 text-gray-600">
            <Brain className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <div className="text-sm">尚未執行 VLM 分析</div>
            <button
              onClick={handleVlmAnalyze}
              className="mt-3 px-4 py-1.5 bg-blue-900/50 border border-blue-700 text-blue-300 rounded text-xs hover:bg-blue-800/50 transition-colors"
            >
              執行分析
            </button>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <VlmStatusBadge status={latestVlm.status} />
              <span className="text-xs text-gray-500 font-mono">
                {latestVlm.model_name} | {latestVlm.provider}
              </span>
              {latestVlm.processing_time_ms && (
                <span className="text-xs text-gray-600">{latestVlm.processing_time_ms}ms</span>
              )}
            </div>

            {latestVlm.status === 'PROCESSING' && (
              <div className="flex items-center gap-2 text-yellow-400 text-sm">
                <RefreshCw className="w-4 h-4 animate-spin" />
                VLM 分析處理中...
              </div>
            )}

            {latestVlm.status === 'FAILED' && (
              <div className="text-red-400 text-sm">
                分析失敗：{latestVlm.error_message}
              </div>
            )}

            {latestVlm.status === 'COMPLETED' && (
              <div className="space-y-3">
                {latestVlm.summary && (
                  <div className="p-3 bg-gray-800/50 rounded border border-gray-700">
                    <div className="text-xs text-gray-500 mb-1">分析摘要</div>
                    <div className="text-sm text-gray-200 leading-relaxed">{latestVlm.summary}</div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-x-8">
                  <InfoRow label="觀察目標類型" value={latestVlm.observed_target_type} />
                  <InfoRow label="觀察行為" value={latestVlm.observed_action} />
                  <InfoRow label="移動方向" value={latestVlm.observed_direction} />
                  <InfoRow label="觀察聯絡道" value={latestVlm.observed_taxiway} mono />
                  <InfoRow label="跑道進入觀察" value={latestVlm.runway_entry_observed} mono />
                  <InfoRow label="風險評估" value={latestVlm.risk_assessment} mono />
                  <InfoRow label="AI 信心度" value={latestVlm.confidence ? `${Math.round(latestVlm.confidence * 100)}%` : undefined} />
                </div>

                {latestVlm.recommended_action && (
                  <div className="p-3 bg-blue-950/30 rounded border border-blue-900/50">
                    <div className="text-xs text-blue-400 mb-1">建議行動</div>
                    <div className="text-sm text-gray-200 whitespace-pre-line">{latestVlm.recommended_action}</div>
                  </div>
                )}

                {latestVlm.evidence_json && (
                  <div>
                    <div className="text-xs text-gray-500 mb-1">分析依據</div>
                    {(JSON.parse(latestVlm.evidence_json) as string[]).map((e, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-gray-400 mb-1">
                        <span className="text-green-500 mt-0.5">•</span>
                        <span>{e}</span>
                      </div>
                    ))}
                  </div>
                )}

                {latestVlm.limitations_json && (
                  <div>
                    <div className="text-xs text-gray-500 mb-1">分析限制</div>
                    {(JSON.parse(latestVlm.limitations_json) as string[]).map((l, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-gray-500 mb-1">
                        <span className="text-yellow-600 mt-0.5">⚠</span>
                        <span>{l}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* E. 事件時間軸 */}
      <SectionCard title="E. 事件時間軸">
        <div className="space-y-3">
          {timeline.map((entry, i) => (
            <div key={entry.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="w-6 h-6 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center flex-shrink-0">
                  <TimelineSourceIcon source={entry.source_type} />
                </div>
                {i < timeline.length - 1 && <div className="w-px flex-1 bg-gray-800 mt-1 mb-1" />}
              </div>
              <div className="flex-1 pb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-gray-500">{formatDisplay(entry.occurred_at)}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                    entry.source_type === 'SYSTEM' ? 'bg-blue-900/40 text-blue-400' :
                    entry.source_type === 'OPERATOR' ? 'bg-green-900/40 text-green-400' :
                    entry.source_type === 'AI' ? 'bg-purple-900/40 text-purple-400' :
                    entry.source_type === 'VLM' ? 'bg-cyan-900/40 text-cyan-400' :
                    'bg-yellow-900/40 text-yellow-400'
                  }`}>{entry.source_type}</span>
                  <span className="text-xs text-gray-600 font-mono">{entry.action_type}</span>
                  {entry.operator_name && (
                    <span className="text-xs text-gray-500">by {entry.operator_name}</span>
                  )}
                </div>
                <div className="text-sm text-gray-300 mt-1">{entry.description}</div>
              </div>
            </div>
          ))}
          {timeline.length === 0 && (
            <div className="text-gray-600 text-sm text-center py-4">無時間軸記錄</div>
          )}
        </div>
      </SectionCard>

      {/* F. 事件影像 */}
      <SectionCard title="F. 事件影像">
        {media.length === 0 ? (
          <div className="text-gray-600 text-sm text-center py-4 flex flex-col items-center">
            <Camera className="w-8 h-8 mb-2 opacity-30" />
            無媒體檔案
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {media.map((m) => (
              <div key={m.id} className="bg-gray-800/50 rounded-lg overflow-hidden border border-gray-700">
                <div className="aspect-video bg-gray-950 flex items-center justify-center overflow-hidden">
                  {m.file_path.endsWith('.svg') ? (
                    <img
                      src={`/api/media/events/${m.file_path}`}
                      alt={m.file_name}
                      className="w-full h-full object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <div className="text-gray-700 text-xs font-mono">{m.file_name}</div>
                  )}
                </div>
                <div className="p-2">
                  <MediaTypeBadge type={m.media_type} />
                  <div className="text-xs text-gray-600 mt-1 font-mono">{m.camera_id}</div>
                  <div className="text-xs text-gray-700 font-mono">{formatDisplay(m.captured_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
