import React, { useState, useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  Radio,
  AlertTriangle,
  FileText,
  ClipboardList,
  Settings,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { ToastContainer } from './Toast';
import { formatDisplay } from '../utils/datetime';

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

const navItems = [
  { to: '/monitor', icon: Radio, label: '即時監控', sublabel: 'Live Monitor' },
  { to: '/events', icon: AlertTriangle, label: '事件中心', sublabel: 'Event Center' },
  { to: '/audit', icon: ClipboardList, label: '操作紀錄', sublabel: 'Audit Log' },
  { to: '/system', icon: Settings, label: '系統狀態', sublabel: 'System Status' },
];

export function Layout() {
  const { state } = useAppStore();

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">
      {/* Left Sidebar */}
      <aside className="w-48 bg-gray-900 border-r border-gray-800 flex flex-col flex-shrink-0">
        {/* Logo */}
        <div className="p-4 border-b border-gray-800">
          <div className="text-xs font-bold text-yellow-400 tracking-wider">CHIMES AI</div>
          <div className="text-xs text-gray-500 mt-0.5">RIWS v1.0 DEMO</div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, icon: Icon, label, sublabel }) => (
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
          <Outlet />
        </main>
      </div>

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
}
