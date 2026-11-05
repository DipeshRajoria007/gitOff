import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: true });

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

marked.use({
  renderer: {
    code({ text, lang }) {
      if (lang === 'suggestion') {
        const lines = text.split('\n').map((l) => `<div class="suggestion-line">${escapeHtml(l) || ' '}</div>`).join('');
        return `<div class="suggestion-box"><div class="suggestion-head">Suggested change</div><pre class="suggestion-body">${lines}</pre></div>`;
      }
      return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(text)}</code></pre>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (/^https?:\/\//.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
  if (node.tagName === 'IMG' || node.tagName === 'VIDEO') node.setAttribute('loading', 'lazy');
});

const PURIFY = {
  ADD_TAGS: ['details', 'summary', 'video', 'source', 'g-emoji', 'kbd', 'picture'],
  ADD_ATTR: ['open', 'controls', 'muted', 'poster', 'data-canonical-src', 'align', 'target', 'fallback-src', 'alias', 'loading'],
  FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'object', 'embed'],
};

/** Sanitize HTML that GitHub (or Jira) rendered. */
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html ?? '', PURIFY) as unknown as string;
}

/** Render markdown typed locally (comment previews). */
export function renderMarkdown(md: string): string {
  return sanitize(marked.parse(md ?? '', { async: false }) as string);
}
