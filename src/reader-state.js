const SAVE_REASONS = new Set(["close", "chapter", "view-close", "unload"]);

export function normalizeEpubPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

export function locationTargetFromPosition(current, total, direction, position) {
  const last = Math.max(0, Math.round(Number(total) || 0) - 1);
  const index = Math.max(0, Math.min(last, Math.round(Number(current) || 0)));
  const ratio = Math.max(0, Math.min(1, Number(position) || 0));
  const depth = ratio >= 0.95 ? 1 : ratio;
  const available = direction === "previous" ? index : last - index;
  if (available < 1) return index;
  const distance = Math.max(1, Math.round(available * depth));
  return direction === "previous"
    ? Math.max(0, index - distance)
    : Math.min(last, index + distance);
}

export function stackWidthsFromProgress(percentage, totalWidth = 14) {
  const progress = Math.max(0, Math.min(1, Number(percentage) || 0));
  const width = Math.max(0, Number(totalWidth) || 0);
  return {
    left: width * progress,
    right: width * (1 - progress)
  };
}

export function startsFirstSpread(location) {
  return Number(location?.start?.displayed?.page) === 1;
}

export function normalizeLastSpread(location) {
  const startTotal = Number(location?.start?.displayed?.total);
  const endTotal = Number(location?.end?.displayed?.total);
  const total = Math.max(startTotal || 0, endTotal || 0);
  if (!location?.start || !location?.end || total < 1) return location;
  return {
    ...location,
    start: {
      ...location.start,
      displayed: {
        ...location.start.displayed,
        page: Math.max(1, total - 1),
        total
      }
    },
    end: {
      ...location.end,
      displayed: {
        ...location.end.displayed,
        page: total,
        total
      }
    }
  };
}

export function shouldPersistProgress(reason) {
  return SAVE_REASONS.has(reason);
}

export function resolveSpineTarget(href, spineItems = []) {
  const [rawPath, fragment = ""] = String(href || "").split("#", 2);
  const normalize = (value) => {
    try {
      return decodeURIComponent(String(value || ""))
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "");
    } catch {
      return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    }
  };
  const wanted = normalize(rawPath);
  const section = spineItems.find((item) => {
    const candidate = normalize(item?.href);
    return candidate === wanted || candidate.endsWith(`/${wanted}`) || wanted.endsWith(`/${candidate}`);
  });
  return section?.href
    ? `${section.href}${fragment ? `#${fragment}` : ""}`
    : href;
}

export function globalPageRange(location, locations, pagination = null) {
  const total = Number(locations?.length?.());
  const indexFromCfi = (cfi) => {
    const index = Number(cfi ? locations?.locationFromCfi?.(cfi) : NaN);
    return Number.isFinite(index) && index >= 0 ? index : null;
  };
  const startIndex = indexFromCfi(location?.start?.cfi);
  const endIndex = indexFromCfi(location?.end?.cfi);
  const approximateRange = () => {
    if (!Number.isFinite(total) || total < 1 || startIndex === null) return null;
    const start = Math.min(total, startIndex + 1);
    const end = Math.min(total, Math.max(start + 1, (endIndex ?? startIndex) + 1));
    return { start, end, total };
  };
  const startSection = Number(location?.start?.index);
  const endSection = Number(location?.end?.index);
  const startLocal = Number(location?.start?.displayed?.page);
  const endLocal = Number(location?.end?.displayed?.page);
  if (
    !pagination?.offsets
    || !pagination?.totals
    || !Number.isFinite(startSection)
    || !Number.isFinite(endSection)
    || !Number.isFinite(startLocal)
    || !Number.isFinite(endLocal)
  ) {
    return approximateRange();
  }

  const rememberTotal = (point) => {
    const section = Number(point?.index);
    const sectionTotal = Number(point?.displayed?.total);
    if (Number.isFinite(section) && Number.isFinite(sectionTotal) && sectionTotal > 0) {
      const previousTotal = pagination.totals.get(section);
      pagination.totals.set(section, sectionTotal);
      if (Number.isFinite(previousTotal) && previousTotal !== sectionTotal) {
        for (const offsetSection of pagination.offsets.keys()) {
          if (offsetSection > section) {
            pagination.offsets.delete(offsetSection);
            pagination.estimatedOffsets?.delete(offsetSection);
          }
        }
      }
    }
  };
  rememberTotal(location.start);
  rememberTotal(location.end);

  const resolveOffset = (section, localPage, approximateIndex) => {
    const previousOffsetKnown = pagination.offsets.has(section - 1)
      && pagination.totals.has(section - 1);
    if (
      pagination.offsets.has(section)
      && (!pagination.estimatedOffsets?.has(section) || !previousOffsetKnown)
    ) {
      return pagination.offsets.get(section);
    }
    let offset = null;
    let estimated = false;
    if (section === 0) {
      offset = 0;
    } else if (previousOffsetKnown) {
      offset = pagination.offsets.get(section - 1) + pagination.totals.get(section - 1);
    } else if (approximateIndex !== null) {
      offset = Math.max(0, approximateIndex + 1 - localPage);
      estimated = true;
    }
    if (offset === null) return null;
    pagination.offsets.set(section, offset);
    if (estimated) {
      pagination.estimatedOffsets?.add(section);
    } else {
      pagination.estimatedOffsets?.delete(section);
    }
    return offset;
  };

  const startOffset = resolveOffset(startSection, startLocal, startIndex);
  const endOffset = resolveOffset(endSection, endLocal, endIndex);
  if (startOffset === null || endOffset === null) return approximateRange();
  const start = Math.max(1, startOffset + startLocal);
  const end = Math.max(start + 1, endOffset + endLocal);
  const knownLastSection = Number(pagination.spineLength) - 1;
  const exactTotal = pagination.offsets.has(knownLastSection)
    && !pagination.estimatedOffsets?.has(knownLastSection)
    && pagination.totals.has(knownLastSection)
    ? pagination.offsets.get(knownLastSection) + pagination.totals.get(knownLastSection)
    : null;
  const wholeBookTotal = Number.isFinite(exactTotal)
    ? exactTotal
    : Number.isFinite(total) && total > 0
      ? Math.max(total, end)
      : end;
  return { start, end, total: wholeBookTotal };
}

export function upsertAnnotation(annotations, annotation) {
  const current = Array.isArray(annotations) ? annotations : [];
  if (!annotation?.id || !annotation?.cfiRange) return current;
  return [
    ...current.filter((item) =>
      item?.id !== annotation.id && item?.cfiRange !== annotation.cfiRange
    ),
    annotation
  ];
}

export function removeAnnotationById(annotations, id) {
  return (Array.isArray(annotations) ? annotations : [])
    .filter((annotation) => annotation?.id !== id);
}

export function fingerprintEpub(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source || 0);
  let hash = 0x811c9dc5;
  const sampleSize = Math.min(65536, bytes.length);
  const update = (start, length) => {
    for (let index = start; index < start + length; index++) {
      hash ^= bytes[index];
      hash = Math.imul(hash, 0x01000193);
    }
  };
  update(0, sampleSize);
  if (bytes.length > sampleSize) update(bytes.length - sampleSize, sampleSize);
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}:${bytes.length}`;
}

export class FlipQueue {
  constructor(executor) {
    this.executor = executor;
    this.pending = Promise.resolve();
  }

  enqueue(direction, pages = 1) {
    const request = {
      direction: direction === "previous" ? "previous" : "next",
      pages: Math.max(1, Math.round(Number(pages) || 1))
    };
    this.pending = this.pending.then(() => this.executor(request));
    return this.pending;
  }

  whenIdle() {
    return this.pending;
  }
}
