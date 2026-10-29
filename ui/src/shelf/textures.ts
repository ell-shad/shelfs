import * as THREE from "three";
import type { Book } from "../lib/api";
import { contrastText, isRtl, shade } from "../lib/format";
import { SHELF_FONT_STACK } from "../lib/fonts";

/** Pixels per scene unit for generated spine art (spec: ~300 px/unit). */
const SPINE_TILE_W = 160;
const SPINE_TILE_H = 640;
const GOLD = "#c9a227";
const GREEN = "#57a06b";
const AMBER = "#dd9e3c";

export function makeWoodTexture(dark = false): THREE.CanvasTexture {
  const w = 512;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const base = dark ? "#4a3324" : "#7b5334";
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Grain: long, slightly wavy dark lines.
  let seed = dark ? 17 : 3;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 240; i++) {
    const y = rand() * h;
    const alpha = 0.03 + rand() * 0.09;
    ctx.strokeStyle = `rgba(30, 18, 10, ${alpha})`;
    ctx.lineWidth = 0.5 + rand() * 2.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    const wobble = 2 + rand() * 10;
    for (let x = 0; x <= w; x += 16) {
      ctx.lineTo(x, y + Math.sin((x / w) * Math.PI * (2 + rand() * 3)) * wobble);
    }
    ctx.stroke();
  }
  // Knots.
  for (let i = 0; i < 4; i++) {
    const cx = rand() * w;
    const cy = rand() * h;
    for (let r = 2; r < 14; r += 2.5) {
      ctx.strokeStyle = `rgba(35, 20, 11, ${0.16 - r * 0.008})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 1.8, r, 0.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // Warm highlight across the middle.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(255, 226, 178, 0.10)");
  grad.addColorStop(0.5, "rgba(255, 226, 178, 0.02)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0.16)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function font(size: number, weight = 700, italic = false): string {
  return `${italic ? "italic " : ""}${weight} ${size}px ${SHELF_FONT_STACK}`;
}

/** Break a line to fit maxWidth, char-by-char so CJK without spaces works. */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const lines: string[] = [];
  let current = "";
  const pushLine = (line: string) => {
    if (lines.length === 0 || lines.length < maxLines) lines.push(line);
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) pushLine(current);
    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
      continue;
    }
    // Long unbroken word: cut by characters.
    let chunk = "";
    for (const ch of word) {
      if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
        pushLine(chunk);
        chunk = "";
      }
      chunk += ch;
    }
    current = chunk;
  }
  if (current) pushLine(current);
  const limited = lines.slice(0, maxLines);
  if (limited.length) {
    let last = limited[limited.length - 1]!;
    if (ctx.measureText(last).width > maxWidth) {
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
        last = last.slice(0, -1);
      }
      limited[limited.length - 1] = `${last}…`;
    }
  }
  return limited;
}

export function drawSpineTexture(book: Book): HTMLCanvasElement {
  const w = SPINE_TILE_W;
  const h = SPINE_TILE_H;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const base = /^#[0-9a-f]{6}$/i.test(book.color) ? book.color : "#6b4f3a";
  const text = contrastText(base);

  // Horizontal shading gradient (darker at the board edges).
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, shade(base, -0.34));
  grad.addColorStop(0.16, base);
  grad.addColorStop(0.5, shade(base, 0.1));
  grad.addColorStop(0.86, base);
  grad.addColorStop(1, shade(base, -0.4));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Vertical darkening at head and tail.
  const vgrad = ctx.createLinearGradient(0, 0, 0, h);
  vgrad.addColorStop(0, "rgba(0,0,0,0.22)");
  vgrad.addColorStop(0.08, "rgba(0,0,0,0)");
  vgrad.addColorStop(0.9, "rgba(0,0,0,0)");
  vgrad.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = vgrad;
  ctx.fillRect(0, 0, w, h);

  // Grain across the spine.
  ctx.save();
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = i % 2 ? "#000" : "#fff";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    const y = (i / 40) * h + Math.sin(i) * 2;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + Math.sin(i * 1.7) * 3);
    ctx.stroke();
  }
  ctx.restore();

  // Gold bands near head and tail.
  ctx.fillStyle = GOLD;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(w * 0.14, h * 0.085, w * 0.72, 1.6);
  ctx.fillRect(w * 0.14, h * 0.105, w * 0.72, 3.2);
  ctx.fillRect(w * 0.14, h * 0.13, w * 0.72, 1.2);
  ctx.fillRect(w * 0.14, h * 0.86, w * 0.72, 1.2);
  ctx.fillRect(w * 0.14, h * 0.884, w * 0.72, 3.2);
  ctx.fillRect(w * 0.14, h * 0.906, w * 0.72, 1.6);
  ctx.globalAlpha = 1;

  // Title, running top-to-bottom along the spine.
  const rtl = isRtl(book.title);
  ctx.fillStyle = text;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rtl ? Math.PI / 2 : -Math.PI / 2);
  const titleSize = Math.min(30, Math.max(18, Math.round(w * 0.19)));
  ctx.font = font(titleSize, 700);
  const titleWidth = h * 0.66;
  const lines = fitText(ctx, book.title || "Untitled", titleWidth, 2);
  const lineHeight = titleSize * 1.15;
  const startY = -((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, startY + i * lineHeight);
  });

  // Author, small italic at the tail end.
  if (book.author.trim()) {
    ctx.fillStyle = text;
    ctx.globalAlpha = 0.82;
    ctx.font = font(Math.max(11, Math.round(w * 0.085)), 450, true);
    ctx.textAlign = rtl ? "left" : "right";
    const authorText = fitText(ctx, book.author, h * 0.22, 1)[0] ?? "";
    ctx.fillText(authorText, rtl ? -titleWidth / 2 - 14 : titleWidth / 2 + 14, 0);
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // Reading status dot near the bottom.
  const dotY = h * 0.935;
  if (book.status === "read" || book.status === "reading") {
    ctx.beginPath();
    ctx.arc(w / 2, dotY, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = book.status === "read" ? GREEN : AMBER;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Progress hairline along the tail.
  if (book.progress > 0.001) {
    ctx.fillStyle = GOLD;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(w * 0.14, h - 7, w * 0.72 * Math.min(1, book.progress), 2.5);
    ctx.globalAlpha = 1;
  }

  if (book.missing) {
    ctx.fillStyle = "rgba(20, 20, 20, 0.45)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255, 220, 150, 0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2 - 26);
    ctx.lineTo(w / 2, h / 2 + 8);
    ctx.moveTo(w / 2, h / 2 + 22);
    ctx.lineTo(w / 2, h / 2 + 24);
    ctx.stroke();
  }
  return canvas;
}

export function drawCoverTexture(book: Book): HTMLCanvasElement {
  const w = 512;
  const h = 768;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const base = /^#[0-9a-f]{6}$/i.test(book.color) ? book.color : "#6b4f3a";
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, shade(base, 0.18));
  grad.addColorStop(0.55, base);
  grad.addColorStop(1, shade(base, -0.32));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Subtle paper texture.
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = i % 2 ? "#fff" : "#000";
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  ctx.globalAlpha = 1;

  // Double gold frame.
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.strokeRect(28, 28, w - 56, h - 56);
  ctx.lineWidth = 1;
  ctx.strokeRect(38, 38, w - 76, h - 76);

  const text = contrastText(base);
  ctx.fillStyle = text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = font(46, 700);
  const lines = fitText(ctx, book.title || "Untitled", w - 140, 5);
  const lineHeight = 56;
  const blockStart = h * 0.36 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, blockStart + i * lineHeight);
  });

  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(w / 2 - 34, blockStart + lines.length * lineHeight * 0.7);
  ctx.lineTo(w / 2 + 34, blockStart + lines.length * lineHeight * 0.7);
  ctx.stroke();

  if (book.author.trim()) {
    ctx.font = font(28, 400, true);
    ctx.globalAlpha = 0.86;
    const author = fitText(ctx, book.author, w - 150, 2);
    author.forEach((line, i) => {
      ctx.fillText(line, w / 2, h * 0.72 + i * 34);
    });
    ctx.globalAlpha = 1;
  }
  return canvas;
}

/** Canvas tint preview for the colour picker. */
export function spinePreviewCanvas(book: Book, width = 40, height = 140): HTMLCanvasElement {
  const source = drawSpineTexture(book);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

export function textureFromCanvas(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** LRU of per-book spine textures; off-screen spines are disposed. */
export class SpineCache {
  private entries = new Map<number, { texture: THREE.CanvasTexture; stamp: number; version: string }>();
  private tick = 0;

  constructor(private readonly max = 220) {}

  get(book: Book): THREE.CanvasTexture {
    this.tick += 1;
    const version = `${book.title}|${book.author}|${book.color}|${book.status}|${book.progress}|${book.missing}`;
    const existing = this.entries.get(book.id);
    if (existing && existing.version === version) {
      existing.stamp = this.tick;
      return existing.texture;
    }
    existing?.texture.dispose();
    const texture = textureFromCanvas(drawSpineTexture(book));
    this.entries.set(book.id, { texture, stamp: this.tick, version });
    this.evict();
    return texture;
  }

  private evict(): void {
    if (this.entries.size <= this.max) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].stamp - b[1].stamp);
    const excess = this.entries.size - this.max;
    for (let i = 0; i < excess; i++) {
      const entry = sorted[i];
      if (!entry) break;
      entry[1].texture.dispose();
      this.entries.delete(entry[0]);
    }
  }

  dispose(): void {
    for (const { texture } of this.entries.values()) texture.dispose();
    this.entries.clear();
  }
}

export function coverTexture(book: Book): THREE.CanvasTexture {
  return textureFromCanvas(drawCoverTexture(book));
}

export { SPINE_TILE_H, SPINE_TILE_W };
