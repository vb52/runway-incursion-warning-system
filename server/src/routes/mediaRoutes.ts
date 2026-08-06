import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { mediaGeneratorService } from '../media/MediaGeneratorService';

const router = Router();

// GET /api/media/events/:eventCode/:filename
// Serves SVG files for event media
router.get('/events/:eventCode/:filename', (req: Request, res: Response) => {
  const { eventCode, filename } = req.params;

  // SECURITY: Sanitize path components to prevent directory traversal
  const safeEventCode = eventCode.replace(/[^a-zA-Z0-9\-_]/g, '');
  const safeFilename = filename.replace(/[^a-zA-Z0-9\-_.]/g, '');

  if (!safeEventCode || !safeFilename) {
    return res.status(400).json({ success: false, error: 'Invalid path.' });
  }

  const relativePath = `${safeEventCode}/${safeFilename}`;

  if (!mediaGeneratorService.mediaExists(relativePath)) {
    return res.status(404).json({ success: false, error: 'Media file not found.' });
  }

  const absolutePath = mediaGeneratorService.getMediaPath(relativePath);

  // Determine content type
  const ext = path.extname(safeFilename).toLowerCase();
  const contentTypes: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.mp4': 'video/mp4',
    // What MediaRecorder actually produces in Chrome/Edge for the 事件影片
    // clip (see ZoneConfig.tsx's recorder) — served as-is rather than
    // transcoded, so archiving stays dependency-free.
    '.webm': 'video/webm',
  };

  const contentType = contentTypes[ext] ?? 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const fileStream = fs.createReadStream(absolutePath);
  fileStream.on('error', () => {
    res.status(500).json({ success: false, error: 'Error reading file.' });
  });
  fileStream.pipe(res);
});

export default router;
