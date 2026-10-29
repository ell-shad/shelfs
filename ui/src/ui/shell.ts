import type { Book, ImportSummary, LibrarySnapshot, Settings } from "../lib/api";
import { el, icons, svgIcon } from "../lib/dom";
import { pluralBooks, t } from "../lib/i18n";
import type { LibraryView, SortKey, StatusFilter } from "../bindings";

export interface ShellHandlers {
  onAddFiles(): void;
  onAddFolder(): void;
  onSearch(query: string): void;
  onFilter(filter: StatusFilter): void;
  onSort(sort: SortKey): void;
  onView(view: LibraryView): void;
  onSettings(): void;
  onPrevCase(): void;
  onNextCase(): void;
  onResetView(): void;
}

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: t("filterAll") },
  { id: "want", label: t("filterWant") },
  { id: "reading", label: t("filterReading") },
  { id: "read", label: t("filterRead") },
];

const SORTS: { id: SortKey; label: string }[] = [
  { id: "manual", label: t("sortManual") },
  { id: "title", label: t("sortTitle") },
  { id: "author", label: t("sortAuthor") },
  { id: "added", label: t("sortAdded") },
  { id: "lastOpened", label: t("sortLastOpened") },
  { id: "status", label: t("sortStatus") },
];

export class Shell {
  readonly topbar: HTMLElement;
  readonly listRoot: HTMLElement;
  private countLabel: HTMLElement;
  private searchInput: HTMLInputElement;
  private filterButtons = new Map<StatusFilter, HTMLButtonElement>();
  private sortSelect: HTMLSelectElement;
  private viewButton: HTMLButtonElement;
  private caseNav: HTMLElement;
  private caseLabel: HTMLElement;
  private hint: HTMLElement;
  private tooltip: HTMLElement;
  private toastRoot: HTMLElement;
  private importStrip: HTMLElement;
  private importBar: HTMLElement;
  private importLabel: HTMLElement;
  private importDetail: HTMLElement;
  private dropOverlay: HTMLElement;
  private addMenu: HTMLElement | null = null;
  private empty: HTMLElement;
  private handlers: ShellHandlers;
  private settings: Settings | null = null;
  private searchTimer: number | undefined;

  constructor(host: HTMLElement, handlers: ShellHandlers) {
    this.handlers = handlers;

    this.countLabel = el("span", { class: "count" });
    const brand = el(
      "div",
      { class: "brand" },
      el("h1", { class: "brand-title" }, t("appTitle")),
      this.countLabel,
    );

    this.searchInput = el("input", {
      type: "search",
      class: "search-input",
      placeholder: t("search"),
      "aria-label": t("search"),
      spellcheck: false,
      autocomplete: "off",
    });
    this.searchInput.addEventListener("input", () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(
        () => this.handlers.onSearch(this.searchInput.value),
        160,
      );
    });
    this.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.searchInput.value = "";
        this.handlers.onSearch("");
        this.searchInput.blur();
      }
    });

    const search = el(
      "div",
      { class: "search" },
      svgIcon(icons.search, 16),
      this.searchInput,
      el("kbd", { class: "kbd" }, t("searchShortcut")),
    );

    const filters = el("div", {
      class: "segmented filters",
      role: "group",
      "aria-label": t("statusLabel"),
    });
    for (const filter of FILTERS) {
      const button = el(
        "button",
        {
          type: "button",
          class: "seg-btn",
          "aria-pressed": "false",
          dataset: { filter: filter.id },
        },
        filter.label,
      );
      button.addEventListener("click", () => this.handlers.onFilter(filter.id));
      this.filterButtons.set(filter.id, button);
      filters.append(button);
    }

    this.sortSelect = el("select", {
      class: "select",
      "aria-label": t("sortBy"),
      title: t("sortBy"),
    });
    for (const sort of SORTS) {
      this.sortSelect.append(el("option", { value: sort.id }, sort.label));
    }
    this.sortSelect.addEventListener("change", () => {
      this.handlers.onSort(this.sortSelect.value as SortKey);
    });
    const sortWrap = el("label", { class: "select-wrap" }, this.sortSelect);

    this.viewButton = el("button", {
      type: "button",
      class: "ghost-btn icon-only",
      "aria-label": t("viewList"),
      title: t("viewList"),
    });
    this.viewButton.append(svgIcon(icons.list));
    this.viewButton.addEventListener("click", () => {
      const current = this.settings?.view ?? "shelf";
      this.handlers.onView(current === "shelf" ? "list" : "shelf");
    });

    const addButton = el(
      "button",
      { type: "button", class: "primary-btn", "aria-haspopup": "menu" },
      svgIcon(icons.plus, 16),
      el("span", {}, t("addBook")),
    );
    addButton.addEventListener("click", () => this.toggleAddMenu(addButton));
    addButton.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.toggleAddMenu(addButton, true);
      }
    });

    const gear = el("button", {
      type: "button",
      class: "ghost-btn icon-only",
      "aria-label": t("settings"),
      title: t("settings"),
    });
    gear.append(svgIcon(icons.gear));
    gear.addEventListener("click", () => this.handlers.onSettings());

    const toolbar = el(
      "div",
      { class: "toolbar" },
      search,
      filters,
      sortWrap,
      this.viewButton,
      addButton,
      gear,
    );

    this.topbar = el("header", { class: "topbar" }, brand, toolbar);

    this.caseNav = el("div", { class: "case-nav", hidden: true });
    const prev = el("button", {
      type: "button",
      class: "nav-arrow",
      "aria-label": t("previousCase"),
      title: t("previousCase"),
    });
    prev.append(svgIcon(icons.left, 16));
    prev.addEventListener("click", () => this.handlers.onPrevCase());
    const next = el("button", {
      type: "button",
      class: "nav-arrow",
      "aria-label": t("nextCase"),
      title: t("nextCase"),
    });
    next.append(svgIcon(icons.right, 16));
    next.addEventListener("click", () => this.handlers.onNextCase());
    this.caseLabel = el("span", { class: "case-label" });
    this.caseNav.append(prev, this.caseLabel, next);

    this.hint = el("p", { class: "hint" });
    this.tooltip = el("div", { class: "tooltip", role: "tooltip", hidden: true });
    this.toastRoot = el("div", { class: "toast-region", "aria-live": "polite" });

    this.importStrip = el("div", { class: "import-strip", hidden: true, role: "status" });
    this.importLabel = el("span", { class: "import-label" });
    this.importBar = el("div", { class: "import-bar" });
    this.importDetail = el("div", { class: "import-detail" });
    this.importStrip.append(this.importLabel, this.importBar, this.importDetail);

    this.dropOverlay = el(
      "div",
      { class: "drop-overlay", hidden: true },
      el("div", { class: "drop-card" }, svgIcon(icons.upload, 28), t("dropToImport")),
    );

    this.empty = el("div", { class: "empty-state", hidden: true });

    this.listRoot = el("section", {
      class: "library-list",
      hidden: true,
      "aria-label": t("listHeading"),
    });

    host.append(
      this.topbar,
      this.empty,
      this.listRoot,
      this.caseNav,
      this.hint,
      this.tooltip,
      this.importStrip,
      this.dropOverlay,
      this.toastRoot,
    );

    document.addEventListener("click", (event) => {
      if (!this.addMenu) return;
      const target = event.target as Node;
      if (!this.addMenu.contains(target)) this.closeAddMenu();
    });
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  getSearch(): string {
    return this.searchInput.value.trim();
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.sortSelect.value = settings.sort;
    for (const [id, button] of this.filterButtons) {
      button.setAttribute("aria-pressed", String(settings.filter === id));
    }
    const isList = settings.view === "list";
    this.viewButton.replaceChildren(svgIcon(isList ? icons.grid : icons.list));
    this.viewButton.setAttribute("aria-label", isList ? t("viewShelf") : t("viewList"));
    this.viewButton.title = isList ? t("viewShelf") : t("viewList");
    this.viewButton.setAttribute("aria-pressed", String(isList));
    this.listRoot.hidden = !isList;
    this.hint.textContent =
      settings.view === "list"
        ? t("shelfHintReduced")
        : window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? t("shelfHintReduced")
          : t("shelfHint");
  }

  setLibrary(snapshot: LibrarySnapshot, filteredCount: number, searchActive: boolean): void {
    const total = snapshot.total;
    this.countLabel.textContent = pluralBooks(total);
    if (total === 0) {
      this.showEmpty(t("noBooksTitle"), t("noBooksBody"));
    } else if (filteredCount === 0) {
      this.showEmpty(t("noMatches"), searchActive ? t("clearSearch") : t("noBooksBody"));
    } else {
      this.empty.hidden = true;
    }
    this.caseNav.hidden = snapshot.layout.caseCount <= 1;
    if (this.settings) this.setSettings(this.settings);
  }

  private showEmpty(title: string, body: string): void {
    this.empty.replaceChildren(
      el("div", { class: "empty-card" }, el("h2", {}, title), el("p", {}, body)),
    );
    this.empty.hidden = false;
  }

  setCase(index: number, total: number): void {
    this.caseLabel.textContent = t("caseOf", { n: index + 1, total });
    this.caseNav.hidden = total <= 1;
  }

  showTooltip(book: Book | null, x: number, y: number): void {
    if (!book) {
      this.tooltip.hidden = true;
      return;
    }
    this.tooltip.replaceChildren(
      el("strong", {}, book.title),
      ...(book.author.trim() ? [el("span", { class: "tooltip-author" }, book.author)] : []),
    );
    this.tooltip.hidden = false;
    const pad = 14;
    const rect = this.tooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - rect.width - 8, x + pad);
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, y + pad));
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  hideTooltip(): void {
    this.tooltip.hidden = true;
  }

  toast(
    message: string,
    options: { kind?: "info" | "error" | "success"; action?: { label: string; run: () => void }; timeout?: number } = {},
  ): void {
    const { kind = "info", action, timeout = 6000 } = options;
    const toast = el("div", { class: `toast toast-${kind}`, role: "status" });
    toast.append(el("span", { class: "toast-text" }, message));
    if (action) {
      const button = el("button", { type: "button", class: "toast-action" }, action.label);
      button.addEventListener("click", () => {
        action.run();
        toast.remove();
      });
      toast.append(button);
    }
    const close = el("button", {
      type: "button",
      class: "toast-close",
      "aria-label": t("close"),
    });
    close.append(svgIcon(icons.close, 14));
    close.addEventListener("click", () => toast.remove());
    toast.append(close);
    this.toastRoot.append(toast);
    if (timeout > 0) {
      window.setTimeout(() => toast.remove(), timeout);
    }
  }

  setImportProgress(done: number, total: number, current: string): void {
    this.importStrip.hidden = false;
    this.importStrip.classList.remove("done", "failed");
    this.importLabel.textContent = `${t("importing")} ${done}/${total}${current ? ` · ${current}` : ""}`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    this.importBar.style.width = `${pct}%`;
    this.importDetail.replaceChildren();
  }

  finishImport(summary: ImportSummary): void {
    this.importStrip.hidden = false;
    this.importBar.style.width = "100%";
    this.importLabel.textContent = t("importDone", { n: summary.imported.length });
    this.importStrip.classList.add("done");
    const details = el("div", { class: "import-detail-inner" });
    if (summary.duplicatesSkipped.length) {
      details.append(
        el(
          "p",
          { class: "import-note" },
          t("duplicatesFound", { n: summary.duplicatesSkipped.length }),
        ),
      );
    }
    for (const failure of summary.failures) {
      details.append(
        el(
          "p",
          { class: "import-failure" },
          el("strong", {}, failure.path.split("/").pop() ?? failure.path),
          el("span", {}, ` — ${failure.message}`),
        ),
      );
    }
    this.importDetail.replaceChildren(details);
    window.setTimeout(() => {
      if (this.importStrip.classList.contains("done")) {
        this.importStrip.hidden = true;
        this.importDetail.replaceChildren();
      }
    }, summary.failures.length ? 14000 : 4500);
  }

  showDropOverlay(visible: boolean): void {
    this.dropOverlay.hidden = !visible;
  }

  private toggleAddMenu(anchor: HTMLElement, fromKeyboard = false): void {
    if (this.addMenu) {
      this.closeAddMenu();
      if (!fromKeyboard) return;
    }
    const menu = el("div", { class: "menu", role: "menu" });
    const files = el(
      "button",
      { type: "button", class: "menu-item", role: "menuitem" },
      svgIcon(icons.book, 16),
      t("addBook"),
    );
    files.addEventListener("click", () => {
      this.closeAddMenu();
      this.handlers.onAddFiles();
    });
    const folder = el(
      "button",
      { type: "button", class: "menu-item", role: "menuitem" },
      svgIcon(icons.layers, 16),
      t("addFolder"),
    );
    folder.addEventListener("click", () => {
      this.closeAddMenu();
      this.handlers.onAddFolder();
    });
    menu.append(files, folder);
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 8}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    document.body.append(menu);
    this.addMenu = menu;
    files.focus();
  }

  private closeAddMenu(): void {
    this.addMenu?.remove();
    this.addMenu = null;
  }
}
