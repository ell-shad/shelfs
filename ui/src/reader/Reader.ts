// The reader panel: one full-window surface over the shelf, with a slim
// toolbar, side panels, a progress bar and a floating selection toolbar.
// Format differences live behind ReaderAdapter; everything here is shared.

import { api } from "../lib/api";
import type {
  Annotation,
  Bookmark,
  Book,
  HighlightColor,
  Locator,
  OpenedBook,
  Settings,
  SettingsPatch,
} from "../lib/api";
import { apiErrorMessage, t, type MessageKey } from "../lib/i18n";
import { READER_FONTS, loadReaderFonts, readerFontStack } from "../lib/fonts";
import type { ReaderThemeId } from "../lib/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { EpubPackage } from "../bindings";
import { EpubReader } from "./epub";
import { PdfReader } from "./pdf";
import type { AdapterCallbacks, PanelKind, ReaderAdapter, SearchHit, SelectionPayload } from "./types";

export interface ReaderOptions {
  book: Book;
  opened: OpenedBook;
  settings: Settings;
  onClose(): void;
  onBookChanged(book: Book): void;
}

type IconName = "back" | "contents" | "search" | "bookmark" | "notes" | "appearance" | "expand" | "prev" | "next";

const ICONS: Record<IconName, string> = {
  back: '<path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  contents: '<path d="M5 6h14M5 12h14M5 18h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  search: '<circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  bookmark: '<path d="M7 4h10v16l-5-4-5 4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  notes: '<path d="M5 5h14v10l-4 4H5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 9h6M9 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  appearance: '<path d="M4 18 10 5l6 13M7 13h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18" cy="8" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  prev: '<path d="m14 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  next: '<path d="m10 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
};

const COLORS: { id: HighlightColor; label: string }[] = [
  { id: "yellow", label: "Yellow" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "pink", label: "Pink" },
];

export class Reader {
  private readonly opts: ReaderOptions;
  private settings: Settings;
  private adapter: ReaderAdapter | null = null;
  private root: HTMLElement;
  private stage: HTMLElement;
  private panel: HTMLElement;
  private panelTitle: HTMLElement;
  private panelBody: HTMLElement;
  private titleEl: HTMLElement;
  private headingEl: HTMLElement;
  private slider: HTMLInputElement;
  private percentEl: HTMLElement;
  private statusEl: HTMLElement;
  private timeEl: HTMLElement;
  private toolbar: HTMLElement;
  private footer: HTMLElement;

  private bookmarks: Bookmark[] = [];
  private annotations: Annotation[] = [];
  private openPanelKind: PanelKind | null = null;
  private scrubbing = false;
  private saveTimer: number | null = null;
  private lastLocator: Locator | null = null;
  private lastProgress = 0;
  private endPrompted = false;
  private closed = false;
  private fullscreen = false;
  private idleTimer: number | null = null;
  private selectionPopup: HTMLElement | null = null;
  private searchTimer: number | null = null;
  private lastSelection: SelectionPayload | null = null;

  private constructor(opts: ReaderOptions, root: HTMLElement) {
    this.opts = opts;
    this.settings = opts.settings;
    this.root = root;
    this.stage = el("div", "reader-stage");
    this.panel = el("aside", "reader-side reader-side-left");
    this.panel.hidden = true;
    this.panelBody = el("div", "reader-side-body");
    this.panelTitle = el("h2", "");
    this.titleEl = el("strong", "reader-title");
    this.headingEl = el("span", "reader-subtitle");
    this.slider = document.createElement("input");
    this.slider.type = "range";
    this.slider.min = "0";
    this.slider.max = "1000";
    this.slider.step = "1";
    this.slider.value = "0";
    this.slider.setAttribute("aria-label", t("reader_progress"));
    this.percentEl = el("span", "numeric");
    this.statusEl = el("span", "numeric");
    this.timeEl = el("span", "numeric meter");
    this.toolbar = this.buildToolbar();
    this.footer = this.buildFooter();
  }

  static async open(root: HTMLElement, opts: ReaderOptions): Promise<Reader> {
    const reader = new Reader(opts, root);
    await reader.mount();
    return reader;
  }

  private async mount(): Promise<void> {
    this.root.hidden = false;
    this.root.replaceChildren();
    this.root.classList.add("reader");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", this.opts.book.title);
    this.root.dataset.theme = this.settings.reader.theme;

    const body = el("div", "reader-body");
    this.stage.classList.add("epub-stage");
    this.panel.append(this.buildPanelHeader(), this.panelBody);
    body.append(this.panel, this.stage);
    this.root.append(this.toolbar, body, this.footer);

    this.titleEl.textContent = this.opts.book.title;
    this.applyReaderTheme();

    this.adapter = this.buildAdapter();
    await this.adapter.mount(this.stage);

    this.bindKeys();
    this.bindSlider();
    this.bindChromeAutoHide();

    const opened = this.opts.opened;
    if (opened.locator) {
      await this.adapter.goTo(opened.locator);
    } else {
      await this.adapter.goTo(null);
    }
    await this.reloadAnnotations();
    await this.reloadBookmarks();
    this.updateProgressUi(this.adapter.locator(), this.adapter.progress());
    this.slider.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------- scaffolding

  private buildToolbar(): HTMLElement {
    const bar = el("header", "reader-toolbar");
    const back = toolButton("back", t("reader_back"), "Shelf", () => void this.close());
    const titles = el("div", "reader-title-wrap");
    titles.append(this.titleEl, this.headingEl);
    const tools = el("div", "reader-tools");
    tools.append(
      toolButton("contents", t("reader_contents"), "T", () => this.togglePanel("toc")),
      toolButton("search", t("reader_search"), "F", () => this.togglePanel("search")),
      toolButton("bookmark", t("reader_bookmark"), "B", () => void this.toggleBookmark()),
      toolButton("notes", t("reader_notes"), "", () => this.togglePanel("notes")),
      toolButton("appearance", t("reader_appearance"), "", () => this.togglePanel("appearance")),
    );
    if (this.adapterNeedsThumbs()) {
      tools.append(toolButton("contents", t("reader_thumbnails"), "", () => this.togglePanel("thumbs")));
    }
    tools.append(
      toolButton("expand", t("reader_fullscreen"), "F11", () => void this.toggleFullscreen()),
    );
    bar.append(back, titles, tools);
    return bar;
  }

  private buildFooter(): HTMLElement {
    const footer = el("footer", "reader-progress");
    const prev = iconButton("prev", t("reader_prev"), () => this.adapter?.prev());
    const next = iconButton("next", t("reader_next"), () => this.adapter?.next());
    footer.append(prev, this.slider, this.percentEl, this.statusEl, this.timeEl, next);
    return footer;
  }

  private buildPanelHeader(): HTMLElement {
    const header = el("header", "reader-side-head");
    const close = textButton("×", () => this.closePanel(), "ghost-btn icon-only");
    close.setAttribute("aria-label", t("close"));
    header.append(this.panelTitle, close);
    return header;
  }

  private adapterNeedsThumbs(): boolean {
    return this.opts.book.format === "pdf";
  }

  // ---------------------------------------------------------------- adapters

  private buildAdapter(): ReaderAdapter {
    const callbacks: AdapterCallbacks = {
      onProgress: (locator, progress) => this.onProgress(locator, progress),
      onSelection: (payload) => this.showSelectionPopup(payload),
      onToc: () => this.renderPanelIfOpen(),
      onPageCount: () => {},
      onNotice: (message) => this.toast(message),
      onError: (message) => this.toast(message, { error: true }),
      onLink: (url) => void this.openExternal(url),
      onImage: (src, alt) => this.showImage(src, alt),
      onPasswordRequest: (reason) => this.askPassword(reason),
      onHistory: (depth) => this.showHistoryChip(depth),
    };
    if (this.opts.book.format === "pdf") {
      return new PdfReader({
        book: this.opts.book,
        settings: this.settings,
        callbacks,
        theme: this.settings.reader.theme,
        performanceMode: this.settings.performanceMode,
      });
    }
    const pkg = this.opts.opened.epub as EpubPackage | null;
    if (!pkg || pkg.chapters.length === 0) {
      throw new Error("This EPUB has no readable chapters.");
    }
    return new EpubReader({
      book: this.opts.book,
      settings: this.settings,
      callbacks,
      theme: this.settings.reader.theme,
      baseUrl: pkg.baseUrl,
      toc: pkg.toc,
      chapters: pkg.chapters,
      rtl: pkg.rtl,
      fixedLayout: pkg.fixedLayout,
    });
  }

  // --------------------------------------------------------------- progress

  private onProgress(locator: Locator, progress: number): void {
    if (this.closed) return;
    this.lastLocator = locator;
    this.lastProgress = progress;
    this.updateProgressUi(locator, progress);
    if (this.adapter) {
      this.headingEl.textContent = this.adapter.heading();
    }
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.persist(), 700);
    if (progress > 0.985 && !this.endPrompted && this.opts.book.status !== "read") {
      this.endPrompted = true;
      this.promptFinished();
    }
  }

  private updateProgressUi(locator: Locator, progress: number): void {
    if (!this.scrubbing) this.slider.value = String(Math.round(progress * 1000));
    this.slider.setAttribute("aria-valuetext", `${Math.round(progress * 100)}%`);
    this.percentEl.textContent = `${Math.round(progress * 100)}%`;
    this.statusEl.textContent = this.adapter?.statusText() ?? "";
    const minutes = this.adapter?.minutesLeft() ?? 0;
    this.timeEl.textContent = minutes > 0 ? t("reader_minutes_left", { minutes }) : "";
    this.timeEl.hidden = minutes <= 0;
    void locator;
  }

  private bindSlider(): void {
    this.slider.addEventListener("pointerdown", () => {
      this.scrubbing = true;
    });
    this.slider.addEventListener("pointerup", () => {
      this.scrubbing = false;
    });
    this.slider.addEventListener("input", () => {
      this.percentEl.textContent = `${Math.round(Number(this.slider.value) / 10)}%`;
    });
    this.slider.addEventListener("change", () => {
      const fraction = Number(this.slider.value) / 1000;
      this.scrubbing = false;
      this.adapter?.goToFraction(fraction);
    });
  }

  private async persist(): Promise<void> {
    if (!this.lastLocator || this.closed) return;
    try {
      await api.saveProgress(this.opts.book.id, this.lastLocator, this.lastProgress);
    } catch {
      // Progress is best effort; a failure must not interrupt reading.
    }
  }

  private promptFinished(): void {
    const minutes = this.adapter?.minutesLeft() ?? 0;
    if (minutes > 2) return;
    this.toast(t("reader_finished"), {
      action: {
        label: t("reader_mark_read"),
        run: () => void this.markRead(),
      },
    });
  }

  private async markRead(): Promise<void> {
    try {
      const book = await api.updateBook(this.opts.book.id, { status: "read" });
      this.opts.book.status = book.status;
      this.opts.onBookChanged(book);
      this.toast(t("reader_marked_read"));
    } catch (error) {
      this.toast(apiErrorMessage(error), { error: true });
    }
  }

  // -------------------------------------------------------------- annotations

  private async reloadAnnotations(): Promise<void> {
    try {
      this.annotations = await api.listAnnotations(this.opts.book.id);
    } catch {
      this.annotations = [];
    }
    this.adapter?.setAnnotations(this.annotations);
    this.renderPanelIfOpen();
  }

  private async reloadBookmarks(): Promise<void> {
    try {
      this.bookmarks = await api.listBookmarks(this.opts.book.id);
    } catch {
      this.bookmarks = [];
    }
    this.renderPanelIfOpen();
  }

  private showSelectionPopup(payload: SelectionPayload): void {
    this.closeSelectionPopup();
    this.lastSelection = payload;
    const popup = el("div", "selection-popup");
    popup.setAttribute("role", "toolbar");
    popup.setAttribute("aria-label", t("reader_highlight"));
    for (const color of COLORS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `swatch swatch-${color.id}`;
      button.title = color.label;
      button.setAttribute("aria-label", `${color.label} highlight`);
      button.addEventListener("click", () => void this.saveHighlight(color.id, ""));
      popup.appendChild(button);
    }
    const note = document.createElement("button");
    note.type = "button";
    note.textContent = t("reader_add_note");
    note.addEventListener("click", () => void this.saveHighlightWithNote());
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = t("reader_copy");
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(payload.quote).then(() => this.toast(t("reader_copied")));
      this.closeSelectionPopup();
    });
    popup.append(note, copy);
    this.root.appendChild(popup);
    const width = 280;
    // The popup renders above its anchor (translate -50% / -100%).
    const left = Math.min(Math.max(width / 2 + 8, payload.anchorRect.x), window.innerWidth - width / 2 - 8);
    const top = Math.max(78, Math.min(payload.anchorRect.y + 4, window.innerHeight - 12));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    this.selectionPopup = popup;
    window.setTimeout(() => {
      const dismiss = (event: MouseEvent) => {
        if (this.selectionPopup && !this.selectionPopup.contains(event.target as Node)) {
          this.closeSelectionPopup();
          document.removeEventListener("mousedown", dismiss, true);
        }
      };
      document.addEventListener("mousedown", dismiss, true);
    }, 0);
  }

  private closeSelectionPopup(): void {
    this.selectionPopup?.remove();
    this.selectionPopup = null;
  }

  private async saveHighlight(color: HighlightColor, note: string): Promise<void> {
    const payload = this.lastSelection;
    if (!payload) return;
    try {
      const annotation = await api.addAnnotation(this.opts.book.id, {
        locator: payload.locator,
        quote: payload.quote,
        note,
        color,
        page: payload.locator.kind === "pdf" ? payload.locator.page : null,
      });
      this.annotations = [...this.annotations, annotation];
      this.adapter?.setAnnotations(this.annotations);
      this.adapter?.clearSelection?.();
      this.closeSelectionPopup();
      this.toast(t("reader_highlighted"));
      this.renderPanelIfOpen();
    } catch (error) {
      this.toast(apiErrorMessage(error), { error: true });
    }
  }

  private async saveHighlightWithNote(): Promise<void> {
    const note = await this.askText({
      title: t("reader_add_note"),
      label: t("reader_note_label"),
      placeholder: t("reader_note_placeholder"),
    });
    if (note === null) return;
    await this.saveHighlight("yellow", note);
  }

  // ---------------------------------------------------------------- bookmarks

  private async toggleBookmark(): Promise<void> {
    if (!this.lastLocator) return;
    const existing = this.bookmarks.find((bookmark) => sameLocator(bookmark.locator, this.lastLocator!));
    if (existing) {
      try {
        await api.removeBookmark(existing.id);
        this.bookmarks = this.bookmarks.filter((b) => b.id !== existing.id);
        this.toast(t("reader_bookmark_removed"));
        this.renderPanelIfOpen();
      } catch (error) {
        this.toast(apiErrorMessage(error), { error: true });
      }
      return;
    }
    try {
      const bookmark = await api.addBookmark(
        this.opts.book.id,
        this.lastLocator,
        this.adapter?.heading() ?? "",
        this.lastLocator.kind === "pdf" ? this.lastLocator.page : null,
      );
      this.bookmarks = [bookmark, ...this.bookmarks];
      this.toast(t("reader_bookmarked"));
      this.renderPanelIfOpen();
    } catch (error) {
      this.toast(apiErrorMessage(error), { error: true });
    }
  }

  // ------------------------------------------------------------------ panels

  private togglePanel(kind: PanelKind): void {
    if (this.openPanelKind === kind) {
      this.closePanel();
      return;
    }
    this.openPanel(kind);
  }

  private openPanel(kind: PanelKind): void {
    this.openPanelKind = kind;
    const side = kind === "appearance" || kind === "thumbs" ? "right" : "left";
    this.panel.classList.toggle("reader-side-left", side === "left");
    this.panel.classList.toggle("reader-side-right", side === "right");
    this.root.dataset.panel = side;
    this.panel.hidden = false;
    this.panelTitle.textContent = t(panelTitleKey(kind));
    this.panelBody.replaceChildren();
    this.renderPanel(kind);
    this.panel.querySelector<HTMLElement>(".ghost-btn")?.focus({ preventScroll: true });
  }

  private closePanel(): void {
    this.panel.hidden = true;
    this.openPanelKind = null;
    delete this.root.dataset.panel;
    this.slider.focus({ preventScroll: true });
  }

  private renderPanelIfOpen(): void {
    if (this.openPanelKind) this.renderPanel(this.openPanelKind);
  }

  private renderPanel(kind: PanelKind): void {
    const body = this.panelBody;
    body.replaceChildren();
    body.dataset.panel = kind;
    if (kind === "toc") return this.renderToc(body);
    if (kind === "thumbs") {
      if (this.adapter?.renderPanel?.(body, "thumbs")) return;
      body.textContent = t("reader_no_thumbnails");
      return;
    }
    if (kind === "bookmarks") return this.renderBookmarks(body);
    if (kind === "notes") return this.renderNotes(body);
    if (kind === "search") return this.renderSearch(body);
    if (kind === "appearance") return this.renderAppearance(body);
  }

  private renderToc(body: HTMLElement): void {
    if (this.adapter?.renderPanel?.(body, "toc")) return;
    const entries = this.adapter?.toc() ?? [];
    if (!entries.length) {
      body.append(emptyNote(t("reader_no_toc")));
      return;
    }
    for (const entry of entries) {
      const button = el("button", `side-link level-${Math.min(2, Math.max(0, entry.level))}`);
      button.type = "button";
      button.textContent = entry.label || t("untitled");
      button.addEventListener("click", () => {
        if (entry.page) void this.adapter?.goTo({ kind: "pdf", page: entry.page, offset: 0 });
      });
      body.appendChild(button);
    }
  }

  private renderBookmarks(body: HTMLElement): void {
    const add = textButton(t("reader_bookmark_here"), () => void this.toggleBookmark(), "primary-btn small");
    body.appendChild(add);
    if (!this.bookmarks.length) {
      body.append(emptyNote(t("reader_no_bookmarks")));
      return;
    }
    const list = el("div", "side-list");
    for (const bookmark of this.bookmarks) {
      const item = el("div", "side-item");
      const go = el("button", "side-link");
      go.type = "button";
      const label = el("span", "row-title");
      label.textContent = bookmark.label || bookmarkCaption(bookmark);
      const meta = el("small", "row-meta");
      meta.textContent = bookmark.page ? `${t("page")} ${bookmark.page}` : bookmarkCaption(bookmark);
      go.append(label, meta);
      go.addEventListener("click", () => {
        void this.adapter?.goTo(bookmark.locator);
        this.closePanel();
      });
      const remove = iconTextButton("×", t("remove"), async () => {
        try {
          await api.removeBookmark(bookmark.id);
          this.bookmarks = this.bookmarks.filter((b) => b.id !== bookmark.id);
          this.renderPanel("bookmarks");
        } catch (error) {
          this.toast(apiErrorMessage(error), { error: true });
        }
      });
      item.append(go, remove);
      list.appendChild(item);
    }
    body.appendChild(list);
  }

  private renderNotes(body: HTMLElement): void {
    const actions = el("div", "annotation-actions");
    actions.append(
      textButton(t("reader_export_md"), () => void this.exportAnnotations("markdown"), "ghost-btn small"),
      textButton(t("reader_export_json"), () => void this.exportAnnotations("json"), "ghost-btn small"),
    );
    body.appendChild(actions);
    if (!this.annotations.length) {
      body.append(emptyNote(t("reader_no_highlights")));
      return;
    }
    const list = el("div", "side-list notes-list");
    for (const annotation of [...this.annotations].reverse()) {
      const item = el("div", "annotation-card");
      item.dataset.color = annotation.color;
      const quote = el("blockquote", "annotation-quote");
      quote.textContent = annotation.quote;
      const note = el("p", "annotation-note");
      note.textContent = annotation.note;
      note.hidden = !annotation.note;
      const meta = el("small", "row-meta");
      meta.textContent = annotation.locator.kind === "pdf"
        ? `${t("page")} ${annotation.locator.page}`
        : annotation.locator.href.split("/").pop() ?? "";
      const tools = el("div", "annotation-actions");
      const edit = iconTextButton("✎", t("reader_edit_note"), async () => {
        const value = await this.askText({
          title: t("reader_edit_note"),
          label: t("reader_note_label"),
          value: annotation.note,
          placeholder: t("reader_note_placeholder"),
        });
        if (value === null) return;
        try {
          const updated = await api.updateAnnotation(annotation.id, { note: value });
          this.annotations = this.annotations.map((a) => (a.id === updated.id ? updated : a));
          this.adapter?.setAnnotations(this.annotations);
          this.renderPanel("notes");
        } catch (error) {
          this.toast(apiErrorMessage(error), { error: true });
        }
      });
      const jump = iconTextButton("↗", t("reader_go_to"), () => {
        void this.adapter?.goTo(annotation.locator);
        this.closePanel();
      });
      const remove = iconTextButton("×", t("remove"), async () => {
        try {
          await api.removeAnnotation(annotation.id);
          this.annotations = this.annotations.filter((a) => a.id !== annotation.id);
          this.adapter?.setAnnotations(this.annotations);
          this.renderPanel("notes");
        } catch (error) {
          this.toast(apiErrorMessage(error), { error: true });
        }
      });
      tools.append(jump, edit, remove);
      item.append(quote, note, meta, tools);
      list.appendChild(item);
    }
    body.appendChild(list);
  }

  private renderSearch(body: HTMLElement): void {
    const field = el("div", "search-field");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = t("reader_search_placeholder");
    input.setAttribute("aria-label", t("reader_search"));
    const results = el("div", "search-results");
    results.setAttribute("role", "list");
    field.appendChild(input);
    body.append(field, results);
    const run = async () => {
      const query = input.value.trim();
      if (!query) {
        results.replaceChildren(emptyNote(t("reader_search_hint")));
        return;
      }
      results.replaceChildren(emptyNote(t("reader_searching")));
      try {
        const hits = await this.adapter?.search(query) ?? [];
        results.replaceChildren();
        if (!hits.length) {
          results.append(emptyNote(t("reader_no_results")));
          return;
        }
        const summary = el("p", "search-summary");
        summary.textContent = t("reader_results", { count: hits.length });
        results.appendChild(summary);
        for (const hit of hits) {
          results.appendChild(this.searchRow(hit, query));
        }
      } catch (error) {
        results.replaceChildren(emptyNote(apiErrorMessage(error)));
      }
    };
    input.addEventListener("input", () => {
      if (this.searchTimer) window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => void run(), 320);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void run();
      }
    });
    results.append(emptyNote(t("reader_search_hint")));
    window.setTimeout(() => input.focus({ preventScroll: true }), 20);
  }

  private searchRow(hit: SearchHit, query: string): HTMLElement {
    const button = el("button", "search-hit");
    button.type = "button";
    const label = el("small", "hit-label");
    label.textContent = hit.label;
    const excerpt = el("span", "hit-excerpt");
    excerpt.appendChild(highlightQuery(hit.excerpt, query));
    button.append(label, excerpt);
    button.addEventListener("click", () => {
      void this.adapter?.revealSearch(hit);
      this.closePanel();
    });
    return button;
  }

  private renderAppearance(body: HTMLElement): void {
    void loadReaderFonts();
    const prefs = this.settings.reader;
    const themes: ReaderThemeId[] = ["system", "light", "sepia", "dark", "black"];
    body.appendChild(
      field(
        t("reader_theme"),
        segmented(
          themes.map((theme) => ({ label: t(`reader_theme_${theme}`), value: theme })),
          prefs.theme,
          (value) => void this.patch({ readerTheme: value }),
        ),
      ),
    );

    if (this.opts.book.format === "epub") {
      const font = document.createElement("select");
      for (const face of READER_FONTS) {
        const option = document.createElement("option");
        option.value = face.id;
        option.textContent = face.label;
        option.selected = prefs.epub.fontFamily === face.id;
        font.appendChild(option);
      }
      font.addEventListener("change", () => {
        void this.patch({ epub: { fontFamily: font.value } });
      });
      body.appendChild(field(t("reader_font"), font));
      body.appendChild(
        rangeField(t("reader_size"), 14, 32, 1, prefs.epub.fontSize ?? 19, (value) =>
          void this.patch({ epub: { fontSize: value } }),
        ),
      );
      body.appendChild(
        rangeField(t("reader_line_height"), 1.2, 2.2, 0.05, prefs.epub.lineHeight ?? 1.6, (value) =>
          void this.patch({ epub: { lineHeight: Number(value.toFixed(2)) } }),
        ),
      );
      body.appendChild(
        rangeField(t("reader_paragraphs"), 0, 1.6, 0.05, prefs.epub.paragraphSpacing ?? 0.7, (value) =>
          void this.patch({ epub: { paragraphSpacing: Number(value.toFixed(2)) } }),
        ),
      );
      body.appendChild(
        rangeField(t("reader_margin"), 16, 120, 4, prefs.epub.margin ?? 48, (value) =>
          void this.patch({ epub: { margin: value } }),
        ),
      );

      body.appendChild(
        field(
          t("reader_align"),
          segmented(
            (["justify", "left"] as const).map((mode) => ({
              label: t(`reader_align_${mode}`),
              value: mode,
            })),
            prefs.epub.align,
            (value) => void this.patch({ epub: { align: value } }),
          ),
        ),
      );

      body.appendChild(
        toggleField(t("reader_hyphenate"), prefs.epub.hyphenate, (value) =>
          void this.patch({ epub: { hyphenate: value } }),
        ),
      );
      body.appendChild(
        toggleField(t("reader_publisher"), prefs.epub.publisherStyles, (value) =>
          void this.patch({ epub: { publisherStyles: value } }),
        ),
      );

      body.appendChild(
        field(
          t("reader_layout"),
          segmented(
            (["paginated", "scroll"] as const).map((mode) => ({
              label: t(`reader_layout_${mode}`),
              value: mode,
            })),
            prefs.epub.layout,
            (value) => void this.patch({ epub: { layout: value } }),
          ),
        ),
      );

      const spread = document.createElement("select");
      for (const mode of ["auto", "never", "always"] as const) {
        const option = document.createElement("option");
        option.value = mode;
        option.textContent = t(`reader_spread_${mode}`);
        option.selected = prefs.epub.spread === mode;
        spread.appendChild(option);
      }
      spread.addEventListener("change", () => {
        void this.patch({ epub: { spread: spread.value as "auto" | "never" | "always" } });
      });
      body.appendChild(field(t("reader_spread"), spread));
    } else {
      body.appendChild(
        field(
          t("reader_pdf_layout"),
          segmented(
            (["single", "continuous", "spread"] as const).map((mode) => ({
              label: t(`reader_pdf_${mode}`),
              value: mode,
            })),
            prefs.pdf.layout,
            (value) => void this.patch({ pdf: { layout: value } }),
          ),
        ),
      );
      body.appendChild(
        toggleField(t("reader_night_mode"), prefs.pdf.nightMode, (value) =>
          void this.patch({ pdf: { nightMode: value } }),
        ),
      );
      const zoom = el("div", "appearance-row button-row");
      const pdf = this.adapter as PdfReader | null;
      zoom.append(
        textButton("−", () => pdf?.zoomOut(), "ghost-btn small"),
        textButton("+", () => pdf?.zoomIn(), "ghost-btn small"),
        textButton(t("reader_fit_width"), () => pdf?.fitTo("width"), "ghost-btn small"),
        textButton(t("reader_fit_page"), () => pdf?.fitTo("page"), "ghost-btn small"),
        textButton(t("reader_actual"), () => pdf?.fitTo("actual"), "ghost-btn small"),
      );
      body.appendChild(field(t("reader_zoom"), zoom));
      body.appendChild(
        textButton(t("reader_rotate"), () => pdf?.rotate(), "ghost-btn wide"),
      );
    }

    body.dataset.preview = prefs.theme;
  }

  private async patch(patch: SettingsPatch): Promise<void> {
    try {
      this.settings = await api.setSettings(patch);
      if (patch.readerTheme) this.applyReaderTheme();
      await this.adapter?.setPrefs(this.settings);
      this.renderPanelIfOpen();
    } catch (error) {
      this.toast(apiErrorMessage(error), { error: true });
    }
  }

  private applyReaderTheme(): void {
    const theme = this.settings.reader.theme;
    // "system" falls back to the stylesheet's default (light) palette; every
    // other value maps directly onto the `#reader-root[data-theme]` tokens.
    this.root.dataset.theme =
      theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
    this.adapter?.applyTheme(theme);
  }

  // ------------------------------------------------------------------ export

  /** Floating "back to where I was" chip after following an internal link. */
  private showHistoryChip(depth: number): void {
    const existing = this.root.querySelector<HTMLElement>(".reader-history");
    if (!depth || !this.adapter?.goBack) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const chip = el("button", "reader-history");
    chip.type = "button";
    chip.textContent = t("reader_back_to");
    chip.addEventListener("click", () => this.adapter?.goBack?.());
    this.root.appendChild(chip);
  }

  private async exportAnnotations(format: "markdown" | "json"): Promise<void> {
    try {
      const contents = await api.exportAnnotations(this.opts.book.id, format);
      const safe = this.opts.book.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "annotations";
      const path = await saveDialog({
        defaultPath: `${safe}.${format === "markdown" ? "md" : "json"}`,
        filters: [
          {
            name: format === "markdown" ? "Markdown" : "JSON",
            extensions: [format === "markdown" ? "md" : "json"],
          },
        ],
      });
      if (!path) return;
      await api.writeExportFile(path, contents);
      this.toast(t("reader_exported"));
    } catch (error) {
      this.toast(apiErrorMessage(error), { error: true });
    }
  }

  // ------------------------------------------------------------------- links

  private async openExternal(url: string): Promise<void> {
    const ok = await this.confirm({
      title: t("reader_open_link"),
      message: url,
      confirm: t("reader_open_browser"),
    });
    if (!ok) return;
    try {
      await api.openExternal(url);
    } catch (error) {
      this.toast(apiErrorMessage(error), { error: true });
    }
  }

  private showImage(src: string, alt: string): void {
    const zoom = el("div", "image-zoom");
    zoom.setAttribute("role", "dialog");
    zoom.setAttribute("aria-label", alt || t("reader_image"));
    const image = document.createElement("img");
    image.src = src;
    image.alt = alt;
    zoom.appendChild(image);
    const close = () => zoom.remove();
    zoom.addEventListener("click", close);
    this.root.appendChild(zoom);
    zoom.tabIndex = -1;
    zoom.focus();
    zoom.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    });
  }

  // ----------------------------------------------------------------- dialogs

  private async askPassword(reason: string): Promise<string | null> {
    return this.askText({
      title: t("reader_password"),
      label: reason === "need-to-decrypt-pdf"
        ? t("reader_password_needed")
        : t("reader_password_wrong"),
      type: "password",
      confirmLabel: t("done"),
    });
  }

  private askText(options: {
    title: string;
    label: string;
    value?: string;
    placeholder?: string;
    type?: "text" | "password";
    confirmLabel?: string;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const handle = this.buildModal(options.title);
      const form = document.createElement("form");
      form.className = "modal-body";
      const label = document.createElement("label");
      label.className = "modal-text";
      label.textContent = options.label;
      const input = document.createElement("input");
      input.type = options.type ?? "text";
      input.value = options.value ?? "";
      input.placeholder = options.placeholder ?? "";
      input.className = "input";
      label.appendChild(input);
      const actions = el("div", "modal-actions");
      const cancel = textButton(t("cancel"), () => handle.finish(null), "ghost-btn");
      const ok = textButton(options.confirmLabel ?? t("save"), () => handle.finish(input.value), "primary-btn");
      ok.type = "submit";
      actions.append(cancel, ok);
      form.append(label, actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        handle.finish(input.value);
      });
      handle.body.appendChild(form);
      handle.onDone((value) => resolve(value as string | null));
      window.setTimeout(() => {
        input.focus();
        input.select();
      }, 30);
    });
  }

  private confirm(options: { title: string; message: string; confirm: string }): Promise<boolean> {
    return new Promise((resolve) => {
      const handle = this.buildModal(options.title);
      const message = el("p", "modal-text");
      message.textContent = options.message;
      const actions = el("div", "modal-actions");
      const cancel = textButton(t("cancel"), () => handle.finish(false), "ghost-btn");
      const ok = textButton(options.confirm, () => handle.finish(true), "primary-btn");
      actions.append(cancel, ok);
      handle.body.append(message, actions);
      handle.onDone((value) => resolve(Boolean(value)));
      window.setTimeout(() => ok.focus(), 30);
    });
  }

  /** A native modal dialog styled like the rest of the app's dialogs. */
  private buildModal(title: string): {
    body: HTMLElement;
    finish(value: unknown): void;
    onDone(callback: (value: unknown) => void): void;
  } {
    const dialog = document.createElement("dialog");
    dialog.className = "modal reader-modal";
    const heading = el("h2", "modal-title");
    heading.textContent = title;
    const head = el("div", "modal-head");
    head.appendChild(heading);
    const body = el("div", "modal-body");
    const panel = el("div", "modal-panel");
    panel.append(head, body);
    dialog.appendChild(panel);

    let done: ((value: unknown) => void) | null = null;
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      done?.(value);
      if (dialog.open) dialog.close();
      dialog.remove();
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(null);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    return {
      body,
      finish,
      onDone: (callback) => {
        done = callback;
      },
    };
  }

  // ------------------------------------------------------------------- toast

  private toast(
    message: string,
    options: { error?: boolean; action?: { label: string; run: () => void } } = {},
  ): void {
    const existing = this.root.querySelector(".reader-toast");
    existing?.remove();
    const toast = el("div", "reader-toast");
    if (options.error) toast.classList.add("error");
    toast.setAttribute("role", "status");
    const text = el("span", "toast-text");
    text.textContent = message;
    toast.appendChild(text);
    if (options.action) {
      const button = textButton(options.action.label, () => {
        options.action?.run();
        toast.remove();
      }, "toast-action");
      toast.appendChild(button);
    }
    this.root.appendChild(toast);
    window.setTimeout(() => toast.classList.add("in"), 10);
    window.setTimeout(() => {
      toast.classList.remove("in");
      window.setTimeout(() => toast.remove(), 300);
    }, options.action ? 8000 : 3200);
  }

  // --------------------------------------------------------------- keyboard

  private bindKeys(): void {
    window.addEventListener("keydown", this.onKey, true);
  }

  private onKey = (event: KeyboardEvent): void => {
    if (this.closed) return;
    const target = event.target as Element | null;
    // Native dialogs own their own Escape handling.
    if (target?.closest("dialog.modal") || document.querySelector("dialog.modal")) {
      if (event.key === "Escape") return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.root.querySelector(".image-zoom")) {
        this.root.querySelector(".image-zoom")?.remove();
      } else if (this.selectionPopup) {
        this.closeSelectionPopup();
      } else if (!this.panel.hidden) {
        this.closePanel();
      } else if (this.fullscreen) {
        void this.toggleFullscreen();
      } else {
        void this.close();
      }
      return;
    }
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.openPanel("search");
      return;
    }
    if (mod && event.key.toLowerCase() === "g") {
      event.preventDefault();
      void this.goToDialog();
      return;
    }
    if (mod) return;

    switch (event.key) {
      case "ArrowRight":
      case "PageDown":
        event.preventDefault();
        this.adapter?.next();
        break;
      case "ArrowLeft":
      case "PageUp":
        event.preventDefault();
        this.adapter?.prev();
        break;
      case " ":
        event.preventDefault();
        if (event.shiftKey) this.adapter?.prev();
        else this.adapter?.next();
        break;
      case "Home":
        event.preventDefault();
        this.adapter?.goToFraction(0);
        break;
      case "End":
        event.preventDefault();
        this.adapter?.goToFraction(0.995);
        break;
      case "b":
      case "B":
        event.preventDefault();
        void this.toggleBookmark();
        break;
      case "t":
      case "T":
        event.preventDefault();
        this.togglePanel("toc");
        break;
      case "F11":
        event.preventDefault();
        void this.toggleFullscreen();
        break;
      case "+":
      case "=":
        event.preventDefault();
        this.zoomBy(1);
        break;
      case "-":
        event.preventDefault();
        this.zoomBy(-1);
        break;
      case "0":
        event.preventDefault();
        this.zoomReset();
        break;
      default:
        break;
    }
  };

  private zoomBy(direction: 1 | -1): void {
    if (this.adapter instanceof PdfReader) {
      if (direction > 0) this.adapter.zoomIn();
      else this.adapter.zoomOut();
      return;
    }
    const current = this.settings.reader.epub.fontSize ?? 19;
    const next = Math.max(14, Math.min(32, current + direction));
    void this.patch({ epub: { fontSize: next } });
  }

  private zoomReset(): void {
    if (this.adapter instanceof PdfReader) {
      this.adapter.fitTo("page");
      return;
    }
    void this.patch({ epub: { fontSize: null, margin: null, lineHeight: null } });
  }

  private async goToDialog(): Promise<void> {
    const value = await this.askText({
      title: t("reader_go_to"),
      label: this.opts.book.format === "pdf" ? t("reader_page_prompt") : t("reader_percent_prompt"),
      placeholder: this.opts.book.format === "pdf" ? "42" : "35%",
    });
    if (!value) return;
    if (this.opts.book.format === "pdf") {
      const page = Number.parseInt(value.replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(page) && page > 0) {
        await this.adapter?.goTo({ kind: "pdf", page, offset: 0 });
      }
      return;
    }
    const number = Number.parseFloat(value.replace("%", ""));
    if (Number.isFinite(number)) {
      this.adapter?.goToFraction(Math.max(0, Math.min(1, number > 1 ? number / 100 : number)));
    }
  }

  // ---------------------------------------------------------------- viewport

  private async toggleFullscreen(): Promise<void> {
    this.fullscreen = !this.fullscreen;
    try {
      await getCurrentWindow().setFullscreen(this.fullscreen);
    } catch {
      document.documentElement.classList.toggle("pseudo-fullscreen", this.fullscreen);
    }
    this.root.classList.toggle("immersive", this.fullscreen);
    this.pingActivity();
  }

  private bindChromeAutoHide(): void {
    this.root.addEventListener("mousemove", () => this.pingActivity());
    this.root.addEventListener("keydown", () => this.pingActivity());
  }

  private pingActivity(): void {
    this.root.classList.remove("idle");
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    if (!this.fullscreen) return;
    this.idleTimer = window.setTimeout(() => this.root.classList.add("idle"), 2600);
  }

  // ------------------------------------------------------------------ close

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener("keydown", this.onKey, true);
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.adapter?.flushProgress?.();
    await this.persist();
    this.adapter?.destroy();
    try {
      await api.closeBook(this.opts.book.id);
    } catch {
      // Session bookkeeping is optional.
    }
    if (this.fullscreen) {
      try {
        await getCurrentWindow().setFullscreen(false);
      } catch {
        document.documentElement.classList.remove("pseudo-fullscreen");
      }
    }
    this.root.replaceChildren();
    this.root.hidden = true;
    this.root.className = "";
    this.root.removeAttribute("style");
    this.opts.onClose();
  }
}

// -------------------------------------------------------------------- helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function iconButton(icon: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "reader-tool icon-only";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${ICONS[icon]}</svg>`;
  button.addEventListener("click", onClick);
  return button;
}

/** Toolbar button with an optional visible text label (hidden on narrow windows). */
function toolButton(icon: IconName, label: string, shortcut: string, onClick: () => void): HTMLButtonElement {
  const button = iconButton(icon, label, onClick);
  button.classList.remove("icon-only");
  if (shortcut) button.title = `${label} (${shortcut})`;
  const text = document.createElement("span");
  text.className = "label";
  text.textContent = label;
  button.appendChild(text);
  return button;
}

function textButton(
  label: string,
  onClick: () => void | Promise<void>,
  className = "ghost-btn",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className || "ghost-btn";
  button.textContent = label;
  button.addEventListener("click", () => void Promise.resolve(onClick()));
  return button;
}

function iconTextButton(
  glyph: string,
  label: string,
  onClick: () => void | Promise<void>,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn icon-only small";
  button.textContent = glyph;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => void Promise.resolve(onClick()));
  return button;
}

function emptyNote(text: string): HTMLElement {
  const node = el("p", "panel-empty");
  node.textContent = text;
  return node;
}

/** One labelled control in the appearance panel. */
function field(label: string, control: HTMLElement): HTMLElement {
  const row = el("div", "appearance-row");
  const text = document.createElement("span");
  text.textContent = label.toUpperCase();
  row.append(text, control);
  return row;
}

function rangeField(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (value: number) => void,
): HTMLElement {
  const wrap = el("div", "range-field");
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  const output = el("output", "range-value");
  output.textContent = String(value);
  input.addEventListener("input", () => {
    output.textContent = String(Math.round(Number(input.value) * 100) / 100);
  });
  input.addEventListener("change", () => onInput(Number(input.value)));
  wrap.append(input, output);
  return field(label, wrap);
}

function toggleField(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  const wrap = el("label", "appearance-row toggle-field");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked));
  const text = document.createElement("span");
  text.textContent = label.toUpperCase();
  wrap.append(input, text);
  return wrap;
}

/** Segmented control matching the app's `.segmented` / `.seg-btn` styles. */
function segmented<T extends string>(
  options: { label: string; value: T }[],
  current: string,
  onPick: (value: T) => void,
): HTMLElement {
  const wrap = el("div", "segmented");
  wrap.setAttribute("role", "group");
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "seg-btn";
    button.textContent = option.label;
    button.setAttribute("aria-pressed", String(current === option.value));
    button.addEventListener("click", () => {
      for (const sibling of Array.from(wrap.querySelectorAll("button"))) {
        sibling.setAttribute("aria-pressed", "false");
      }
      button.setAttribute("aria-pressed", "true");
      onPick(option.value);
    });
    wrap.appendChild(button);
  }
  return wrap;
}

function panelTitleKey(kind: PanelKind): MessageKey {
  const keys: Record<PanelKind, MessageKey> = {
    toc: "reader_contents",
    thumbs: "reader_thumbnails",
    bookmarks: "reader_bookmarks",
    notes: "reader_notes",
    search: "reader_search",
    appearance: "reader_appearance",
  };
  return keys[kind];
}

function bookmarkCaption(bookmark: Bookmark): string {
  if (bookmark.locator.kind === "pdf") return `${t("page")} ${bookmark.locator.page}`;
  const progress = bookmark.locator.progress;
  return typeof progress === "number" ? `${Math.round(progress * 100)}%` : t("reader_marked");
}

function sameLocator(a: Locator, b: Locator): boolean {
  if (a.kind === "pdf" && b.kind === "pdf") return a.page === b.page;
  if (a.kind === "epub" && b.kind === "epub") {
    return a.href === b.href && Math.abs((a.progress ?? 0) - (b.progress ?? 0)) < 0.02;
  }
  return false;
}

function highlightQuery(text: string, query: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) {
    fragment.append(text);
    return fragment;
  }
  let cursor = 0;
  while (true) {
    const at = lower.indexOf(needle, cursor);
    if (at < 0) break;
    if (at > cursor) fragment.append(text.slice(cursor, at));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(at, at + needle.length);
    fragment.append(mark);
    cursor = at + needle.length;
  }
  if (cursor < text.length) fragment.append(text.slice(cursor));
  return fragment;
}

export function readerFontFamily(settings: Settings): string {
  return readerFontStack(settings.reader.epub.fontFamily);
}
