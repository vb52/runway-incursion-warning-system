import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './stores/appStore';
import { Layout } from './components/Layout';
import { EventCenter } from './pages/EventCenter';
import { EventDetail } from './pages/EventDetail';
import { AuditLogPage } from './pages/AuditLog';
import { SystemStatus } from './pages/SystemStatus';
import { ZoneConfigPage } from './pages/ZoneConfig';
import { SocketInitializer } from './components/SocketInitializer';
import './index.css';

// "monitor" and "detector" are registered here with a null element (so
// react-router still matches the URL / drives NavLink's isActive), but
// Layout renders <LiveMonitor>/<DetectorConfigPage> itself, permanently
// mounted and just CSS-toggled by route — see Layout.tsx's comment for why:
// DetectorConfigPage's AI/motion detection loops must keep running when the
// operator navigates to another page, not stop the instant it unmounts.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <BrowserRouter>
        <SocketInitializer />
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/monitor" replace />} />
            <Route path="monitor" element={null} />
            <Route path="events" element={<EventCenter />} />
            <Route path="events/:id" element={<EventDetail />} />
            <Route path="audit" element={<AuditLogPage />} />
            <Route path="system" element={<SystemStatus />} />
            <Route path="detector" element={null} />
            <Route path="detector/zones" element={<ZoneConfigPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  </React.StrictMode>
);
