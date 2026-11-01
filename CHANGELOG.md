# Changelog

All notable changes to Shelfs. Format follows Keep a Changelog; versions follow
SemVer once 1.0 is out.

## [Unreleased]

### Fixed

- **Flowers no longer float or look broken.** Every potted plant stem is now its own
  pivot: the shaft, its leaves and a tulip-shaped head (cup, three petals, pointed
  bud) hang off one another, so each flower sits on the end of a stem that leans with
  it. The table vase gets the same treatment, its stems rise from the mouth of the
  glass instead of hovering beside it, the glass is double-sided and no longer hides
  what is inside it, and the vase has a rim.
- **Framed prints have both side rails.** Only the top, bottom and left boards were
  drawn, so every picture was open on the right.

### Changed

- **The app is called Shelfs.** Window title, About dialog, boot text, the `.desktop`
  entry, the AppStream name, the bundle file names and the log lines all use the new
  name. The identifier stays `com.ellshad.bookshelf` and the library stays in
  `~/.local/share/bookshelf`, so nothing moves.

### Added

- **The bookcase now stands in a room.** A woven rug, a bright window with a sill,
  two framed prints, a potted plant with flowers and a small round table set with
  books, a mug and a vase of tulips are generated procedurally (no image assets) and
  pan with the camera, so every case is furnished. Everything follows the light and
  dark palettes.
- **A proper About section, and GPLv3.** The app identifier is now
  `com.ellshad.bookshelf`, Bookshelf is licensed under the GNU General Public
  License v3.0 or later, and About lists the licence, copyright, source code and
  third-party credits. The `.deb` installs the GPL text and the third-party notices
  to `/usr/share/doc/bookshelf/`.

- **Place a book on any shelf.** Dragging a book up or down onto another shelf
  pins it there; the shelf it was dropped on is remembered per book, the board
  under the pointer lights up while dragging, and dropping a book back beside its
  neighbours still reorders them. Pinned books reserve their shelf and the rest
  of the library packs around them.
- **Warmer, less clinical shelf lighting.** The room uses a cream wall, oak floor
  and a lighter back panel instead of a green-grey wall and an almost-black back;
  a warm ambient fill, a brighter sun and a stronger lamp replace the flat, cold
  wash, the boards gained a darker front lip, and books lean by a fraction of a
  degree so a shelf no longer looks machine-stacked.

### Fixed

- **The page jumped when a reader panel opened.** The side panel took a grid
  column, so opening it shrank the stage, re-fitted the PDF and slid the sheet
  sideways (with the thumbnail panel it disappeared behind the squeezed column).
  The panel now floats over the page, so the document never moves.
- **Night mode switched itself off.** Pages got the `night` class when they were
  built, but a rebuilt page (new layout, zoom, rotation) came back without it, so
  changing almost any appearance setting showed a bright page again while the
  toggle still read on. New pages now carry the night class too.

- **The reader's appearance and thumbnail panels opened invisibly.** The side
  panel is the first grid child and the stage is pinned to column 2, so the panel
  auto-placed into column 1. That is the 0-width column when a panel sits on the
  right, so "Reading appearance" and "Page thumbnails" had nothing to show, while
  the left-hand panels (contents, search, notes) worked. The panel now declares
  its column and is clipped to its own box.
- **Reader panel controls could be invisible.** The zoom and rotate buttons used
  the shelf theme's colours, which went dark-on-dark whenever the shelf was light
  and the reader dark; they now use the reading palette.
- **The Add book button did nothing.** The button opened its menu on click, and
  the same click then reached the document-level "click outside closes the menu"
  listener, which removed the menu again in the same tick. The click no longer
  propagates, so the menu stays open and its "Add book" / "Add a folder…" items
  are reachable.
- **The Add book menu was unreadable in dark theme.** The dark palette never
  defined `--surface-solid`, so the menu fell back to the light cream surface with
  light text on top of it. The variable is now defined per theme.

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
