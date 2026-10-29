// Robust text anchors for highlights: character offsets plus a quote with
// prefix/suffix context, so a highlight survives reflow, font changes and
// re-pagination. Offsets are UTF-16 code units, matching JS string indices.

export interface AnchorData {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface TextIndex {
  text: string;
  nodes: { node: Text; start: number; end: number }[];
}

/** Collect all text under a root, skipping script/style, like the reader sees it. */
export function buildTextIndex(root: Node): TextIndex {
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, svg")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current: Node | null = walker.nextNode();
  while (current) {
    const data = current.nodeValue ?? "";
    if (data.length) {
      nodes.push({ node: current as Text, start: text.length, end: text.length + data.length });
      text += data;
    }
    current = walker.nextNode();
  }
  return { text, nodes };
}

export function offsetOf(index: TextIndex, node: Node, offset: number): number {
  for (const entry of index.nodes) {
    if (entry.node === node) return entry.start + offset;
  }
  return 0;
}

export function rangeToOffsets(index: TextIndex, range: Range): { start: number; end: number } | null {
  if (!index.nodes.some((n) => n.node === range.startContainer)) return null;
  const start = offsetOf(index, range.startContainer, range.startOffset);
  const end = offsetOf(index, range.endContainer, range.endOffset);
  if (end <= start) return null;
  return { start, end };
}

export function offsetsToRange(index: TextIndex, start: number, end: number): Range | null {
  if (start < 0 || end > index.text.length || end <= start) return null;
  const range = document.createRange();
  let startSet = false;
  for (const entry of index.nodes) {
    if (!startSet && start >= entry.start && start <= entry.end) {
      range.setStart(entry.node, Math.min(entry.node.length, start - entry.start));
      startSet = true;
    }
    if (startSet && end >= entry.start && end <= entry.end) {
      range.setEnd(entry.node, Math.min(entry.node.length, end - entry.start));
      return range;
    }
  }
  return null;
}

export function rangesFor(
  index: TextIndex,
  start: number,
  end: number,
): Range[] {
  const range = offsetsToRange(index, start, end);
  return range ? [range] : [];
}

export function anchorFromRange(
  index: TextIndex,
  range: Range,
  context = 32,
): AnchorData | null {
  const offsets = rangeToOffsets(index, range);
  if (!offsets) return null;
  const { text } = index;
  const quote = text.slice(offsets.start, offsets.end);
  if (!quote.trim()) return null;
  return {
    quote,
    prefix: text.slice(Math.max(0, offsets.start - context), offsets.start),
    suffix: text.slice(offsets.end, Math.min(text.length, offsets.end + context)),
    start: offsets.start,
    end: offsets.end,
  };
}

/**
 * Locate an anchor in fresh text. Prefers the stored offsets; falls back to the
 * quote plus context, then to the first occurrence of the quote.
 */
export function resolveAnchor(text: string, anchor: AnchorData): { start: number; end: number } | null {
  const { quote, start, end } = anchor;
  if (!quote) return null;
  if (
    start >= 0 &&
    end <= text.length &&
    end > start &&
    text.slice(start, end) === quote
  ) {
    return { start, end };
  }
  const matches: number[] = [];
  let from = 0;
  while (matches.length < 200) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    matches.push(at);
    from = at + 1;
  }
  if (matches.length === 0) {
    const loose = text.toLowerCase().indexOf(quote.toLowerCase());
    return loose < 0 ? null : { start: loose, end: loose + quote.length };
  }
  const score = (at: number) => {
    let value = Math.abs(at - start) / Math.max(1, text.length);
    if (anchor.prefix && text.slice(Math.max(0, at - anchor.prefix.length), at) !== anchor.prefix) {
      value += 0.35;
    }
    const after = at + quote.length;
    if (anchor.suffix && text.slice(after, after + anchor.suffix.length) !== anchor.suffix) {
      value += 0.35;
    }
    return value;
  };
  matches.sort((a, b) => score(a) - score(b));
  const best = matches[0]!;
  return { start: best, end: best + quote.length };
}

/** Map a plain-text offset (from Rust search) to a DOM offset using the query. */
export function locateQueryNear(
  text: string,
  query: string,
  approximateStart: number,
): { start: number; end: number } | null {
  const needle = query.trim();
  if (!needle) return null;
  const lower = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let from = 0;
  while (true) {
    const at = lower.indexOf(lowerNeedle, from);
    if (at < 0) break;
    const score = Math.abs(at - approximateStart);
    if (score < bestScore) {
      best = at;
      bestScore = score;
    }
    from = at + lowerNeedle.length;
  }
  return best < 0 ? null : { start: best, end: best + needle.length };
}
