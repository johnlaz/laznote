# LazNote v4.5

## AI models no longer break when Groq retires them
- Groq shut down `llama-3.1-8b-instant`, `llama-3.3-70b-versatile` (Aug 16 2026) and `llama-4-scout` (Jul 17 2026), which LazNote had hardcoded. Sorting, Logic, Scan were failing.
- Models are now chosen per task (Sorting, Logic, Scan, Voice) from `GET /models` for the user's own key, ranked by family and newest version.
- Refreshes on key save, once a day at launch / on return to the app, and via Settings → Groq → **Refresh models**.
- Self-healing: a call that hits a retired model re-checks the list, switches and retries (max 2 switches). 401/429 never trigger a switch.
- Scan falls back to on-device OCR if no vision model is usable.
- Cold-start defaults (`MODEL_FALLBACKS` in app.js): gpt-oss-20b, gpt-oss-120b, qwen3.8-27b, whisper-large-v3-turbo.

## Language
- "Blades" is now "Notes" everywhere in the app UI.

## Trash
- Every route to Trash (note screen, desktop panel, Archive, card menu) shows a red "Moved to trash" toast with **Undo**.
- Removed the native "Move to trash?" popups (Undo replaces them). Card-menu "Delete" now trashes instead of erasing permanently.

## Layout and buttons
- Desktop: opening a note no longer dumps the phone screen below the grid (blank list, empty panel). Notes open in the side panel, which now shares one renderer with the phone screen; the open note is highlighted.
- **Done** is a raised, labelled button (icon-only under 480px). Airlock notes get a Confirm banner at the top.
- Tooltips open below header buttons, stay on-screen, and are readable in the light theme.
- Fixed: the closed capture sheet invisibly blocked clicks in the centre of the desktop list.
- Fixed: "Move to" chips on the note screen did nothing.
- Fixed: the exit toast left the Undo button labelled "Stay".
- Toasts sit above the Pulse button on phones. Note text box auto-grows.
