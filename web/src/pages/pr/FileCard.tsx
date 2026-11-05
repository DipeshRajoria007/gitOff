import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { parsePatchFiles } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CommentIcon,
  CopyIcon,
  FileCodeIcon,
  FoldIcon,
  KebabHorizontalIcon,
  UnfoldIcon,
} from '@primer/octicons-react';
import { ActionList, ActionMenu, Button, IconButton, Label, Spinner } from '@primer/react';
import type { Actor, DiffFileEntry, DiffSide, DraftThread, ReviewThread } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { DiffStat } from '../../components/common';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { api, blobUrl, prPath } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { copy } from '../../lib/util';
import { LocalComment, ThreadView, type ReplyActions } from './Thread';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i;

export interface FileCardProps {
  owner: string;
  repo: string;
  number: number;
  file: DiffFileEntry;
  from: string;
  to: string;
  ignoreWhitespace: boolean;
  mode: 'split' | 'unified';
  viewed: boolean;
  changedSinceViewed: boolean;
  onToggleViewed: (viewed: boolean) => void;
  threads: ReviewThread[];
  resolveOverrides: Record<string, boolean>;
  draftThreads: DraftThread[];
  draftReplies: { localId: string; threadId: string; body: string }[];
  queuedThreads: (DraftThread & { status: string })[];
  queuedReplies: Map<string, { id: string; body: string; status: string }[]>;
  canComment: boolean;
  allowLeft: boolean;
  hasDraft: boolean;
  online: boolean;
  prAuthor?: string | null;
  viewer?: Actor | null;
  onAddDraftThread: (t: Omit<DraftThread, 'localId' | 'createdAt' | 'updatedAt'>) => void;
  onSingleThread: (t: Omit<DraftThread, 'localId' | 'createdAt' | 'updatedAt'>) => void;
  onUpdateDraftThread: (localId: string, body: string) => void;
  onRemoveDraftThread: (localId: string) => void;
  replyActions: (thread: ReviewThread) => ReplyActions;
  onEditDraftReply: (localId: string, body: string) => void;
  onDeleteDraftReply: (localId: string) => void;
  onResolve: (threadId: string, resolve: boolean) => void;
  onOpenInEditor: (path: string, line?: number) => void;
  registerRef: (path: string, el: HTMLDivElement | null) => void;
}

type Ann =
  | { kind: 'thread'; id: string; thread: ReviewThread }
  | { kind: 'draft'; id: string; draft: DraftThread }
  | { kind: 'queued'; id: string; draft: DraftThread & { status: string } }
  | { kind: 'composer'; id: string; range: CommentRange };

interface CommentRange {
  side: DiffSide;
  line: number;
  startSide?: DiffSide;
  startLine?: number;
}

const toSide = (s?: string): DiffSide => (s === 'deletions' ? 'LEFT' : 'RIGHT');
const toAnnSide = (s: DiffSide) => (s === 'LEFT' ? 'deletions' : 'additions');

/** Map line numbers to text for both sides of a unified patch, and note which lines GitHub can comment on. */
function lineMaps(patch: string | null) {
  const oldMap = new Map<number, string>();
  const newMap = new Map<number, string>();
  let firstNewLine = 1;
  if (!patch) return { oldMap, newMap, firstNewLine };
  let o = 0;
  let n = 0;
  let inHunk = false;
  let sawChange = false;
  for (const line of patch.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      if (!sawChange) (firstNewLine = n), (sawChange = true);
      newMap.set(n++, line.slice(1));
    } else if (line.startsWith('-')) {
      if (!sawChange) (firstNewLine = Math.max(1, n)), (sawChange = true);
      oldMap.set(o++, line.slice(1));
    } else if (line.startsWith(' ')) {
      oldMap.set(o++, line.slice(1));
      newMap.set(n++, line.slice(1));
    }
  }
  return { oldMap, newMap, firstNewLine };
}

function Composer({
  range,
  snippet,
  inDiff,
  hasDraft,
  online,
  onCancel,
  onReview,
  onSingle,
}: {
  range: CommentRange | null;
  snippet: string | null;
  inDiff: boolean;
  hasDraft: boolean;
  online: boolean;
  onCancel: () => void;
  onReview: (body: string) => void;
  onSingle: (body: string) => void;
}) {
  const [text, setText] = useState('');
  const label = !range
    ? 'Comment on this file'
    : range.startLine && range.startLine !== range.line
      ? `Comment on lines ${range.startSide === 'LEFT' ? 'L' : 'R'}${range.startLine} to ${range.side === 'LEFT' ? 'L' : 'R'}${range.line}`
      : `Comment on line ${range.side === 'LEFT' ? 'L' : 'R'}${range.line}`;
  return (
    <div className="annotation">
      <div className="gh-thread" style={{ padding: 12 }}>
        <div className="small muted" style={{ marginBottom: 8 }}>
          {label}
          {!inDiff && ' · outside the changed lines, so GitHub may attach it to the file instead'}
        </div>
        <MarkdownEditor
          compact
          value={text}
          onChange={setText}
          autoFocus
          minHeight={80}
          placeholder="Leave a comment"
          suggestion={range && range.side === 'RIGHT' && snippet != null ? snippet : null}
          onCancel={onCancel}
          onSubmit={() => text.trim() && onReview(text)}
          hint={online ? undefined : "You're offline: kept locally, sent when you reconnect"}
          actions={
            <>
              <Button size="small" onClick={onCancel}>
                Cancel
              </Button>
              {!hasDraft && (
                <Button size="small" disabled={!text.trim()} onClick={() => onSingle(text)}>
                  Add single comment
                </Button>
              )}
              <Button size="small" variant="primary" disabled={!text.trim()} onClick={() => onReview(text)}>
                {hasDraft ? 'Add review comment' : 'Start a review'}
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}

function StatusLabel({ status }: { status: DiffFileEntry['status'] }) {
  if (status === 'added') return <Label variant="success">Added</Label>;
  if (status === 'deleted') return <Label variant="danger">Deleted</Label>;
  if (status === 'renamed') return <Label variant="accent">Renamed</Label>;
  return null;
}

export const FileCard = memo(function FileCard(p: FileCardProps) {
  const { file } = p;
  const themeMode = useTheme();
  const [open, setOpen] = useState(!p.viewed);
  const [expandAll, setExpandAll] = useState(false);
  const [loadDeferred, setLoadDeferred] = useState(false);
  const [composer, setComposerState] = useState<CommentRange | null>(null);
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const [fileComposer, setFileComposer] = useState(false);
  const [visible, setVisible] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const base = prPath(p.owner, p.repo, p.number);
  const setComposer = (r: CommentRange | null) => {
    setComposerState(r);
    if (!r) setSelection(null);
  };

  useEffect(() => {
    if (p.viewed) setOpen(false);
  }, [p.viewed]);

  // Only build heavy diff DOM once the card scrolls near the viewport.
  useEffect(() => {
    if (visible || !holder.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '1200px 0px' });
    io.observe(holder.current);
    return () => io.disconnect();
  }, [visible, open]);

  const deferredQ = useQuery({
    queryKey: ['file-patch', base, p.from, p.to, file.path, p.ignoreWhitespace],
    queryFn: () =>
      api<{ patch: string }>(
        'GET',
        `${base}/file-patch?${new URLSearchParams({ from: p.from, to: p.to, path: file.path, ...(file.oldPath ? { old: file.oldPath } : {}), ...(p.ignoreWhitespace ? { ws: '1' } : {}) })}`,
      ),
    enabled: file.deferred && loadDeferred,
    staleTime: Infinity,
  });
  const patch = file.patch ?? deferredQ.data?.patch ?? null;
  const maps = useMemo(() => lineMaps(patch), [patch]);
  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (!patch) return null;
    try {
      return parsePatchFiles(patch)[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  }, [patch]);

  const lineThreads = p.threads.filter((t) => t.subjectType === 'LINE' && t.line != null && !t.isOutdated);
  const fileThreads = p.threads.filter((t) => !(t.subjectType === 'LINE' && t.line != null && !t.isOutdated));
  const draftLine = p.draftThreads.filter((d) => d.subjectType === 'LINE' && d.line);
  const draftFile = p.draftThreads.filter((d) => !(d.subjectType === 'LINE' && d.line));
  const queuedLine = p.queuedThreads.filter((d) => d.subjectType === 'LINE' && d.line);
  const queuedFile = p.queuedThreads.filter((d) => !(d.subjectType === 'LINE' && d.line));

  const annotations = useMemo<DiffLineAnnotation<Ann>[]>(() => {
    const out: DiffLineAnnotation<Ann>[] = [];
    for (const t of lineThreads) out.push({ side: toAnnSide(t.diffSide), lineNumber: t.line!, metadata: { kind: 'thread', id: t.id, thread: t } });
    for (const d of queuedLine) out.push({ side: toAnnSide(d.side ?? 'RIGHT'), lineNumber: d.line!, metadata: { kind: 'queued', id: `q-${d.localId}`, draft: d } });
    for (const d of draftLine) out.push({ side: toAnnSide(d.side ?? 'RIGHT'), lineNumber: d.line!, metadata: { kind: 'draft', id: d.localId, draft: d } });
    if (composer) out.push({ side: toAnnSide(composer.side), lineNumber: composer.line, metadata: { kind: 'composer', id: 'composer', range: composer } });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.threads, p.draftThreads, p.queuedThreads, composer]);

  const snippetFor = (r: CommentRange): string | null => {
    const map = r.side === 'LEFT' ? maps.oldMap : maps.newMap;
    const start = r.startLine && (r.startSide ?? r.side) === r.side ? r.startLine : r.line;
    const lines: string[] = [];
    for (let i = start; i <= r.line; i++) {
      const fromPatch = map.get(i);
      const full = fileDiff && !fileDiff.isPartial ? (r.side === 'LEFT' ? fileDiff.deletionLines : fileDiff.additionLines)[i - 1] : undefined;
      const text = fromPatch ?? full?.replace(/\r?\n$/, '');
      if (text === undefined) return lines.length ? lines.join('\n') : null;
      lines.push(text);
    }
    return lines.join('\n');
  };
  const inDiff = (r: CommentRange) => (r.side === 'LEFT' ? maps.oldMap : maps.newMap).has(r.line);

  const openComposer = (range: SelectedLineRange | null) => {
    if (!range || !p.canComment) return;
    const endSide = toSide(range.endSide ?? range.side);
    const startSide = toSide(range.side);
    const lo = Math.min(range.start, range.end);
    const hi = Math.max(range.start, range.end);
    const r: CommentRange =
      lo === hi && startSide === endSide
        ? { side: endSide, line: hi }
        : range.start <= range.end
          ? { side: endSide, line: range.end, startSide, startLine: range.start }
          : { side: startSide, line: range.start, startSide: endSide, startLine: range.end };
    if (!p.allowLeft && (r.side === 'LEFT' || r.startSide === 'LEFT')) return;
    setComposer(r);
  };

  const options = useMemo(
    () => ({
      diffStyle: p.mode,
      theme: { light: 'github-light-default', dark: 'github-dark-default' },
      themeType: themeMode === 'auto' ? ('system' as const) : themeMode,
      diffIndicators: 'classic' as const,
      lineDiffType: 'word-alt' as const,
      overflow: 'scroll' as const,
      disableFileHeader: true,
      hunkSeparators: 'line-info' as const,
      expansionLineCount: 20,
      expandUnchanged: expandAll,
      enableGutterUtility: p.canComment,
      enableLineSelection: p.canComment,
      onLineSelected: (range: SelectedLineRange | null) => setSelection(range),
      onGutterUtilityClick: (range: SelectedLineRange) => {
        setSelection(range);
        openComposer(range);
      },
      loadDiffFiles:
        file.status === 'added' || file.status === 'deleted'
          ? undefined
          : async () => {
              const [oldText, newText] = await Promise.all([
                fetch(blobUrl(p.owner, p.repo, p.number, p.from, file.oldPath ?? file.path)).then((r) => (r.ok ? r.text() : '')),
                fetch(blobUrl(p.owner, p.repo, p.number, p.to, file.path)).then((r) => (r.ok ? r.text() : '')),
              ]);
              return { oldFile: { name: file.oldPath ?? file.path, contents: oldText }, newFile: { name: file.path, contents: newText } };
            },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.mode, p.canComment, p.allowLeft, file.path, file.oldPath, file.status, p.from, p.to, themeMode, expandAll],
  );

  const renderAnnotation = (a: DiffLineAnnotation<Ann>) => {
    const m = a.metadata;
    if (m.kind === 'thread') {
      return (
        <div className="annotation" key={m.id}>
          <ThreadView
            thread={m.thread}
            resolved={p.resolveOverrides[m.thread.id] ?? m.thread.isResolved}
            showContext={false}
            prAuthor={p.prAuthor}
            viewer={p.viewer}
            draftReplies={p.draftReplies.filter((r) => r.threadId === m.thread.id)}
            queuedReplies={p.queuedReplies.get(m.thread.id) ?? []}
            onReply={p.replyActions(m.thread)}
            onResolve={(r) => p.onResolve(m.thread.id, r)}
            onEditDraftReply={p.onEditDraftReply}
            onDeleteDraftReply={p.onDeleteDraftReply}
            online={p.online}
            hasDraft={p.hasDraft}
          />
        </div>
      );
    }
    if (m.kind === 'draft' || m.kind === 'queued') {
      const d = m.draft;
      return (
        <div className="annotation" key={m.id}>
          <div className="gh-thread">
            <LocalComment
              viewer={p.viewer}
              body={d.body}
              badge={m.kind === 'draft' ? 'Pending' : (d as any).status === 'failed' ? 'Failed to send' : 'Queued to send'}
              badgeVariant={m.kind === 'draft' ? 'attention' : 'accent'}
              onSave={m.kind === 'draft' ? (b) => p.onUpdateDraftThread(d.localId, b) : undefined}
              onDelete={m.kind === 'draft' ? () => p.onRemoveDraftThread(d.localId) : undefined}
            />
          </div>
        </div>
      );
    }
    const r = m.range;
    const snippet = snippetFor(r);
    const make = (body: string) => ({
      path: file.path,
      subjectType: 'LINE' as const,
      line: r.line,
      side: r.side,
      ...(r.startLine && (r.startLine !== r.line || r.startSide !== r.side) ? { startLine: r.startLine, startSide: r.startSide } : {}),
      body,
      snippet: snippet ?? undefined,
    });
    return (
      <Composer
        key="composer"
        range={r}
        snippet={snippet}
        inDiff={inDiff(r)}
        hasDraft={p.hasDraft}
        online={p.online}
        onCancel={() => setComposer(null)}
        onReview={(body) => {
          p.onAddDraftThread(make(body));
          setComposer(null);
        }}
        onSingle={(body) => {
          p.onSingleThread(make(body));
          setComposer(null);
        }}
      />
    );
  };

  const isImage = file.binary && IMAGE_EXT.test(file.path);
  const commentCount = p.threads.reduce((n, t) => n + t.comments.length, 0) + p.draftThreads.length;
  const estimate = Math.min(2400, (file.additions + file.deletions + 6) * 20);
  const pathLabel = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;

  return (
    <div className={`gh-file ${open ? '' : 'collapsed'}`} ref={(el) => p.registerRef(file.path, el)} data-path={file.path}>
      <div className="gh-file-header">
        <IconButton size="small" variant="invisible" icon={open ? ChevronDownIcon : ChevronRightIcon} aria-label={open ? 'Collapse file' : 'Expand file'} onClick={() => setOpen((v) => !v)} />
        <span className="gh-file-path" title={pathLabel}>
          <span>{pathLabel}</span>
        </span>
        <IconButton size="small" variant="invisible" icon={CopyIcon} aria-label="Copy file path" onClick={() => copy(file.path)} />
        {fileDiff && file.status !== 'added' && file.status !== 'deleted' && (
          <IconButton
            size="small"
            variant="invisible"
            icon={expandAll ? FoldIcon : UnfoldIcon}
            aria-label={expandAll ? 'Collapse unchanged lines' : 'Expand all lines'}
            onClick={() => (setOpen(true), setExpandAll((v) => !v))}
          />
        )}
        <StatusLabel status={file.status} />
        {file.generated && <Label>Generated</Label>}
        <span className="grow" />
        {p.changedSinceViewed && !p.viewed && <Label variant="attention">Changed since last view</Label>}
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <button type="button" className={`gh-viewed ${p.viewed ? 'on' : ''}`} onClick={() => p.onToggleViewed(!p.viewed)} aria-pressed={p.viewed}>
          <input type="checkbox" checked={p.viewed} readOnly tabIndex={-1} />
          Viewed
        </button>
        {p.canComment && (
          <IconButton
            size="small"
            variant="invisible"
            icon={CommentIcon}
            aria-label="Comment on this file"
            onClick={() => (setOpen(true), setFileComposer(true))}
          />
        )}
        {commentCount > 0 && <span className="gh-tree-comment">{commentCount}</span>}
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label="More file actions" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList>
              {file.status !== 'deleted' && (
                <ActionList.Item onSelect={() => p.onOpenInEditor(file.path, maps.firstNewLine)}>
                  <ActionList.LeadingVisual>
                    <FileCodeIcon />
                  </ActionList.LeadingVisual>
                  Open in editor
                </ActionList.Item>
              )}
              {file.status !== 'deleted' && (
                <ActionList.LinkItem href={blobUrl(p.owner, p.repo, p.number, p.to, file.path)} target="_blank">
                  View file
                </ActionList.LinkItem>
              )}
              <ActionList.Item onSelect={() => copy(file.path)}>
                <ActionList.LeadingVisual>
                  <CopyIcon />
                </ActionList.LeadingVisual>
                Copy path
              </ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
      {open && (
        <>
          {(fileThreads.length > 0 || draftFile.length > 0 || queuedFile.length > 0 || fileComposer) && (
            <div className="gh-file-comments">
              {fileThreads.map((t) => (
                <ThreadView
                  key={t.id}
                  thread={t}
                  resolved={p.resolveOverrides[t.id] ?? t.isResolved}
                  showContext={t.subjectType !== 'FILE'}
                  prAuthor={p.prAuthor}
                  viewer={p.viewer}
                  draftReplies={p.draftReplies.filter((r) => r.threadId === t.id)}
                  queuedReplies={p.queuedReplies.get(t.id) ?? []}
                  onReply={p.replyActions(t)}
                  onResolve={(r) => p.onResolve(t.id, r)}
                  onEditDraftReply={p.onEditDraftReply}
                  onDeleteDraftReply={p.onDeleteDraftReply}
                  online={p.online}
                  hasDraft={p.hasDraft}
                />
              ))}
              {queuedFile.map((d) => (
                <div className="gh-thread" key={`q-${d.localId}`}>
                  <LocalComment viewer={p.viewer} body={d.body} badge={d.status === 'failed' ? 'Failed to send' : 'Queued to send'} badgeVariant="accent" />
                </div>
              ))}
              {draftFile.map((d) => (
                <div className="gh-thread" key={d.localId}>
                  <LocalComment
                    viewer={p.viewer}
                    body={d.body}
                    badge="Pending (file comment)"
                    onSave={(b) => p.onUpdateDraftThread(d.localId, b)}
                    onDelete={() => p.onRemoveDraftThread(d.localId)}
                  />
                </div>
              ))}
              {fileComposer && (
                <Composer
                  range={null}
                  snippet={null}
                  inDiff
                  hasDraft={p.hasDraft}
                  online={p.online}
                  onCancel={() => setFileComposer(false)}
                  onReview={(body) => {
                    p.onAddDraftThread({ path: file.path, subjectType: 'FILE', body });
                    setFileComposer(false);
                  }}
                  onSingle={(body) => {
                    p.onSingleThread({ path: file.path, subjectType: 'FILE', body });
                    setFileComposer(false);
                  }}
                />
              )}
            </div>
          )}
          <div ref={holder}>
            {file.binary ? (
              isImage ? (
                <div className="image-diff">
                  {file.status !== 'added' && (
                    <figure>
                      <img src={blobUrl(p.owner, p.repo, p.number, p.from, file.oldPath ?? file.path)} alt="before" />
                      <figcaption className="muted small">Before</figcaption>
                    </figure>
                  )}
                  {file.status !== 'deleted' && (
                    <figure>
                      <img src={blobUrl(p.owner, p.repo, p.number, p.to, file.path)} alt="after" />
                      <figcaption className="muted small">After</figcaption>
                    </figure>
                  )}
                </div>
              ) : (
                <div className="gh-file-note">Binary file not shown.</div>
              )
            ) : file.deferred && !loadDeferred ? (
              <div className="gh-file-note">
                {file.generated ? 'Some generated files are not rendered by default. ' : 'Large diffs are not rendered by default. '}
                <Button size="small" variant="invisible" onClick={() => setLoadDeferred(true)}>
                  Load diff
                </Button>
              </div>
            ) : !patch ? (
              <div className="gh-file-note">
                {deferredQ.isLoading ? <Spinner size="small" /> : file.status === 'renamed' ? 'File renamed without changes.' : 'No changes to show.'}
              </div>
            ) : !fileDiff ? (
              <pre className="gh-hunk" style={{ padding: 8 }}>
                {patch}
              </pre>
            ) : visible ? (
              <FileDiff<Ann> fileDiff={fileDiff} options={options as any} lineAnnotations={annotations} selectedLines={selection} renderAnnotation={renderAnnotation} />
            ) : (
              <div className="gh-file-placeholder" style={{ height: estimate }} />
            )}
          </div>
        </>
      )}
    </div>
  );
});
