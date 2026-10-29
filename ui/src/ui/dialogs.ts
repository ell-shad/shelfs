import type { AppInfo, Book, DuplicateHit, Settings, SettingsPatch } from "../lib/api";
import type { BookPatch, Status, SortKey } from "../bindings";
import { el, icons, svgIcon } from "../lib/dom";
import { t } from "../lib/i18n";
import { READER_FONTS } from "../lib/fonts";
import { drawSpineTexture } from "../shelf/textures";

export interface ModalHandle {
  close(): void;
  dialog: HTMLDialogElement;
}

interface ModalOptions {
  title: string;
  body: Node;
  actions?: Node[];
  dismissible?: boolean;
  className?: string;
  onClose?: () => void;
}

export function openModal(options: ModalOptions): ModalHandle {
  const dialog = el("dialog", { class: `modal ${options.className ?? ""}` });
  const title = el("h2", { class: "modal-title" }, options.title);
  const closeButton = el(
    "button",
    { type: "button", class: "ghost-btn icon-only", "aria-label": t("close") },
    svgIcon(icons.close, 16),
  );
  const body = el("div", { class: "modal-body" }, options.body);
  const footer = options.actions ? el("div", { class: "modal-actions" }, ...options.actions) : null;
  const panel = el(
    "div",
    { class: "modal-panel" },
    el("div", { class: "modal-head" }, title, closeButton),
    body,
    footer ?? "",
  );
  dialog.append(panel);

  const close = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
    options.onClose?.();
  };
  closeButton.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    if (options.dismissible === false) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && options.dismissible !== false) close();
  });

  document.body.append(dialog);
  dialog.showModal();
  const focusable = panel.querySelector<HTMLElement>(
    "input, select, textarea, button:not(.modal-head button)",
  );
  focusable?.focus();
  return { close, dialog };
}

export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
      handle.close();
    };
    const cancel = el("button", { type: "button", class: "ghost-btn" }, t("cancel"));
    cancel.addEventListener("click", () => done(false));
    const confirm = el(
      "button",
      {
        type: "button",
        class: options.danger ? "primary-btn danger" : "primary-btn",
      },
      options.confirmLabel,
    );
    confirm.addEventListener("click", () => done(true));
    const handle = openModal({
      title: options.title,
      body: el("p", { class: "modal-text" }, options.message),
      actions: [cancel, confirm],
      onClose: () => done(false),
    });
  });
}

export function duplicateDialog(hits: DuplicateHit[]): Promise<"add" | "skip"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: "add" | "skip") => {
      if (settled) return;
      settled = true;
      resolve(value);
      handle.close();
    };
    const list = el(
      "ul",
      { class: "duplicate-list" },
      ...hits.map((hit) =>
        el(
          "li",
          {},
          el("strong", {}, hit.title),
          el("span", {}, ` — ${t("duplicateTitle")}: ${hit.existingTitle}`),
        ),
      ),
    );
    const skip = el("button", { type: "button", class: "ghost-btn" }, t("skipDuplicates"));
    skip.addEventListener("click", () => finish("skip"));
    const add = el("button", { type: "button", class: "primary-btn" }, t("addAnyway"));
    add.addEventListener("click", () => finish("add"));
    const handle = openModal({
      title: t("duplicateTitle"),
      body: el(
        "div",
        {},
        el("p", { class: "modal-text" }, t("duplicatesFound", { n: hits.length })),
        list,
      ),
      actions: [skip, add],
      onClose: () => finish("skip"),
    });
  });
}

function field(label: string, control: Node, hint?: string): HTMLElement {
  return el(
    "label",
    { class: "field" },
    el("span", { class: "field-label" }, label),
    control,
    hint ? el("span", { class: "field-hint" }, hint) : null,
  );
}

export function editBookDialog(
  book: Book,
  onSave: (patch: BookPatch) => Promise<void>,
  onDelete?: () => void,
): void {
  const title = el("input", {
    type: "text",
    class: "input",
    value: book.title,
    required: true,
  });
  const author = el("input", { type: "text", class: "input", value: book.author });
  const pages = el("input", {
    type: "number",
    class: "input",
    min: "1",
    max: "20000",
    value: String(book.pages || 100),
  });
  const color = el("input", { type: "color", class: "color-input", value: book.color });
  const preview = el("div", { class: "spine-preview" });
  const renderPreview = () => {
    const previewBook: Book = {
      ...book,
      title: title.value || book.title,
      author: author.value,
      color: color.value,
      pages: Number(pages.value) || book.pages,
    };
    const canvas = drawSpineTexture(previewBook);
    canvas.style.width = "48px";
    canvas.style.height = "192px";
    preview.replaceChildren(canvas);
  };
  title.addEventListener("input", renderPreview);
  author.addEventListener("input", renderPreview);
  color.addEventListener("input", renderPreview);

  let status: Status = book.status;
  const statusGroup = el("div", {
    class: "segmented",
    role: "group",
    "aria-label": t("statusLabel"),
  });
  const statuses: { id: Status; label: string }[] = [
    { id: "want", label: t("statusWant") },
    { id: "reading", label: t("statusReading") },
    { id: "read", label: t("statusRead") },
  ];
  const buttons: HTMLButtonElement[] = [];
  for (const entry of statuses) {
    const button = el(
      "button",
      { type: "button", class: "seg-btn", "aria-pressed": String(entry.id === status) },
      entry.label,
    );
    button.addEventListener("click", () => {
      status = entry.id;
      buttons.forEach((b, i) =>
        b.setAttribute("aria-pressed", String(statuses[i]?.id === status)),
      );
    });
    buttons.push(button);
    statusGroup.append(button);
  }

  const error = el("p", { class: "form-error", hidden: true, role: "alert" });
  const form = el(
    "form",
    { class: "form" },
    el("div", { class: "form-main" },
      field(t("titleLabel"), title),
      field(t("authorLabel"), author),
      field(t("pagesLabel"), pages),
      field(t("statusLabel"), statusGroup),
      field(t("colorLabel"), el("div", { class: "color-row" }, color, preview)),
    ),
    error,
  );
  const cancel = el("button", { type: "button", class: "ghost-btn" }, t("cancel"));
  const save = el("button", { type: "button", class: "primary-btn" }, t("save"));
  error.hidden = true;

  const handle = openModal({
    title: t("editBook"),
    body: form,
    actions: [cancel, save],
  });
  cancel.addEventListener("click", () => handle.close());
  save.addEventListener("click", (event) => {
    event.preventDefault();
    const value = title.value.trim();
    if (!value) {
      error.textContent = "A book needs a title.";
      error.hidden = false;
      title.focus();
      return;
    }
    save.setAttribute("disabled", "true");
    void onSave({
      title: value,
      author: author.value.trim(),
      pages: Math.max(1, Math.min(20000, Number(pages.value) || 1)),
      color: color.value,
      status,
    })
      .then(() => handle.close())
      .catch((err: unknown) => {
        error.textContent = err instanceof Error ? err.message : String(err);
        error.hidden = false;
      })
      .finally(() => save.removeAttribute("disabled"));
  });

  renderPreview();

  if (onDelete) {
    const remove = el("button", { type: "button", class: "ghost-btn danger-text" }, t("removeBook"));
    remove.addEventListener("click", () => {
      handle.close();
      onDelete();
    });
    form.append(remove);
  }
}

interface SettingsHandlers {
  patch: (patch: SettingsPatch) => Promise<void>;
  backup: () => void;
  restore: () => void;
  resetView: () => void;
}

export function settingsDialog(
  settings: Settings,
  info: AppInfo,
  handlers: SettingsHandlers,
): void {
  const local: Settings = structuredClone(settings);
  const update = (patch: SettingsPatch) => {
    void handlers.patch(patch);
  };

  const select = <T extends string>(
    options: { value: T; label: string }[],
    value: T,
    onChange: (value: T) => void,
    label: string,
  ): HTMLSelectElement => {
    const node = el("select", { class: "select", "aria-label": label });
    for (const option of options) {
      const opt = el("option", { value: option.value }, option.label);
      if (option.value === value) opt.setAttribute("selected", "true");
      node.append(opt);
    }
    node.addEventListener("change", () => onChange(node.value as T));
    return node;
  };

  const toggle = (checked: boolean, onChange: (value: boolean) => void, label: string) => {
    const input = el("input", { type: "checkbox", class: "toggle", "aria-label": label });
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    return input;
  };

  const range = (
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
    label: string,
  ) => {
    const input = el("input", {
      type: "range",
      class: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      "aria-label": label,
    });
    const output = el("output", { class: "range-value" }, String(value));
    input.addEventListener("input", () => {
      output.textContent = input.value;
      onChange(Number(input.value));
    });
    return el("div", { class: "range-row" }, input, output);
  };

  const theme = select(
    [
      { value: "system", label: t("themeSystem") },
      { value: "light", label: t("themeLight") },
      { value: "dark", label: t("themeDark") },
    ],
    local.theme,
    (value) => {
      local.theme = value;
      update({ theme: value });
    },
    t("theme"),
  );

  const performance = toggle(
    local.performanceMode,
    (value) => {
      local.performanceMode = value;
      update({ performanceMode: value });
    },
    t("performanceMode"),
  );

  const storageGroup = el("div", { class: "segmented", role: "group", "aria-label": t("libraryStorage") });
  const storageOptions = [
    { value: "reference", label: t("storageReference") },
    { value: "copy", label: t("storageCopy") },
  ] as const;
  for (const option of storageOptions) {
    const button = el(
      "button",
      {
        type: "button",
        class: "seg-btn",
        "aria-pressed": String(local.storageMode === option.value),
      },
      option.label,
    );
    button.addEventListener("click", () => {
      local.storageMode = option.value;
      storageGroup
        .querySelectorAll("button")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      update({ storageMode: option.value });
    });
    storageGroup.append(button);
  }

  const fontSelect = select(
    READER_FONTS.map((font) => ({ value: font.id, label: font.label })),
    local.reader.epub.fontFamily as (typeof READER_FONTS)[number]["id"],
    (value) => {
      local.reader.epub.fontFamily = value;
      update({ epub: { fontFamily: value } });
    },
    t("epubFont"),
  );

  const alignSelect = select(
    [
      { value: "justify", label: t("alignJustify") },
      { value: "left", label: t("alignLeft") },
    ],
    local.reader.epub.align,
    (value) => {
      local.reader.epub.align = value;
      update({ epub: { align: value } });
    },
    t("alignment"),
  );

  const layoutSelect = select(
    [
      { value: "paginated", label: t("layoutPaginated") },
      { value: "scroll", label: t("layoutScroll") },
    ],
    local.reader.epub.layout,
    (value) => {
      local.reader.epub.layout = value;
      update({ epub: { layout: value } });
    },
    t("layout"),
  );

  const spreadSelect = select(
    [
      { value: "auto", label: t("spreadAuto") },
      { value: "never", label: t("spreadNever") },
      { value: "always", label: t("spreadAlways") },
    ],
    local.reader.epub.spread,
    (value) => {
      local.reader.epub.spread = value;
      update({ epub: { spread: value } });
    },
    t("spread"),
  );

  const pdfLayoutSelect = select(
    [
      { value: "continuous", label: t("pdfContinuous") },
      { value: "single", label: t("pdfSingle") },
      { value: "spread", label: t("pdfSpread") },
    ],
    local.reader.pdf.layout,
    (value) => {
      local.reader.pdf.layout = value;
      update({ pdf: { layout: value } });
    },
    t("pdfLayout"),
  );

  const backup = el("button", { type: "button", class: "ghost-btn" }, t("backup"));
  backup.addEventListener("click", () => handlers.backup());
  const restore = el("button", { type: "button", class: "ghost-btn" }, t("restore"));
  restore.addEventListener("click", () => handlers.restore());
  const reset = el("button", { type: "button", class: "ghost-btn" }, t("resetView"));
  reset.addEventListener("click", () => handlers.resetView());

  const paths = el(
    "dl",
    { class: "about-list" },
    el("dt", {}, t("version")),
    el("dd", {}, `${info.version} (WebKitGTK ${info.webkitVersion})`),
    el("dt", {}, t("dataFolder")),
    el("dd", { class: "path" }, info.dataDir),
    el("dt", {}, t("cacheFolder")),
    el("dd", { class: "path" }, info.cacheDir),
    el("dt", {}, t("settingsFile")),
    el("dd", { class: "path" }, `${info.configDir}/settings.json`),
    el("dt", {}, "App ID"),
    el("dd", {}, info.appId),
  );

  const body = el(
    "div",
    { class: "settings" },
    el("section", { class: "settings-section" },
      el("h3", {}, t("theme")),
      field(t("theme"), theme),
    ),
    el("section", { class: "settings-section" },
      el("h3", {}, t("performanceMode")),
      el(
        "label",
        { class: "switch-row" },
        performance,
        el("span", {}, t("performanceMode")),
      ),
      el("p", { class: "field-hint" }, t("performanceHint")),
    ),
    el("section", { class: "settings-section" },
      el("h3", {}, t("libraryStorage")),
      storageGroup,
      el("p", { class: "field-hint" }, t("storageHint")),
    ),
    el("section", { class: "settings-section" },
      el("h3", {}, t("readerDefaults")),
      field(t("epubFont"), fontSelect),
      field(
        t("fontSize"),
        range(local.reader.epub.fontSize, 12, 34, 1, (value) => {
          local.reader.epub.fontSize = value;
          update({ epub: { fontSize: value } });
        }, t("fontSize")),
      ),
      field(
        t("lineHeight"),
        range(local.reader.epub.lineHeight, 1.1, 2.4, 0.05, (value) => {
          local.reader.epub.lineHeight = value;
          update({ epub: { lineHeight: value } });
        }, t("lineHeight")),
      ),
      field(
        t("paragraphSpacing"),
        range(local.reader.epub.paragraphSpacing, 0, 2, 0.1, (value) => {
          local.reader.epub.paragraphSpacing = value;
          update({ epub: { paragraphSpacing: value } });
        }, t("paragraphSpacing")),
      ),
      field(
        t("margin"),
        range(local.reader.epub.margin, 16, 160, 4, (value) => {
          local.reader.epub.margin = value;
          update({ epub: { margin: value } });
        }, t("margin")),
      ),
      field(t("alignment"), alignSelect),
      field(t("layout"), layoutSelect),
      field(t("spread"), spreadSelect),
      el(
        "label",
        { class: "switch-row" },
        toggle(
          local.reader.epub.hyphenate,
          (value) => {
            local.reader.epub.hyphenate = value;
            update({ epub: { hyphenate: value } });
          },
          t("hyphenation"),
        ),
        el("span", {}, t("hyphenation")),
      ),
      el(
        "label",
        { class: "switch-row" },
        toggle(
          local.reader.epub.publisherStyles,
          (value) => {
            local.reader.epub.publisherStyles = value;
            update({ epub: { publisherStyles: value } });
          },
          t("publisherStyles"),
        ),
        el("span", {}, t("publisherStyles")),
      ),
      field(t("pdfLayout"), pdfLayoutSelect),
      el(
        "label",
        { class: "switch-row" },
        toggle(
          local.reader.pdf.nightMode,
          (value) => {
            local.reader.pdf.nightMode = value;
            update({ pdf: { nightMode: value } });
          },
          t("pdfNight"),
        ),
        el("span", {}, t("pdfNight")),
      ),
    ),
    el("section", { class: "settings-section" },
      el("h3", {}, t("resetView")),
      el("p", { class: "field-hint" }, t("resetViewHint")),
      el("div", { class: "button-row" }, reset, backup, restore),
      el("p", { class: "field-hint" }, t("backupHint")),
    ),
    el("section", { class: "settings-section" },
      el("h3", {}, t("about")),
      el("p", { class: "modal-text" }, t("aboutBody", { version: info.version })),
      paths,
    ),
  );

  const done = el("button", { type: "button", class: "primary-btn" }, t("done"));
  const handle = openModal({ title: t("settings"), body, actions: [done] });
  done.addEventListener("click", () => handle.close());
}

export function pickSortLabel(sort: SortKey): string {
  return (
    {
      manual: t("sortManual"),
      title: t("sortTitle"),
      author: t("sortAuthor"),
      added: t("sortAdded"),
      lastOpened: t("sortLastOpened"),
      status: t("sortStatus"),
    }[sort] ?? t("sortManual")
  );
}
