import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Eye, FileText, RefreshCw, Filter } from 'lucide-react';
import { eventsApi, EventsQuery } from '../services/api';
import { RiwsEvent, EventSeverity, EventStatus, TargetType, ALL_TAXIWAY_IDS, PaginatedResult } from '../types';
import { formatDisplay, formatRelative } from '../utils/datetime';

// ── Badge Components ───────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: EventSeverity }) {
  const styles: Record<EventSeverity, string> = {
    INFO: 'bg-blue-900/60 text-blue-300 border-blue-700',
    YELLOW: 'bg-yellow-900/60 text-yellow-300 border-yellow-700',
    RED: 'bg-red-900/60 text-red-300 border-red-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-mono font-bold ${styles[severity]}`}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: EventStatus }) {
  const styles: Record<EventStatus, string> = {
    NEW: 'bg-blue-900/60 text-blue-300 border-blue-700',
    ACKNOWLEDGED: 'bg-green-900/60 text-green-300 border-green-700',
    CLOSED: 'bg-gray-800/60 text-gray-500 border-gray-700',
  };
  const labels: Record<EventStatus, string> = {
    NEW: '新事件',
    ACKNOWLEDGED: '已確認',
    CLOSED: '已關閉',
  };
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-mono ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function VlmStatusBadge({ eventId }: { eventId: string }) {
  // Simplified - just show icon
  return (
    <span className="text-xs text-gray-600 font-mono">—</span>
  );
}

function EventTypeLabel({ type }: { type: string }) {
  const labels: Record<string, string> = {
    AUTHORIZED_ENTRY: '授權進入',
    UNAUTHORIZED_APPROACH: '未授權接近',
    RUNWAY_INCURSION: '跑道入侵',
    SYSTEM_FAULT: '系統異常',
    CAMERA_FAULT: '攝影機異常',
  };
  return <span>{labels[type] ?? type}</span>;
}

function TargetTypeLabel({ type }: { type?: string }) {
  if (!type) return <span className="text-gray-600">—</span>;
  const labels: Record<string, string> = {
    VEHICLE: '車輛',
    PERSON: '人員',
    AIRCRAFT: '航空器',
    ANIMAL: '動物',
    UNKNOWN: '不明',
  };
  return <span>{labels[type] ?? type}</span>;
}

// ── Main Component ─────────────────────────────────────────────────────────

export function EventCenter() {
  const [result, setResult] = useState<PaginatedResult<RiwsEvent> | null>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<EventsQuery>({
    page: 1,
    pageSize: 20,
  });

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await eventsApi.getAll(filters) as { success: boolean } & PaginatedResult<RiwsEvent>;
      setResult(data);
    } catch (err) {
      console.error('Failed to fetch events:', err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const updateFilter = (key: keyof EventsQuery, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined, page: 1 }));
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">事件中心</h1>
          <p className="text-sm text-gray-500 mt-0.5">Event Center — 所有跑道入侵事件記錄</p>
        </div>
        <button
          onClick={fetchEvents}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 border border-gray-700 text-gray-300 rounded hover:bg-gray-700 transition-colors text-sm"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          重新整理
        </button>
      </div>

      {/* Filters */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-gray-500" />
          <span className="text-sm text-gray-400 font-medium">篩選條件</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">嚴重程度</label>
            <select
              className="w-full bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1.5 text-xs"
              value={filters.severity ?? ''}
              onChange={(e) => updateFilter('severity', e.target.value)}
            >
              <option value="">全部</option>
              <option value="RED">RED</option>
              <option value="YELLOW">YELLOW</option>
              <option value="INFO">INFO</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">狀態</label>
            <select
              className="w-full bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1.5 text-xs"
              value={filters.status ?? ''}
              onChange={(e) => updateFilter('status', e.target.value)}
            >
              <option value="">全部</option>
              <option value="NEW">新事件</option>
              <option value="ACKNOWLEDGED">已確認</option>
              <option value="CLOSED">已關閉</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">位置</label>
            <select
              className="w-full bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1.5 text-xs"
              value={filters.taxiway_id ?? ''}
              onChange={(e) => updateFilter('taxiway_id', e.target.value)}
            >
              <option value="">全部聯絡道</option>
              {ALL_TAXIWAY_IDS.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">目標類型</label>
            <select
              className="w-full bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1.5 text-xs"
              value={filters.target_type ?? ''}
              onChange={(e) => updateFilter('target_type', e.target.value)}
            >
              <option value="">全部</option>
              <option value="VEHICLE">車輛</option>
              <option value="PERSON">人員</option>
              <option value="AIRCRAFT">航空器</option>
              <option value="ANIMAL">動物</option>
              <option value="UNKNOWN">不明</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">事件類型</label>
            <select
              className="w-full bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1.5 text-xs"
              value={filters.event_type ?? ''}
              onChange={(e) => updateFilter('event_type', e.target.value)}
            >
              <option value="">全部</option>
              <option value="RUNWAY_INCURSION">跑道入侵</option>
              <option value="UNAUTHORIZED_APPROACH">未授權接近</option>
              <option value="AUTHORIZED_ENTRY">授權進入</option>
              <option value="CAMERA_FAULT">攝影機異常</option>
              <option value="SYSTEM_FAULT">系統異常</option>
            </select>
          </div>
          <div className="flex items-end">
            <button
              onClick={() => setFilters({ page: 1, pageSize: 20 })}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded text-xs hover:bg-gray-700 transition-colors"
            >
              清除篩選
            </button>
          </div>
        </div>
      </div>

      {/* Stats */}
      {result && (
        <div className="flex items-center gap-4 mb-4 text-sm text-gray-500">
          <span>共 <strong className="text-gray-300">{result.total}</strong> 筆事件</span>
          <span>第 {result.page} / {result.totalPages} 頁</span>
        </div>
      )}

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-500">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" />
            載入中...
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-950">
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">EVENT ID</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">偵測時間</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">位置</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">目標</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">類型</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">嚴重程度</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">狀態</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">攝影機</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {result?.data.map((event, idx) => (
                <tr
                  key={event.id}
                  className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
                    event.severity === 'RED' && event.status === 'NEW' ? 'bg-red-950/20' :
                    event.severity === 'YELLOW' && event.status === 'NEW' ? 'bg-yellow-950/10' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-yellow-400">{event.event_code}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-gray-300">{formatDisplay(event.detected_at)}</div>
                    <div className="text-xs text-gray-600">{formatRelative(event.detected_at)}</div>
                  </td>
                  <td className="px-4 py-3">
                    {event.taxiway_id ? (
                      <span className="font-mono text-sm text-blue-300">{event.taxiway_id}</span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-gray-300">{event.target_id ?? '—'}</div>
                    <div className="text-xs text-gray-600">
                      <TargetTypeLabel type={event.target_type} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    <EventTypeLabel type={event.event_type} />
                  </td>
                  <td className="px-4 py-3">
                    <SeverityBadge severity={event.severity} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={event.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                    {event.camera_id ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/events/${event.id}`}
                        className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors rounded hover:bg-blue-900/20"
                        title="查看詳情"
                      >
                        <Eye className="w-4 h-4" />
                      </Link>
                      <Link
                        to={`/events/${event.id}`}
                        className="p-1.5 text-gray-500 hover:text-green-400 transition-colors rounded hover:bg-green-900/20"
                        title="查看時間軸"
                      >
                        <FileText className="w-4 h-4" />
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {(!result || result.data.length === 0) && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-600">
                    沒有符合條件的事件記錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {result && result.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            onClick={() => setFilters((p) => ({ ...p, page: Math.max(1, (p.page ?? 1) - 1) }))}
            disabled={(filters.page ?? 1) <= 1}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded text-xs disabled:opacity-50 hover:bg-gray-700 transition-colors"
          >
            上一頁
          </button>
          <span className="text-sm text-gray-500">
            {filters.page} / {result.totalPages}
          </span>
          <button
            onClick={() => setFilters((p) => ({ ...p, page: Math.min(result.totalPages, (p.page ?? 1) + 1) }))}
            disabled={(filters.page ?? 1) >= result.totalPages}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded text-xs disabled:opacity-50 hover:bg-gray-700 transition-colors"
          >
            下一頁
          </button>
        </div>
      )}
    </div>
  );
}
