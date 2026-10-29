// EPUB renderer.
//
// Chapters are sanitised in Rust and rendered in a sandboxed, script-less
// iframe with a strict CSP (no network, no frames, no scripts). Pagination is
// CSS multi-column with a transform for page turns; scroll mode keeps one
// chapter mounted at a time and advances at the end, so memory stays bounded
// for thousand-chapter books.

import { api } from "../lib/api";
import type { Annotation, Book, Locator, Settings, TextAnchor } from "../lib/api";
import { t } from "../lib/i18n";
import type { TocEntry } from "../bindings";
import { readerFontStack } from "../lib/fonts";
import { readerPalette } from "../lib/theme";
import type { ResolvedTheme, ReaderTheme } from "../lib/theme";
import { buildTextIndex, anchorFromRange, resolveAnchor, locateQueryNear, offsetsToRange } from "./anchor";
import type { TextIndex } from "./anchor";
import type { AdapterCallbacks, PanelKind, ReaderAdapter, SearchHit } from "./types";

const HL_CLASS = "bs-hl";
const FIND_CLASS = "bs-find";
const FIND_CURRENT_CLASS = "bs-find-current";

interface ChapterState {
  index: number;
  href: string;
  title: string;
  chars: number;
}

export class EpubReader implements ReaderAdapter {
  readonly kind = "epub" as const;

  private readonly book: Book;
  private readonly callbacks: AdapterCallbacks;
  private readonly chapters: ChapterState[];
  private readonly tocEntries: TocEntry[];
  private readonly rtl: boolean;
  private readonly fixedLayout: boolean;
  private readonly baseUrl: string;

  private stage!: HTMLElement;
  private frame!: HTMLIFrameElement;
  private shellReady!: Promise<void>;
  private popup: HTMLElement | null = null;
  private backStack: Locator[] = [];

  private prefs: Settings["reader"]["epub"];
  private theme: ReaderTheme;
  private chapter: ChapterState | null = null;
  private page = 0;
  private pageCount = 1;
  private pageStep = 1;
  private annotations: Annotation[] = [];
  private marks: HTMLElement[] = [];
  private findMarks: HTMLElement[] = [];
  private textIndex: TextIndex | null = null;
  private mounted = true;
  private saveTimer: number | null = null;
  private lastFraction = 0;
  private layoutQueued = false;
  private observer: ResizeObserver | null = null;

  constructor(opts: {
    book: Book;
    settings: Settings;
    callbacks: AdapterCallbacks;
    theme: ReaderTheme;
    baseUrl: string;
    toc: TocEntry[];
    chapters: { index: number; href: string; title: string; chars: number }[];
    rtl: boolean;
    fixedLayout: boolean;
  }) {
    this.book = opts.book;
    this.callbacks = opts.callbacks;
    this.prefs = opts.settings.reader.epub;
    this.theme = opts.theme;
    this.baseUrl = opts.baseUrl;
    this.tocEntries = opts.toc;
    this.chapters = opts.chapters;
    this.rtl = opts.rtl;
    this.fixedLayout = opts.fixedLayout;
  }

  async mount(stage: HTMLElement): Promise<void> {
    this.stage = stage;
    if (this.fixedLayout) stage.classList.add("fixed-layout");
    const frame = document.createElement("iframe");
    frame.className = "reader-frame";
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("title", this.book.title || "Book");
    this.frame = frame;
    this.shellReady = new Promise((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
    });
    frame.srcdoc = this.frameShell();
    stage.appendChild(frame);
    await this.shellReady;

    const doc = this.doc();
    doc.addEventListener("click", (event) => this.onClick(event));
    doc.addEventListener("mouseup", () => this.reportSelection());
    doc.addEventListener("keyup", (event) => {
      if (event.key === "Shift" || event.key.startsWith("Arrow")) this.reportSelection();
    });
    doc.addEventListener("scroll", () => {
      if (this.prefs.layout === "scroll") this.onScroll();
    });
    this.frame.contentWindow?.addEventListener("wheel", (event) => this.onWheel(event), { passive: true });

    this.observer = new ResizeObserver(() => this.queueLayout());
    this.observer.observe(stage);
  }

  destroy(): void {
    this.mounted = false;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.flushProgress();
    this.observer?.disconnect();
    this.frame.remove();
  }

  // ------------------------------------------------------------- navigation

  next(): void {
    if (this.prefs.layout === "paginated") {
      if (this.page + 1 < this.pageCount) this.setPage(this.page + 1);
      else void this.stepChapter(1, "start");
    } else {
      this.scrollBy(this.viewportHeight() * 0.9);
    }
  }

  prev(): void {
    if (this.prefs.layout === "paginated") {
      if (this.page > 0) this.setPage(this.page - 1);
      else void this.stepChapter(-1, "end");
    } else {
      this.scrollBy(-this.viewportHeight() * 0.9);
    }
  }

  async goTo(locator: Locator | null): Promise<void> {
    if (!locator || locator.kind !== "epub") {
      if (!this.chapter) await this.loadChapter(0, 0, null);
      return;
    }
    const index = this.chapters.find((c) => c.href === locator.href)?.index ?? locator.spine_index;
    await this.loadChapter(index, locator.progress ?? 0, locator.anchor ?? null);
  }

  locator(): Locator {
    const anchor = this.currentAnchor();
    return {
      kind: "epub",
      spine_index: this.chapter?.index ?? 0,
      href: this.chapter?.href ?? "",
      progress: this.progress(),
      text_offset: anchor?.start ?? null,
      anchor,
    };
  }

  progress(): number {
    const chapterProgress =
      this.prefs.layout === "paginated"
        ? this.pageCount <= 1
          ? 0
          : this.page / this.pageCount
        : this.scrollFraction();
    const total = this.chapters.length;
    if (total <= 1) return chapterProgress;
    const index = this.chapter?.index ?? 0;
    return Math.min(0.9999, (index + chapterProgress) / total);
  }

  goToFraction(fraction: number): void {
    const target = Math.max(0, Math.min(0.9999, fraction)) * (this.chapters.length || 1);
    const index = Math.min(this.chapters.length - 1, Math.floor(target));
    const within = target - index;
    void this.loadChapter(index, within, null);
  }

  statusText(): string {
    if (this.prefs.layout === "paginated") {
      return `${this.page + 1} / ${Math.max(1, this.pageCount)}`;
    }
    return `${Math.round(this.progress() * 100)}%`;
  }

  heading(): string {
    return this.chapter?.title ?? "";
  }

  minutesLeft(): number {
    const total = this.chapters.reduce((sum, c) => sum + c.chars, 0);
    const done = this.chapters
      .slice(0, this.chapter?.index ?? 0)
      .reduce((sum, c) => sum + c.chars, 0);
    const inChapter = (this.chapter?.chars ?? 0) * this.progressInChapter();
    const remaining = Math.max(0, total - done - inChapter);
    return Math.max(1, Math.round(remaining / 1100));
  }

  toc(): TocEntry[] {
    return this.tocEntries;
  }

  // --------------------------------------------------------------- searching

  async search(query: string): Promise<SearchHit[]> {
    const needle = query.trim();
    if (!needle) return [];
    const hits = await api.searchBook(this.book.id, needle, 300);
    return hits.map((hit, i) => ({
      id: `${hit.spineIndex}:${hit.textOffset}:${i}`,
      label: hit.chapterTitle || this.chapters[hit.spineIndex]?.title || "",
      excerpt: hit.excerpt,
      locator: {
        kind: "epub",
        spine_index: hit.spineIndex,
        href: hit.href,
        progress: 0,
        text_offset: hit.textOffset,
        anchor: null,
      },
      query: needle,
    }));
  }

  async revealSearch(hit: SearchHit): Promise<void> {
    const locator = hit.locator;
    if (locator.kind !== "epub") return;
    const chapter = this.chapters.find((c) => c.href === locator.href);
    if (!chapter) return;
    if (!this.chapter || this.chapter.index !== chapter.index) {
      await this.loadChapter(chapter.index, 0, null);
    }
    const index = this.textIndex;
    if (!index) return;
    const anneal = hit.query ?? "";
    const approximate = Math.round(
      ((locator.text_offset ?? 0) / Math.max(1, chapter.chars)) * index.text.length,
    );
    const found = locateQueryNear(index.text, anneal, approximate);
    if (!found) {
      this.callbacks.onNotice(t("reader_search_partial"));
      return;
    }
    this.clearFind();
    const range = offsetsToRange(index, found.start, found.end);
    if (!range) return;
    this.marks = wrapRange(range, FIND_CLASS);
    this.marks.forEach((el) => el.classList.add(FIND_CURRENT_CLASS));
    this.revealElement(this.marks[0] ?? null);
  }

  // ------------------------------------------------------------------ prefs

  async setPrefs(settings: Settings): Promise<void> {
    const previous = this.prefs;
    this.prefs = settings.reader.epub;
    if (previous.publisherStyles !== this.prefs.publisherStyles) {
      await this.loadChapter(this.chapter?.index ?? 0, this.progressInChapter(), null, true);
      return;
    }
    if (previous.layout !== this.prefs.layout) {
      const fraction = this.progressInChapter();
      this.applyAppearance();
      this.applyLayout(Math.round(fraction * this.pageCount));
      return;
    }
    this.applyAppearance();
    this.queueLayout();
  }

  applyTheme(theme: ReaderTheme): void {
    this.theme = theme;
    this.applyAppearance();
    this.queueLayout();
  }

  private palette() {
    return readerPalette(this.theme, systemTheme());
  }

  // -------------------------------------------------------------- annotations

  setAnnotations(annotations: Annotation[]): void {
    this.annotations = annotations;
    this.paintAnnotations();
  }

  refreshAnnotations(): void {
    this.paintAnnotations();
  }

  private paintAnnotations(): void {
    const doc = this.doc();
    for (const mark of this.marks) unwrap(mark);
    this.marks = [];
    const index = this.textIndex;
    if (!index || !this.chapter) return;
    for (const annotation of this.annotations) {
      const locator = annotation.locator;
      if (locator.kind !== "epub") continue;
      if (locator.href !== this.chapter.href) continue;
      const anchor = locator.anchor;
      if (!anchor) continue;
      const found = resolveAnchor(index.text, anchor);
      if (!found) continue;
      const range = offsetsToRange(index, found.start, found.end);
      if (!range) continue;
      const spans = wrapRange(range, `${HL_CLASS} hl-${annotation.color}`);
      for (const span of spans) {
        span.dataset.annotationId = String(annotation.id);
        span.title = annotation.note || annotation.quote;
      }
      this.marks.push(...spans);
    }
    // Keep find highlights on top by re-appending their class.
    if (doc && this.findMarks.length) {
      for (const el of this.findMarks) el.classList.add(FIND_CLASS);
    }
  }

  private currentAnchor() {
    const index = this.textIndex;
    const doc = this.doc();
    if (!index || !doc) return null;
    const selection = doc.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const anchor = anchorFromRange(index, selection.getRangeAt(0).cloneRange());
      if (anchor) return anchor;
    }
    return null;
  }

  // ------------------------------------------------------------ frame setup

  private frameShell(): string {
    const resourceOrigin = originOf(this.baseUrl) || "http://bookshelf.localhost";
    const appOrigin = window.location.origin;
    const csp = [
      "default-src 'none'",
      "script-src 'none'",
      `style-src 'unsafe-inline' ${resourceOrigin} ${appOrigin}`,
      `img-src ${resourceOrigin} data: blob:`,
      `font-src ${resourceOrigin} ${appOrigin} data:`,
      `media-src ${resourceOrigin}`,
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; ");
    const dir = this.chapter ? dirname(this.chapter.href) : "";
    const base = new URL(dir, this.baseUrl).href;
    return `<!doctype html><html lang="${escapeAttr(this.book.language ?? "en")}"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">
<base href="${escapeAttr(base)}">
<style id="bs-reset">${RESET_CSS}</style>
<style id="bs-appearance"></style>
</head><body><div id="bs-content"></div></body></html>`;
  }

  private doc(): Document {
    const doc = this.frame.contentDocument;
    if (!doc) throw new Error("reader frame unavailable");
    return doc;
  }

  // --------------------------------------------------------------- chapters

  private async loadChapter(
    index: number,
    progress: number,
    anchor: TextAnchor | null,
    force = false,
  ): Promise<void> {
    const chapter = this.chapters[Math.max(0, Math.min(this.chapters.length - 1, index))];
    if (!chapter) return;
    if (!force && this.chapter?.index === chapter.index) {
      this.applyPosition(progress, anchor);
      return;
    }
    const doc = this.doc();
    const content = doc.getElementById("bs-content");
    if (!content) return;
    this.chapter = chapter;
    this.page = 0;
    this.pageCount = 1;
    this.textIndex = null;
    this.clearFind();
    for (const mark of this.marks) unwrap(mark);
    this.marks = [];
    content.innerHTML = "";

    // Re-base the document for this chapter's relative resources.
    const baseEl = doc.querySelector("base");
    if (baseEl) baseEl.setAttribute("href", new URL(dirname(chapter.href), this.baseUrl).href);
    for (const link of Array.from(doc.head.querySelectorAll("link[rel~='stylesheet'], style.bs-publisher"))) {
      link.remove();
    }

    let html: string;
    try {
      html = await api.getChapter(this.book.id, chapter.href);
    } catch (error) {
      this.callbacks.onError(t("reader_chapter_failed", { title: chapter.title, message: message(error) }));
      return;
    }
    if (!this.mounted) return;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    for (const node of Array.from(parsed.head.querySelectorAll("link[rel~='stylesheet'], style"))) {
      const clone = doc.importNode(node, true);
      clone.classList.add("bs-publisher");
      doc.head.appendChild(clone);
    }
    const title = parsed.querySelector("title")?.textContent?.trim();
    if (title) chapter.title = chapter.title || title;
    const body = parsed.body;
    if (body) {
      const fragment = doc.importNode(body, true);
      fragment.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());
      content.appendChild(fragment);
    }
    this.applyAppearance();
    this.applyDirection(content);

    await this.waitForAssets(doc, content);
    if (!this.mounted) return;
    this.textIndex = buildTextIndex(content);
    this.layout();
    this.applyPosition(progress, anchor);
    this.paintAnnotations();
    this.emitProgress();
  }

  private applyDirection(content: HTMLElement): void {
    const first = content.querySelector<HTMLElement>("[dir]");
    const dir = first?.getAttribute("dir") ?? (this.rtl ? "rtl" : "ltr");
    content.setAttribute("dir", dir);
    content.style.writingMode = "";
  }

  private async waitForAssets(doc: Document, content: HTMLElement): Promise<void> {
    const pending = Array.from(content.querySelectorAll("img, svg image"))
      .filter((img) => img instanceof HTMLImageElement && !img.complete)
      .map(
        (img) =>
          new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
            window.setTimeout(done, 2500);
          }),
      );
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => window.setTimeout(resolve, 2500)),
    ]);
    const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) {
      await Promise.race([
        fonts.ready,
        new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
      ]);
    }
  }

  private applyPosition(progress: number, anchor: TextAnchor | null): void {
    if (anchor && this.textIndex) {
      const found = resolveAnchor(this.textIndex.text, anchor);
      if (found) {
        const range = offsetsToRange(this.textIndex, found.start, found.end);
        if (range) {
          this.revealRange(range);
          return;
        }
      }
    }
    if (this.prefs.layout === "paginated") {
      this.setPage(Math.min(this.pageCount - 1, Math.round(progress * this.pageCount)), false);
    } else {
      const max = this.maxScroll();
      this.doc().defaultView?.scrollTo({ top: max * progress, behavior: "instant" as ScrollBehavior });
    }
    this.emitProgress();
  }

  // ----------------------------------------------------------------- layout

  private queueLayout(): void {
    if (this.layoutQueued || !this.mounted) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      const fraction = this.progressInChapter();
      this.layout();
      if (this.prefs.layout === "paginated") {
        this.setPage(Math.min(this.pageCount - 1, Math.round(fraction * this.pageCount)), false);
      }
    });
  }

  private viewportWidth(): number {
    return this.stage.clientWidth;
  }

  private viewportHeight(): number {
    return this.stage.clientHeight;
  }

  private geometry(): { width: number; height: number; margin: number; gap: number; colWidth: number; columns: number } {
    const margin = Math.max(16, Math.min(96, this.prefs.margin ?? 48));
    const width = Math.max(180, this.viewportWidth() - margin * 2);
    const height = Math.max(180, this.viewportHeight() - margin * 2);
    const gap = Math.max(32, margin * 2);
    const wantedSpread =
      this.prefs.spread === "always" || (this.prefs.spread === "auto" && width >= 860);
    const columns = this.prefs.layout === "paginated" && wantedSpread ? 2 : 1;
    const colWidth = Math.floor((width - gap * (columns - 1)) / columns);
    return { width, height, margin, gap, colWidth, columns };
  }

  private layout(): void {
    const doc = this.doc();
    const content = doc.getElementById("bs-content");
    if (!content) return;
    const geo = this.geometry();
    const body = doc.body;
    const style = content.style;
    content.style.width = `${geo.width}px`;
    content.style.margin = "0 auto";
    content.style.padding = `${geo.margin}px 0`;
    doc.documentElement.style.setProperty("--bs-page-width", `${geo.width}px`);
    doc.documentElement.style.setProperty("--bs-page-height", `${geo.height}px`);

    if (this.prefs.layout === "paginated") {
      body.classList.add("bs-pages");
      style.height = `${geo.height}px`;
      style.columnWidth = `${geo.colWidth}px`;
      style.columnGap = `${geo.gap}px`;
      style.columnFill = "auto";
      style.transform = "translateX(0)";
      body.style.overflow = "hidden";
      // Let WebKit finish the multi-column pass before measuring.
      const total = Math.max(content.scrollWidth, doc.documentElement.scrollWidth);
      const step = geo.width + geo.gap;
      this.pageStep = step;
      this.pageCount = Math.max(1, Math.ceil((total + geo.gap) / step));
      if (this.pageCount > 4000) this.pageCount = 4000;
    } else {
      body.classList.remove("bs-pages");
      style.height = "auto";
      style.columnWidth = "auto";
      style.columnGap = "normal";
      style.columnFill = "balance";
      style.transform = "none";
      body.style.overflow = "auto";
      this.pageCount = 1;
      this.pageStep = 1;
    }
    this.applyAppearance();
  }

  private applyLayout(page: number): void {
    this.layout();
    if (this.prefs.layout === "paginated") {
      this.setPage(Math.max(0, Math.min(this.pageCount - 1, page)), false);
    }
  }

  private setPage(page: number, animate = true): void {
    this.page = Math.max(0, Math.min(this.pageCount - 1, page));
    const content = this.doc().getElementById("bs-content");
    if (!content) return;
    content.style.transition = animate && !matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "transform 160ms ease-out"
      : "none";
    content.style.transform = `translateX(${-this.page * this.pageStep}px)`;
    this.emitProgress();
  }

  private scrollBy(delta: number): void {
    const view = this.doc().defaultView;
    if (!view) return;
    const target = view.scrollY + delta;
    if (delta > 0 && target >= this.maxScroll() - 2) {
      if (this.chapter && this.chapter.index + 1 < this.chapters.length) {
        void this.stepChapter(1, "start");
        return;
      }
    }
    if (delta < 0 && target <= 0) {
      if (this.chapter && this.chapter.index > 0) {
        void this.stepChapter(-1, "end");
        return;
      }
    }
    view.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  private maxScroll(): number {
    const view = this.doc().defaultView;
    if (!view) return 0;
    return Math.max(0, view.document.documentElement.scrollHeight - view.innerHeight);
  }

  private scrollFraction(): number {
    const max = this.maxScroll();
    if (max <= 0) return 0;
    return Math.max(0, Math.min(1, (this.doc().defaultView?.scrollY ?? 0) / max));
  }

  private progressInChapter(): number {
    return this.prefs.layout === "paginated"
      ? this.pageCount <= 1
        ? 0
        : this.page / this.pageCount
      : this.scrollFraction();
  }

  private async stepChapter(direction: 1 | -1, edge: "start" | "end"): Promise<void> {
    const target = (this.chapter?.index ?? 0) + direction;
    if (target < 0 || target >= this.chapters.length) {
      if (direction > 0) this.callbacks.onNotice(t("reader_end_of_book"));
      return;
    }
    this.pushHistory();
    await this.loadChapter(target, edge === "end" ? 0.999 : 0, null);
    if (this.prefs.layout === "paginated" && edge === "end") {
      this.setPage(this.pageCount - 1, false);
    } else if (this.prefs.layout === "scroll" && edge === "end") {
      this.doc().defaultView?.scrollTo({ top: this.maxScroll(), behavior: "instant" as ScrollBehavior });
      this.emitProgress();
    }
  }

  private onScroll(): void {
    if (this.popup) this.closePopup();
    this.emitProgress();
  }

  private onWheel(event: WheelEvent): void {
    if (this.prefs.layout !== "scroll") return;
    if (event.deltaY <= 0) return;
    if (this.scrollFraction() < 0.995) return;
    if (this.chapter && this.chapter.index + 1 < this.chapters.length) {
      void this.stepChapter(1, "start");
    }
  }

  // ---------------------------------------------------------------- progress

  private emitProgress(): void {
    this.lastFraction = this.progress();
    this.callbacks.onProgress(this.locator(), this.lastFraction);
  }

  flushProgress(): void {
    if (!this.chapter) return;
    this.callbacks.onProgress(this.locator(), this.lastFraction || this.progress());
  }

  // -------------------------------------------------------------- selection

  private reportSelection(): void {
    const doc = this.doc();
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const index = this.textIndex;
    if (!index) return;
    const range = selection.getRangeAt(0);
    const anchor = anchorFromRange(index, range.cloneRange());
    if (!anchor) return;
    const rect = range.getBoundingClientRect();
    const frameRect = this.frame.getBoundingClientRect();
    this.callbacks.onSelection({
      locator: {
        kind: "epub",
        spine_index: this.chapter?.index ?? 0,
        href: this.chapter?.href ?? "",
        progress: this.progressInChapter(),
        text_offset: anchor.start,
        anchor: {
          quote: anchor.quote,
          prefix: anchor.prefix,
          suffix: anchor.suffix,
          start: anchor.start,
          end: anchor.end,
        },
      },
      quote: anchor.quote,
      anchorRect: { x: frameRect.left + rect.left, y: frameRect.top + rect.bottom },
    });
  }

  // ------------------------------------------------------------------ links

  private onClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (!target) return;
    const img = target.closest<HTMLImageElement>("img");
    if (img && !target.closest("a")) {
      this.callbacks.onImage(img.src, img.alt || "");
      return;
    }
    const link = target.closest<HTMLAnchorElement>("a");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    this.followLink(href, event);
  }

  private followLink(href: string, event: MouseEvent): void {
    const lower = href.toLowerCase();
    if (lower.startsWith("mailto:") || lower.startsWith("tel:")) {
      this.callbacks.onLink(href);
      return;
    }
    if (/^https?:/i.test(href)) {
      if (!href.startsWith(this.baseUrl) && !href.startsWith(originOf(this.baseUrl))) {
        this.callbacks.onLink(href);
        return;
      }
    }
    const resource = this.parseInternal(href);
    if (!resource) {
      this.callbacks.onLink(href);
      return;
    }
    const { path, fragment } = resource;
    const chapter = this.chapters.find((c) => c.href === path);
    if (chapter && fragment) {
      const target = (this.doc().getElementById(fragment) ?? this.doc().querySelector(`[id="${cssEscape(fragment)}"]`));
      if (chapter.index === this.chapter?.index && target) {
        this.showFootnote(target, event);
        return;
      }
    }
    if (chapter) {
      if (chapter.index === this.chapter?.index) {
        if (fragment) this.scrollToId(fragment);
        return;
      }
      this.pushHistory();
      void this.loadChapter(chapter.index, 0, null).then(() => {
        if (fragment) this.scrollToId(fragment);
      });
      return;
    }
    if (fragment && this.chapter) {
      this.scrollToId(fragment);
    }
  }

  private parseInternal(href: string): { path: string; fragment: string } | null {
    const decoded = decodeURIComponent(href.split("#")[0] ?? "");
    const fragment = decodeURIComponent(href.split("#")[1] ?? "");
    const marker = `/epub/${this.book.id}/`;
    const at = decoded.indexOf(marker);
    if (at < 0) return { path: decoded.replace(/^\.\//, ""), fragment };
    return { path: decoded.slice(at + marker.length), fragment };
  }

  private scrollToId(id: string): void {
    const doc = this.doc();
    const el = doc.getElementById(id);
    if (!el) return;
    this.revealElement(el);
    el.classList.add("bs-target");
    window.setTimeout(() => el.classList.remove("bs-target"), 1600);
  }

  private pushHistory(): void {
    const current = this.locator();
    if (current.kind === "epub" && current.href) this.backStack.push(current);
    if (this.backStack.length > 30) this.backStack.shift();
    this.callbacks.onHistory?.(this.backStack.length);
  }

  back(): void {
    const previous = this.backStack.pop();
    this.callbacks.onHistory?.(this.backStack.length);
    if (previous) void this.goTo(previous);
  }

  private showFootnote(target: HTMLElement, event: MouseEvent): void {
    this.closePopup();
    const popup = document.createElement("div");
    popup.className = "note-popup";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", t("reader_footnote"));
    const text = document.createElement("p");
    text.textContent = (target.textContent ?? "").trim().slice(0, 600);
    popup.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "note-popup-actions";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "ghost";
    go.textContent = t("reader_go_to_note");
    go.addEventListener("click", () => {
      this.pushHistory();
      this.scrollToId(target.id);
      this.closePopup();
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ghost";
    close.textContent = t("close");
    close.addEventListener("click", () => this.closePopup());
    actions.append(go, close);
    popup.appendChild(actions);
    this.stage.appendChild(popup);
    const rect = this.frame.getBoundingClientRect();
    const left = Math.min(Math.max(12, event.clientX - rect.left - 20), this.viewportWidth() - 340);
    const top = Math.min(Math.max(12, event.clientY - rect.top + 14), this.viewportHeight() - 200);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    this.popup = popup;
    const dismiss = (ev: MouseEvent) => {
      if (!popup.contains(ev.target as Node)) {
        this.closePopup();
        document.removeEventListener("mousedown", dismiss, true);
      }
    };
    window.setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
  }

  private closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  // --------------------------------------------------------------- rendering

  private revealRange(range: Range): void {
    const el = (range.startContainer.parentElement ?? null);
    if (this.prefs.layout === "paginated") {
      // Find the page by measuring the element's horizontal offset within the
      // multi-column flow.
      const content = this.doc().getElementById("bs-content");
      if (content && el) {
        const offset = el.getBoundingClientRect().left - content.getBoundingClientRect().left;
        const page = Math.max(0, Math.round(offset / this.pageStep));
        this.setPage(page, false);
      }
    } else {
      this.revealElement(el);
    }
    this.emitProgress();
  }

  private revealElement(el: HTMLElement | null): void {
    if (!el) return;
    if (this.prefs.layout === "paginated") {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      this.revealRange(range);
      return;
    }
    const view = this.doc().defaultView;
    if (!view) return;
    const top = el.getBoundingClientRect().top + view.scrollY;
    view.scrollTo({ top: Math.max(0, top - 24), behavior: "instant" as ScrollBehavior });
    this.emitProgress();
  }

  private clearFind(): void {
    for (const el of this.findMarks) unwrap(el);
    this.findMarks = [];
  }

  // ---------------------------------------------------------------- styling

  private applyAppearance(): void {
    const doc = this.doc();
    const styleEl = doc.getElementById("bs-appearance");
    if (!styleEl) return;
    const palette = this.palette();
    const family = readerFontStack(this.prefs.fontFamily);
    const size = this.prefs.fontSize ?? 19;
    const line = this.prefs.lineHeight ?? 1.6;
    const paragraph = this.prefs.paragraphSpacing ?? 0.7;
    const align = this.prefs.align === "left" ? "left" : "justify";
    const hyphen = this.prefs.hyphenate ? "auto" : "manual";
    const fontBase = new URL("/fonts/", window.location.href).href;
    styleEl.textContent = `
:root { color-scheme: ${palette.dark ? "dark" : "light"}; }
html, body { background: ${palette.bg}; }
body {
  color: ${palette.ink};
  font-family: ${family}, "Noto Serif SC", "Noto Naskh Arabic", serif;
  font-size: ${size}px;
  line-height: ${line};
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
}
#bs-content { color: ${palette.ink}; }
#bs-content p, #bs-content li, #bs-content dd, #bs-content blockquote {
  margin-block: 0 ${paragraph}em;
  text-align: ${align};
  hyphens: ${hyphen};
}
#bs-content h1, #bs-content h2, #bs-content h3 { line-height: 1.25; margin-block: 1.2em 0.6em; text-wrap: balance; }
#bs-content img, #bs-content svg { max-width: 100%; height: auto; }
#bs-content img { cursor: zoom-in; border-radius: 3px; }
#bs-content a { color: ${palette.accent}; text-decoration-thickness: 1px; text-underline-offset: 2px; }
#bs-content pre { white-space: pre-wrap; font-size: 0.86em; }
#bs-content table { max-width: 100%; border-collapse: collapse; }
#bs-content hr { border: 0; border-top: 1px solid ${palette.rule}; margin: 1.6em auto; width: 40%; }
#bs-content blockquote { border-inline-start: 3px solid ${palette.rule}; padding-inline-start: 1em; opacity: 0.9; }
#bs-content .bs-target { background: ${palette.accent}22; border-radius: 3px; }
::selection { background: ${palette.accent}44; }
.${HL_CLASS} { border-radius: 2px; padding-block: 0.05em; }
.hl-yellow { background: #f2cf5b66; }
.hl-green { background: #79c68d66; }
.hl-blue { background: #7fb6e866; }
.hl-pink { background: #e89bbf66; }
.${FIND_CLASS} { background: ${palette.accent}33; border-radius: 2px; }
.${FIND_CURRENT_CLASS} { background: ${palette.accent}66; outline: 1px solid ${palette.accent}; }
@font-face { font-family: "Literata"; src: url("${fontBase}Literata-Variable.ttf"); font-weight: 100 900; }
@font-face { font-family: "Source Serif 4"; src: url("${fontBase}SourceSerif4-Variable.ttf"); font-weight: 200 900; }
@font-face { font-family: "Gelasio"; src: url("${fontBase}Gelasio-Variable.ttf"); font-weight: 100 900; }
@font-face { font-family: "Inter"; src: url("${fontBase}Inter-Variable.ttf"); font-weight: 100 900; }
@font-face { font-family: "OpenDyslexic"; src: url("${fontBase}OpenDyslexic-Regular.otf"); font-weight: 400; }
`;
    doc.documentElement.style.background = palette.bg;
    doc.body.style.background = palette.bg;
  }

  renderPanel(container: HTMLElement, kind: PanelKind): boolean {
    if (kind !== "toc") return false;
    container.replaceChildren();
    for (const entry of this.tocEntries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toc-row";
      button.style.paddingInlineStart = `${8 + entry.level * 14}px`;
      button.textContent = entry.label || t("untitled");
      button.addEventListener("click", () => {
        const chapter = this.chapters.find((c) => c.href === stripFragment(entry.href ?? ""));
        if (chapter) {
          this.pushHistory();
          void this.loadChapter(chapter.index, 0, null).then(() => {
            const fragment = entry.href?.split("#")[1];
            if (fragment) this.scrollToId(decodeURIComponent(fragment));
          });
        } else if (entry.href) {
          const resource = this.parseInternal(entry.href);
          if (resource) {
            const target = this.chapters.find((c) => c.href === resource.path);
            if (target) {
              this.pushHistory();
              void this.loadChapter(target.index, 0, null).then(() => {
                if (resource.fragment) this.scrollToId(resource.fragment);
              });
            }
          }
        }
      });
      container.appendChild(button);
    }
    if (!this.tocEntries.length) {
      const empty = document.createElement("p");
      empty.className = "panel-empty";
      empty.textContent = t("reader_no_toc");
      container.appendChild(empty);
    }
    return true;
  }

  clearSelection(): void {
    this.doc().getSelection()?.removeAllRanges();
  }
}

const RESET_CSS = `
html, body { margin: 0; padding: 0; }
#bs-content { box-sizing: border-box; }
body.bs-pages #bs-content { will-change: transform; }
body.bs-pages { overscroll-behavior: none; }
img { -webkit-user-drag: none; }
`;

function systemTheme(): ResolvedTheme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at + 1);
}

function stripFragment(href: string): string {
  const at = href.indexOf("#");
  return at < 0 ? href : href.slice(0, at);
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wrap the parts of a range that live in text nodes; returns the marks. */
export function wrapRange(range: Range, className: string): HTMLElement[] {
  const doc = range.startContainer.ownerDocument;
  if (!doc) return [];
  const root = range.commonAncestorContainer;
  const walker = doc.createTreeWalker(
    root.nodeType === Node.TEXT_NODE ? root.parentNode ?? root : root,
    NodeFilter.SHOW_TEXT,
  );
  const targets: { node: Text; start: number; end: number }[] = [];
  let node = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node)) {
      const text = node as Text;
      const start = text === range.startContainer ? range.startOffset : 0;
      const end = text === range.endContainer ? range.endOffset : text.length;
      if (end > start) targets.push({ node: text, start, end });
    }
    node = walker.nextNode();
  }
  const marks: HTMLElement[] = [];
  for (const target of targets) {
    let textNode = target.node;
    const length = target.end - target.start;
    if (target.start > 0) textNode = textNode.splitText(target.start);
    if (length < textNode.length) textNode.splitText(length);
    const span = doc.createElement("span");
    span.className = className;
    textNode.parentNode?.insertBefore(span, textNode);
    span.appendChild(textNode);
    marks.push(span);
  }
  return marks;
}

/** Replace a mark with its text and normalise the parent. */
export function unwrap(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
  if (parent instanceof Element) parent.normalize();
}
