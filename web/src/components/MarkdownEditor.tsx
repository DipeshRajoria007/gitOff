import {
  BoldIcon,
  CodeIcon,
  CrossReferenceIcon,
  FileDiffIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ListOrderedIcon,
  ListUnorderedIcon,
  MarkdownIcon,
  MentionIcon,
  QuoteIcon,
  TasklistIcon,
} from '@primer/octicons-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { renderMarkdown } from '../lib/markdown';

export interface MarkdownEditorProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  minHeight?: number;
  /** Cmd/Ctrl+Enter */
  onSubmit?: () => void;
  onCancel?: () => void;
  actions?: ReactNode;
  hint?: ReactNode;
  /** Lines to put in a ```suggestion block (the code being commented on). */
  suggestion?: string | null;
  /** smaller chrome for inline review comments */
  compact?: boolean;
}

type Wrap = { before: string; after?: string; line?: boolean; placeholder?: string };

export function MarkdownEditor(p: MarkdownEditorProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const ta = useRef<HTMLTextAreaElement>(null);
  const preview = useMemo(() => (tab === 'preview' ? renderMarkdown(p.value) : ''), [tab, p.value]);

  useEffect(() => {
    if (p.autoFocus) ta.current?.focus();
  }, [p.autoFocus]);

  const replaceSelection = (fn: (sel: string, before: string) => { text: string; selectFrom: number; selectTo: number }) => {
    const el = ta.current;
    const v = p.value;
    const start = el?.selectionStart ?? v.length;
    const end = el?.selectionEnd ?? v.length;
    const before = v.slice(0, start);
    const r = fn(v.slice(start, end), before);
    p.onChange(before + r.text + v.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + r.selectFrom, start + r.selectTo);
    });
  };

  const wrap = (w: Wrap) =>
    replaceSelection((sel, before) => {
      if (w.line) {
        const pad = before && !before.endsWith('\n') ? '\n' : '';
        const lines = (sel || w.placeholder || '').split('\n');
        const text = pad + lines.map((l, i) => (w.before === '1. ' ? `${i + 1}. ` : w.before) + l).join('\n');
        return { text, selectFrom: text.length, selectTo: text.length };
      }
      const inner = sel || w.placeholder || '';
      const text = w.before + inner + (w.after ?? w.before);
      return { text, selectFrom: w.before.length, selectTo: w.before.length + inner.length };
    });

  const insertBlock = (text: string) =>
    replaceSelection((_sel, before) => {
      const pad = before && !before.endsWith('\n') ? '\n' : '';
      const t = pad + text;
      return { text: t, selectFrom: t.length, selectTo: t.length };
    });

  const tools: { icon: ReactNode; label: string; run: () => void }[][] = [
    [
      { icon: <HeadingIcon />, label: 'Heading', run: () => wrap({ before: '### ', line: true }) },
      { icon: <BoldIcon />, label: 'Bold', run: () => wrap({ before: '**' }) },
      { icon: <ItalicIcon />, label: 'Italic', run: () => wrap({ before: '_' }) },
      { icon: <QuoteIcon />, label: 'Quote', run: () => wrap({ before: '> ', line: true }) },
      {
        icon: <CodeIcon />,
        label: 'Code',
        run: () => {
          const el = ta.current;
          const sel = el ? p.value.slice(el.selectionStart, el.selectionEnd) : '';
          if (sel.includes('\n')) wrap({ before: '```\n', after: '\n```' });
          else wrap({ before: '`' });
        },
      },
      { icon: <LinkIcon />, label: 'Link', run: () => wrap({ before: '[', after: '](url)' }) },
    ],
    [
      { icon: <ListOrderedIcon />, label: 'Numbered list', run: () => wrap({ before: '1. ', line: true }) },
      { icon: <ListUnorderedIcon />, label: 'Unordered list', run: () => wrap({ before: '- ', line: true }) },
      { icon: <TasklistIcon />, label: 'Task list', run: () => wrap({ before: '- [ ] ', line: true }) },
    ],
    [
      { icon: <MentionIcon />, label: 'Mention', run: () => wrap({ before: '@', after: '' }) },
      { icon: <CrossReferenceIcon />, label: 'Reference', run: () => wrap({ before: '#', after: '' }) },
      ...(p.suggestion != null
        ? [{ icon: <FileDiffIcon />, label: 'Add a suggestion', run: () => insertBlock('```suggestion\n' + p.suggestion + '\n```\n') }]
        : []),
    ],
  ];

  return (
    <>
      <div className={`gh-editor ${p.compact ? 'inline' : ''}`}>
        <div className="gh-editor-head">
          <button type="button" className={`gh-editor-tab ${tab === 'write' ? 'selected' : ''}`} onClick={() => setTab('write')}>
            Write
          </button>
          <button type="button" className={`gh-editor-tab ${tab === 'preview' ? 'selected' : ''}`} onClick={() => setTab('preview')}>
            Preview
          </button>
          {tab === 'write' && (
            <div className="gh-editor-tools" role="toolbar" aria-label="Formatting tools">
              {tools.map((group, gi) => (
                <span key={gi} className="row" style={{ gap: 2 }}>
                  {gi > 0 && <span className="sep" />}
                  {group.map((t) => (
                    <button key={t.label} type="button" title={t.label} aria-label={t.label} onMouseDown={(e) => e.preventDefault()} onClick={t.run}>
                      {t.icon}
                    </button>
                  ))}
                </span>
              ))}
            </div>
          )}
        </div>
        {tab === 'write' ? (
          <div className="gh-editor-body">
            <textarea
              ref={ta}
              value={p.value}
              placeholder={p.placeholder ?? 'Add your comment here...'}
              style={{ minHeight: p.minHeight ?? 100 }}
              onChange={(e) => p.onChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  p.onSubmit?.();
                } else if (e.key === 'Escape' && p.onCancel) {
                  e.preventDefault();
                  p.onCancel();
                } else if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i')) {
                  e.preventDefault();
                  wrap({ before: e.key === 'b' ? '**' : '_' });
                }
              }}
            />
          </div>
        ) : (
          <div className="gh-editor-body">
            <div className="gh-editor-preview markdown-body" dangerouslySetInnerHTML={{ __html: preview || '<p>Nothing to preview</p>' }} />
          </div>
        )}
        <div className="gh-editor-foot">
          <span className="row" style={{ gap: 6 }}>
            <MarkdownIcon size={16} /> Markdown is supported
          </span>
        </div>
      </div>
      {(p.actions || p.hint) && (
        <div className="gh-editor-actions">
          {p.hint && <span className="hint">{p.hint}</span>}
          {p.actions}
        </div>
      )}
    </>
  );
}
