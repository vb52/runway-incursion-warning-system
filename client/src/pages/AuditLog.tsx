import React, { useState, useEffect } from 'react';
import { RefreshCw, Shield } from 'lucide-react';
import { auditApi } from '../services/api';
import { AuditLog, PaginatedResult } from '../types';
import { formatDisplay, formatRelative } from '../utils/datetime';

function ResultBadge({ result }: { result: string }) {
  const styles: Record<string, string> = {
    SUCCESS: 'bg-green-900/60 text-green-300 border-green-700',
    FAILED: 'bg-red-900/60 text-red-300 border-red-700',
    BLOCKED: 'bg-orange-900/60 text-orange-300 border-orange-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-mono ${styles[result] ?? 'bg-gray-800 text-gray-400 border-gray-700'}`}>
      {result}
    </span>
  );
}

export function AuditLogPage() {
  const [result, setResult] = useState<PaginatedResult<AuditLog> | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  const fetchLogs = async (p = page) => {
    setLoading(true);
    try {
      const data = await auditApi.getLogs(p, 50) as { success: boolean } & PaginatedResult<AuditLog>;
      setResult(data);
    } catch (err) {
      console.error('Failed to fetch audit logs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(page);
  }, [page]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-yellow-400" />
            操作紀錄
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Audit Log — 所有系統操作記錄（唯讀）</p>
        </div>
        <button
          onClick={() => fetchLogs(page)}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 border border-gray-700 text-gray-300 rounded hover:bg-gray-700 transition-colors text-sm"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          重新整理
        </button>
      </div>

      {result && (
        <div className="text-sm text-gray-500 mb-4">
          共 <strong className="text-gray-300">{result.total}</strong> 筆記錄 | 第 {result.page} / {result.totalPages} 頁
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-500">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" />
            載入中...
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-950">
                <th className="text-left px-3 py-3 text-gray-500 font-medium">時間</th>
                <th className="text-left px-3 py-3 text-gray-500 font-medium">操作員</th>
                <th className="text-left px-3 py-3 text-gray-500 font-medium">操作類型</th>
                <th className="text-left px-3 py-3 text-gray-500 font-medium">對象</th>
                <th className="text-left px-3 py-3 text-gray-500 font-medium">前一狀態</th>
                <th className="text-left px-3 py-3 text-gray-500 font-medium">新狀態</th>
                <th className="text-left px-3 py-3 text-gray-500 font-medium">結果</th>
                <th className="text-left px-3 py-3 text-gray-500 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {result?.data.map((log) => (
                <tr key={log.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
                  <td className="px-3 py-2.5">
                    <div className="font-mono text-gray-300">{formatDisplay(log.occurred_at)}</div>
                    <div className="text-gray-600">{formatRelative(log.occurred_at)}</div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-gray-400">
                    {log.operator_name ?? <span className="text-gray-700">SYSTEM</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="font-mono text-yellow-400/80">{log.action_type}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    {log.target_type && (
                      <span className="text-gray-400">{log.target_type}</span>
                    )}
                    {log.target_id && (
                      <span className="font-mono text-gray-500 ml-1">#{log.target_id}</span>
                    )}
                    {!log.target_type && !log.target_id && <span className="text-gray-700">—</span>}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-gray-600">
                    {log.previous_state ?? '—'}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-gray-400">
                    {log.new_state ?? '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    <ResultBadge result={log.result} />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-gray-700">
                    {log.source_ip ?? '—'}
                  </td>
                </tr>
              ))}
              {(!result || result.data.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-600">
                    沒有操作記錄
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
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded text-xs disabled:opacity-50 hover:bg-gray-700 transition-colors"
          >
            上一頁
          </button>
          <span className="text-sm text-gray-500">{page} / {result.totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(result.totalPages, p + 1))}
            disabled={page >= result.totalPages}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded text-xs disabled:opacity-50 hover:bg-gray-700 transition-colors"
          >
            下一頁
          </button>
        </div>
      )}
    </div>
  );
}
