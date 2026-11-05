import type { DraftReply, DraftReview, DraftThread, OutboxItem, OutboxReview } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, prPath } from '../../lib/api';
import { uid } from '../../lib/util';
import type { Detail } from '../PullRequest';

/**
 * The pending review lives on the local server (so it survives reloads and
 * restarts). This hook keeps an optimistic copy and writes every change through.
 */
export function useDraft(detail: Detail) {
  const snap = detail.snapshot!;
  const qc = useQueryClient();
  const head = snap.git?.headOid ?? snap.pr.headRefOid;
  const [draft, setDraftState] = useState<DraftReview | null>(detail.local.draft);
  const current = useRef<DraftReview | null>(detail.local.draft);
  const setDraft = (d: DraftReview | null) => {
    current.current = d;
    setDraftState(d);
  };
  const inFlight = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (inFlight.current === 0) setDraft(detail.local.draft);
  }, [detail.local.draft]);

  const persist = useCallback(
    (next: DraftReview | null) => {
      inFlight.current++;
      chain.current = chain.current
        .then(() => api('PUT', `${prPath(snap.owner, snap.repo, snap.number)}/draft`, { draft: next }))
        .then(() => setError(null))
        .catch((e) => setError(e.message))
        .finally(() => {
          inFlight.current--;
          if (inFlight.current === 0) qc.invalidateQueries({ queryKey: ['pr', snap.key.toLowerCase()] });
        });
    },
    [qc, snap.owner, snap.repo, snap.number, snap.key],
  );

  const update = useCallback(
    (fn: (d: DraftReview) => void) => {
      const prev = current.current;
      const d: DraftReview = prev ? structuredClone(prev) : { commitOid: head, body: '', threads: [], replies: [], updatedAt: new Date().toISOString() };
      fn(d);
      d.updatedAt = new Date().toISOString();
      const empty = !d.threads.length && !d.replies.length && !d.body.trim();
      const next = empty ? null : d;
      setDraft(next);
      persist(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [head, persist],
  );

  const now = () => new Date().toISOString();
  return {
    draft,
    error,
    addThread: (t: Omit<DraftThread, 'localId' | 'createdAt' | 'updatedAt'>) =>
      update((d) => {
        if (!d.threads.length && !d.replies.length) d.commitOid = head;
        d.threads.push({ ...t, localId: uid(), createdAt: now(), updatedAt: now() });
      }),
    updateThread: (localId: string, body: string) =>
      update((d) => {
        const t = d.threads.find((x) => x.localId === localId);
        if (t) {
          t.body = body;
          t.updatedAt = now();
        }
      }),
    removeThread: (localId: string) => update((d) => void (d.threads = d.threads.filter((x) => x.localId !== localId))),
    addReply: (r: Omit<DraftReply, 'localId' | 'createdAt' | 'updatedAt'>) =>
      update((d) => {
        if (!d.threads.length && !d.replies.length) d.commitOid = head;
        d.replies.push({ ...r, localId: uid(), createdAt: now(), updatedAt: now() });
      }),
    updateReply: (localId: string, body: string) =>
      update((d) => {
        const r = d.replies.find((x) => x.localId === localId);
        if (r) {
          r.body = body;
          r.updatedAt = now();
        }
      }),
    removeReply: (localId: string) => update((d) => void (d.replies = d.replies.filter((x) => x.localId !== localId))),
    setBody: (body: string) => update((d) => void (d.body = body)),
    discard: () => {
      setDraft(null);
      persist(null);
    },
  };
}

export type DraftApi = ReturnType<typeof useDraft>;

/** Review comments sitting in the outbox (submitted offline, not on GitHub yet). */
export function queuedFromOutbox(items: OutboxItem[]) {
  const replies = new Map<string, { body: string; status: string; id: string }[]>();
  const threads: (DraftThread & { status: string; itemId: string })[] = [];
  for (const x of items) {
    if (x.type !== 'review' || x.status === 'sent') continue;
    const r = x as OutboxReview;
    for (const rep of r.replies) {
      if (r.progress.replies[rep.localId]) continue;
      replies.set(rep.threadId, [...(replies.get(rep.threadId) ?? []), { body: rep.body, status: r.status, id: rep.localId }]);
    }
    for (const t of r.threads) {
      if (r.progress.threads[t.localId]) continue;
      threads.push({ ...t, status: r.status, itemId: r.id });
    }
  }
  return { replies, threads };
}
