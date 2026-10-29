export type AttrValue = string | number | boolean | undefined | null | Record<string, string | number | boolean>;

export interface Attrs {
  class?: string;
  dataset?: Record<string, string | number | boolean>;
  style?: Record<string, string>;
  [key: string]: AttrValue;
}

function scalar(value: AttrValue): string {
  return typeof value === "object" ? "" : String(value);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      node.className = scalar(value);
    } else if (key === "dataset") {
      for (const [k, v] of Object.entries(value as Record<string, string | number | boolean>)) {
        node.dataset[k] = String(v);
      }
    } else if (key === "style") {
      for (const [k, v] of Object.entries(value as Record<string, string>)) {
        node.style.setProperty(k, v);
      }
    } else if (key === "html") {
      node.innerHTML = scalar(value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else if (typeof value === "string" || typeof value === "number") {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function svgIcon(path: string, size = 18): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

export const icons = {
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm10 18-5-5",
  plus: "M12 5v14M5 12h14",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  close: "M6 6l12 12M18 6L6 18",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 0-.13-1.4l2-1.55-2-3.46-2.37.95a8 8 0 0 0-2.42-1.4L14.7 2h-4l-.38 2.54a8 8 0 0 0-2.42 1.4L5.53 5l-2 3.46 2 1.55a8 8 0 0 0 0 2.8l-2 1.55 2 3.46 2.37-.95a8 8 0 0 0 2.42 1.4L10.7 22h4l.38-2.54a8 8 0 0 0 2.42-1.4l2.37.95 2-3.46-2-1.55c.09-.46.13-.93.13-1.4Z",
  list: "M4 6h16M4 12h16M4 18h16",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13Z M4 18.5A2.5 2.5 0 0 1 6.5 16H20",
  toc: "M4 6h16M4 12h10M4 18h13",
  bookmark: "M6 3h12v18l-6-4-6 4V3Z",
  edit: "M4 20h4l10-10-4-4L4 16v4Zm10-14 4 4",
  trash: "M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13",
  sun: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.42-1.42M4.92 19.08l1.42-1.42m0-11.32L4.92 4.92m14.16 14.16-1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z",
  note: "M5 4h9l5 5v11H5V4Zm9 0v5h5",
  expand: "M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5",
  external: "M14 4h6v6M20 4l-8 8M18 14v5H5V6h5",
  info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  highlight: "M5 16l6-6 4 4-6 6H5v-4Zm8-8 3-3 4 4-3 3",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 20h16",
  upload: "M12 21V9m0 0 4 4M12 9 8 13M4 4h16",
  warning: "M12 3 2 21h20L12 3Zm0 6v6m0 3h.01",
  check: "M4 12.5 9 18 20 6",
  clock: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  chevron: "M6 9l6 6 6-6",
  layers: "M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5",
  link: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1m-1 6a5 5 0 0 1-7 0 5 5 0 0 1 0-7l2-2a5 5 0 0 1 7 0",
} as const;
