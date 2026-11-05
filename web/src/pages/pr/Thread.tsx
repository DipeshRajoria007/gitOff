import { ChevronDownIcon, ChevronRightIcon, KebabHorizontalIcon, PencilIcon, TrashIcon } from '@primer/octicons-react';
import { Button, IconButton, Label } from '@primer/react';
import type { Actor, ReviewComment, ReviewThread } from '@shared/types';
import { useState } from 'react';
import { Avatar, Html, ROLE, Time } from '../../components/common';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { renderMarkdown } from '../../lib/markdown';

interface HunkRow {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

function parseHunk(hunk: string): HunkRow[] {
  const rows: HunkRow[] = [];
  let o = 0;
  let n = 0;
  for (const line of hunk.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith('+')) rows.push({ kind: 'add', oldNo: null, newNo: n++, text: line });
    else if (line.startsWith('-')) rows.push({ kind: 'del', oldNo: o++, newNo: null, text: line });
    else if (line.startsWith('\\')) continue;
    else rows.push({ kind: 'ctx', oldNo: o++, newNo: n++, text: line.length ? line : ' ' });
  }
  return rows;
}

const lineRef = (r: HunkRow) => (r.kind === 'add' ? `+${r.newNo}` : r.kind === 'del' ? `-${r.oldNo}` : `${r.newNo ?? r.oldNo}`);
const lineCls = (r: HunkRow) => (r.kind === 'add' ? 'plus' : r.kind === 'del' ? 'minus' : '');

/** The few diff lines a review comment is about, like GitHub shows above a thread. */
export function ThreadContext({ thread }: { thread: ReviewThread }) {
  const first = thread.comments[0];
  if (!first?.diffHunk || thread.subjectType === 'FILE') return null;
  const all = parseHunk(first.diffHunk).filter((r) => r.kind !== 'hunk');
  const span = thread.originalStartLine && thread.originalLine ? Math.max(1, thread.originalLine - thread.originalStartLine + 1) : 0;
  const rows = all.slice(-(span > 1 ? Math.min(span, 30) : 4));
  if (!rows.length) return null;
  const a = rows[span > 1 ? 0 : rows.length - 1];
  const b = rows[rows.length - 1];
  return (
    <>
      <div className="gh-thread-lines">
        {span > 1 ? (
          <>
            Comment on lines <span className={lineCls(a)}>{lineRef(a)}</span> to <span className={lineCls(b)}>{lineRef(b)}</span>
          </>
        ) : (
          <>
            Comment on line <span className={lineCls(b)}>{lineRef(b)}</span>
          </>
        )}
      </div>
      <table className="gh-hunk">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.kind === 'add' ? 'add' : r.kind === 'del' ? 'del' : ''}>
              <td className="num">{r.oldNo ?? ''}</td>
              <td className="num">{r.newNo ?? ''}</td>
              <td className="code">{r.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function roleOf(c: ReviewComment, prAuthor?: string | null): string | null {
  if (prAuthor && c.author?.login === prAuthor) return 'Author';
  return c.authorAssociation ? (ROLE[c.authorAssociation] ?? null) : null;
}

function CommentItem({ c, prAuthor }: { c: ReviewComment; prAuthor?: string | null }) {
  const role = roleOf(c, prAuthor);
  return (
    <div className="gh-thread-comment">
      <div className="head">
        <Avatar actor={c.author} size={24} />
        <span className="gh-comment-author">{c.author?.login ?? 'ghost'}</span>
        <Time iso={c.createdAt} />
        {c.lastEditedAt && <span>• edited</span>}
        <span className="gh-comment-tools">
          {role && <span className="gh-role">{role}</span>}
          <KebabHorizontalIcon />
        </span>
      </div>
      <div className="body">
        <Html html={c.bodyHTML} />
        {c.reactions.length > 0 && (
          <div className="row wrap" style={{ marginTop: 8, gap: 4 }}>
            {c.reactions.map((r) => (
              <span key={r.content} className={`gh-reaction ${r.viewerHasReacted ? 'mine' : ''}`}>
                {REACTION[r.content] ?? r.content} {r.count}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const REACTION: Record<string, string> = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀',
};

/** A comment you wrote locally (pending in your review, or waiting in the outbox). */
export function LocalComment({
  body,
  badge,
  badgeVariant = 'attention',
  viewer,
  onSave,
  onDelete,
}: {
  body: string;
  badge: string;
  badgeVariant?: 'attention' | 'accent' | 'danger';
  viewer?: Actor | null;
  onSave?: (body: string) => void;
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  if (editing && onSave) {
    return (
      <div className="gh-thread-comment">
        <MarkdownEditor
          compact
          value={text}
          onChange={setText}
          autoFocus
          minHeight={80}
          onSubmit={() => {
            if (text.trim()) {
              onSave(text);
              setEditing(false);
            }
          }}
          onCancel={() => setEditing(false)}
          actions={
            <>
              <Button size="small" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="small"
                variant="primary"
                disabled={!text.trim()}
                onClick={() => {
                  onSave(text);
                  setEditing(false);
                }}
              >
                Update comment
              </Button>
            </>
          }
        />
      </div>
    );
  }
  return (
    <div className="gh-thread-comment">
      <div className="head">
        <Avatar actor={viewer} size={24} />
        <span className="gh-comment-author">{viewer?.login ?? 'You'}</span>
        <Label variant={badgeVariant}>{badge}</Label>
        <span className="gh-comment-tools">
          {onSave && <IconButton size="small" variant="invisible" icon={PencilIcon} aria-label="Edit comment" onClick={() => (setText(body), setEditing(true))} />}
          {onDelete && <IconButton size="small" variant="invisible" icon={TrashIcon} aria-label="Delete comment" onClick={onDelete} />}
        </span>
      </div>
      <div className="body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
    </div>
  );
}

export interface ReplyActions {
  addToReview: (body: string) => void;
  single: (body: string) => void;
}

export function ReplyBox({ actions, online, hasDraft, viewer }: { actions: ReplyActions; online: boolean; hasDraft: boolean; viewer?: Actor | null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const done = () => {
    setText('');
    setOpen(false);
  };
  return (
    <div className="gh-thread-reply">
      {!open && <Avatar actor={viewer} size={24} />}
      {!open ? (
        <button type="button" className="gh-reply-btn" onClick={() => setOpen(true)}>
          Reply...
        </button>
      ) : (
        <div style={{ flex: 1 }}>
          <MarkdownEditor
            compact
            value={text}
            onChange={setText}
            autoFocus
            placeholder="Leave a comment"
            minHeight={70}
            onCancel={done}
            onSubmit={() => {
              if (!text.trim()) return;
              actions.addToReview(text);
              done();
            }}
            hint={online ? undefined : "You're offline: kept locally and sent when you reconnect"}
            actions={
              <>
                <Button size="small" onClick={done}>
                  Cancel
                </Button>
                {!hasDraft && (
                  <Button size="small" disabled={!text.trim()} onClick={() => (actions.single(text), done())}>
                    Add single comment
                  </Button>
                )}
                <Button size="small" variant="primary" disabled={!text.trim()} onClick={() => (actions.addToReview(text), done())}>
                  {hasDraft ? 'Add review comment' : 'Start a review'}
                </Button>
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

export function ThreadView({
  thread,
  resolved,
  showContext,
  prAuthor,
  viewer,
  draftReplies,
  queuedReplies,
  onReply,
  onResolve,
  onEditDraftReply,
  onDeleteDraftReply,
  online,
  hasDraft,
}: {
  thread: ReviewThread;
  resolved: boolean;
  showContext: boolean;
  prAuthor?: string | null;
  viewer?: Actor | null;
  draftReplies: { localId: string; body: string }[];
  queuedReplies: { id: string; body: string; status: string }[];
  onReply: ReplyActions;
  onResolve: (resolve: boolean) => void;
  onEditDraftReply: (localId: string, body: string) => void;
  onDeleteDraftReply: (localId: string) => void;
  online: boolean;
  hasDraft: boolean;
}) {
  const [expanded, setExpanded] = useState(!resolved);
  const header = showContext || resolved;
  return (
    <div className={`gh-thread ${expanded ? '' : 'collapsed'}`}>
      {header && (
        <div className="gh-thread-header">
          <IconButton
            size="small"
            variant="invisible"
            icon={expanded ? ChevronDownIcon : ChevronRightIcon}
            aria-label={expanded ? 'Collapse thread' : 'Expand thread'}
            onClick={() => setExpanded((v) => !v)}
          />
          {showContext ? (
            <span className="path truncate grow" title={thread.path}>
              {thread.path}
            </span>
          ) : (
            <span className="small muted grow truncate">{thread.comments[0]?.body.replace(/\s+/g, ' ').slice(0, 90)}</span>
          )}
          {thread.isOutdated && <Label variant="attention">Outdated</Label>}
          {resolved && (
            <Button size="small" variant="invisible" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Hide resolved' : 'Show resolved'}
            </Button>
          )}
        </div>
      )}
      {expanded && (
        <>
          {showContext && <ThreadContext thread={thread} />}
          {thread.comments.map((c) => (
            <CommentItem key={c.id} c={c} prAuthor={prAuthor} />
          ))}
          {queuedReplies.map((r) => (
            <LocalComment
              key={r.id}
              viewer={viewer}
              body={r.body}
              badge={r.status === 'held' ? 'Waiting for your OK' : r.status === 'failed' ? 'Failed to send' : 'Queued to send'}
              badgeVariant={r.status === 'failed' ? 'danger' : 'accent'}
            />
          ))}
          {draftReplies.map((r) => (
            <LocalComment key={r.localId} viewer={viewer} body={r.body} badge="Pending" onSave={(b) => onEditDraftReply(r.localId, b)} onDelete={() => onDeleteDraftReply(r.localId)} />
          ))}
          {thread.viewerCanReply !== false && <ReplyBox actions={onReply} online={online} hasDraft={hasDraft} viewer={viewer} />}
          <div className="gh-thread-footer">
            {resolved ? (
              <Button size="small" onClick={() => onResolve(false)}>
                Unresolve conversation
              </Button>
            ) : (
              <Button size="small" onClick={() => onResolve(true)}>
                Resolve conversation
              </Button>
            )}
            {resolved && thread.resolvedBy && <span className="small muted" style={{ alignSelf: 'center' }}>Resolved by {thread.resolvedBy}</span>}
          </div>
        </>
      )}
    </div>
  );
}
