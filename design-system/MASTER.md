# RIWS Design System — MASTER
## Chimes AI — Runway Incursion Warning System

Version: 1.0.0
Target Platform: Desktop ATC Workstation (1440×900)
Theme: Industrial Control Panel (always dark)

---

## 1. Design Philosophy

RIWS is a safety-critical Air Traffic Control system. Every visual decision must:

- **Prioritize legibility** over aesthetics — operators must read status at a glance
- **Use physical metaphors** — the UI should feel like a real hardware control panel
- **Enforce color semantics** — colors are not decorative, they carry operational meaning
- **Minimize distraction** — no animations except for alarm states and critical status changes
- **Support high-stress operation** — large tap targets, clear state differentiation

This is NOT a web dashboard. It is NOT a mobile app. It is a desktop ATC industrial control interface.

---

## 2. Color Tokens

### 2.1 Background & Surface

| Token           | Hex       | Usage                                      |
|-----------------|-----------|--------------------------------------------|
| `bg-base`       | `#0a0a0a` | Main application background (near-black)   |
| `bg-surface`    | `#141414` | Dark panels, sidebar, card backgrounds     |
| `bg-panel`      | `#1a1a1a` | Control panel metal surface                |
| `bg-panel-edge` | `#222222` | Panel edge highlights for depth            |
| `bg-screw`      | `#555555` | Panel corner screw base color              |

### 2.2 Borders & Dividers

| Token             | Hex       | Usage                                    |
|-------------------|-----------|------------------------------------------|
| `border-subtle`   | `#2a2a2a` | Subtle dividers, inactive borders        |
| `border-bright`   | `#3a3a3a` | Visible dividers, active panel borders   |
| `border-section`  | `#333333` | Section separator lines on metal panels  |

### 2.3 Typography Colors

| Token            | Hex       | Usage                                     |
|------------------|-----------|-------------------------------------------|
| `text-primary`   | `#e0e0e0` | Main readable text                        |
| `text-secondary` | `#888888` | Muted labels, descriptions                |
| `text-engraved`  | `#a0a0a0` | Panel-engraved style labels (uppercase)   |
| `text-dim`       | `#555555` | Inactive labels, placeholders             |

### 2.4 Status Colors

These colors carry strict operational meaning. Do not use them decoratively.

| Token            | Hex       | Meaning                                   |
|------------------|-----------|-------------------------------------------|
| `status-yellow`  | `#FFD700` | GUARDED — taxiway is under runway protection, no authorization yet |
| `status-green`   | `#00FF88` | AUTHORIZED / STM ACTIVE / ONLINE / SUCCESS |
| `status-red`     | `#FF4444` | INCURSION — alarm state, unauthorized runway entry |
| `status-blue`    | `#4499FF` | INFO events, NEW status badge             |
| `status-gray`    | `#666666` | OFF / CLOSED / inactive                   |
| `status-purple`  | `#AA66FF` | FAULT — system fault, alternating animation |

### 2.5 Glow Effects

| Token         | Value                    | Used With       |
|---------------|--------------------------|-----------------|
| `glow-yellow` | `0 0 12px #FFD70066`     | GUARDED state   |
| `glow-green`  | `0 0 12px #00FF8866`     | ACTIVE / OK     |
| `glow-red`    | `0 0 16px #FF444488`     | INCURSION alarm |
| `glow-purple` | `0 0 12px #AA66FF66`     | FAULT state     |
| `glow-blue`   | `0 0 10px #4499FF55`     | INFO / selected |

### 2.6 Accent

| Token      | Hex       | Usage                              |
|------------|-----------|------------------------------------|
| `accent`   | `#2A5298` | Selection highlight, focus rings   |

---

## 3. Typography

### 3.1 Font Families

| Token        | Stack                                                      | Usage                             |
|--------------|------------------------------------------------------------|-----------------------------------|
| `font-panel` | `'Share Tech Mono', 'Courier New', monospace`              | Control panel labels, engraved text, taxiway IDs, RWY indicators |
| `font-ui`    | `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`   | Event center, tables, forms, general UI text |
| `font-mono`  | `'JetBrains Mono', 'Courier New', monospace`               | Event IDs, timestamps, technical codes, audit log |

Load via Google Fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

### 3.2 Type Scale

| Token         | Size  | Line Height | Usage                                |
|---------------|-------|-------------|--------------------------------------|
| `text-panel`  | 10px  | 1.2         | Panel-engraved labels (ALL CAPS, letter-spacing: 0.15em) |
| `text-xs`     | 11px  | 1.4         | Badges, secondary metadata           |
| `text-sm`     | 12px  | 1.5         | Table text, secondary labels         |
| `text-base`   | 14px  | 1.6         | Body text, form inputs               |
| `text-md`     | 16px  | 1.5         | Subheadings, prominent labels        |
| `text-lg`     | 18px  | 1.4         | Section headings                     |
| `text-xl`     | 24px  | 1.3         | Page titles                          |

### 3.3 Panel Text Rules

Panel engraved text must always:
- Be ALL CAPS
- Use `font-family: font-panel`
- Have `letter-spacing: 0.15em` minimum (up to 0.25em for titles)
- Be `text-engraved` (#a0a0a0) or `text-secondary` (#888888)
- Never exceed 11px on actual panel surfaces

---

## 4. Spacing & Layout

### 4.1 Grid

- Base unit: 4px
- Main layout: Fixed sidebar (224px / w-56) + fluid main content
- Header: 48px fixed height
- Content: fills remaining height with overflow-auto

### 4.2 Spacing Scale

| Token | Value | Usage               |
|-------|-------|---------------------|
| `1`   | 4px   | Tight gaps          |
| `2`   | 8px   | Component padding   |
| `3`   | 12px  | Standard padding    |
| `4`   | 16px  | Section padding     |
| `6`   | 24px  | Large gaps          |
| `8`   | 32px  | Section separation  |

### 4.3 Panel Layout

Control panels follow a fixed structure:
1. Panel frame with visible border and corner screws
2. Engraved title bar (top)
3. Indicator light row
4. Main content area (divided into sections)
5. Control button row (bottom)
6. Footer label bar

---

## 5. Component Patterns

### 5.1 Indicator Lights

Rectangular pills representing operational state.

**Dimensions:** ~80×32px minimum (larger for touch)
**Shape:** `border-radius: 4px`

**OFF state:**
```css
background: #1a1a1a;
border: 1px solid #333;
color: #333;
```

**ON state (varies by color):**
```css
/* Yellow - GUARDED */
background: rgba(255, 215, 0, 0.15);
border: 1px solid #FFD700;
color: #FFD700;
box-shadow: 0 0 12px #FFD70066;

/* Green - ACTIVE */
background: rgba(0, 255, 136, 0.15);
border: 1px solid #00FF88;
color: #00FF88;
box-shadow: 0 0 12px #00FF8866;

/* Red - INCURSION */
background: rgba(255, 68, 68, 0.15);
border: 1px solid #FF4444;
color: #FF4444;
box-shadow: 0 0 16px #FF444488;
```

**Glass highlight:** Add `::after` pseudo-element with semi-transparent white gradient on top half.

### 5.2 Metal Buttons

Round or rectangular buttons with physical depth illusion.

**Default (unpressed):**
```css
background: radial-gradient(circle at 40% 35%, #3a3a3a, #1a1a1a);
border: 2px solid #3a3a3a;
box-shadow: 0 4px 8px rgba(0,0,0,0.6),
            inset 0 1px 0 rgba(255,255,255,0.08),
            inset 0 -1px 0 rgba(0,0,0,0.4);
```

**Pressed (`:active`):**
```css
transform: scale(0.96) translateY(1px);
box-shadow: 0 2px 4px rgba(0,0,0,0.6),
            inset 0 2px 4px rgba(0,0,0,0.4);
```

### 5.3 Taxiway Buttons

Square buttons for individual taxiway control.

**Dimensions:** 52×52px
**Shape:** `border-radius: 8px` (rounded-lg)

| State              | Border      | Text        | Background                  | Animation         |
|--------------------|-------------|-------------|----------------------------|-------------------|
| OFF                | `#2a2a2a`   | `#555555`   | `#1a1a1a`                  | none              |
| GUARDED            | `#FFD700`   | `#FFD700`   | `rgba(255,215,0, 0.08)`    | none              |
| AUTHORIZED         | `#00FF88`   | `#00FF88`   | `rgba(0,255,136, 0.08)`    | none              |
| INCURSION_LATCHED  | `#FF4444`   | `#FF4444`   | `rgba(255,68,68, 0.15)`    | `incursion-pulse` |
| FAULT              | alternating | alternating | alternating                | `fault-flash`     |

### 5.4 Panel Frame

Container for the main control panel.

```css
.panel-metal {
  background: linear-gradient(145deg, #1e1e1e 0%, #161616 50%, #1a1a1a 100%);
  border: 1px solid #333;
  box-shadow: inset 0 1px 0 #333,
              0 0 0 2px #111,
              0 4px 20px rgba(0,0,0,0.8);
  position: relative;
}

/* Noise texture overlay */
.panel-metal::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: radial-gradient(circle, #ffffff08 1px, transparent 1px);
  background-size: 3px 3px;
  pointer-events: none;
  z-index: 0;
}
```

### 5.5 Corner Screws

Small circular elements at panel corners.

```css
.panel-screw {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #666, #333);
  border: 1px solid #555;
  display: flex;
  align-items: center;
  justify-content: center;
}
.panel-screw::before {
  content: '+';
  font-size: 10px;
  color: #444;
  font-weight: bold;
}
```

Placement: Absolute positioned at 8px from each corner of the panel frame.

### 5.6 Event Table Rows

Table rows for event center.

```css
.event-row {
  background: #141414;
  border-left: 3px solid <severity-color>;
  border-bottom: 1px solid #1e1e1e;
  transition: background 0.1s;
}
.event-row:hover {
  background: #1a1a1a;
}
```

### 5.7 Severity & Status Badges

Small pill-shaped labels.

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
```

| Badge Type    | Background              | Text      |
|---------------|-------------------------|-----------|
| RED           | `rgba(255,68,68,0.2)`   | `#FF4444` |
| YELLOW        | `rgba(255,215,0,0.2)`   | `#FFD700` |
| BLUE / INFO   | `rgba(68,153,255,0.2)`  | `#4499FF` |
| GREEN         | `rgba(0,255,136,0.2)`   | `#00FF88` |
| GRAY / CLOSED | `rgba(102,102,102,0.2)` | `#666666` |
| PURPLE        | `rgba(170,102,255,0.2)` | `#AA66FF` |

---

## 6. Animation Tokens

### 6.1 INCURSION Pulse (alarm)

```css
@keyframes incursion-pulse {
  0%, 100% { box-shadow: 0 0 8px #FF444488, 0 0 20px #FF444444; }
  50%       { box-shadow: 0 0 16px #FF4444cc, 0 0 40px #FF444466; }
}
/* Duration: 1.5s, easing: ease-in-out, iteration: infinite */
```

### 6.2 STM Initializing Blink

```css
@keyframes stm-init {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.2; }
}
/* Duration: 0.8s, easing: ease-in-out, iteration: infinite */
```

### 6.3 FAULT Flash

```css
@keyframes fault-flash {
  0%, 49% {
    background: rgba(170, 100, 255, 0.15);
    border-color: #AA66FF;
    color: #AA66FF;
  }
  50%, 100% {
    background: rgba(200, 200, 255, 0.1);
    border-color: #ccccff;
    color: #ccccff;
  }
}
/* Duration: 0.5s, timing: step-end, iteration: infinite */
```

### 6.4 Transition Defaults

- State changes: `transition: all 0.15s ease`
- Page transitions: `transition: opacity 0.1s`
- Button press: `transition: all 0.1s`
- Drawer slide: `transition: transform 0.25s ease`

---

## 7. Operational States

### 7.1 STM (Surface Traffic Monitoring) States

| State          | Indicator Color | Behavior                        |
|----------------|----------------|---------------------------------|
| `OFF`          | Off (dim)      | System inactive                 |
| `INITIALIZING` | Blinking green | 2-second startup sequence       |
| `ACTIVE`       | Solid green    | System operational              |

### 7.2 Runway Protection States

| State  | Indicator | Taxiways        |
|--------|-----------|-----------------|
| `OFF`  | Off       | All OFF         |
| `ON`   | Yellow    | All → GUARDED   |

### 7.3 Taxiway States

| State              | Operational Meaning                              |
|--------------------|--------------------------------------------------|
| `OFF`              | No monitoring active                             |
| `GUARDED`          | Runway protection active, entry not authorized   |
| `AUTHORIZED`       | ATC has authorized entry/crossing                |
| `INCURSION_LATCHED`| Unauthorized entry detected — alarm              |
| `FAULT`            | Sensor or system fault on this taxiway           |

### 7.4 Event Severity

| Level    | Meaning                                            |
|----------|----------------------------------------------------|
| `RED`    | Incursion detected — immediate action required     |
| `YELLOW` | Guard violation — potential conflict               |
| `INFO`   | System event — informational only                  |

### 7.5 Event Status

| Status         | Meaning                                 |
|----------------|-----------------------------------------|
| `NEW`          | Unacknowledged, requires operator action|
| `ACKNOWLEDGED` | Operator has confirmed awareness        |
| `CLOSED`       | Event resolved and logged               |

### 7.6 VLM Analysis Status

| Status          | Meaning                                       |
|-----------------|-----------------------------------------------|
| `NOT_REQUESTED` | No VLM analysis initiated                     |
| `PENDING`       | VLM analysis queued or in progress            |
| `COMPLETED`     | VLM analysis finished, results available      |
| `FAILED`        | VLM analysis error                            |

---

## 8. Runway Diagram Specification

SVG viewBox: `0 0 400 120`

### Elements

| Element              | Description                                     |
|----------------------|-------------------------------------------------|
| Runway rectangle     | `x=20 y=45 w=360 h=30`, fill `#2a2a2a`, stroke `#999` |
| Center dashes        | White `#ccc`, dash pattern `8,6`, along centerline |
| RWY 18 label         | Left side, panel font, `#ccc`                   |
| RWY 36 label         | Right side, panel font, `#ccc`                  |
| Taxiway lines North  | 6 lines from runway top edge going up, `#555`   |
| Taxiway lines South  | 6 lines from runway bottom edge going down, `#555` |
| Junction dots        | `r=4` circles at each taxiway/runway junction   |
| Incursion markers    | `r=6` circles, `#FF4444`, toggled by JS state   |
| Taxiway labels       | `1N`–`6N` above, `1S`–`6S` below, `#888`, 10px |

---

## 9. Page Structure

### Page 1: Live Monitor (`/monitor`)
Industrial control panel. The most critical page. Looks like physical hardware.

### Page 2: Event Center (`/events`)
Dark table view of all detected events. Sortable, filterable.

### Page 3: Event Detail (`/events/:id`)
Full detail view for a single event including VLM analysis, timeline, and imagery.

### Page 4: Audit Log (`/audit`)
System audit trail. Tabular format. All operator actions logged.

### Page 5: System Status (`/system`)
Overview of all system components and their health states.

---

## 10. Anti-Patterns (Never Do)

- NO blue neon gradients used decoratively
- NO white or light backgrounds anywhere
- NO gradient rainbow headers
- NO emoji as functional icons (use Lucide SVG icons)
- NO light mode — always dark
- NO mobile layout — this is a 1440×900 desktop application
- NO color used for decoration only — every color must carry operational meaning
- NO blinking or animation except for alarm states (INCURSION, FAULT) and system transitions (INITIALIZING)
- NO sans-serif for panel/device labels — always use panel font
- NO rounded-full badges for severity — use `border-radius: 4px` pill shapes
- NO shadows on text in body copy — only on glowing indicators

---

## 11. Iconography

Use **Lucide** icons (loaded via CDN):

| Context           | Icon Name    | Usage                        |
|-------------------|--------------|------------------------------|
| View event        | `eye`        | Action: view event detail    |
| Timeline          | `file-text`  | Action: view audit timeline  |
| Media / Camera    | `camera`     | Action: view event imagery   |
| Alert / Incursion | `alert-triangle` | Severity indicator        |
| Check             | `check`      | VLM completed, acknowledged  |
| X / Close         | `x`          | Close, cancel                |
| Activity          | `activity`   | System status, STM           |
| Wifi              | `wifi`       | Network connectivity         |
| Volume            | `volume-2`   | Audio/speaker state          |
| Volume off        | `volume-x`   | Audio muted                  |
| Settings          | `settings`   | System config                |
| Shield            | `shield`     | Runway protection / security |
| Zap               | `zap`        | Alarm, high severity         |
| Clock             | `clock`      | Timestamps, timing           |
| Filter            | `filter`     | Filter controls              |
| Search            | `search`     | Search input                 |
| Download          | `download`   | Export / download            |
| ChevronRight      | `chevron-right` | Navigation, expand        |

Load and initialize:
```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<script>lucide.createIcons();</script>
```

---

## 12. Tailwind Configuration

```javascript
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        panel: '#1a1a1a',
        'panel-edge': '#222',
        surface: '#141414',
        border: {
          DEFAULT: '#2a2a2a',
          bright: '#3a3a3a'
        },
        status: {
          yellow: '#FFD700',
          green:  '#00FF88',
          red:    '#FF4444',
          blue:   '#4499FF',
          gray:   '#666666',
          purple: '#AA66FF',
        }
      },
      fontFamily: {
        panel: ['"Share Tech Mono"', '"Courier New"', 'monospace'],
        ui:    ['Inter', 'system-ui', 'sans-serif'],
        mono:  ['"JetBrains Mono"', '"Courier New"', 'monospace'],
      }
    }
  }
}
```

---

*RIWS Design System — Chimes AI — v1.0.0*
*Last updated: 2026-06-16*
