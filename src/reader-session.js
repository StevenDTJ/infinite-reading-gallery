import ePub from "epubjs";
import { TFile } from "obsidian";
import {
  fingerprintEpub,
  FlipQueue,
  globalPageRange,
  locationTargetFromPosition,
  normalizeLastSpread,
  normalizeEpubPath,
  resolveSpineTarget,
  startsFirstSpread
} from "./reader-state.js";
import { createReaderShell } from "./reader-shell.js";

export class ReaderSession {
  constructor(plugin, options) {
    this.plugin = plugin;
    this.path = normalizeEpubPath(options.path);
    this.host = options.host;
    this.onClose = options.onClose;
    this.currentCfi = null;
    this.currentChapter = "";
    this.percentage = 0;
    this.annotations = [];
    this.annotationHandles = new Map();
    this.footnoteDocuments = new WeakSet();
    this.pagination = {
      offsets: new Map(),
      totals: new Map(),
      estimatedOffsets: new Set(),
      spineLength: 0
    };
    this.flipQueue = new FlipQueue((request) => this.performFlip(request));
  }

  async open() {
    this.shell = createReaderShell(this.host, {
      close: () => this.plugin.closeEmbedded("close"),
      flip: (direction, pages) => this.flipQueue.enqueue(direction, pages),
      stack: (direction, position) => this.jumpByStackPosition(direction, position),
      chapter: (href) => this.openChapter(href),
      footnoteAtPoint: (clientX, clientY) => this.showFootnoteAtPoint(clientX, clientY)
    });

    try {
      const file = this.plugin.app.vault.getAbstractFileByPath(this.path);
      if (!(file instanceof TFile)) throw new Error("EPUB 文件不存在。");
      const archive = await this.plugin.app.vault.adapter.readBinary(this.path);
      this.identity = {
        size: file.stat.size,
        fingerprint: fingerprintEpub(archive)
      };
      this.book = ePub(archive);
      await this.book.ready;
      this.pagination.spineLength = this.book.spine?.spineItems?.length || 0;
      const metadata = this.book.packaging?.metadata || this.book.package?.metadata || {};
      this.shell.setFixedLayout(metadata.layout === "pre-paginated");
      const navigation = await this.book.loaded.navigation;
      this.navigation = navigation;
      this.shell.renderToc(navigation?.toc || []);

      this.rendition = this.book.renderTo(this.shell.renditionHost, {
        width: "100%",
        height: "100%",
        flow: "paginated",
        spread: "always",
        minSpreadWidth: 0,
        allowScriptedContent: false
      });
      this.rendition.themes.default({
        body: {
          color: "#20262a !important",
          background: "#f5f2ea !important",
          "font-family": "\"Constructivist Literata\", \"Constructivist WenKai\", \"Noto Serif SC\", serif !important",
          "font-optical-sizing": "auto !important",
          "line-height": "1.65 !important",
          margin: "0 !important",
          padding: "0 3% !important"
        },
        img: {
          "max-width": "100% !important",
          "max-height": "92% !important",
          "object-fit": "contain !important"
        },
        a: {
          color: "#9f3733 !important"
        },
        p: {
          "text-indent": "2em !important"
        },
        "::selection": {
          color: "inherit !important",
          background: "rgba(191, 79, 72, 0.22) !important"
        },
        "aside[epub\\:type~='footnote'], aside[role='doc-footnote'], aside[id^='footnote-'], .duokan-footnote-content#duokan-footnote, .duokan-footnote-content:has(> .duokan-footnote-item)": {
          display: "none !important"
        },
        "a[epub\\:type~='noteref'], a[role='doc-noteref']": {
          cursor: "pointer !important"
        },
        "img.epub-footnote, img.epub-footnote1, a[epub\\:type~='noteref'] img, a[role='doc-noteref'] img": {
          width: "1.08em !important",
          height: "1.08em !important",
          "max-width": "1.08em !important",
          "max-height": "1.08em !important",
          "object-fit": "contain !important",
          display: "inline-block !important",
          "vertical-align": "super !important",
          margin: "0 0.08em !important"
        },
        "img.constructivist-reader-decorative-icon": {
          width: "0.82em !important",
          height: "0.82em !important",
          "max-width": "0.82em !important",
          "max-height": "0.82em !important",
          "object-fit": "contain !important",
          display: "inline-block !important",
          "vertical-align": "middle !important",
          margin: "0 0.08em !important"
        }
      });
      this.annotations = this.plugin.getAnnotations(this.path);
      for (const annotation of this.annotations) this.renderAnnotation(annotation);
      this.bindAnnotationInput();
      this.rendition.on("resized", () => this.resetPagination());
      this.rendition.on("rendered", (_section, view) => this.bindReaderInputFrames(view));
      this.rendition.on("relocated", (location) => this.handleRelocated(location));
      const saved = this.plugin.resolveProgress(this.path, this.identity);
      if (Number.isFinite(saved?.percentage)) {
        this.percentage = Math.max(0, Math.min(1, saved.percentage));
      } else if (saved?.cfi) {
        const savedSection = this.book.spine?.get?.(saved.cfi);
        const spineLength = this.book.spine?.spineItems?.length || 1;
        this.percentage = savedSection
          ? savedSection.index / Math.max(1, spineLength - 1)
          : 0;
      }
      if (saved?.cfi) {
        this.shell.setPosition(this.currentChapter, this.percentage);
      }
      await this.rendition.display(saved?.cfi || undefined);
      this.bindReaderInputFrames();
      this.shell.setReady();
      void this.ensureLocations();
      return this;
    } catch (error) {
      console.error(`Unable to open EPUB: ${this.path}`, error);
      this.shell.showError(error?.message || "EPUB 文件可能已损坏或加密。");
      return this;
    }
  }

  async generateLocations() {
    try {
      await this.book.locations.generate(1200);
      if (this.currentCfi) {
        this.percentage = this.book.locations.percentageFromCfi(this.currentCfi) || 0;
        this.shell.setPosition(this.currentChapter, this.percentage);
        this.updatePageNumbers(this.currentLocation);
      }
    } catch (error) {
      console.warn("Unable to generate EPUB locations.", error);
    }
  }

  ensureLocations() {
    if (!this.locationsPromise) this.locationsPromise = this.generateLocations();
    return this.locationsPromise;
  }

  handleRelocated(location) {
    if (this.relocationSuspended) {
      this.pendingRelocation = location;
      return;
    }
    this.shell?.hideFootnote?.();
    this.currentLocation = location;
    const start = location?.start;
    this.currentCfi = start?.cfi || this.currentCfi;
    this.currentChapter = start?.displayed?.page
      ? `${start.href || "章节"} · ${start.displayed.page}/${start.displayed.total}`
      : start?.href || "未命名章节";
    if (this.book?.locations?.length?.() && this.currentCfi) {
      this.percentage = this.book.locations.percentageFromCfi(this.currentCfi) || 0;
    } else if (Number.isFinite(start?.percentage)) {
      this.percentage = start.percentage;
    }
    this.plugin.updateMemoryProgress(this.path, this.currentCfi, this.identity, this.percentage);
    this.shell.setPosition(this.currentChapter, this.percentage);
    this.updatePageNumbers(location);
    this.shell.setBounds(Boolean(location?.atStart), Boolean(location?.atEnd));
  }

  updatePageNumbers(location) {
    const range = globalPageRange(location, this.book?.locations, this.pagination);
    this.shell.setPageNumbers(range?.start, range?.end, range?.total);
  }

  resetPagination() {
    this.pagination.offsets.clear();
    this.pagination.totals.clear();
    this.pagination.estimatedOffsets.clear();
  }

  bindReaderInputFrames(renderedView = null) {
    const bindView = (view) => {
      this.shell?.bindContentWindow?.(view?.iframe?.contentWindow);
      const doc = view?.iframe?.contentDocument;
      this.bindFootnoteInput(doc);
      this.classifyReaderImages(doc);
    };
    if (renderedView) bindView(renderedView);
    const viewCollection = this.rendition?.views?.();
    const views = typeof viewCollection?.all === "function"
      ? viewCollection.all()
      : Array.isArray(viewCollection)
        ? viewCollection
        : [];
    for (const view of views) bindView(view);
  }

  classifyReaderImages(doc) {
    if (!doc) return;
    const classify = (image) => {
      if (!(image instanceof doc.defaultView.HTMLImageElement)) return;
      if (image.getAttribute("zy-footnote")) return;
      if (image.closest("a[epub\\:type~='noteref'], a[role='doc-noteref']")) return;
      const width = image.naturalWidth || 0;
      const height = image.naturalHeight || 0;
      if (!width || !height) return;
      const hasAlt = Boolean((image.getAttribute("alt") || "").trim());
      if (!hasAlt && width <= 96 && height <= 96) {
        image.classList.add("constructivist-reader-decorative-icon");
      }
    };
    for (const image of doc.querySelectorAll("img")) {
      classify(image);
      if (!image.complete) image.addEventListener("load", () => classify(image), { once: true });
    }
  }

  bindFootnoteInput(doc) {
    if (!doc || this.footnoteDocuments.has(doc)) return;
    this.footnoteDocuments.add(doc);
    doc.addEventListener("click", (event) => {
      const anchor = event.target?.closest?.("a[href], a[epub\\:type~='noteref'], a[role='doc-noteref']");
      const image = event.target?.closest?.("img[zy-footnote], img[alt]");
      if (!anchor && !image) return;
      const footnoteAnchor = anchor && this.isFootnoteReference(anchor) ? anchor : null;
      const text = footnoteAnchor ? this.footnoteTextForAnchor(doc, footnoteAnchor) : this.footnoteTextForImage(image);
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      this.shell?.showFootnote?.(footnoteAnchor?.textContent?.trim(), text);
    }, true);
  }

  showFootnoteAtPoint(clientX, clientY) {
    const point = this.contentPoint(clientX, clientY);
    const hit = point?.doc?.elementFromPoint?.(point.x, point.y);
    const anchor = hit?.closest?.("a[href], a[epub\\:type~='noteref'], a[role='doc-noteref']");
    const image = hit?.closest?.("img[zy-footnote], img[alt]");
    if (!anchor && !image) return false;
    const footnoteAnchor = anchor && this.isFootnoteReference(anchor) ? anchor : null;
    const text = footnoteAnchor ? this.footnoteTextForAnchor(point.doc, footnoteAnchor) : this.footnoteTextForImage(image);
    if (!text) return false;
    this.shell?.showFootnote?.(footnoteAnchor?.textContent?.trim(), text);
    return true;
  }

  isFootnoteReference(anchor) {
    const epubType = anchor.getAttribute("epub:type") || "";
    const role = anchor.getAttribute("role") || "";
    const href = anchor.getAttribute("href") || "";
    if (/\bnote(ref)?\b/i.test(epubType) || role === "doc-noteref") return true;
    return /#(?:footnote|fn|note)[-_]?\w*/i.test(href);
  }

  footnoteTextForAnchor(doc, anchor) {
    const href = anchor.getAttribute("href") || "";
    const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
    let target = null;
    if (hash) {
      try {
        target = doc.getElementById(decodeURIComponent(hash));
      } catch {
        target = doc.getElementById(hash);
      }
    }
    const targetText = target?.textContent?.replace(/\s+/g, " ").trim();
    if (targetText) return targetText;
    const image = anchor.querySelector("img[zy-footnote], img[alt]");
    return this.footnoteTextForImage(image);
  }

  footnoteTextForImage(image) {
    return image?.getAttribute("zy-footnote") || image?.getAttribute("alt") || "";
  }

  bindAnnotationInput() {
    const pages = this.shell?.pages;
    if (!pages) return;
    pages.addEventListener("pointerdown", (event) => this.handleAnnotationPointerDown(event));
    pages.addEventListener("pointermove", (event) => this.handleAnnotationPointerMove(event));
    pages.addEventListener("pointerup", (event) => this.handleAnnotationPointerUp(event));
    pages.addEventListener("pointercancel", () => this.cancelAnnotationDrag());
    pages.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  contentPoint(clientX, clientY) {
    const viewCollection = this.rendition?.views?.();
    const views = typeof viewCollection?.all === "function"
      ? viewCollection.all()
      : Array.isArray(viewCollection)
        ? viewCollection
        : [];
    for (const view of views) {
      const iframe = view?.iframe;
      const contents = view?.contents;
      if (!iframe || !contents?.document) continue;
      const box = iframe.getBoundingClientRect();
      if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) continue;
      const doc = contents.document;
      const width = doc.documentElement?.clientWidth || box.width;
      const height = doc.documentElement?.clientHeight || box.height;
      return {
        contents,
        doc,
        x: (clientX - box.left) * width / Math.max(1, box.width),
        y: (clientY - box.top) * height / Math.max(1, box.height)
      };
    }
    return null;
  }

  caretRangeAt(point) {
    if (!point) return null;
    if (typeof point.doc.caretRangeFromPoint === "function") {
      return point.doc.caretRangeFromPoint(point.x, point.y);
    }
    const position = point.doc.caretPositionFromPoint?.(point.x, point.y);
    if (!position) return null;
    const range = point.doc.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }

  selectionRange(anchor, focus) {
    if (!anchor || !focus || anchor.startContainer.ownerDocument !== focus.startContainer.ownerDocument) return null;
    const doc = anchor.startContainer.ownerDocument;
    const range = doc.createRange();
    const anchorFirst = anchor.compareBoundaryPoints(0, focus) <= 0;
    const start = anchorFirst ? anchor : focus;
    const end = anchorFirst ? focus : anchor;
    range.setStart(start.startContainer, start.startOffset);
    range.setEnd(end.startContainer, end.startOffset);
    return range;
  }

  handleAnnotationPointerDown(event) {
    if (event.button !== 2) return;
    const point = this.contentPoint(event.clientX, event.clientY);
    const anchor = this.caretRangeAt(point);
    if (!point || !anchor) return;
    event.preventDefault();
    event.stopPropagation();
    this.shell.pages.setPointerCapture?.(event.pointerId);
    this.annotationDrag = {
      pointerId: event.pointerId,
      contents: point.contents,
      doc: point.doc,
      anchor,
      range: anchor.cloneRange(),
      startX: event.clientX,
      startY: event.clientY
    };
    this.shell.pages.classList.add("is-annotating");
    const selection = point.doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(anchor.cloneRange());
  }

  handleAnnotationPointerMove(event) {
    const drag = this.annotationDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = this.contentPoint(event.clientX, event.clientY);
    if (!point || point.contents !== drag.contents) return;
    const focus = this.caretRangeAt(point);
    const range = this.selectionRange(drag.anchor, focus);
    if (!range) return;
    event.preventDefault();
    drag.range = range;
    const selection = drag.doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async handleAnnotationPointerUp(event) {
    const drag = this.annotationDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.annotationDrag = null;
    this.shell.pages.classList.remove("is-annotating");
    this.shell.pages.releasePointerCapture?.(event.pointerId);
    const text = drag.range?.toString().replace(/\s+/g, " ").trim();
    try {
      if (text) {
        const cfiRange = drag.contents.cfiFromRange(drag.range);
        await this.addAnnotation(cfiRange, text);
      } else {
        const hit = this.annotationAtPoint(drag.contents, drag.anchor);
        if (hit) await this.removeAnnotation(hit);
      }
    } finally {
      drag.doc.getSelection()?.removeAllRanges();
    }
  }

  cancelAnnotationDrag() {
    const drag = this.annotationDrag;
    this.annotationDrag = null;
    this.shell?.pages?.classList.remove("is-annotating");
    drag?.doc.getSelection()?.removeAllRanges();
  }

  annotationAtPoint(contents, caret) {
    for (const annotation of this.annotations) {
      try {
        const range = contents.range(annotation.cfiRange);
        if (range?.isPointInRange(caret.startContainer, caret.startOffset)) return annotation;
      } catch {
        // The annotation belongs to another spine section.
      }
    }
    return null;
  }

  async addAnnotation(cfiRange, text) {
    if (!cfiRange || this.annotations.some((annotation) => annotation.cfiRange === cfiRange)) return;
    const annotation = {
      id: `mark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      cfiRange,
      text,
      createdAt: Date.now()
    };
    this.annotations.push(annotation);
    this.renderAnnotation(annotation);
    await this.plugin.addAnnotation(this.path, annotation);
  }

  renderAnnotation(annotation) {
    if (!annotation?.cfiRange || this.annotationHandles.has(annotation.id)) return;
    try {
      const handle = this.rendition.annotations.underline(
        annotation.cfiRange,
        { annotationId: annotation.id },
        null,
        "constructivist-epub-underline",
        {
          stroke: "none",
          "stroke-opacity": "1",
          "mix-blend-mode": "multiply"
        }
      );
      this.annotationHandles.set(annotation.id, handle);
    } catch (error) {
      console.warn(`Unable to render EPUB annotation: ${annotation.id}`, error);
    }
  }

  async removeAnnotation(annotation) {
    this.rendition.annotations.remove(annotation.cfiRange, "underline");
    this.annotations = this.annotations.filter((item) => item.id !== annotation.id);
    this.annotationHandles.delete(annotation.id);
    await this.plugin.removeAnnotation(this.path, annotation.id);
  }

  async performFlip({ direction, pages }) {
    if (!this.rendition) return;
    const spreadSteps = Math.max(1, Math.ceil(pages / 2));
    const turnClass = direction === "previous" ? "is-turning-back" : "is-turning-forward";
    this.shell.book.classList.remove("is-turning-back", "is-turning-forward");
    void this.shell.book.offsetWidth;
    this.shell.book.classList.add(turnClass);
    try {
      for (let index = 0; index < spreadSteps; index++) {
        const crossesPreviousSection = direction === "previous"
          && startsFirstSpread(this.currentLocation);
        if (crossesPreviousSection) {
          await this.performPreviousSectionFlip();
        } else {
          await (direction === "previous" ? this.rendition.prev() : this.rendition.next());
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, 370));
    } finally {
      this.shell?.book.classList.remove("is-turning-back", "is-turning-forward");
    }
  }

  async performPreviousSectionFlip() {
    this.relocationSuspended = true;
    this.pendingRelocation = null;
    this.shell.book.classList.add("is-stabilizing-section");
    let finalLocation = null;
    try {
      await this.rendition.prev();
      finalLocation = await this.finishPreviousSectionFlip();
      this.relocationSuspended = false;
      this.pendingRelocation = null;
      if (finalLocation) {
        this.rendition.location = finalLocation;
        this.handleRelocated(finalLocation);
      }
    } finally {
      if (this.relocationSuspended) {
        this.relocationSuspended = false;
        const pending = this.pendingRelocation;
        this.pendingRelocation = null;
        if (pending) this.handleRelocated(pending);
      }
      this.shell?.book.classList.remove("is-stabilizing-section");
    }
  }

  async finishPreviousSectionFlip() {
    const viewCollection = this.rendition?.views?.();
    const views = typeof viewCollection?.all === "function"
      ? viewCollection.all()
      : Array.isArray(viewCollection)
        ? viewCollection
        : [];
    await Promise.all(views.map((view) =>
      view?.contents?.document?.fonts?.ready?.catch?.(() => {})
    ));
    await new Promise((resolve) => window.requestAnimationFrame(() =>
      window.requestAnimationFrame(resolve)
    ));
    for (const view of views) view?.expand?.(true);
    const manager = this.rendition?.manager;
    if (!manager?.container || !manager?.layout) return;
    manager.updateLayout?.();
    const target = Math.max(0, manager.container.scrollWidth - manager.layout.delta);
    manager.scrollTo(target, 0, true);
    await new Promise((resolve) => window.requestAnimationFrame(() =>
      window.requestAnimationFrame(resolve)
    ));
    return normalizeLastSpread(this.rendition.currentLocation?.());
  }

  async jumpByStackPosition(direction, position) {
    if (!this.rendition) return;
    await this.flipQueue.whenIdle().catch(() => {});
    await this.ensureLocations();
    const total = Number(this.book.locations.length?.());
    const current = Number(this.book.locations.locationFromCfi?.(this.currentCfi));
    if (!Number.isFinite(total) || total < 1 || !Number.isFinite(current)) return;
    const targetIndex = locationTargetFromPosition(current, total, direction, position);
    const target = targetIndex === 0
      ? this.book.locations.cfiFromPercentage(0)
      : targetIndex >= total - 1
        ? this.book.locations.cfiFromPercentage(1)
        : this.book.locations.cfiFromLocation(targetIndex);
    if (!target) return;
    const leavingClass = direction === "previous" ? "is-jumping-back" : "is-jumping-forward";
    const arrivingClass = direction === "previous" ? "is-jump-arriving-back" : "is-jump-arriving-forward";
    const jumpClasses = [
      "is-jumping-back",
      "is-jumping-forward",
      "is-jump-arriving-back",
      "is-jump-arriving-forward"
    ];
    this.shell.book.classList.remove(...jumpClasses, "is-turning-back", "is-turning-forward");
    void this.shell.book.offsetWidth;
    this.shell.book.classList.add(leavingClass);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      await this.rendition.display(target);
      this.shell.book.classList.remove(leavingClass);
      void this.shell.book.offsetWidth;
      this.shell.book.classList.add(arrivingClass);
      await new Promise((resolve) => window.setTimeout(resolve, 340));
    } finally {
      this.shell?.book.classList.remove(...jumpClasses);
    }
  }

  async openChapter(href) {
    if (!this.rendition || !href) return false;
    await this.flipQueue.whenIdle().catch(() => {});
    const [rawPath, fragment = ""] = String(href).split("#", 2);
    const section = this.book?.spine?.get?.(href)
      || this.book?.spine?.get?.(rawPath);
    const target = section?.href
      ? `${section.href}${fragment ? `#${fragment}` : ""}`
      : resolveSpineTarget(href, this.book?.spine?.spineItems);
    try {
      await this.rendition.display(target);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      await this.plugin.persistProgress(this.path, "chapter", this.currentCfi, this.percentage);
      return true;
    } catch (error) {
      console.error(`Unable to open EPUB chapter: ${href}`, error);
      return false;
    }
  }

  async close(reason = "close") {
    await this.flipQueue.whenIdle().catch(() => {});
    await this.plugin.persistProgress(this.path, reason, this.currentCfi, this.percentage);
    if (reason === "close") await this.shell?.startClosing();
    this.rendition?.destroy();
    this.book?.destroy();
    this.shell?.destroy();
    this.onClose?.();
  }
}
