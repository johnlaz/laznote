# LazNote v4.0 — Capture, Confirm, Conquer

## What changed

### Capture sheet — no more vanishing buttons
- New flex structure: scrollable `.capture-body` + sticky `.capture-footer`
- "Save raw" and "Sort with AI" are pinned to the bottom regardless of keyboard, content length, or input mode
- Textarea autogrows up to 50vh, then scrolls internally instead of pushing the footer off

### Blade view — frozen chrome
- FAB and bottom nav stay anchored to the shell
- Blade list gets `padding-bottom: 168px + safe-area` so the last note never hides under the FAB

### Note detail — 4 clearer top buttons
- Replaced the small icon-btn row with `.action-btn` (40×40 with 18px icons)
- **Done**: lime-filled with bold 3px check + soft glow — unambiguous
- **Edit**: pencil-and-paper combo
- **Export**: download-into-tray
- **Trash**: classic bin with lid, red-tinted on hover
- When a note is already done, the check swaps to a curved revive arrow (same lime style)

### Tooltips everywhere
- Every icon button has `has-tip` + `data-tip="…"` for hover labels (`.has-tip[data-tip]::after`)
- Touch devices: 500ms long-press surfaces the same tooltip for 1.8s
- Custom CSS tooltips (no native `title=` since iOS ignores them)

### Onboarding — 6 cards instead of 3
- 01 — Pulse intro
- 02 — Three capture modes with icon rows
- 03 — Filing demo: a sample note flies into the DIY stack (animated)
- 04 — Airlock walkthrough showing a 62% confidence pill + the manual stack choice
- 05 — Merge demo with anchor + 82% match
- 06 — Groq key entry
- "Skip tour" link top-right on every card except the last
- "Back" button on every card except the first
- "Replay tour" row added in Settings → Tour & learning

### Scan / merge — anchor dropdown, confirmation, undo
- Each duplicate group now renders as a card with a **dropdown** listing all members; pick whichever one should survive the merge
- Anchor preview (first 140 chars) and stack/date right under the dropdown
- Each match shows score, preview snippet, and a "why these matched" reasons line
- Clicking **Merge →** opens a confirmation modal with side-by-side anchor (lime) → archived (default) preview, plus a callout explaining what merges and the 8-second undo window
- After confirm: rich undo toast with progress bar (`#undo-toast`) — 8s window to revert
- Permanent unmerge available from:
  - **Settings → Merge history** (up to 20 most recent, full timestamps)
  - **Archive → merged notes** (↺ Unmerge button next to a merged dup)
- Each merge stores a complete snapshot (both notes' pre-merge state) so unmerge restores byte-for-byte

### Desktop mode (auto at ≥1024px)
- Three-column grid: left sidebar (220px) · main feed (1fr) · edit panel (380px)
- **Sidebar**: branded header, "New note" button, all nav targets with active/airlock count badges, Scan + Search rows, Settings at the bottom
- **Main column**: contextual title + subtitle, 1-col / 2-col toggle for blade and cards views (persisted in settings)
- **Edit panel**: notes open in-place on the right instead of replacing the main column — same 4 action buttons in the header, autosaving textarea, hashtags, timestamp
- Bottom nav and the FAB are hidden on desktop (a header "New note" button takes over)
- Capture sheet on desktop becomes a centered 560×640 modal with a blurred backdrop instead of bottom-sliding
- **Keyboard shortcuts** (desktop, outside inputs):
  - `N` — new note
  - `/` — search
  - `Esc` — close modal / edit panel
  - `Cmd/Ctrl+Enter` (inside capture textarea) — save with AI

### Service worker
- Cache bumped to `laznote-v4.0` — existing installs will fetch fresh files on next load

## File changes
- `index.html` — capture-sheet rewritten, note-detail buttons replaced, desktop sidebar/main/edit panel added, merge confirmation modal + undo toast container, onboarding skip button, scan-modal switched to `.modal-sheet`, tooltips added on all icon-btns
- `styles.css` — capture sheet flex column, autosizing textarea, blade scroll padding, FAB cleanup; **+330 lines appended** for tooltips, `.action-btn` styles, onboarding demo cards, merge confirmation modal, undo toast, anchor dropdown, full desktop mode grid, and confirmation modal helpers
- `app.js` — `showUndoToast()` helper; 6-card `ONB` array + back/skip handlers; `autosize`, `setDesktopCols`, `skipOnboarding`, `replayTour` exposed on `LazNote`; `scanNotes` rewritten to build `state._scanGroups` with anchor swap; `requestMerge` → `confirmMerge` → `_performMerge` flow with snapshot capture; `unmergeBySnapshot`, `unmergeByTimestamp`, `unmergeFromArchive`; desktop-mode runtime (`setupDesktopMode`, `navWrapper`, `renderDesktopEditPanel`, `closeDesktopEditPanel`, sidebar badges, header sync); touch tooltip handler; desktop keyboard shortcuts; Settings gets Merge history + Tour & learning sections; Archive gets ↺ Unmerge on merged dups
- `sw.js` — cache name → `laznote-v4.0`

## Known boundaries
- Merge history is capped at 100 snapshots (oldest auto-pruned). If you regularly unmerge old stuff and never want to lose history, bump that cap in `_performMerge`.
- Desktop mode kicks in strictly at ≥1024px. On a 1023px tablet you'll still see the phone-shell layout; resize past 1024 and the view re-parents live (handled by `DESKTOP_MQ.addEventListener`).
- The desktop edit panel saves the textarea on blur. If you want true keystroke-by-keystroke autosave I can swap to a debounced input handler.
