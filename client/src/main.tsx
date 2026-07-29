import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './stores/appStore';
import { Layout } from './components/Layout';
import { LiveMonitor } from './pages/LiveMonitor';
import { EventCenter } from './pages/EventCenter';
import { EventDetail } from './pages/EventDetail';
import { AuditLogPage } from './pages/AuditLog';
import { SystemStatus } from './pages/SystemStatus';
import { DetectorConfigPage } from './pages/DetectorConfig';
import { SocketInitializer } from './components/SocketInitializer';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <BrowserRouter>
        <SocketInitializer />
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/monitor" replace />} />
            <Route path="monitor" element={<LiveMonitor />} />
            <Route path="events" element={<EventCenter />} />
            <Route path="events/:id" element={<EventDetail />} />
            <Route path="audit" element={<AuditLogPage />} />
            <Route path="system" element={<SystemStatus />} />
            <Route path="detector" element={<DetectorConfigPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  </React.StrictMode>
);
