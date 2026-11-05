# offline-github

Review GitHub pull requests with no internet. While you're online it caches each PR: description, conversation, review threads, commits, checks, diffs, screenshots and screen recordings, linked PRs and Jira tickets. It also checks the branch out as a git worktree you can open in Cursor. Offline you review in a GitHub-style UI. Comments, suggestions, approvals, "viewed" marks and resolved threads wait in an outbox and go to GitHub on their own when you're back online.

## Setup (once)

```bash
cd ~/code/offline-github
npm install
npm run build        # builds the web UI into web/dist
npm link             # puts the `ogh` command on your PATH (undo: npm unlink -g offline-github)
gh auth status       # uses your gh CLI login; no tokens are stored by this tool
ogh serve            # starts the app at http://localhost:4777 and opens it
```

Keep `ogh serve` running in a terminal tab. Or run `ogh service install` to start it at login and keep it running in the background (macOS LaunchAgent; `ogh service uninstall` removes it). It has to be running to send your outbox when the connection comes back.

## Before you lose connection

1. Open http://localhost:4777 and press **Sync now**. That pulls:
   - every open PR where your review is requested,
   - your own PRs updated in the last 7 days (change this in Settings),
   - anything you pasted into "Add pull requests",
   - PRs linked from those PRs' descriptions (e.g. the matching backend PR),
   - Jira tickets mentioned in the title, branch, description or commits (needs `ogh jira login` once).
2. Check the **Ready to go offline** box on the dashboard. It lists anything that failed to download.
3. If you want to run a PR's code offline, open the PR and use **Prepare to run** (⋯ menu or sidebar). This copies your git-ignored `.env*` files from your main checkout and installs dependencies. If the lockfile matches your main checkout, it clones `node_modules` copy-on-write, which takes no extra disk.

Auto-sync also runs every 15 minutes while you're online, so the cache is usually fresh anyway.

## Reviewing offline

- **Files changed** works like GitHub: split/unified, hide whitespace, file tree, "N unmodified lines" expanders, per-commit and "changes since your last review" views. Diffs are computed locally with git, so expanding context works offline too.
- Hover a line and click **+** to comment. Drag to select several lines. **± Suggest change** inserts a suggestion block. **Start a review / Add review comment** builds a pending review; **Add single comment** sends just that comment.
- Reply to threads, resolve or unresolve them, tick **Viewed** (`v`), and move between files with `j`/`k`.
- **Review changes** submits: Comment, Approve or Request changes. Offline, it goes to the **Outbox**.
- **Open in Cursor** opens the PR's worktree (`~/code/<repo>-review-<number>`, next to your clone). The file icon in a file's header opens that file at the changed line.

## What happens when you're back online

The app checks for a connection every 15 seconds while offline. When it can reach GitHub it sends the outbox first, then refreshes PRs.

- A review is created against the commit you actually reviewed, so your line comments land on the right lines even if new commits were pushed meanwhile (GitHub marks them outdated if the lines changed).
- An **Approve is held** if new commits landed after you reviewed. The outbox asks you to approve anyway, send it as a comment, or put it back into a draft. The same happens if the commit you reviewed was force-pushed away.
- If GitHub can't place a comment on a line (outside the diff, or the file changed), it's posted as a file comment that quotes the code. If even that fails, it goes into the review summary. Nothing is dropped.
- Sending is safe on bad networks. Every comment carries an invisible marker (`<!-- ogh:… -->`), so if a response gets lost the next attempt can see what already reached GitHub and doesn't post it twice. Rate limits and GitHub errors are retried later; only a real "this line isn't in the diff" turns a line comment into a file comment.
- Reviews for the same PR go out one at a time, in order. A later review waits while an earlier one is held for your OK.
- If you had started a review on github.com, your offline comments are added to that pending review. Single comments never touch it.
- A "viewed" tick isn't sent for a file that changed after you looked at it.
- Deleting a half-sent review from the outbox (or sending it back to draft) also discards its pending copy on GitHub, which needs a connection.

## Jira

`ogh jira login` (or Settings → Jira) asks for your Atlassian email and an API token from https://id.atlassian.com/manage-profile/security/api-tokens. The token goes into the macOS Keychain (service `offline-github-jira`), not a file. Tickets are found from links to `*.atlassian.net/browse/KEY-123` and from bare keys like `PROJ-123` in the PR title, branch and commits.

## Commands

| command | |
|---|---|
| `ogh serve [--port N] [--no-open]` | run the app and background sync |
| `ogh add <url>…` | cache PRs (also `owner/repo#123`) |
| `ogh sync [--full]` | send the outbox, refresh queue and PRs (`--full` re-downloads everything) |
| `ogh status` | what's cached, drafts, outbox |
| `ogh open <pr> [file[:line]]` | open the worktree in Cursor |
| `ogh prepare <pr>` | copy `.env` files and install dependencies in the worktree |
| `ogh jira login` | connect Jira |
| `ogh doctor` | check gh auth, git, editor, clones, Jira |
| `ogh service install\|uninstall` | background service at login |

Rehearse offline without turning off Wi-Fi: `OGH_OFFLINE=1 ogh serve`. The app then never contacts GitHub, and everything you submit stays in the outbox.

## Where things live

- `~/.offline-github/`: snapshots (`prs/`), media (`assets/`), outbox, settings, logs. Delete it to start over.
- PR refs are fetched into your existing clones under `refs/ogh/pr/<n>/*`. Your branches and `origin/*` aren't touched. Fetches use your `gh` login over HTTPS, so they don't depend on SSH keys.
- PRs you review get a worktree automatically. Your own PRs get one only when you click **Create worktree** (dashboard or PR page; works offline).
- Worktrees are created next to the matching clone, detached at the PR head. A worktree is moved to a new head only when it has no uncommitted changes and no commits of yours. Your own PR uses your existing checkout of that branch if there is one.
- Cleanup: a PR that is closed, or no longer in your queue, with no activity for a week and nothing unsent, is removed with its worktree (only if the worktree is clean). Media and tickets no PR refers to any more are deleted with it.
- Repos without a clone under `~/code` get a bare clone in `~/.offline-github/clones/`.

## How it's built

- `src/server`: Node + TypeScript (run through `tsx`), Hono HTTP server on 127.0.0.1. It only answers requests for localhost, and writes need an `x-ogh` header, so other websites can't drive it. GitHub GraphQL for snapshots and reviews, REST for single comments.
- `web`: React + Vite, GitHub's Primer components and tokens, `@pierre/diffs` (Shiki highlighting) for diffs. Everything is bundled locally, so the UI works with no network.
- Tests: `npm test` covers the outbox (against a fake GitHub API: ordering, holds, fallbacks, lost responses, no double posts), diff parsing (renames, quoted and unicode paths, binary and generated files) and worktree safety.

## Known limits

- Reactions, editing or deleting comments already on GitHub, and merging aren't supported offline.
- CI logs aren't downloaded. The Checks tab shows each check's status as of the last sync.
- Line comments are only allowed on the "All changes" view, and on new-side lines in "since last review". Other views map to different line numbers on GitHub.
- Very large or generated files (lockfiles, `linguist-generated`) are collapsed until you click **Load diff**, like on GitHub.
- "Move to latest version" moves comments on new-side lines. Comments on removed (old-side) lines keep their line numbers, which can be off if the base branch moved (e.g. after "Update branch").
- PR-supplied files (raw files, downloaded media) are served with a sandboxing Content-Security-Policy, and the app has its own strict CSP.
