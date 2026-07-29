import React, { useState, useEffect } from 'react';
import { RefreshCw, Database, Wifi, HardDrive, Cpu, Activity } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { systemApi, vlmApi } from '../services/api';
import { ALL_TAXIWAY_IDS, TaxiwayControlState } from '../types';
import { formatDisplay, formatRelative } from '../utils/datetime';

function StatusCard({ title, value, sub, color = 'gray', icon }: {
  title: string;
  value: string;
  sub?: string;
  color?: 'green' | 'yellow' | 'red' | 'blue' | 'gray';
  icon?: React.ReactNode;
}) {
  const colors = {
    green: 'border-green-800 bg-green-950/30 text-green-300',
    yellow: 'border-yellow-800 bg-yellow-950/30 text-yellow-300',
    red: 'border-red-800 bg-red-950/30 text-red-300',
    blue: 'border-blue-800 bg-blue-950/30 text-blue-300',
    gray: 'border-gray-700 bg-gray-800/30 text-gray-300',
  };

  return (
    <div className={`border rounded-lg p-4 ${colors[color]}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500 uppercase tracking-wider">{title}</span>
        {icon && <div className="text-gray-600">{icon}</div>}
      </div>
      <div className="font-mono font-bold text-lg">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function TaxiwayStateColor(state: TaxiwayControlState): 'green' | 'yellow' | 'red' | 'blue' | 'gray' {
  switch (state) {
    case 'GUARDED': return 'yellow';
    case 'AUTHORIZED': return 'green';
    case 'INCURSION_LATCHED': return 'red';
    case 'FAULT': return 'yellow';
    case 'OFF': return 'gray';
    default: return 'gray';
  }
}

export function SystemStatus() {
  const { state } = useAppStore();
  const systemState = state.systemState;
  const [vlmHealth, setVlmHealth] = useState<{ health: unknown; info: unknown } | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchVlmHealth = async () => {
    try {
      const data = await vlmApi.health() as { success: boolean; data: { health: unknown; info: unknown } };
      setVlmHealth(data.data);
    } catch {}
  };

  useEffect(() => {
    fetchVlmHealth();
  }, []);

  const powerStateColor = (): 'green' | 'yellow' | 'red' | 'gray' => {
    switch (systemState?.powerState) {
      case 'ACTIVE': return 'green';
      case 'INITIALIZING': case 'SHUTTING_DOWN': return 'yellow';
      case 'FAULT': return 'red';
      default: return 'gray';
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-green-400" />
            系統狀態
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">System Status — 即時系統監控</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <div className={`w-2 h-2 rounded-full ${state.isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
            <span className={state.isConnected ? 'text-green-400' : 'text-red-400'}>
              {state.isConnected ? 'Socket.IO 已連線' : 'Socket.IO 未連線'}
            </span>
          </div>
          <button
            onClick={fetchVlmHealth}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-300 rounded hover:bg-gray-700 transition-colors text-sm"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            更新
          </button>
        </div>
      </div>

      {/* Core System Status */}
      <h2 className="text-sm font-medium text-gray-400 mb-3 uppercase tracking-wider">核心系統</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatusCard
          title="STM 狀態"
          value={systemState?.powerState ?? 'UNKNOWN'}
          sub={systemState?.startedAt ? `啟動於 ${formatRelative(systemState.startedAt)}` : undefined}
          color={powerStateColor()}
          icon={<Cpu className="w-4 h-4" />}
        />
        <StatusCard
          title="跑道保護"
          value={systemState?.runwayProtectionState ?? 'UNKNOWN'}
          sub="RWY 18/36"
          color={systemState?.runwayProtectionState === 'ON' ? 'yellow' : 'gray'}
        />
        <StatusCard
          title="Socket.IO"
          value={state.isConnected ? 'CONNECTED' : 'DISCONNECTED'}
          color={state.isConnected ? 'green' : 'red'}
          icon={<Wifi className="w-4 h-4" />}
        />
        <StatusCard
          title="VLM 分析器"
          value={(vlmHealth as { health?: { healthy?: boolean } } | null)?.health ? ((vlmHealth as { health?: { healthy?: boolean } }).health?.healthy ? 'HEALTHY' : 'UNHEALTHY') : 'CHECKING...'}
          sub={(vlmHealth as { info?: { name?: string } } | null)?.info ? (vlmHealth as { info?: { name?: string } }).info?.name : undefined}
          color={(vlmHealth as { health?: { healthy?: boolean } } | null)?.health?.healthy ? 'green' : 'yellow'}
          icon={<Cpu className="w-4 h-4" />}
        />
      </div>

      {/* Taxiway States */}
      <h2 className="text-sm font-medium text-gray-400 mb-3 uppercase tracking-wider">聯絡道狀態 (12 條)</h2>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
        {ALL_TAXIWAY_IDS.map((id) => {
          const tw = systemState?.taxiways.find((t) => t.id === id);
          const twState = tw?.state ?? 'OFF';
          return (
            <div
              key={id}
              className={`border rounded-lg p-3 text-center transition-all`}
              style={{
                borderColor: twState === 'INCURSION_LATCHED' ? '#ff3333' :
                  twState === 'AUTHORIZED' ? '#00ff88' :
                  twState === 'GUARDED' ? '#ffd700' :
                  twState === 'FAULT' ? '#ffaa00' : '#374151',
                background: twState === 'INCURSION_LATCHED' ? 'rgba(255,51,51,0.1)' :
                  twState === 'AUTHORIZED' ? 'rgba(0,255,136,0.1)' :
                  twState === 'GUARDED' ? 'rgba(255,215,0,0.1)' : 'rgba(31,41,55,0.3)',
              }}
            >
              <div className="font-mono font-bold text-base" style={{
                color: twState === 'INCURSION_LATCHED' ? '#ff3333' :
                  twState === 'AUTHORIZED' ? '#00ff88' :
                  twState === 'GUARDED' ? '#ffd700' :
                  twState === 'FAULT' ? '#ffaa00' : '#6b7280',
              }}>{id}</div>
              <div className="text-xs mt-1" style={{ color: '#6b7280' }}>{twState}</div>
            </div>
          );
        })}
      </div>

      {/* Infrastructure */}
      <h2 className="text-sm font-medium text-gray-400 mb-3 uppercase tracking-wider">基礎設施</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatusCard
          title="SQLite 資料庫"
          value="CONNECTED"
          sub="./storage/riws.db"
          color="green"
          icon={<Database className="w-4 h-4" />}
        />
        <StatusCard
          title="媒體儲存"
          value="AVAILABLE"
          sub="./storage/events (SVG)"
          color="green"
          icon={<HardDrive className="w-4 h-4" />}
        />
        <StatusCard
          title="VLM 模式"
          value={(vlmHealth as { info?: { mode?: string } } | null)?.info?.mode ?? 'CHECKING...'}
          sub="伺服器 VLM_PROVIDER 設定值"
          color="blue"
        />
      </div>

      {/* System Info */}
      <h2 className="text-sm font-medium text-gray-400 mb-3 uppercase tracking-wider">系統資訊</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <div className="text-gray-500 mb-1">系統版本</div>
            <div className="font-mono text-gray-300">RIWS v1.0.0</div>
          </div>
          <div>
            <div className="text-gray-500 mb-1">演示基地</div>
            <div className="font-mono text-gray-300">演示基地 A</div>
          </div>
          <div>
            <div className="text-gray-500 mb-1">跑道</div>
            <div className="font-mono text-gray-300">RWY 18/36</div>
          </div>
          <div>
            <div className="text-gray-500 mb-1">聯絡道數量</div>
            <div className="font-mono text-gray-300">12 (1N-6N, 1S-6S)</div>
          </div>
          <div>
            <div className="text-gray-500 mb-1">攝影機</div>
            <div className="font-mono text-gray-300">CAM-01 ~ CAM-06</div>
          </div>
          <div>
            <div className="text-gray-500 mb-1">VLM 提供者</div>
            <div className="font-mono text-gray-300">{(vlmHealth as { info?: { name?: string } } | null)?.info ? (vlmHealth as { info?: { name?: string } }).info?.name : 'Mock VLM'}</div>
          </div>
          <div>
            <div className="text-gray-500 mb-1">後端連接埠</div>
            <div className="font-mono text-gray-300">3001</div>
          </div>
          <div>
            <div className="text-gray-500 mb-1">前端連接埠</div>
            <div className="font-mono text-gray-300">5173</div>
          </div>
        </div>

        {systemState?.updatedAt && (
          <div className="mt-4 pt-4 border-t border-gray-800 text-xs text-gray-600">
            系統狀態最後更新：{formatDisplay(systemState.updatedAt)}
          </div>
        )}
      </div>

      {/* Safety Rules Summary */}
      <h2 className="text-sm font-medium text-gray-400 mb-3 mt-6 uppercase tracking-wider">安全規則摘要</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
        {[
          '聯絡道鎖定 (INCURSION_LATCHED) 時無法停止 STM',
          '聯絡道鎖定時無法關閉 RWY 保護',
          'RED 聯絡道復歸後只能回到 GUARDED，不能直接回到 AUTHORIZED',
          'VLM 分析結果不能自動解除入侵鎖定',
          '目標離開跑道不會自動重設鎖定狀態',
          'VLM 處理不能阻塞主要警報工作流程',
        ].map((rule, i) => (
          <div key={i} className="flex items-start gap-2 text-xs">
            <span className="text-yellow-500 mt-0.5">⚠</span>
            <span className="text-gray-400">{rule}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
