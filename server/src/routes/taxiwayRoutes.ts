import { Router, Request, Response } from 'express';
import { systemStateService } from '../services/SystemStateService';
import { auditService } from '../services/AuditService';
import { TaxiwayId, ALL_TAXIWAY_IDS } from '../types';

const router = Router();

function isValidTaxiwayId(id: string): id is TaxiwayId {
  return (ALL_TAXIWAY_IDS as string[]).includes(id);
}

// GET /api/taxiways
router.get('/', (_req: Request, res: Response) => {
  const state = systemStateService.getSystemState();
  res.json({ success: true, data: state.taxiways });
});

// POST /api/taxiways/:id/authorize
router.post('/:id/authorize', (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidTaxiwayId(id)) {
    return res.status(400).json({ success: false, error: `Invalid taxiway ID: ${id}` });
  }

  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const previousState = systemStateService.getTaxiwayState(id);
  const result = systemStateService.authorizeTaxiway(id);

  auditService.logAction({
    action_type: 'TAXIWAY_AUTHORIZE',
    target_type: 'TAXIWAY',
    target_id: id,
    operator_name: operatorName,
    previous_state: previousState,
    new_state: result.success ? 'AUTHORIZED' : previousState,
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: result.error ? { error: result.error } : undefined,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: `Taxiway ${id} authorized.` });
});

// POST /api/taxiways/:id/revoke
router.post('/:id/revoke', (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidTaxiwayId(id)) {
    return res.status(400).json({ success: false, error: `Invalid taxiway ID: ${id}` });
  }

  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const previousState = systemStateService.getTaxiwayState(id);
  const result = systemStateService.revokeTaxiwayAuthorization(id);

  auditService.logAction({
    action_type: 'TAXIWAY_REVOKE',
    target_type: 'TAXIWAY',
    target_id: id,
    operator_name: operatorName,
    previous_state: previousState,
    new_state: result.success ? 'GUARDED' : previousState,
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: result.error ? { error: result.error } : undefined,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: `Taxiway ${id} authorization revoked.` });
});

// POST /api/taxiways/:id/reset
router.post('/:id/reset', (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidTaxiwayId(id)) {
    return res.status(400).json({ success: false, error: `Invalid taxiway ID: ${id}` });
  }

  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const previousState = systemStateService.getTaxiwayState(id);
  const result = systemStateService.resetTaxiway(id);

  // Idempotent no-op (taxiway was already not INCURSION_LATCHED) — nothing
  // changed, so this isn't audit-worthy and must not be reported as FAILED:
  // the caller's intent ("this taxiway should not be latched") is already
  // satisfied. Still HTTP 200 with an explicit flag so the client can tell
  // "already done" apart from "just did it" without treating either as an
  // error.
  if (result.alreadyCleared) {
    return res.json({ success: true, alreadyCleared: true, message: `Taxiway ${id} was already cleared.` });
  }

  auditService.logAction({
    action_type: 'TAXIWAY_RESET',
    target_type: 'TAXIWAY',
    target_id: id,
    operator_name: operatorName,
    previous_state: previousState,
    // SAFETY: Reset always goes to GUARDED, never AUTHORIZED
    new_state: result.success ? 'GUARDED' : previousState,
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: result.error ? { error: result.error } : undefined,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: `Taxiway ${id} reset to GUARDED.` });
});

export default router;
