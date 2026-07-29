# RIWS — Runway Incursion Warning System

**Chimes AI 跑道入侵警告系統** — 機場地面監控 (Airport Surface Monitoring) 原型系統。

> **維護交接說明**：這份 README 是為接手工程師撰寫的完整技術說明。每個章節都假設讀者第一次看這個 repo。

---

## 目錄

1. [系統概述](#系統概述)
2. [架構總覽](#架構總覽)
3. [技術棧](#技術棧)
4. [快速啟動](#快速啟動)
5. [專案目錄結構](#專案目錄結構)
6. [核心概念](#核心概念)
7. [後端 API](#後端-api)
8. [WebSocket 事件](#websocket-事件)
9. [前端架構](#前端架構)
10. [機場地面模擬系統](#機場地面模擬系統)
11. [RIWS-POC 偵測器整合](#riws-poc-偵測器整合)
12. [VLM 視覺語意分析](#vlm-視覺語意分析)
13. [稽核日誌](#稽核日誌)
14. [環境變數](#環境變數)
15. [安全規則（禁止違反）](#安全規則禁止違反)
16. [Mock vs 正式](#mock-vs-正式)
17. [部署到正式環境](#部署到正式環境)

---

## 系統概述

RIWS 是一套跑道入侵偵測與警告系統的操作員介面原型。系統功能：

- **即時監控**：顯示跑道（RWY 18/36）與 12 條聯絡道（1N-6N, 1S-6S）的即時狀態
- **入侵告警**：當未授權目標進入 GUARDED 聯絡道時，立即鎖定（INCURSION_LATCHED）並觸發警報
- **操作員控制**：授權目標進入、人工復歸告警、啟停系統
- **事件記錄**：每次告警建立完整事件紀錄，含時間軸、影像、VLM 分析
- **稽核日誌**：所有操作員操作均留下不可刪除的稽核紀錄
- **地面模擬**：內建動態機場模擬，用於測試告警流程

系統目前以 **Demo 模式**運行（模擬偵測器輸入）。接實際硬體感測器後，只需替換 `SimulationEngine.processDetection()` 的呼叫入口。

---

## 架構總覽

```
┌─────────────────────────────────────────────────────────┐
│                    瀏覽器 (Client)                        │
│  React + TypeScript + Tailwind                          │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐ │
│  │LiveMonitor│ │EventCenter│ │AuditLog  │ │SystemStatus│ │
│  └──────────┘ └───────────┘ └──────────┘ └──────────┘ │
│  ┌─────────────────────────────────────────────────────┐│
│  │  appStore (Context + useReducer)                    ││
│  │  useSocket hook → Socket.IO client                  ││
│  └─────────────────────────────────────────────────────┘│
└────────────────────┬──────────────────┬─────────────────┘
                     │ REST API          │ Socket.IO
                     ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│                   後端 (Server)                           │
│  Node.js 24 + Express + Socket.IO                       │
│                                                         │
│  ┌───────────────────┐  ┌────────────────────────────┐  │
│  │ SystemStateService │  │    EventService             │  │
│  │  (in-memory 狀態)  │  │    (SQLite 持久化)           │  │
│  └───────────────────┘  └────────────────────────────┘  │
│  ┌───────────────────┐  ┌────────────────────────────┐  │
│  │  AuditService     │  │    VlmService               │  │
│  │  (SQLite 持久化)  │  │    (Mock / HTTP provider)   │  │
│  └───────────────────┘  └────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  SimulationEngine (Demo 情境觸發 + 規則引擎)          │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                         │
│  SQLite DB: server/storage/riws.db                      │
│  媒體檔案:  server/storage/events/                       │
└─────────────────────────────────────────────────────────┘
```

**資料流向**（正常告警循環）：

```
感測器輸入（現在是 demoApi.detect() / AirportSimPanel）
  → POST /api/demo/detect
  → SimulationEngine.processDetection()
  → SystemStateService.latchIncursion(taxiwayId)  ← 狀態鎖定
  → EventService.createEvent()                    ← 事件入庫
  → io.emit('system:state-updated')               ← 廣播
  → io.emit('event:created')
  → Client useSocket 接收 → appStore dispatch
  → React 重新渲染（紅色閃爍 + Toast + 語音告警）
  ↓
  操作員點擊聯絡道按鈕（復歸）
  → POST /api/taxiways/:id/reset
  → SystemStateService.resetTaxiway()            ← INCURSION_LATCHED → GUARDED
  → io.emit('system:state-updated')
  → 面板恢復黃色（GUARDED）
  → AirportSimPanel 偵測到狀態變化，模擬飛機倒退
```

---

## 技術棧

| 層 | 技術 | 版本 | 備註 |
|---|---|---|---|
| 前端框架 | React | 18 | TypeScript |
| 前端打包 | Vite | 5 | dev: port 5173 |
| 前端樣式 | Tailwind CSS | 3 | — |
| 後端框架 | Express | 4 | TypeScript |
| 後端執行環境 | Node.js | **24** | 必須 24+，原因見下 |
| 資料庫 | SQLite (`node:sqlite`) | 內建 | **Node.js 24 原生模組，不是 better-sqlite3** |
| 即時通訊 | Socket.IO | 4 | 雙向事件推送 |
| 圖示庫 | Lucide React | — | 前端圖示 |
| TypeScript | — | 5 | 前後端都用 |

> **為什麼必須 Node.js 24？** 後端使用 `node:sqlite`（Node.js 22.5+ 才有，24 穩定）。如果改用 better-sqlite3，需同步更新 `db.ts` 中所有 `.all()` / `.get()` / `.run()` 呼叫的 API。

---

## 快速啟動

### 前置需求

- Node.js 24+
- npm

### 第一次安裝

```bash
# 1. 安裝根目錄套件
npm install

# 2. 安裝 server 套件
cd server && npm install && cd ..

# 3. 安裝 client 套件
cd client && npm install && cd ..

# 4. 複製環境變數（預設值已可直接使用）
cp server/.env.example server/.env
```

### 啟動開發模式

```bash
# 終端機 1：後端（port 3001）
cd server && npm run dev

# 終端機 2：前端（port 5173）
cd client && npm run dev
```

開啟瀏覽器 `http://localhost:5173`。

### Windows 一鍵啟動

```
setup.bat
```

---

## 專案目錄結構

```
RIWS/
├── client/                           # 前端 React 應用
│   └── src/
│       ├── components/
│       │   ├── AirportSimPanel.tsx   # ★ 機場地面模擬動畫組件
│       │   ├── Layout.tsx            # 側邊欄 + 頁面容器
│       │   ├── SocketInitializer.tsx # Socket.IO 初始化（掛在 App 根）
│       │   └── Toast.tsx             # 浮動通知組件
│       ├── hooks/
│       │   └── useSocket.ts          # ★ WebSocket 事件 → appStore 橋接
│       ├── pages/
│       │   ├── LiveMonitor.tsx       # ★ 主控制面板（最重要的頁面，屬於「主戰情表」分組）
│       │   ├── EventCenter.tsx       # 事件列表 + 篩選（屬於「RIWS 後台管理」分組）
│       │   ├── EventDetail.tsx       # 事件詳情 + VLM 分析結果（屬於「RIWS 後台管理」分組）
│       │   ├── AuditLog.tsx          # 稽核日誌表格（屬於「RIWS 後台管理」分組）
│       │   ├── SystemStatus.tsx      # 系統健康狀態頁（屬於「RIWS 後台管理」分組）
│       │   └── DetectorConfig.tsx    # ★ RIWS-POC Zone/Mask 網頁編輯器（屬於「偵測器後台管理」分組，見下方 RIWS-POC 整合章節）
│       ├── services/
│       │   ├── api.ts                # ★ 所有 REST API 呼叫函式
│       │   ├── AudioController.ts    # 語音告警（"Check Runway"）
│       │   └── socketService.ts      # Socket.IO 客戶端初始化
│       ├── stores/
│       │   └── appStore.ts           # ★ 全域狀態（Context + useReducer）
│       └── types/
│           └── index.ts              # ★ 所有 TypeScript 型別定義
│
├── server/
│   └── src/
│       ├── index.ts                  # ★ 應用程式進入點、所有路由掛載
│       ├── database/
│       │   ├── db.ts                 # SQLite 初始化（node:sqlite）
│       │   ├── schema.ts             # 資料表 DDL
│       │   ├── migrations.ts         # Schema 版本遷移
│       │   └── seed.ts               # 開發用初始資料
│       ├── routes/                   # Express 路由（每個資源一個檔案）
│       │   ├── systemRoutes.ts       # /api/system/*
│       │   ├── runwayRoutes.ts       # /api/runway/*
│       │   ├── taxiwayRoutes.ts      # /api/taxiways/*
│       │   ├── eventRoutes.ts        # /api/events/*
│       │   ├── demoRoutes.ts         # /api/demo/*
│       │   ├── auditRoutes.ts        # /api/audit-logs
│       │   ├── vlmRoutes.ts          # /api/events/:id/vlm/*
│       │   ├── vlmHealthRoutes.ts    # /api/vlm/health
│       │   ├── mediaRoutes.ts        # /api/media/:id
│       │   ├── healthRoutes.ts       # /api/health
│       │   └── detectorRoutes.ts     # /api/detector/config — RIWS-POC 整合
│       ├── services/
│       │   ├── SystemStateService.ts # ★ 系統狀態單例（in-memory）
│       │   ├── EventService.ts       # ★ 事件 CRUD（SQLite）
│       │   ├── AuditService.ts       # 稽核日誌寫入（SQLite，只寫不刪）
│       │   └── DetectorConfigService.ts # RIWS-POC Zone/Mask 設定讀寫（SQLite，單行 JSON blob）
│       ├── simulation/
│       │   └── SimulationEngine.ts   # ★ Demo 規則引擎 + 預設情境
│       ├── socket/
│       │   └── socketHandlers.ts     # Socket.IO 連線事件處理
│       ├── vlm/
│       │   ├── VlmService.ts         # ★ VLM 佇列管理（非同步）
│       │   ├── VlmAnalysisProvider.ts # 介面定義（interface）
│       │   ├── MockVlmProvider.ts    # ★ 現在使用（假資料，不呼叫外部）
│       │   └── HttpVlmProvider.ts    # 未來接真實 VLM 用這個
│       ├── media/
│       │   └── MediaGeneratorService.ts # 生成 Demo 假影像 placeholder
│       └── types/
│           └── index.ts              # 後端 TypeScript 型別
│
├── mockups/
│   └── riws-all-pages.html           # ★ L3 互動原型（單一 HTML 檔，含完整模擬邏輯）
├── design-system/
│   └── MASTER.md                     # 設計規範（色彩、字型、元件視覺規格）
├── .env.example                      # 環境變數範本
└── README.md                         # 本文件
```

---

## 核心概念

### 1. 聯絡道狀態機

每條聯絡道（12 條：1N-6N、1S-6S）都有自己的狀態，統一由 `SystemStateService` 管理（in-memory）：

```
         STM 啟動 + RWY ON
   OFF ──────────────────────────► GUARDED
    ▲                                  │
    │ STM OFF / RWY OFF                │  操作員授權
    │                                  ▼
    │                             AUTHORIZED ◄──┐
    │                                  │         │ 撤銷授權
    │                                  │ ─────────┘
    │                                  │
    │   感測器偵測到未授權入侵          │
    │   ↓                              │
    │   INCURSION_LATCHED ◄────────────┘
    │       │
    │       │ 操作員人工復歸
    │       │ （只能到 GUARDED，不可跳 AUTHORIZED）
    └───────┘

FAULT：攝影機異常時進入此狀態
```

**關鍵安全規則**：
- `INCURSION_LATCHED → GUARDED`（復歸後要再次授權才能放行）
- 有任何 `INCURSION_LATCHED` 時，禁止 `RWY OFF` 和 `STM OFF`

### 2. 事件生命週期

```
偵測觸發
  → EventService.createEvent() → status: 'NEW'
  → 操作員確認 → status: 'ACKNOWLEDGED'
  → 操作員關閉（填寫處理備註）→ status: 'CLOSED'

每個事件包含：
  ├─ 基本欄位（聯絡道、目標類型、信心度、偵測時間）
  ├─ EventTimeline（完整操作歷程，不可刪除）
  ├─ EventMedia（偵測當下的影像截圖）
  └─ VlmAnalysis（AI 語意分析，非同步）
```

### 3. SystemStateService — 唯一狀態來源

所有系統狀態儲存在 `SystemStateService` 單例（in-memory）：
- `powerState`: `OFF | INITIALIZING | ACTIVE | FAULT | SHUTTING_DOWN`
- `runwayProtectionState`: `OFF | ON`
- `taxiways`: `Map<TaxiwayId, TaxiwayControlState>`

**重要**：伺服器重啟後，系統狀態歸零（回到 OFF）。這是刻意的安全設計——重啟後操作員必須主動重新啟動。事件和稽核日誌透過 SQLite 持久化，不受影響。

### 4. Socket.IO 即時推送原則

前端**不輪詢**。後端每次狀態改變，主動透過 Socket.IO 廣播。客戶端的 `useSocket` hook 接收廣播並更新 `appStore`，React 自動重渲染。

---

## 後端 API

所有路徑前綴 `/api`，統一回傳格式：
```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "錯誤訊息" }
```

### 系統控制

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/api/health` | 伺服器健康檢查 |
| `GET` | `/api/system/state` | 取得完整系統狀態（含所有聯絡道） |
| `POST` | `/api/system/start` | 啟動 STM → INITIALIZING，1.5 秒後 ACTIVE |
| `POST` | `/api/system/stop` | 停止 STM（有未復歸入侵時拒絕） |

### 跑道控制

| Method | Path | 說明 |
|--------|------|------|
| `POST` | `/api/runway/enable` | 開啟跑道保護（所有 OFF 聯絡道 → GUARDED） |
| `POST` | `/api/runway/disable` | 關閉跑道保護（有未復歸入侵時拒絕） |

### 聯絡道控制

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/api/taxiways` | 取得所有 12 條聯絡道狀態 |
| `POST` | `/api/taxiways/:id/authorize` | 授權聯絡道（GUARDED → AUTHORIZED） |
| `POST` | `/api/taxiways/:id/revoke` | 撤銷授權（AUTHORIZED → GUARDED） |
| `POST` | `/api/taxiways/:id/reset` | 人工復歸（INCURSION_LATCHED → GUARDED） |

### 事件

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/api/events` | 事件列表（`?severity=RED&status=NEW&page=1&pageSize=20`） |
| `GET` | `/api/events/:id` | 事件詳情 |
| `PATCH` | `/api/events/:id/acknowledge` | 確認事件（`{ operator_name }` in body） |
| `PATCH` | `/api/events/:id/close` | 關閉事件（`{ operator_name, resolution_note }`） |
| `POST` | `/api/events/:id/timeline` | 手動追加時間軸 |
| `GET` | `/api/events/:id/media` | 取得媒體清單 |
| `POST` | `/api/events/:id/vlm/analyze` | 觸發 VLM 分析（非同步，結果透過 WebSocket 推送） |

### Demo / 模擬觸發

| Method | Path | 說明 |
|--------|------|------|
| `POST` | `/api/demo/detect` | 手動觸發偵測（`{ taxiway_id, target_type, entering_runway, confidence }`） |
| `POST` | `/api/demo/scenarios/:id/trigger` | 觸發預設情境（見下方） |
| `POST` | `/api/demo/reset` | 清除所有事件 + 重設系統狀態 |

**預設情境 ID**：

| ID | 說明 |
|----|------|
| `system-start` | 啟動 STM |
| `rwy-on-all-yellow` | 開啟 RWY 保護（全聯絡道黃色） |
| `1s-authorize` | 授權 1S |
| `1s-revoke` | 撤銷 1S 授權 |
| `1s-authorized-entry` | 1S 已授權目標進入（INFO 事件） |
| `1n-unauthorized-incursion` | 1N 未授權入侵（RED 告警） |
| `1n-manual-reset` | 1N 人工復歸 |
| `multi-incursion` | 多重入侵 1N + 3S |
| `camera-fault` | 攝影機 CAM-02 異常（YELLOW 事件） |
| `vlm-fail` | VLM 分析失敗情境 |
| `system-reset` | 全部重設 |

### 偵測器設定（RIWS-POC 整合）

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/api/detector/config` | 取得目前的 Zone A/B/C + Mask 設定 |
| `PUT` | `/api/detector/config` | 更新 Zone/Mask 設定（`{ frame_w, frame_h, zones, masks }`） |

這兩支 API 是 client 的「偵測器後台管理 → 偵測器設定」頁面（`DetectorConfig.tsx`）與 RIWS-POC（Python 偵測器，另一個獨立 repo）共用的設定同步點，詳見下方「[RIWS-POC 偵測器整合](#riws-poc-偵測器整合)」章節。

### 稽核日誌

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/api/audit-logs?page=1&pageSize=50` | 稽核日誌分頁（按時間倒序） |

---

## WebSocket 事件

### 伺服器 → 客戶端（廣播）

| 事件名稱 | Payload 結構 | 觸發時機 |
|---------|-------------|---------|
| `system:state-updated` | `{ systemState: SystemState }` | 任何系統狀態改變 |
| `taxiway:state-updated` | `{ taxiway: { id, state } }` | 單一聯絡道狀態改變 |
| `runway:state-updated` | `{ runwayProtectionState }` | 跑道保護開關 |
| `event:created` | `{ event: RiwsEvent }` | 新事件建立 |
| `event:updated` | `{ event: RiwsEvent }` | 事件確認/關閉 |
| `vlm:updated` | `{ eventId, analysis: VlmAnalysis }` | VLM 分析進度更新 |

### 客戶端 → 伺服器

| 事件名稱 | 說明 |
|---------|------|
| `system:request-state` | 請求完整系統狀態（連線建立後自動發送） |

---

## 前端架構

### 全域狀態（appStore）

`client/src/stores/appStore.ts` — Context + useReducer 模式：

```typescript
// 狀態結構
AppState {
  systemState: SystemState | null   // 來自 WebSocket，含所有聯絡道狀態
  events: RiwsEvent[]               // 事件列表
  isConnected: boolean              // WebSocket 連線狀態
  audioEnabled: boolean             // 語音告警開關
  toasts: ToastMessage[]            // 浮動通知佇列
}

// 使用方式
const { state, dispatch, addToast } = useAppStore();
state.systemState?.taxiways         // 讀取聯絡道狀態
dispatch({ type: 'SET_SYSTEM_STATE', payload: newState })
addToast({ type: 'error', title: '告警', duration: 5000 })
```

### WebSocket 橋接（useSocket）

`client/src/hooks/useSocket.ts` 掛載在 app 根層，接收 Socket.IO 事件並 dispatch 到 appStore：

```
WebSocket event 'system:state-updated'
  → dispatch({ type: 'SET_SYSTEM_STATE', payload: data.systemState })

WebSocket event 'event:created'
  → dispatch({ type: 'ADD_EVENT', payload: data.event })
  → addToast(...)
  → playCheckRunway(...)   ← 語音告警（RED 事件才播放）

WebSocket event 'taxiway:state-updated'
  → dispatch({ type: 'UPDATE_TAXIWAY', payload: data.taxiway })
```

### API 服務層

`client/src/services/api.ts` — 統一管理所有 REST 呼叫：

```typescript
// 新增 API 呼叫的標準模式
export const myApi = {
  doSomething: (id: string) =>
    apiCall<{ success: boolean; data: YourType }>(`/your-path/${id}`, {
      method: 'POST',
      body: JSON.stringify({ key: 'value' }),
    }),
};
```

### 頁面導覽

`Layout.tsx` 提供左側工具列（react-router-dom 的 `NavLink`/`Outlet`，不是純 state 切換），分成三個群組，對應目前這個 repo 橫跨的兩個系統：

1. **主戰情表** — 兩個系統共用的即時操作畫面，目前只有 `LiveMonitor`。
2. **RIWS 後台管理** — 主系統（本 repo `server/`）自己的管理頁面：事件中心、操作紀錄、系統狀態。
3. **偵測器後台管理** — RIWS-POC（Python YOLO 偵測器，獨立 repo）的管理頁面，目前只有 `DetectorConfig.tsx`。

新增頁面時請對號放進正確分組（`Layout.tsx` 裡的 `navGroups` 常數有詳細註解），不要因為省事就塞錯地方。

---

## 機場地面模擬系統

`client/src/components/AirportSimPanel.tsx` — 純前端視覺模擬，呼叫真實後端 API。

### 設計原理（重要）

模擬動畫與後端**完全解耦**：

```
前端 requestAnimationFrame loop
  → 飛機到達 GUARDED 聯絡道口
  → 呼叫 demoApi.detect({ taxiway_id, entering_runway: true })
                    ↓
            後端處理告警邏輯
            （建立事件、鎖定聯絡道、WebSocket 廣播）
                    ↓
  ← WebSocket 'taxiway:state-updated'
  ← 模擬面板讀取新狀態（聯絡道口指示點變紅）
  ← 操作員在主面板點擊復歸
  ← WebSocket 推送狀態回 GUARDED
  ← 飛機偵測到狀態不再是 INCURSION_LATCHED，開始倒退
```

### 飛行器類型

沒有固定時間表的背景車流——每台車輛都是隨選生成（見下方「生成方式」），不會自己排隊出現。

| 類型 | 代號前綴 | 流程 |
|------|---------|------|
| 出發 `DEPART` | `D`（DEMO START）/ `Z`（偵測觸發） | 停機坪 → 滑行 → 聯絡道口 → 進跑道 → 真正起飛動畫（滑跑 → 加速 → 抬頭 → 離地 → 爬升離開畫面，見 `TAKEOFF_KEYFRAMES`），不是單純水平穿越 |
| 地面車輛 `VEHICLE` | `D`（DEMO START）/ `Z`（偵測觸發） | 停機坪 → 滑行至聯絡道附近 → 停留 → 返回 |

`LAND`（降落）型別仍保留在型別定義中，但目前兩個生成入口都不會建立它——DEMO START 和偵測觸發都是「從停機坪滑出」的情境，降落機是直接出現在跑道上，語意不合。

### 生成方式

| 方式 | 觸發點 | 說明 |
|------|--------|------|
| `spawnDemoVehicle` | 面板上的「DEMO START」按鈕 | 隨機挑一個目前空著的聯絡道口，生成一台車 |
| `spawnAtTaxiway` | Socket `sim:spawn-at-taxiway`（見 `socketHandlers.ts`） | 偵測器（`DetectorConfig.tsx` 的動態偵測）回報「某聯絡道有飛機」時，在對應聯絡道口生成一台車，讓模擬畫面跟真實影片偵測對得起來 |

兩種都是一次性（one-shot）：完成流程（起飛/返場）後直接從陣列移除，不會遞迴重生。曾經有第三種「腳本化機隊」（固定時間表自動生成 A1-A6/L1-L3/V1-V3），因為會在背景持續產生入侵告警、干擾操作員判斷是否為真實偵測觸發而移除。

### 速度調整

```typescript
// AirportSimPanel.tsx 第 16 行
const SIM_SPD = {
  taxi: 0.026,    // 1/0.026 ≈ 38 秒滑行
  enter: 0.22,    // 1/0.22 ≈ 4.5 秒進跑道
  takeoff: 0.083, // 1/0.083 ≈ 12 秒起飛滑跑
  land: 0.028,    // 1/0.028 ≈ 36 秒降落滑跑
  vacate: 0.22,   // 1/0.22 ≈ 4.5 秒離跑
  svc: 0.022,     // 1/0.022 ≈ 45 秒車輛行駛
};
```

---

## RIWS-POC 偵測器整合

`runway-incursion-warning-system`（本 repo，操作員介面 + 狀態機）與 `RIWS-POC`（獨立 repo，Python + YOLOv8 即時偵測器，吃 YouTube 直播串流）是兩個分開開發、分開部署的專案，透過 HTTP 串接：

```
RIWS-POC (Python, 獨立進程/獨立機器亦可)
  ├─ src/riws_poc.py     — YOLO + 背景消去偵測迴圈，桌面 OpenCV 視窗
  └─ src/riws_bridge.py  — 對本系統的 HTTP client
        │
        │ POST /api/demo/detect      （偵測觸發，30 秒/聯絡道防洗版）
        │ GET/PUT /api/detector/config （Zone/Mask 設定同步）
        ▼
RIWS (本 repo, Node/Express + SQLite)
  ├─ server/src/routes/demoRoutes.ts     — 既有端點，未改動，繼續吃 AirportSimPanel 的模擬輸入
  ├─ server/src/routes/detectorRoutes.ts — 新增，Zone/Mask 設定的唯一資料來源
  └─ client/src/pages/DetectorConfig.tsx — 網頁版 Zone/Mask 編輯器（左側工具列「偵測器後台管理」）
```

**關鍵設計決定**：

- **Zone ≠ Taxiway**：RIWS-POC 的 Zone A/B/C 是任意畫面區域，跟本系統虛構的 12 條聯絡道（1N-6N/1S-6S）沒有物理對應。映射寫死在 `RIWS-POC/src/riws_bridge.py` 的 `ZONE_TAXIWAY_MAP`（預設 `A→1N, B→3S, C→5N`），純粹是 demo 情境設定，改 dict 即可調整。
- **主系統是設定的唯一真相來源**：Zone/Mask 設定存在本系統的 `detector_config` SQLite 表（`DetectorConfigService.ts`）。RIWS-POC 啟動時用 `fetch_config()` 讀取，桌面端存檔時用 `push_config()` 寫回；本機 `output/layout.json` 只是離線備援快取。兩邊都能編輯，後存的會覆蓋前者，沒有欄位級合併。
- **完全選配、互不阻塞**：這兩個 repo 各自能獨立運作。RIWS-POC 連不到本系統時，`riws_bridge.py` 只印一次警告然後繼續用本機快取；本系統開發/測試時完全不需要 RIWS-POC 在跑，`AirportSimPanel` 的模擬輸入路徑沒有任何改動。
- **既有安全規則沒有被繞過**：`POST /api/demo/detect` 仍然要求 STM ACTIVE + RWY 保護 ON 才會處理偵測（見下方安全規則章節），`riws_bridge.py` 不會、也不能繞過這個檢查。

---

## VLM 視覺語意分析

每個 RED 事件，系統自動非同步觸發 VLM 分析，對影像進行語意描述。

### Provider 架構（Strategy Pattern）

| Provider | `VLM_PROVIDER=` | 說明 |
|---------|----------------|------|
| `MockVlmProvider` | `mock` | **現在使用**，回傳假結果，不呼叫外部 API |
| `HttpVlmProvider` | `http` | 呼叫外部 VLM HTTP API（Anthropic、OpenAI Vision 等） |

### 切換到真實 VLM

在 `server/.env` 設定：
```bash
VLM_PROVIDER=http
VLM_API_URL=https://api.anthropic.com/v1/messages
VLM_API_KEY=sk-ant-xxxxx      # 從環境變數讀，絕不寫在程式碼裡
VLM_MODEL=claude-opus-4-8
```

只需改這四個環境變數，其餘程式碼不需動。`HttpVlmProvider.ts` 已實作 `VlmAnalysisProvider` 介面。

### 安全限制（不可違反）

- VLM 分析結果**絕對不能**自動解除 `INCURSION_LATCHED`
- VLM 僅作為輔助資訊供操作員參考
- VLM 影像**不傳送到任何公開外部服務**（只用設定的 `VLM_API_URL`）

---

## 稽核日誌

`AuditService` 記錄所有狀態改變，存入 `audit_logs` 資料表。

### 特性

- **僅追加**（append-only）：沒有提供刪除 API，稽核紀錄永久保留
- 記錄欄位：`operator_name`、`action_type`、`target_type`、`target_id`、`previous_state`、`new_state`、`result`、`source_ip`、`occurred_at`

### 自動記錄的操作

| 操作 | `action_type` |
|------|--------------|
| 啟動 STM | `SYSTEM_START` |
| 停止 STM | `SYSTEM_STOP` |
| 開啟 RWY 保護 | `RUNWAY_ENABLE` |
| 關閉 RWY 保護 | `RUNWAY_DISABLE` |
| 授權聯絡道 | `TAXIWAY_AUTHORIZE` |
| 撤銷授權 | `TAXIWAY_REVOKE` |
| 鎖定入侵 | `INCURSION_LATCHED` |
| 人工復歸 | `TAXIWAY_RESET` |
| 觸發 Demo 情境 | `DEMO_SCENARIO_TRIGGER` |
| Demo 重設 | `DEMO_RESET` |

---

## 環境變數

複製 `.env.example` 為 `server/.env`：

```bash
# 伺服器
PORT=3001
NODE_ENV=development
LOG_LEVEL=info           # debug | info | warn | error
DEBUG_MODE=false         # true 時記錄所有 HTTP 請求

# 資料庫（路徑相對於 server/ 目錄）
DB_PATH=./storage/riws.db

# 媒體儲存（Demo 假影像）
MEDIA_STORAGE_PATH=./storage/events

# VLM 設定
VLM_PROVIDER=mock        # mock | http
VLM_API_URL=             # http 模式必填
VLM_API_KEY=             # http 模式必填，不得 commit 此值
VLM_MODEL=               # 例如 claude-opus-4-8
VLM_TIMEOUT_MS=15000
VLM_PROMPT_VERSION=riws-v1

# 行為設定
REQUIRE_AUTHORIZATION_CONFIRMATION=false
REQUIRE_RESET_CONFIRMATION=false
AUTO_CLOSE_EVENT_ON_PANEL_RESET=true
INCURSION_FLASH_MODE=steady
```

---

## 安全規則（禁止違反）

這些規則直接影響系統安全性，程式碼中有明確的 `// SAFETY:` 注解標記：

**1. VLM 結果絕不自動解除鎖定**
> `VlmService.ts` — VLM 分析僅提供資訊，不觸發任何狀態改變

**2. 入侵復歸只能到 GUARDED**
> `SystemStateService.resetTaxiway()` — `INCURSION_LATCHED → GUARDED`（不可跳 AUTHORIZED）

**3. 有未復歸入侵時禁止關閉保護**
> `SystemStateService.disableRunwayProtection()` 和 `stopSystem()` 都有此檢查

**4. API 金鑰不寫死**
> 所有敏感值只從環境變數讀取，`server/.env` 在 `.gitignore` 中

**5. UI 資安限制**
> 禁止使用：真實軍事基地名稱、真實跑道位置、真實地理座標、真實軍事設備編號

---

## Mock vs 正式

| 功能 | 目前狀態（Mock） | 接正式的步驟 |
|------|----------------|-------------|
| **感測器輸入** | `AirportSimPanel` 前端模擬 + `demoApi.detect()` | 已有選配的真實路徑：`RIWS-POC`（獨立 repo，YOLOv8 偵測器）透過 `riws_bridge.py` 呼叫同一個 `POST /api/demo/detect`，見「[RIWS-POC 偵測器整合](#riws-poc-偵測器整合)」。要接其他硬體感測器一樣呼叫這個入口，或直接呼叫 `SimulationEngine.processDetection()` |
| **影像/影片** | `MediaGeneratorService` 生成 placeholder 圖片 | 替換 `MediaGeneratorService` 邏輯，儲存真實 CCTV 截圖 |
| **VLM 分析** | `MockVlmProvider` 回傳假結果 | 設定 `VLM_PROVIDER=http` + 填入 `VLM_API_URL` / `VLM_API_KEY` |
| **操作員身份** | 硬寫 `'ATC-01'` / `'OPR-001'` | 接入 JWT/Session 認證，從 token 取得操作員 ID |
| **地面模擬面板** | 純前端展示 | 可保留作為訓練/展示工具（不影響正式告警流程） |
| **資料庫** | 本地 SQLite 單檔 | 可換成 PostgreSQL（需重寫 `db.ts` 和 `EventService` 的查詢語法） |

---

## 部署到正式環境

### Build

```bash
# 打包前端
cd client && npm run build

# 編譯後端 TypeScript
cd server && npm run build
```

### 啟動正式服務

```bash
NODE_ENV=production PORT=3001 node server/dist/index.js
```

前端靜態檔案由 Express 服務（`client/dist/` → Express static）。

### 注意事項

- `server/storage/riws.db` 需確保有寫入權限
- `server/storage/events/` 隨時間增長，規劃磁碟空間或定期清理
- `SystemStateService` 是 in-memory，**伺服器重啟後系統狀態歸零**（刻意設計）
- 生產環境設定 `VLM_API_KEY`，確認不出現在程式碼或 git history 中

---

## 互動原型（Mockup）

`mockups/riws-all-pages.html` — 單一 HTML 檔，包含完整的互動原型：
- 所有頁面的靜態 UI
- 聯絡道狀態機的前端模擬
- 機場地面模擬動畫（與正式版共用相同邏輯）
- 所有模擬函式都有 `// MOCKUP: DELETE` 注解，說明如何替換為真實 API

---

## 設計系統

`design-system/MASTER.md` 包含：
- 色彩規範（告警色、狀態色、背景色）
- 字型規範（Share Tech Mono 工業風面板字體）
- 工業金屬面板 UI 設計語言
- 各狀態的視覺規格（邊框、光暈、動畫）

---

*文件版本：2026-06-23*
*原始開發：Chimes AI Team*
*如有疑問：vb890221@gmail.com*
