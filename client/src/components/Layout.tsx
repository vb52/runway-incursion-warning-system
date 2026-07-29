import React, { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Radio,
  AlertTriangle,
  FileText,
  ClipboardList,
  Settings,
  Crosshair,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { ToastContainer } from './Toast';
import { formatDisplay } from '../utils/datetime';
import { LiveMonitor } from '../pages/LiveMonitor';
import { DetectorConfigPage } from '../pages/DetectorConfig';

function Clock() {
  const [time, setTime] = useState(() => formatDisplay(new Date().toISOString()));

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(formatDisplay(new Date().toISOString()));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="font-mono text-sm text-green-400">{time}</span>
  );
}

interface NavItem {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sublabel: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

// 左側工具列分成三組，對應這個 repo 目前橫跨兩個系統（主 RIWS 後端 + RIWS-POC
// 偵測器）之後的權責邊界。之後加新頁面時請對號放進正確的分組，不要圖方便塞
// 錯地方，不然後面接手的工程師會搞不清楚哪個頁面屬於哪個系統：
//
//   1. 主戰情表 — 兩個系統共用的即時操作畫面。目前只有 LiveMonitor；如果
//      RIWS-POC 之後也要有自己的即時戰情視圖，一樣放這組。
//   2. RIWS 後台管理 — 主系統（Node/Express + SQLite + Socket.IO，本 repo
//      server/ 底下那一套狀態機）自己的管理頁面：事件中心、操作紀錄、系統
//      狀態。這些頁面完全不碰偵測器設定。
//   3. 偵測器後台管理 — RIWS-POC（Python YOLO 偵測器，獨立 repo）的管理頁
//      面。目前只有 Zone/Mask 編輯器（DetectorConfig.tsx），資料存在
//      detector_config 表（server/src/services/DetectorConfigService.ts），
//      透過 RIWS-POC/src/riws_bridge.py 跟桌面版 Python 程式互相同步。
const navGroups: NavGroup[] = [
  {
    title: '主戰情表',
    items: [
      { to: '/monitor', icon: Radio, label: '即時監控', sublabel: 'Live Monitor' },
    ],
  },
  {
    title: 'RIWS 後台管理',
    items: [
      { to: '/events', icon: AlertTriangle, label: '事件中心', sublabel: 'Event Center' },
      { to: '/audit', icon: ClipboardList, label: '操作紀錄', sublabel: 'Audit Log' },
      { to: '/system', icon: Settings, label: '系統狀態', sublabel: 'System Status' },
    ],
  },
  {
    title: '偵測器後台管理',
    items: [
      { to: '/detector', icon: Crosshair, label: '偵測器設定', sublabel: 'Detector Config' },
    ],
  },
];

export function Layout() {
  const { state } = useAppStore();
  const location = useLocation();
  // LiveMonitor and DetectorConfigPage are rendered here directly (see
  // main.tsx's comment) rather than via <Outlet/>, always mounted for the
  // life of the app and just shown/hidden by CSS depending on the route.
  // The reason is DetectorConfigPage: its AI/motion/manual detection
  // setInterval loops (client/src/pages/DetectorConfig.tsx) must keep
  // running when the operator switches to another page — a real detector
  // doesn't stop watching the runway just because someone looked away from
  // its settings screen. A normal <Route>-driven unmount would clearInterval
  // every one of those loops the instant you navigated off /detector.
  const isMonitor = location.pathname === '/' || location.pathname === '/monitor';
  const isDetector = location.pathname === '/detector';

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">
      {/* Left Sidebar */}
      <aside className="w-48 bg-gray-900 border-r border-gray-800 flex flex-col flex-shrink-0">
        {/* Logo */}
        <div className="p-4 border-b border-gray-800">
          <div className="text-xs font-bold text-yellow-400 tracking-wider">CHIMES AI</div>
          <div className="text-xs text-gray-500 mt-0.5">RIWS v1.0 DEMO</div>
        </div>

        {/* Navigation — grouped by system ownership, see navGroups comment above */}
        <nav className="flex-1 p-2 space-y-4 overflow-y-auto">
          {navGroups.map((group) => (
            <div key={group.title}>
              <div className="px-3 mb-1 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.items.map(({ to, icon: Icon, label, sublabel }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm ${
                        isActive
                          ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30'
                          : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                      }`
                    }
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    <div>
                      <div className="font-medium text-xs leading-tight">{label}</div>
                      <div className="text-xs opacity-60 leading-tight">{sublabel}</div>
                    </div>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Connection Status */}
        <div className="p-3 border-t border-gray-800">
          <div className="flex items-center gap-2 text-xs">
            {state.isConnected ? (
              <>
                <Wifi className="w-3 h-3 text-green-400" />
                <span className="text-green-400">已連線</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3 h-3 text-red-400" />
                <span className="text-red-400">未連線</span>
              </>
            )}
          </div>
          <div className="text-xs text-gray-600 mt-1">演示基地 A</div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between flex-shrink-0">
          <div>
            <h1 className="font-bold text-base text-white tracking-wide">
              Chimes AI — RIWS
            </h1>
            <p className="text-xs text-gray-400">Runway Incursion Detection & Status Management</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-xs bg-yellow-500/20 text-yellow-300 px-2 py-1 rounded border border-yellow-500/30 font-mono">
              DEMO v1.0
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">時間</span>
              <Clock />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <div className={`w-2 h-2 rounded-full ${state.isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
              <span className={state.isConnected ? 'text-green-400' : 'text-red-400'}>
                {state.isConnected ? 'CONNECTED' : 'DISCONNECTED'}
              </span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-auto">
          {/* Always mounted, CSS-toggled — see the comment on isMonitor/
              isDetector above for why. */}
          <div className="h-full" style={{ display: isMonitor ? 'block' : 'none' }}>
            <LiveMonitor />
          </div>
          <div className="h-full overflow-auto" style={{ display: isDetector ? 'block' : 'none' }}>
            <DetectorConfigPage />
          </div>
          {/* Every other page still uses normal route-driven mount/unmount. */}
          <Outlet />
        </main>
      </div>

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
}
