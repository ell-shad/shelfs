// Application entry point. Owns state and wiring only: the 3D shelf, the shell
// chrome, the detail card, dialogs and the reader panel are separate modules,
// and every piece of real logic (library, files, database) lives in Rust.

import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { api, type AppInfo, type Book, type ImportProgressEvent, type Settings } from "./lib/api";
import { applyTheme, prefersReducedMotion, resolveTheme, watchSystemTheme } from "./lib/theme";
import { loadReaderFonts, loadShelfFonts } from "./lib/fonts";
import { apiErrorMessage, t } from "./lib/i18n";
import { basename } from "./lib/format";
import { Shell } from "./ui/shell";
import { BookCard } from "./ui/card";
import { LibraryList } from "./ui/list";
import { confirmDialog, duplicateDialog, editBookDialog, settingsDialog } from "./ui/dialogs";
import { ShelfView } from "./shelf/ShelfView";
import { Reader } from "./reader/Reader";
import { renderPdfCoverPng } from "./reader/pdfCover";
import type { LibraryView, SortKey, StatusFilter } from "./bindings";

const BOOK_FILTERS = [{ name: "Books", extensions: ["pdf", "epub"] }];

async function main(): Promise<void> {
  const app = document.getElementById("app");
  const shelfRoot = document.getElementById("shelf-root");
  const overlayRoot = document.getElementById("overlay-root");
  const readerRoot = document.getElementById("reader-root");
  if (!app || !shelfRoot || !overlayRoot || !readerRoot) {
    throw new Error("index.html is missing its mount points");
  }
  const readerHost: HTMLElement = readerRoot;

  let settings: Settings = await api.settings();
  let info: AppInfo | null = null;
  try {
    info = await api.appInfo();
  } catch {
    info = null;
  }
  applyTheme(settings.theme);
  void loadShelfFonts();
  void loadReaderFonts();

  const state = {
    snapshot: null as Awaited<ReturnType<typeof api.library>> | null,
    search: "",
    searchIds: null as Set<number> | null,
    readerOpen: false,
    coverQueue: [] as number[],
    coverBusy: false,
  };

  const shell = new Shell(app, {
    onAddFiles: () => void pickFiles(),
    onAddFolder: () => void pickFolder(),
    onSearch: (query) => void runSearch(query),
    onFilter: (filter) => void patchView({ filter }),
    onSort: (sort) => void patchView({ sort }),
    onView: (view) => void patchView({ view }),
    onSettings: () => openSettings(),
    onPrevCase: () => shelf.prevCase(),
    onNextCase: () => shelf.nextCase(),
    onResetView: () => void resetView(),
  });

  const shelf = new ShelfView(shelfRoot, {
    onSelect: (bookId) => {
      const book = bookId === null ? null : (findBook(bookId) ?? null);
      card.show(book);
    },
    onHover: (bookId, x, y) => {
      const book = bookId === null ? null : (findBook(bookId) ?? null);
      if (book) shell.showTooltip(book, x, y);
      else shell.hideTooltip();
    },
    onReorder: (bookId, targetIndex) => void reorder(bookId, targetIndex),
    onDrag: () => {
      /* drop position is computed inside ShelfView; no shell chrome needed */
    },
    onCaseChange: (index, total) => shell.setCase(index, total),
    onRead: (bookId) => {
      const book = findBook(bookId);
      if (book) void openBook(book);
    },
    onSlowFrame: (frameMs) => void maybeSuggestPerformance(frameMs),
  });

  const list = new LibraryList(shell.listRoot, {
    onSelect: (book) => card.show(book),
    onRead: (book) => void openBook(book),
    onRelink: (book) => void relink(book),
  });

  const card = new BookCard(overlayRoot, {
    onRead: (book) => void openBook(book),
    onEdit: (book) =>
      editBookDialog(book, async (patch) => {
        await api.updateBook(book.id, patch);
        await reload();
        const refreshed = findBook(book.id);
        card.show(refreshed ?? null);
      }, () => void removeBook(book)),
    onRemove: (book) => void removeBook(book),
    onStatus: (book, status) => void setStatus(book, status),
    onRelink: (book) => void relink(book),
    onClose: () => card.show(null),
  });

  function findBook(id: number): Book | undefined {
    return state.snapshot?.books.find((book) => book.id === id);
  }

  function visibleBooks(): Book[] {
    const books = state.snapshot?.books ?? [];
    if (!state.searchIds) return books;
    return books.filter((book) => state.searchIds?.has(book.id));
  }

  async function reload(): Promise<void> {
    const snapshot = await api.library();
    state.snapshot = snapshot;
    settings = snapshot.settings;
    applyTheme(settings.theme);
    shelf.setTheme(resolveTheme(settings.theme));
    shelf.setPerformanceMode(settings.performanceMode);
    shell.setSettings(settings);
    shelf.setData(snapshot, { reducedMotion: prefersReducedMotion() });
    shelf.setSearchMatch(state.searchIds);
    shelf.setPaused(state.readerOpen || settings.view === "list");
    const visible = visibleBooks();
    shell.setLibrary(snapshot, visible.length, Boolean(state.searchIds));
    list.render(visible, snapshot.total);
    queueMissingCovers();
  }

  // ------------------------------------------------------------- importing

  async function pickFiles(): Promise<void> {
    const chosen: unknown = await openFileDialog({ multiple: true, filters: BOOK_FILTERS });
    const paths = asPaths(chosen);
    if (paths.length) await importPaths(paths);
  }

  async function pickFolder(): Promise<void> {
    const chosen: unknown = await openFileDialog({ directory: true, multiple: false });
    const path = typeof chosen === "string" ? chosen : null;
    if (path) await importPaths([path]);
  }

  async function importPaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    try {
      const hits = await api.checkDuplicates(paths);
      let policy: "skip" | "add" = "skip";
      if (hits.length) {
        shell.toast(t("duplicatesFound", { n: hits.length }));
        policy = await duplicateDialog(hits);
      }
      const summary = await api.importFiles(paths, policy);
      shell.finishImport(summary);
      await reload();
      for (const id of summary.needsCover) state.coverQueue.push(id);
      void pumpCovers();
      if (summary.imported.length === 0 && summary.failures.length === 0) {
        shell.toast(t("importFailed", { n: summary.failures.length }), { kind: "info" });
      }
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  /** Render page 1 for PDFs that came in without an extracted cover. */
  function queueMissingCovers(): void {
    if (!info) return;
    for (const book of state.snapshot?.books ?? []) {
      if (book.format === "pdf" && !book.coverPath && !book.missing && !state.coverQueue.includes(book.id)) {
        state.coverQueue.push(book.id);
      }
    }
    void pumpCovers();
  }

  async function pumpCovers(): Promise<void> {
    if (state.coverBusy || state.readerOpen || !info) return;
    const id = state.coverQueue.shift();
    if (id === undefined) return;
    state.coverBusy = true;
    try {
      const png = await renderPdfCoverPng(`${info.protocolBase}/pdf/${id}`);
      if (png) {
        const book = await api.savePdfCover(id, png);
        const stored = state.snapshot?.books.find((b) => b.id === id);
        if (stored) {
          stored.coverPath = book.coverPath;
          stored.coverUrl = book.coverUrl;
          stored.color = book.color;
        }
        shelf.setData(state.snapshot!, { reducedMotion: prefersReducedMotion() });
        shelf.setSearchMatch(state.searchIds);
      }
    } catch {
      // A cover that cannot render is cosmetic: the generated cover stays.
    } finally {
      state.coverBusy = false;
      if (state.coverQueue.length) window.setTimeout(() => void pumpCovers(), 40);
    }
  }

  // -------------------------------------------------------------- library

  async function patchView(patch: { filter?: StatusFilter; sort?: SortKey; view?: LibraryView }): Promise<void> {
    try {
      settings = await api.setSettings(patch);
      await reload();
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  async function resetView(): Promise<void> {
    try {
      settings = await api.resetLibraryView();
      state.search = "";
      state.searchIds = null;
      await reload();
      shell.toast(t("resetView"));
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  async function runSearch(query: string): Promise<void> {
    state.search = query.trim();
    if (!state.search) {
      state.searchIds = null;
      shelf.setSearchMatch(null);
    } else {
      const ids = await api.searchLibrary(state.search);
      state.searchIds = new Set(ids);
      shelf.setSearchMatch(state.searchIds);
      const first = visibleBooks()[0];
      if (first) shelf.panToBook(first.id);
    }
    const visible = visibleBooks();
    shell.setLibrary(state.snapshot ?? { ...emptySnapshot() }, visible.length, Boolean(state.searchIds));
    list.render(visible, state.snapshot?.total ?? 0);
  }

  async function setStatus(book: Book, status: Book["status"]): Promise<void> {
    try {
      await api.updateBook(book.id, { status });
      await reload();
      const refreshed = findBook(book.id);
      card.show(refreshed ?? null);
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  async function removeBook(book: Book): Promise<void> {
    const ok = await confirmDialog({
      title: t("removeBook"),
      message: t("removeConfirm", { title: book.title }),
      confirmLabel: t("remove"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeBook(book.id);
      card.show(null);
      shelf.select(null);
      await reload();
      shell.toast(t("removed"));
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  async function relink(book: Book): Promise<void> {
    const chosen: unknown = await openFileDialog({ multiple: false, filters: BOOK_FILTERS });
    const path = typeof chosen === "string" ? chosen : null;
    if (!path) return;
    try {
      await api.relinkBook(book.id, path);
      await reload();
      card.show(findBook(book.id) ?? null);
      shell.toast(t("added"));
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  async function reorder(bookId: number, targetIndex: number): Promise<void> {
    try {
      await api.moveBook(bookId, targetIndex);
      await reload();
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  // --------------------------------------------------------------- reader

  async function openBook(book: Book): Promise<void> {
    if (state.readerOpen) return;
    if (book.missing) {
      shell.toast(t("missingExplanation"), {
        kind: "error",
        action: { label: t("relink"), run: () => void relink(book) },
      });
      return;
    }
    try {
      state.readerOpen = true;
      shelf.setPaused(true);
      card.show(null);
      const opened = await api.openBook(book.id);
      await Reader.open(readerHost, {
        book: opened.book,
        opened,
        settings,
        onClose: () => {
          state.readerOpen = false;
          shelf.setPaused(settings.view === "list");
          void reload().then(() => void pumpCovers());
        },
        onBookChanged: (changed) => {
          const stored = state.snapshot?.books.find((b) => b.id === changed.id);
          if (stored) Object.assign(stored, changed);
        },
      });
    } catch (error) {
      state.readerOpen = false;
      shelf.setPaused(settings.view === "list");
      shell.toast(t("openFailed", { message: apiErrorMessage(error) }), { kind: "error" });
    }
  }

  // ------------------------------------------------------------- settings

  function openSettings(): void {
    if (!info) return;
    settingsDialog(settings, info, {
      patch: async (patch) => {
        settings = await api.setSettings(patch);
        applyTheme(settings.theme);
        shelf.setTheme(resolveTheme(settings.theme));
        shelf.setPerformanceMode(settings.performanceMode);
        await reload();
      },
      backup: () => void backup(),
      restore: () => void restore(),
      resetView: () => void resetView(),
    });
  }

  async function backup(): Promise<void> {
    const path = await saveFileDialog({
      defaultPath: "bookshelf-backup.zip",
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (!path) return;
    try {
      const report = await api.backupLibrary(path);
      shell.toast(t("backupDone", { n: report.books, path: basename(report.path) }));
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  async function restore(): Promise<void> {
    const chosen: unknown = await openFileDialog({
      multiple: false,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    const path = typeof chosen === "string" ? chosen : null;
    if (!path) return;
    try {
      const report = await api.restoreLibrary(path);
      await reload();
      shell.toast(t("restoreDone", { n: report.booksAdded, m: report.booksMerged }));
    } catch (error) {
      shell.toast(apiErrorMessage(error), { kind: "error" });
    }
  }

  async function maybeSuggestPerformance(frameMs: number): Promise<void> {
    if (settings.performanceMode || settings.suggestPerformance) return;
    if (frameMs < 26) return;
    const fps = Math.max(1, Math.round(1000 / frameMs));
    const enabled = await confirmDialog({
      title: t("performanceTitle"),
      message: t("performanceBody", { fps }),
      confirmLabel: t("enable"),
    });
    settings = await api.setSettings({ suggestPerformance: true });
    if (!enabled) return;
    settings = await api.setSettings({ performanceMode: true });
    shelf.setPerformanceMode(true);
    shell.toast(t("performanceHint"));
  }

  // ------------------------------------------------------- events & input

  let reloadTimer = 0;
  const scheduleReload = () => {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void reload(), 120);
  };

  await listen("library-changed", scheduleReload);
  await listen<ImportProgressEvent>("import-progress", (event) => {
    const payload = event.payload;
    shell.setImportProgress(
      payload.done,
      payload.total,
      payload.phase === "done" ? "" : payload.current,
    );
  });
  await listen<string[]>("open-files", (event) => void importPaths(event.payload));

  // Drag and drop: Tauri's webview event carries real filesystem paths.
  const overlayHandlers = {
    dragOver: (over: boolean) => shell.showDropOverlay(over),
    drop: (paths: string[]) => {
      shell.showDropOverlay(false);
      if (paths.length) void importPaths(paths);
    },
  };
  getCurrentWebview()
    .onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "drop") overlayHandlers.drop(asPaths(payload.paths));
      else overlayHandlers.dragOver(payload.type === "over");
    })
    .catch(() => {
      /* drag-and-drop is optional: the Add book button always works */
    });
  // Stop the webview from navigating away when a file is dropped outside.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  window.addEventListener("keydown", (event) => {
    const target = event.target as Element | null;
    const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      shell.focusSearch();
      return;
    }
    if (typing || state.readerOpen) return;
    if (event.key === "ArrowLeft") shelf.prevCase();
    else if (event.key === "ArrowRight") shelf.nextCase();
    else if (event.key === "Escape" && card.book) {
      card.show(null);
      shelf.select(null);
    }
  });

  watchSystemTheme(() => {
    applyTheme(settings.theme);
    shelf.setTheme(resolveTheme(settings.theme));
  });

  document.addEventListener("visibilitychange", () => {
    shelf.setPaused(document.hidden || state.readerOpen || settings.view === "list");
  });

  await reload();

  // Files handed over by a second launch (`bookshelf book.pdf`).
  const pending = await api.takePendingFiles();
  if (pending.length) await importPaths(pending);

  document.getElementById("boot")?.remove();
}

/** Normalise whatever the file dialog returned into a list of paths. */
function asPaths(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  const list: unknown[] = value;
  return list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function emptySnapshot(): Awaited<ReturnType<typeof api.library>> {
  return {
    books: [],
    layout: { slots: [], caseCount: 1 },
    settings: undefined as unknown as Settings,
    total: 0,
    byStatus: { want: 0, reading: 0, read: 0, missing: 0 },
  };
}

main().catch((error: unknown) => {
  const boot = document.getElementById("boot");
  if (boot) {
    boot.replaceChildren();
    const message = document.createElement("p");
    message.textContent = t("bootError", { message: apiErrorMessage(error) });
    boot.append(message);
  } else {
    console.error(error);
  }
});
