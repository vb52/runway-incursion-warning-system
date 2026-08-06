import { Router, Request, Response } from 'express';
import { systemStateService } from '../services/SystemStateService';
import { auditService } from '../services/AuditService';
import { detectorAlertService } from '../services/DetectorAlertService';
import { eventService } from '../services/EventService';
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

  // 警報復歸的優先級最高，等於人員手動操作的優先級最高 — nothing a detection
  // source reports outranks it. acknowledgeReset silences the live alert
  // window on the spot (when this 復歸 leaves nothing else latched) and opens
  // the 20s no-warning window so Z1/motion/AI/incursion-line detections can't
  // immediately re-raise what the operator just dismissed. See that method
  // for why it is alarm-only (a full suppression would also freeze the
  // ground-sim spawn relay — "ICON 沒成功出來"), why it doesn't route through
  // clear() (that would force-disable RWY protection for every taxiway), and
  // why an incursion the operator has NOT acknowledged keeps alarming
  // through this window.
  //
  // Applied regardless of whether this call found a real INCURSION_LATCHED to
  // clear or the taxiway had already resolved itself (alreadyCleared) — the
  // operator's intent is the same either way.
  detectorAlertService.acknowledgeReset();

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

  // Record the 復歸 on the timeline of every incursion event it resolves.
  // Until now this existed only in audit_logs, so an event's own detail page
  // ended at "聯絡道已鎖定" and never showed that a human had since dealt with
  // it — the operator's single most important action on the incident was
  // invisible exactly where an incident review looks for it.
  //
  // Written only when the reset actually cleared a latch (result.success, and
  // not the alreadyCleared no-op which returned earlier): a 復歸 on a taxiway
  // that wasn't latched resolved nothing and must not appear on any event's
  // history as though it had.
  if (result.success) {
    for (const event of eventService.getOpenIncursionEvents(id)) {
      eventService.addTimeline(event.id, {
        action_type: 'TAXIWAY_RESET',
        description: `操作員 ${operatorName} 執行人工復歸，聯絡道 ${id} 解除鎖定`,
        source_type: 'OPERATOR',
        operator_name: operatorName,
        metadata: { taxiway: id, previous_state: previousState, new_state: 'GUARDED' },
      });
    }
  }

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: `Taxiway ${id} reset to GUARDED.` });
});

export default router;
