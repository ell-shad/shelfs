# Changelog

All notable changes to Bookshelf. Format follows Keep a Changelog; versions follow
SemVer once 1.0 is out.

## [0.1.0] — 2026-10-28

First release: a working local PDF/EPUB library with a 3D shelf and a built-in
reader for both formats.

### Added

- **Shelf.** three.js bookcase built to the reference geometry (5 boards, 4
  shelves, wood-grain boards, darker back panel) with books as 3D objects: generated
  spines with title, author and status dot, real covers when a book has one, hover
  pull-out with tooltip, click-to-fly detail view, orbit/zoom with clamped camera,
  damped motion (`k = 1 - 0.0009^dt`), drop-in for new books and slide-close for
  removed ones. Unlimited library: extra cases appear and the camera pans between
  them (arrows, keys, shift-drag, horizontal scroll) with a case indicator.
- **Library backend (Rust).** SQLite with WAL and versioned migrations, blake3
  deduplication, background import with progress and per-file error reporting,
  metadata extraction (title, author, language, pages; EPUB pages estimated from
  text length), cover extraction (EPUB cover image, PDF page 1), dominant-colour
  spine tint clamped to a legible mid-tone, persistable book dimensions, missing
  file detection with hash-checked relinking, edit/remove, reference-or-copy storage
  modes, library backup and restore as a ZIP.
- **Import entry points.** File picker (portal-backed), drag and drop onto the
  window, folder import, CLI arguments, and single-instance hand-off from a second
  launch.
- **Library UI.** Search with lit/dimmed matches and camera pan to the first hit,
  status filters, five sort orders, manual drag reordering, empty and no-match
  states, toasts with actions.
- **PDF reader.** pdf.js with virtualised pages and a text layer, fit width/page/
  actual/custom zoom, rotation, single/continuous/spread layouts, thumbnails
  sidebar, outline, working internal and external links, night mode, password
  prompt, resume, and page navigation from the progress slider.
- **EPUB reader.** EPUB 2 and 3 parsing in Rust (container, OPF, spine, manifest,
  nav/NCX, cover, fixed-layout detection, DRM refusal), chapters rendered in a
  sandboxed script-less iframe with network blocked, paginated mode with an
  automatic two-column spread, continuous scroll, contents panel, appearance
  controls (five bundled fonts including a dyslexia-friendly one, size, line and
  paragraph spacing, margins, alignment, hyphenation, publisher styles on/off),
  image zoom, footnote pop-ups, RTL best effort.
- **Reader features.** Bookmarks with labels, highlights in four colours with notes
  stored against text-quote anchors, in-book search with in-text highlighting and
  next/previous, five themes with per-book override, full keyboard control,
  fullscreen with auto-hiding chrome, annotation export as Markdown or JSON, and
  resume with a status auto-update (Want to read → Reading → offer to mark Read).
- **Accessibility.** List/grid library view that needs no GPU, ARIA labels, visible
  focus, reduced-motion mode, performance mode for software rendering.
- **Packaging.** `.deb` and AppImage bundles, `.desktop` file with PDF/EPUB MIME
  associations, icon set, AppStream metainfo, MIT licence.
- **Docs and tests.** README, architecture, decision log, 60+ Rust tests covering
  layout, migrations, import, formats, anchors and zip safety, frontend unit tests,
  generated fixtures, headless GUI scripts, GitHub Actions CI.

### Fixed

- Reader shortcuts (paging, `T`, `B`, `Ctrl+F`, zoom) were ignored whenever the
  progress slider had focus, which is exactly where focus lands after a panel
  closes. Only text-entry controls own the keyboard now.
- In-book search highlights were invisible in PDFs: the `bs-find` classes were never
  styled for the PDF text layer (the EPUB reader styles its own copy inside the
  chapter iframe).
- The shelf hint wrapped onto a second line and read as two separate hints.

### Known limitations

- Fixed-layout EPUB and vertical writing are best effort.
- PDF search highlights and text selection can sit a few characters off the printed
  word when a PDF has no embedded font: pdf.js lays the text layer out with
  fallback-font metrics, so the transparent text drifts from the rendered glyphs.
  Documents with embedded fonts align.
- PDF pages arrive over IPC (see docs/DECISIONS.md), so one copy of the file is held
  in memory while it is open; very large PDFs are slower to open than they would be
  with range requests.
- The 3D view is a canvas: it is not screen-reader accessible by design, which is why
  the list view exists.
- The app id is a placeholder (`com.example.Bookshelf`).
