import type { Book } from "../lib/api";
import type { Status } from "../bindings";
import { el, icons, svgIcon } from "../lib/dom";
import { pct, relativeOpened } from "../lib/format";
import { t } from "../lib/i18n";
import { drawCoverTexture } from "../shelf/textures";

export interface CardHandlers {
  onRead(book: Book): void;
  onEdit(book: Book): void;
  onRemove(book: Book): void;
  onStatus(book: Book, status: Status): void;
  onRelink(book: Book): void;
  onClose(): void;
}

const STATUSES: { id: Status; label: string }[] = [
  { id: "want", label: t("statusWant") },
  { id: "reading", label: t("statusReading") },
  { id: "read", label: t("statusRead") },
];

export class BookCard {
  readonly root: HTMLElement;
  private handlers: CardHandlers;
  private current: Book | null = null;
  private coverHost: HTMLElement;
  private bodyHost: HTMLElement;

  constructor(host: HTMLElement, handlers: CardHandlers) {
    this.handlers = handlers;
    this.coverHost = el("div", { class: "detail-cover" });
    this.bodyHost = el("div", { class: "detail-body" });
    this.root = el(
      "aside",
      {
        class: "book-card",
        role: "dialog",
        "aria-label": t("bookInfo"),
        hidden: true,
      },
      el(
        "button",
        {
          type: "button",
          class: "card-close ghost-btn icon-only",
          "aria-label": t("close"),
          title: t("close"),
        },
        svgIcon(icons.close, 16),
      ),
      this.coverHost,
      this.bodyHost,
    );
    const close = this.root.querySelector(".card-close");
    close?.addEventListener("click", () => this.handlers.onClose());
    host.append(this.root);
  }

  show(book: Book | null): void {
    this.current = book;
    if (!book) {
      this.root.classList.remove("is-visible");
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add("is-visible"));
    this.render(book);
  }

  get book(): Book | null {
    return this.current;
  }

  private render(book: Book): void {
    this.root.dataset.status = book.status;
    this.root.classList.toggle("is-missing", book.missing);

    if (book.coverUrl) {
      const image = el("img", {
        src: book.coverUrl,
        alt: t("coverAlt", { title: book.title }),
        loading: "eager",
        decoding: "async",
      });
      image.addEventListener("error", () => {
        image.replaceWith(this.generatedCover(book));
      });
      this.coverHost.replaceChildren(image);
    } else {
      this.coverHost.replaceChildren(this.generatedCover(book));
    }

    const percent = pct(book.progress);
    const meta = [
      book.format === "pdf" ? t("formatPdf") : t("formatEpub"),
      book.pages > 0 ? t("pagesShort", { n: book.pages }) : t("pagesUnknown"),
      relativeOpened(book.lastOpenedAt),
    ];

    const statusButtons = STATUSES.map((status) => {
      const button = el(
        "button",
        {
          type: "button",
          class: "seg-btn",
          "aria-pressed": String(book.status === status.id),
        },
        status.label,
      );
      button.addEventListener("click", () => this.handlers.onStatus(book, status.id));
      return button;
    });

    const readLabel =
      book.progress > 0.001 ? t("continueReading") : t("read");
    const readButton = el(
      "button",
      { type: "button", class: "primary-btn wide", disabled: book.missing },
      svgIcon(icons.book, 16),
      readLabel,
    );
    readButton.addEventListener("click", () => this.handlers.onRead(book));

    const edit = el("button", { type: "button", class: "ghost-btn" }, t("edit"));
    edit.addEventListener("click", () => this.handlers.onEdit(book));

    const remove = el("button", { type: "button", class: "ghost-btn danger-text" }, t("remove"));
    remove.addEventListener("click", () => this.handlers.onRemove(book));

    const rows: Array<Node> = [
      el("p", { class: "eyebrow" }, meta.join(" · ")),
      el("h2", { class: "detail-title" }, book.title),
      el("p", { class: "detail-author" }, book.author.trim() || t("unknownAuthor")),
      el(
        "div",
        { class: "progress-block" },
        el(
          "div",
          {
            class: "progress-track",
            role: "progressbar",
            "aria-valuemin": "0",
            "aria-valuemax": "100",
            "aria-valuenow": String(percent),
            "aria-label": t("progress", { pct: percent }),
          },
          el("i", { class: "progress-fill", style: { width: `${percent}%` } }),
        ),
        el("span", { class: "progress-label" }, t("progress", { pct: percent })),
      ),
      el(
        "div",
        { class: "status-control segmented", role: "group", "aria-label": t("statusLabel") },
        ...statusButtons,
      ),
      el("div", { class: "detail-actions" }, readButton, edit, remove),
    ];

    if (book.missing) {
      const explanation = el(
        "p",
        { class: "missing-note" },
        svgIcon(icons.warning, 15),
        el("span", {}, t("missingExplanation")),
      );
      const relink = el("button", { type: "button", class: "ghost-btn" }, t("relink"));
      relink.addEventListener("click", () => this.handlers.onRelink(book));
      rows.splice(rows.length - 1, 0, explanation, relink);
    }

    this.bodyHost.replaceChildren(...rows);
  }

  private generatedCover(book: Book): HTMLElement {
    const canvas = drawCoverTexture(book);
    canvas.className = "generated-cover";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", t("coverAlt", { title: book.title }));
    return canvas;
  }
}
