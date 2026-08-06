import fs from 'fs';
import path from 'path';
import { RiwsEvent, MediaType } from '../types';
import { formatDisplay, nowIso, offsetMs } from '../utils/datetime';
import { logger } from '../utils/logger';

// MOCK: Generates SVG simulation images for demo purposes.
// INTEGRATION: Replace with actual camera snapshot retrieval and video clip extraction.

const STORAGE_BASE = process.env.MEDIA_STORAGE_PATH || './storage/events';

function getAbsoluteStorageBase(): string {
  return path.isAbsolute(STORAGE_BASE)
    ? STORAGE_BASE
    : path.join(process.cwd(), STORAGE_BASE);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getTargetLabel(targetType?: string): string {
  const labels: Record<string, string> = {
    VEHICLE: '車輛',
    PERSON: '人員',
    AIRCRAFT: '航空器',
    ANIMAL: '動物',
    UNKNOWN: '不明目標',
  };
  return targetType ? labels[targetType] ?? targetType : '不明目標';
}

function generateSvgContent(params: {
  title: string;
  cameraId: string;
  datetime: string;
  taxiwayId: string;
  targetId: string;
  targetType: string;
  confidence: number;
  showBoundingBox: boolean;
  incursionStatus: string;
  isIncursion: boolean;
  frameColor: string;
  frameLabel: string;
}): string {
  const {
    title,
    cameraId,
    datetime,
    taxiwayId,
    targetId,
    targetType,
    confidence,
    showBoundingBox,
    incursionStatus,
    isIncursion,
    frameColor,
    frameLabel,
  } = params;

  const width = 640;
  const height = 480;

  // Background colors based on state
  const bgColor = isIncursion ? '#1a0000' : '#0a0a14';
  const gridColor = isIncursion ? '#330000' : '#111133';
  const runwayColor = '#3a3a3a';
  const runwayMarkingColor = '#cccccc';

  // Bounding box for target (center of frame)
  const bbX = 220;
  const bbY = 180;
  const bbW = 200;
  const bbH = 120;
  const bbColor = isIncursion ? '#ff3333' : '#00ff88';

  // Build grid lines SVG
  const gridLines: string[] = [];
  for (let x = 0; x <= width; x += 40) {
    gridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${gridColor}" stroke-width="1"/>`);
  }
  for (let y = 0; y <= height; y += 40) {
    gridLines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${gridColor}" stroke-width="1"/>`);
  }

  const boundingBoxSvg = showBoundingBox
    ? `
    <!-- Target Bounding Box -->
    <rect x="${bbX}" y="${bbY}" width="${bbW}" height="${bbH}"
      fill="none" stroke="${bbColor}" stroke-width="3"
      stroke-dasharray="${isIncursion ? '' : '8,4'}">
      ${isIncursion ? '<animate attributeName="stroke-opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite"/>' : ''}
    </rect>
    <!-- Corner marks -->
    <line x1="${bbX}" y1="${bbY}" x2="${bbX + 20}" y2="${bbY}" stroke="${bbColor}" stroke-width="4"/>
    <line x1="${bbX}" y1="${bbY}" x2="${bbX}" y2="${bbY + 20}" stroke="${bbColor}" stroke-width="4"/>
    <line x1="${bbX + bbW}" y1="${bbY}" x2="${bbX + bbW - 20}" y2="${bbY}" stroke="${bbColor}" stroke-width="4"/>
    <line x1="${bbX + bbW}" y1="${bbY}" x2="${bbX + bbW}" y2="${bbY + 20}" stroke="${bbColor}" stroke-width="4"/>
    <line x1="${bbX}" y1="${bbY + bbH}" x2="${bbX + 20}" y2="${bbY + bbH}" stroke="${bbColor}" stroke-width="4"/>
    <line x1="${bbX}" y1="${bbY + bbH}" x2="${bbX}" y2="${bbY + bbH - 20}" stroke="${bbColor}" stroke-width="4"/>
    <line x1="${bbX + bbW}" y1="${bbY + bbH}" x2="${bbX + bbW - 20}" y2="${bbY + bbH}" stroke="${bbColor}" stroke-width="4"/>
    <line x1="${bbX + bbW}" y1="${bbY + bbH}" x2="${bbX + bbW}" y2="${bbY + bbH - 20}" stroke="${bbColor}" stroke-width="4"/>
    <!-- Target label -->
    <rect x="${bbX}" y="${bbY - 24}" width="160" height="22" fill="${bbColor}" rx="2"/>
    <text x="${bbX + 6}" y="${bbY - 7}" fill="black" font-family="monospace" font-size="13" font-weight="bold">${targetType} ${targetId}</text>
    <!-- Confidence -->
    <text x="${bbX + bbW + 6}" y="${bbY + 14}" fill="${bbColor}" font-family="monospace" font-size="12">CONF: ${Math.round(confidence * 100)}%</text>
    `
    : '';

  // Target representation (simple shape)
  const targetSvg = showBoundingBox
    ? `
    <!-- Target shape representation -->
    <rect x="${bbX + 70}" y="${bbY + 30}" width="60" height="60" fill="${bbColor}" fill-opacity="0.2" rx="4"/>
    <rect x="${bbX + 80}" y="${bbY + 15}" width="40" height="20" fill="${bbColor}" fill-opacity="0.3" rx="4"/>
    `
    : '';

  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
  width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">

  <defs>
    <filter id="glow">
      <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="${width}" height="${height}" fill="${bgColor}"/>

  <!-- Grid -->
  ${gridLines.join('\n  ')}

  <!-- Runway area indicator -->
  <rect x="0" y="${height / 2 - 40}" width="${width}" height="80" fill="${runwayColor}" fill-opacity="0.3"/>
  <line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" stroke="${runwayMarkingColor}" stroke-width="2" stroke-dasharray="20,10"/>
  <text x="10" y="${height / 2 - 22}" fill="${runwayMarkingColor}" font-family="monospace" font-size="14" font-weight="bold">RWY 18/36</text>

  <!-- Taxiway indicator -->
  <rect x="60" y="${height / 2 - 100}" width="30" height="100" fill="#556" fill-opacity="0.5"/>
  <text x="68" y="${height / 2 - 108}" fill="#aaa" font-family="monospace" font-size="12">${taxiwayId}</text>

  ${targetSvg}
  ${boundingBoxSvg}

  <!-- Frame border -->
  <rect x="2" y="2" width="${width - 4}" height="${height - 4}"
    fill="none" stroke="${frameColor}" stroke-width="4"/>

  <!-- Frame label -->
  <rect x="2" y="2" width="${width - 4}" height="30" fill="${frameColor}" fill-opacity="0.8"/>
  <text x="10" y="22" fill="white" font-family="monospace" font-size="14" font-weight="bold">${frameLabel}</text>

  <!-- Top-right HUD -->
  <text x="${width - 10}" y="22" fill="white" font-family="monospace" font-size="12"
    text-anchor="end">${cameraId}</text>

  <!-- Bottom HUD bar -->
  <rect x="0" y="${height - 60}" width="${width}" height="60" fill="black" fill-opacity="0.7"/>

  <!-- Datetime -->
  <text x="10" y="${height - 38}" fill="#aaffaa" font-family="monospace" font-size="12">${datetime}</text>

  <!-- Location -->
  <text x="10" y="${height - 20}" fill="#aaaaff" font-family="monospace" font-size="12">LOC: 演示基地 A | TWY: ${taxiwayId} | RWY: 18/36</text>

  <!-- Incursion status -->
  <text x="${width / 2}" y="${height - 38}" fill="${isIncursion ? '#ff3333' : '#00ff88'}"
    font-family="monospace" font-size="14" font-weight="bold" text-anchor="middle"
    filter="${isIncursion ? 'url(#glow)' : ''}">${incursionStatus}</text>

  <!-- DEMO MODE watermark -->
  <text x="${width / 2}" y="${height / 2 - 60}" fill="white" fill-opacity="0.08"
    font-family="monospace" font-size="48" font-weight="bold" text-anchor="middle"
    transform="rotate(-30, ${width / 2}, ${height / 2})">DEMO MODE</text>

  <!-- AI Overlay -->
  <text x="${width - 10}" y="${height - 38}" fill="#ffaa00" font-family="monospace" font-size="11"
    text-anchor="end">AI: Chimes RIWS v1.0</text>
  <text x="${width - 10}" y="${height - 20}" fill="#ffaa00" font-family="monospace" font-size="11"
    text-anchor="end">CONF: ${Math.round(confidence * 100)}% | ${getTargetLabel(targetType.split(' ')[0])}</text>

  <!-- Scan lines effect -->
  <rect width="${width}" height="${height}" fill="url(#scanlines)" opacity="0.05"/>

  <!-- Title overlay -->
  <text x="${width / 2}" y="${height - 42}" fill="white" fill-opacity="0.1"
    font-family="monospace" font-size="11" text-anchor="middle">${title}</text>
</svg>`;

  return svgContent;
}

export interface GeneratedMediaRecord {
  mediaType: MediaType;
  fileName: string;
  filePath: string;
  capturedAt: string;
}

class MediaGeneratorService {
  // skipDetectionImage / skipPreEventImage: true when a real camera frame is
  // being attached for that slot instead (see saveBinaryMedia) — otherwise
  // the event would end up with both a real .jpg AND a placeholder .svg both
  // tagged the same media_type, showing two conflicting images for one
  // moment.
  //
  // POST_EVENT_IMAGE has no skip flag on purpose: it can only be captured
  // some seconds AFTER this runs (the "after" frame does not exist yet at
  // event-creation time — see the attach-media route), so the placeholder is
  // always written first and replaced later if a real one arrives.
  generateEventMedia(
    event: RiwsEvent,
    options?: { skipDetectionImage?: boolean; skipPreEventImage?: boolean },
  ): GeneratedMediaRecord[] {
    const storageBase = getAbsoluteStorageBase();
    const eventDir = path.join(storageBase, event.event_code);
    ensureDir(eventDir);

    const records: GeneratedMediaRecord[] = [];
    const now = Date.now();
    const cameraId = event.camera_id ?? 'CAM-01';
    const taxiwayId = event.taxiway_id ?? 'N/A';
    const targetId = event.target_id ?? 'UNKNOWN';
    const targetType = event.target_type ?? 'UNKNOWN';
    const confidence = event.confidence ?? 0.85;

    // PRE-EVENT: Normal state, no target in frame
    const preTime = new Date(now - 30000).toISOString();
    if (!options?.skipPreEventImage) {
      const preSvg = generateSvgContent({
        title: 'PRE-EVENT IMAGE',
        cameraId,
        datetime: formatDisplay(preTime),
        taxiwayId,
        targetId,
        targetType,
        confidence: 0,
        showBoundingBox: false,
        incursionStatus: 'MONITORING',
        isIncursion: false,
        frameColor: '#006600',
        frameLabel: '▶ PRE-EVENT | NORMAL',
      });
      const preFileName = 'pre-event.svg';
      const preFilePath = path.join(eventDir, preFileName);
      fs.writeFileSync(preFilePath, preSvg, 'utf-8');
      records.push({
        mediaType: 'PRE_EVENT_IMAGE',
        fileName: preFileName,
        filePath: `${event.event_code}/${preFileName}`,
        capturedAt: preTime,
      });
    }

    // DETECTION: Target detected with bounding box (skipped when a real
    // camera snapshot is being attached instead — see saveDetectionSnapshot)
    const detectTime = event.detected_at;
    const isIncursion = event.event_type === 'RUNWAY_INCURSION';
    if (!options?.skipDetectionImage) {
      const detectSvg = generateSvgContent({
        title: 'DETECTION IMAGE',
        cameraId,
        datetime: formatDisplay(detectTime),
        taxiwayId,
        targetId,
        targetType,
        confidence,
        showBoundingBox: true,
        incursionStatus: isIncursion ? '⚠ RUNWAY INCURSION DETECTED ⚠' : '⚠ UNAUTHORIZED APPROACH',
        isIncursion,
        frameColor: isIncursion ? '#ff3333' : '#ffaa00',
        frameLabel: isIncursion ? '▶ DETECTION | INCURSION' : '▶ DETECTION | ALERT',
      });
      const detectFileName = 'detection.svg';
      const detectFilePath = path.join(eventDir, detectFileName);
      fs.writeFileSync(detectFilePath, detectSvg, 'utf-8');
      records.push({
        mediaType: 'DETECTION_IMAGE',
        fileName: detectFileName,
        filePath: `${event.event_code}/${detectFileName}`,
        capturedAt: detectTime,
      });
    }

    // POST-EVENT: After event, area clear
    const postTime = new Date(now + 60000).toISOString();
    const postSvg = generateSvgContent({
      title: 'POST-EVENT IMAGE',
      cameraId,
      datetime: formatDisplay(postTime),
      taxiwayId,
      targetId,
      targetType,
      confidence: 0,
      showBoundingBox: false,
      incursionStatus: 'AREA CLEAR - MONITORING',
      isIncursion: false,
      frameColor: '#003366',
      frameLabel: '▶ POST-EVENT | AREA CLEAR',
    });
    const postFileName = 'post-event.svg';
    const postFilePath = path.join(eventDir, postFileName);
    fs.writeFileSync(postFilePath, postSvg, 'utf-8');
    records.push({
      mediaType: 'POST_EVENT_IMAGE',
      fileName: postFileName,
      filePath: `${event.event_code}/${postFileName}`,
      capturedAt: postTime,
    });

    logger.info(`[MEDIA] Generated ${records.length} SVG file(s) for event ${event.event_code} in ${eventDir}`);
    return records;
  }

  // Writes REAL captured media (base64, from the detector's <video> — see
  // ZoneConfig.tsx's captureSnapshot / event-video recorder) to disk under
  // the event's directory, replacing the corresponding generated placeholder.
  // Paired with generateEventMedia's skip* options so a real file and a
  // placeholder never both claim the same media_type.
  //
  // Overwrites by fixed file name per slot rather than accumulating
  // timestamped files: an event has exactly one 事前/偵測/事後 frame and one
  // clip, and a late-arriving real frame is meant to REPLACE the placeholder
  // (the caller drops the old media row to match — see the attach route).
  // Naming them by slot is what makes that replacement possible at all.
  saveBinaryMedia(
    event: RiwsEvent,
    base64: string,
    opts: { mediaType: MediaType; fileName: string; capturedAt?: string },
  ): GeneratedMediaRecord {
    const storageBase = getAbsoluteStorageBase();
    const eventDir = path.join(storageBase, event.event_code);
    ensureDir(eventDir);

    // Tolerate both a raw base64 string and a "data:<mime>;base64,...." URI.
    const commaIdx = base64.indexOf(',');
    const raw = base64.startsWith('data:') && commaIdx !== -1 ? base64.slice(commaIdx + 1) : base64;
    const buffer = Buffer.from(raw, 'base64');
    if (buffer.length === 0) {
      throw new Error('Decoded media is empty — base64 payload was not valid.');
    }

    const filePath = path.join(eventDir, opts.fileName);
    fs.writeFileSync(filePath, buffer);
    logger.info(`[MEDIA] Saved real ${opts.mediaType} for event ${event.event_code} → ${opts.fileName} (${buffer.length} bytes)`);

    return {
      mediaType: opts.mediaType,
      fileName: opts.fileName,
      filePath: `${event.event_code}/${opts.fileName}`,
      capturedAt: opts.capturedAt ?? event.detected_at,
    };
  }

  getMediaPath(relativePath: string): string {
    const storageBase = getAbsoluteStorageBase();
    return path.join(storageBase, relativePath);
  }

  mediaExists(relativePath: string): boolean {
    return fs.existsSync(this.getMediaPath(relativePath));
  }

  deleteEventMedia(eventCode: string): void {
    const storageBase = getAbsoluteStorageBase();
    const eventDir = path.join(storageBase, eventCode);
    if (fs.existsSync(eventDir)) {
      fs.rmSync(eventDir, { recursive: true });
      logger.info(`[MEDIA] Deleted media directory: ${eventDir}`);
    }
  }
}

export const mediaGeneratorService = new MediaGeneratorService();
