import { bus, netSignals } from './events.js';
import { ping } from './github/client.js';
import { now } from './util.js';

interface NetState {
  online: boolean;
  lastCheckAt: string | null;
  lastOnlineAt: string | null;
}

const state: NetState = { online: false, lastCheckAt: null, lastOnlineAt: null };
let timer: NodeJS.Timeout | null = null;
let checking: Promise<boolean> | null = null;
let onOnline: () => void = () => {};

export const getNet = (): NetState => ({ ...state });
export const isOnline = () => state.online;

function set(online: boolean) {
  const was = state.online;
  state.online = online;
  state.lastCheckAt = now();
  if (online) state.lastOnlineAt = now();
  if (was !== online) {
    bus.emitEvent({ type: 'net', online });
    bus.emitEvent({ type: 'status' });
    if (online) onOnline();
  }
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void checkNow(), ms);
}

/** Probe api.github.com right now. A captive portal or dead link both count as offline. */
export function checkNow(): Promise<boolean> {
  if (checking) return checking;
  checking = (async () => {
    const r = await ping();
    set(r.ok);
    schedule(state.online ? 60_000 : 15_000);
    return state.online;
  })().finally(() => {
    checking = null;
  });
  return checking;
}

export function startConnectivity(handlers: { onOnline: () => void }) {
  onOnline = handlers.onOnline;
  // A failed API call might be a blip: re-probe soon instead of flipping immediately.
  netSignals.on('failure', () => {
    if (state.online) schedule(1500);
  });
  netSignals.on('success', () => {
    if (!state.online) set(true);
  });
  void checkNow();
}
