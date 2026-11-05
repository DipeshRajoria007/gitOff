import { EventEmitter } from 'node:events';

/** App-wide event bus. The HTTP layer forwards these to the browser over SSE. */
export type BusEvent =
  | { type: 'status' }
  | { type: 'net'; online: boolean }
  | { type: 'pr'; key: string }
  | { type: 'prs' }
  | { type: 'outbox' }
  | { type: 'sync' }
  | { type: 'prepare'; key: string };

class Bus extends EventEmitter {
  emitEvent(e: BusEvent) {
    this.emit('event', e);
  }
  onEvent(fn: (e: BusEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);

/** Network signals from API calls, consumed by the connectivity monitor. */
export const netSignals = new EventEmitter();
export const reportNetworkFailure = () => netSignals.emit('failure');
export const reportNetworkSuccess = () => netSignals.emit('success');
