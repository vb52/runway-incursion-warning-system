import { Router, Request, Response } from 'express';
import { auditService } from '../services/AuditService';

const router = Router();

// GET /api/audit-logs
router.get('/', (req: Request, res: Response) => {
  const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
  const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 50;
  const result = auditService.getLogs(page, pageSize);
  res.json({ success: true, ...result });
});

export default router;
