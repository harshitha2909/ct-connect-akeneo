import { Request, Response, Router } from 'express';
import { logger } from '../utils/logger.utils';
import { fetchCustomObject, updateCustomObject } from 'common-connect/build/commercetools';
import { JobStatus } from 'common-connect/build/job-status';
 
const CONTAINER = 'job-status';
const KEY_DELTA = 'delta';
const KEY_FULL = 'full';
 
type AnyJson = Record<string, unknown>;
 
function parseValue(value: any): AnyJson {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return { raw: value }; }
  }
  return value as AnyJson;
}
 
async function readState(key: string): Promise<AnyJson> {
  const { value } = await fetchCustomObject({ container: CONTAINER, key });
  const parsed = parseValue(value);
  logger.info(`[job] read ${key}: ${JSON.stringify(parsed)}`);
  return parsed;
}
 
async function writeState(key: string, state: AnyJson): Promise<void> {
  // store as string (compatible with CT's string/object value)
  const payload = JSON.stringify(state);
  await updateCustomObject({ container: CONTAINER, key, value: payload });
  logger.info(`[job] write ${key}: ${payload}`);
}
 
function stamp(state: AnyJson) {
  return { ...state, lastModifiedAt: new Date().toISOString() };
}
 
export const JobController = Router();
 
/** health */
JobController.get('/ping', async (_req: Request, res: Response) => {
  res.status(200).json({ pong: true });
});
 
/** dry-run helper */
JobController.get('/dry-run', async (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, note: 'dry-run only' });
});
 
/**
* Reset baseline for demo:
*  - FULL -> IDLE
*  - DELTA -> SCHEDULED
*/
JobController.post('/reset', async (_req: Request, res: Response) => {
  try {
    const fullExisting  = await readState(KEY_FULL);
    const deltaExisting = await readState(KEY_DELTA);
 
    const full  = { status: JobStatus.IDLE,      detail: {}, ...fullExisting };
    const delta = { status: JobStatus.SCHEDULED, detail: {}, ...deltaExisting };
 
    await writeState(KEY_FULL,  stamp({ ...full,  status: JobStatus.IDLE }));
    await writeState(KEY_DELTA, stamp({ ...delta, status: JobStatus.SCHEDULED }));
 
    return res.json({
      ok: true,
      baseline: 'full=IDLE, delta=SCHEDULED',
      full: await readState(KEY_FULL),
      delta: await readState(KEY_DELTA),
    });
  } catch (err: any) {
    logger.error(`[job] reset error: ${err?.message || err}`);
    return res.status(500).json({
      message: 'Internal Server Error - Error resetting job states',
      errors: [{ message: String(err?.message || err) }],
    });
  }
});
 
/**
* Orchestrate:
*  - POST /job?type=full      => schedule FULL and force DELTA to TO_STOP
*  - POST /job                => schedule DELTA unless FULL is active
*/
JobController.post('/', async (req: Request, res: Response) => {
  try {
    const type = (req.query.type as string) || 'delta';
 
    // defaults if missing
    const delta = { status: JobStatus.IDLE, detail: {}, ...(await readState(KEY_DELTA)) };
    const full  = { status: JobStatus.IDLE, detail: {}, ...(await readState(KEY_FULL)) };
 
    if (type === 'full') {
      await writeState(KEY_FULL,  stamp({ ...full,  status: JobStatus.SCHEDULED }));
      await writeState(KEY_DELTA, stamp({ ...delta, status: JobStatus.TO_STOP }));
 
      return res.json({
        ok: true,
        action: 'full_scheduled_delta_to_stop',
        full: await readState(KEY_FULL),
        delta: await readState(KEY_DELTA),
      });
    }
 
    // type === 'delta'
    const fullStatus = String(full.status || '').toUpperCase();
    const fullActive = ['SCHEDULED', 'RUNNING', 'RESUMABLE', 'TO_STOP'].includes(fullStatus);
    if (fullActive) {
      return res.json({
        ok: true,
        skipped: 'delta_blocked_by_full',
        full: await readState(KEY_FULL),
        delta: await readState(KEY_DELTA),
      });
    }
 
    await writeState(KEY_DELTA, stamp({ ...delta, status: JobStatus.SCHEDULED }));
    return res.json({
      ok: true,
      action: 'delta_scheduled',
      full: await readState(KEY_FULL),
      delta: await readState(KEY_DELTA),
    });
  } catch (err: any) {
    logger.error(`[job] error: ${err?.message || err}`);
    return res.status(500).json({
      message: 'Internal Server Error - Error processing job',
      errors: [{ message: String(err?.message || err) }],
    });
  }
});
