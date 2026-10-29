import type { Book } from "../lib/api";
import { el, icons, svgIcon } from "../lib/dom";
import { pct, relativeOpened } from "../lib/format";
import { pluralBooks, t } from "../lib/i18n";
import { drawCoverTexture } from "../shelf/textures";

export interface ListHandlers {
  onSelect(book: Book): void;
  onRead(book: Book): void;
  onRelink(book: Book): void;
}

/** A keyboard- and screen-reader-friendly alternative to the 3D shelf. */
export class LibraryList {
  readonly root: HTMLElement;
  private handlers: ListHandlers;

  constructor(root: HTMLElement, handlers: ListHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  render(books: Book[], total: number): void {
    const heading = el(
      "div",
      { class: "list-head" },
      el("h2", {}, t("listHeading")),
      el("span", { class: "count" }, pluralBooks(total)),
    );
    const grid = el("div", { class: "list-grid", role: "list" });
    for (const book of books) {
      grid.append(this.row(book));
    }
    if (books.length === 0) {
      grid.append(el("p", { class: "list-empty" }, t("noMatches")));
    }
    this.root.replaceChildren(heading, grid);
  }

  private row(book: Book): HTMLElement {
    const percent = pct(book.progress);
    const statusLabel =
      book.status === "read"
        ? t("statusRead")
        : book.status === "reading"
          ? t("statusReading")
          : t("statusWant");

    const cover = el("div", { class: "list-cover" });
    if (book.coverUrl) {
      const img = el("img", {
        src: book.coverUrl,
        alt: "",
        loading: "lazy",
        decoding: "async",
      });
      img.addEventListener("error", () => {
        const canvas = drawCoverTexture(book);
        canvas.setAttribute("aria-hidden", "true");
        cover.replaceChildren(canvas);
      });
      cover.append(img);
    } else {
      const canvas = drawCoverTexture(book);
      canvas.setAttribute("aria-hidden", "true");
      cover.append(canvas);
    }

    const open = el(
      "button",
      {
        type: "button",
        class: "list-row",
        "aria-label": `${book.title}, ${book.author || t("unknownAuthor")}, ${statusLabel}, ${t("progress", { pct: percent })}${book.missing ? `, ${t("missingFile")}` : ""}`,
      },
      cover,
      el(
        "span",
        { class: "list-text" },
        el("span", { class: "list-title" }, book.title),
        el("span", { class: "list-author" }, book.author.trim() || t("unknownAuthor")),
        el(
          "span",
          { class: "list-meta" },
          `${book.format === "pdf" ? t("formatPdf") : t("formatEpub")} · ${
            book.pages > 0 ? t("pagesShort", { n: book.pages }) : t("pagesUnknown")
          } · ${relativeOpened(book.lastOpenedAt)}`,
        ),
      ),
      el(
        "span",
        { class: "list-side" },
        el("span", { class: `status-pill status-${book.status}` }, statusLabel),
        el(
          "span",
          { class: "list-progress", "aria-hidden": "true" },
          el("i", { style: { width: `${percent}%` } }),
        ),
        book.missing
          ? el("span", { class: "status-pill status-missing" }, t("missingFile"))
          : null,
      ),
    );
    open.addEventListener("click", () => this.handlers.onSelect(book));

    const actions = el("div", { class: "list-actions" });
    if (book.missing) {
      const relink = el("button", { type: "button", class: "ghost-btn small" }, t("relink"));
      relink.addEventListener("click", () => this.handlers.onRelink(book));
      actions.append(relink);
    } else {
      const read = el(
        "button",
        {
          type: "button",
          class: "primary-btn small",
          "aria-label": `${book.progress > 0.001 ? t("continueReading") : t("read")}: ${book.title}`,
        },
        svgIcon(icons.book, 14),
        book.progress > 0.001 ? t("continueReading") : t("read"),
      );
      read.addEventListener("click", () => this.handlers.onRead(book));
      actions.append(read);
    }

    return el("div", { class: "list-item", role: "listitem" }, open, actions);
  }
}
