import { log } from '../log';

export function logCallEvent(event: string, payload: Record<string, unknown> = {}): void {
  log.info({ event, ...payload }, 'call event');
}