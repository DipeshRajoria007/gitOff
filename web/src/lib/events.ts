import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** Listen to the local server's event stream and refresh the affected queries. */
export function useServerEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: number | undefined;
    const pending = new Set<string>();
    let flush: number | undefined;

    const invalidate = (...keys: string[]) => {
      keys.forEach((k) => pending.add(k));
      if (flush) return;
      flush = window.setTimeout(() => {
        flush = undefined;
        for (const k of pending) {
          const parts = k.split('|');
          qc.invalidateQueries({ queryKey: parts });
        }
        pending.clear();
      }, 250);
    };

    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('bus', (ev) => {
        const e = JSON.parse((ev as MessageEvent).data);
        switch (e.type) {
          case 'status':
          case 'net':
          case 'sync':
            invalidate('status');
            if (e.type === 'net') invalidate('prs');
            break;
          case 'pr':
            invalidate(`pr|${String(e.key).toLowerCase()}`, `diff|${String(e.key).toLowerCase()}`, 'prs');
            break;
          case 'prs':
            invalidate('prs');
            break;
          case 'outbox':
            invalidate('outbox', 'status', 'prs', 'pr');
            break;
          case 'prepare':
            invalidate(`pr|${String(e.key).toLowerCase()}`, `prepare-log|${String(e.key).toLowerCase()}`, 'prs');
            break;
        }
      });
      es.addEventListener('hello', () => invalidate('status', 'prs', 'pr', 'outbox'));
      es.onerror = () => {
        es?.close();
        retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
      if (flush) clearTimeout(flush);
    };
  }, [qc]);
}
