const ePub = require("epubjs");
const { ItemView, Plugin, TFile, Notice } = require("obsidian");
const {
  normalizeEpubPath,
  removeAnnotationById,
  shouldPersistProgress,
  upsertAnnotation
} = require("./reader-state.js");
const { ReaderSession } = require("./reader-session.js");

const VIEW_TYPE = "infinite-reading-gallery-view";
const EPUB_BOOK_FOLDER = "书籍";
const READER_VIEW_TYPE = "infinite-reading-gallery-reader-view";

function gallerySlotPoint(index, columns) {
  const row = Math.floor(index / columns);
  const column = index % columns;
  return {
    x: column + (row % 2) * 0.5,
    y: row
  };
}

function galleryToroidalDistanceSquared(firstIndex, secondIndex, columns, rows) {
  const first = gallerySlotPoint(firstIndex, columns);
  const second = gallerySlotPoint(secondIndex, columns);
  const directX = Math.abs(first.x - second.x);
  const directY = Math.abs(first.y - second.y);
  const dx = Math.min(directX, columns - directX);
  const dy = Math.min(directY, rows - directY);
  return dx * dx + dy * dy;
}

function assignGalleryBooks(bookCount, columns, rows) {
  const capacity = columns * rows;
  if (bookCount < 1 || capacity < bookCount || columns < 2 || rows < 2 || rows % 2) return null;

  const assignments = Array.from({ length: bookCount }, (_, index) => index);
  const occurrences = Array.from({ length: bookCount }, (_, index) => [index]);
  const usages = Array(bookCount).fill(1);
  const duplicatedBooks = new Set();
  const canSeparateDuplicateSelections = capacity - bookCount <= Math.floor(bookCount / 2);
  const adjacentDistanceSquared = 1.25;

  for (let slot = bookCount; slot < capacity; slot++) {
    const minimumUsage = Math.min(...usages);
    let selectedBook = -1;
    let selectedDistance = -1;

    for (let book = 0; book < bookCount; book++) {
      if (usages[book] !== minimumUsage) continue;
      if (canSeparateDuplicateSelections && Array.from(duplicatedBooks).some((duplicatedBook) => {
        const directDistance = Math.abs(book - duplicatedBook);
        return Math.min(directDistance, bookCount - directDistance) <= 1;
      })) continue;
      const minimumDistance = Math.min(...occurrences[book].map((existingSlot) =>
        galleryToroidalDistanceSquared(slot, existingSlot, columns, rows)
      ));
      if (minimumDistance <= adjacentDistanceSquared) continue;
      if (minimumDistance > selectedDistance) {
        selectedBook = book;
        selectedDistance = minimumDistance;
      }
    }

    if (selectedBook < 0) return null;
    assignments.push(selectedBook);
    occurrences[selectedBook].push(slot);
    usages[selectedBook]++;
    duplicatedBooks.add(selectedBook);
  }

  return assignments;
}

function createGalleryLayout(bookCount) {
  if (bookCount < 1) {
    return { columns: 0, rows: 0, bookIndices: [] };
  }

  const targetAspect = 1.5;
  const maximumRows = Math.max(2, Math.ceil(Math.sqrt(bookCount / targetAspect)) * 2 + 6);
  let best = null;

  for (let rows = 2; rows <= maximumRows; rows += 2) {
    const minimumColumns = Math.max(2, Math.ceil(bookCount / rows), rows);
    for (let columns = minimumColumns; columns <= minimumColumns + 2; columns++) {
      const bookIndices = assignGalleryBooks(bookCount, columns, rows);
      if (!bookIndices) continue;
      const repeatedBooks = columns * rows - bookCount;
      const aspectPenalty = bookCount * Math.abs(Math.log(columns / rows / targetAspect));
      const score = repeatedBooks * 5 + aspectPenalty;
      if (!best || score < best.score) {
        best = { columns, rows, bookIndices, score };
      }
    }
  }

  if (!best) {
    const rows = 2;
    const columns = Math.max(2, Math.ceil(bookCount / rows));
    return {
      columns,
      rows,
      bookIndices: Array.from({ length: columns * rows }, (_, index) => index % bookCount)
    };
  }

  return {
    columns: best.columns,
    rows: best.rows,
    bookIndices: best.bookIndices
  };
}


class InfiniteReadingGalleryView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.offsetX = -95;
    this.offsetY = -140;
    this.targetOffsetX = this.offsetX;
    this.targetOffsetY = this.offsetY;
    this.velocityX = 0;
    this.velocityY = 0;
    this.pointerId = null;
    this.dragDistance = 0;
    this.marqueeSpeed = 0;
    this.motionMode = null;
    this.horizontalDirection = "right";
    this.verticalDirection = "down";
    this.edgeWord = "DRAG";
    this.marqueeAnimations = null;
  }

  getViewType() {
    return READING_GALLERY_VIEW_TYPE;
  }

  getDisplayText() {
    return "无限书场";
  }

  getIcon() {
    return "library-big";
  }

  async onOpen() {
    const content = this.contentEl;
    content.empty();
    content.addClass("infinite-reading-gallery-view");

    try {
      content.innerHTML = await this.app.vault.adapter.read(`${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/reading-gallery.html`);
      this.viewport = content.querySelector("[data-gallery-viewport]");
      this.canvas = content.querySelector("[data-gallery-canvas]");
      this.search = content.querySelector("[data-gallery-search]");
      this.catalog = content.querySelector("[data-gallery-catalog]");
      this.books = await this.loadBooks();
      this.renderBooks();
      this.updateCanvasPosition();
      this.refreshMarqueeContent();
      this.registerDomEvent(content, "click", (event) => this.handleClick(event));
      this.registerDomEvent(this.viewport, "pointerdown", (event) => this.handlePointerDown(event));
      this.registerDomEvent(this.viewport, "pointermove", (event) => this.handlePointerMove(event));
      this.registerDomEvent(this.viewport, "pointerup", (event) => this.handlePointerUp(event));
      this.registerDomEvent(this.viewport, "pointercancel", (event) => this.handlePointerUp(event));
      this.registerDomEvent(this.viewport, "wheel", (event) => this.handleWheel(event), { passive: false });
      this.registerDomEvent(this.viewport, "dragover", (event) => this.handleEpubDragOver(event));
      this.registerDomEvent(this.viewport, "dragleave", (event) => this.handleEpubDragLeave(event));
      this.registerDomEvent(this.viewport, "drop", (event) => this.handleEpubDrop(event));
    } catch (error) {
      content.createEl("p", { text: "无法加载无限书场。", cls: "infinite-gallery-error" });
      console.error("Reading gallery failed to load.", error);
    }
  }

  async onClose() {
    window.cancelAnimationFrame(this.motionFrame);
    window.clearTimeout(this.scrollEndTimer);
    window.clearTimeout(this.focusTimer);
    if (this.focusState?.phase === "reading" || this.focusState?.phase === "opening") {
      await this.plugin.closeEmbedded("view-close");
    }
    this.releaseCoverUrls();
    this.contentEl.empty();
  }

  async loadBooks() {
    this.releaseCoverUrls();
    const files = this.app.vault.getFiles()
      .filter((file) => file.extension.toLowerCase() === "epub")
      .sort((first, second) => first.path.localeCompare(second.path, "zh-CN"));
    return Promise.all(files.map(async (file) => ({
      path: file.path,
      title: this.cleanBookTitle(file.basename),
      cover: await this.createEpubCoverUrl(file)
    })));
  }

  async createEpubCoverUrl(file) {
    try {
      const archive = await this.app.vault.adapter.readBinary(file.path);
      const entries = this.readZipDirectory(archive);
      const containerPath = this.findZipEntry(entries, "META-INF/container.xml");
      if (!containerPath) return null;
      const container = new DOMParser().parseFromString(
        new TextDecoder().decode(await this.readZipEntry(archive, entries.get(containerPath))),
        "application/xml"
      );
      const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
      const resolvedOpfPath = this.findZipEntry(entries, opfPath);
      if (!resolvedOpfPath) return null;
      const opf = new DOMParser().parseFromString(
        new TextDecoder().decode(await this.readZipEntry(archive, entries.get(resolvedOpfPath))),
        "application/xml"
      );
      const items = Array.from(opf.querySelectorAll("item"));
      const coverId = Array.from(opf.querySelectorAll("meta"))
        .find((meta) => meta.getAttribute("name")?.toLowerCase() === "cover")
        ?.getAttribute("content");
      const coverItem = items.find((item) => coverId && item.getAttribute("id") === coverId)
        || items.find((item) => item.getAttribute("properties")?.split(/\s+/).includes("cover-image"))
        || items.find((item) => /cover/i.test(item.getAttribute("href") || "")
          && /^image\//i.test(item.getAttribute("media-type") || ""));
      if (!coverItem) return null;
      const opfFolder = resolvedOpfPath.includes("/")
        ? resolvedOpfPath.slice(0, resolvedOpfPath.lastIndexOf("/") + 1)
        : "";
      const coverPath = this.normalizeZipPath(opfFolder + this.decodeEpubHref(coverItem.getAttribute("href")));
      const resolvedCoverPath = this.findZipEntry(entries, coverPath);
      if (!resolvedCoverPath) return null;
      const bytes = await this.readZipEntry(archive, entries.get(resolvedCoverPath));
      const mime = coverItem.getAttribute("media-type") || this.getImageMime(resolvedCoverPath);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (!this.coverUrls) this.coverUrls = new Set();
      this.coverUrls.add(url);
      return url;
    } catch (error) {
      console.warn(`Unable to extract EPUB cover: ${file.path}`, error);
      return null;
    }
  }

  readZipDirectory(archive) {
    const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const minimum = Math.max(0, bytes.length - 65557);
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= minimum; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        endOffset = offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error("Invalid EPUB ZIP directory.");
    const count = view.getUint16(endOffset + 10, true);
    let offset = view.getUint32(endOffset + 16, true);
    const entries = new Map();
    for (let index = 0; index < count; index++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid EPUB ZIP entry.");
      const compression = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      entries.set(this.normalizeZipPath(name), { compression, compressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async readZipEntry(archive, entry) {
    if (!entry) throw new Error("Missing EPUB ZIP entry.");
    const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error("Invalid EPUB ZIP data.");
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const compressed = bytes.slice(start, start + entry.compressedSize);
    if (entry.compression === 0) return compressed;
    if (entry.compression !== 8) throw new Error(`Unsupported EPUB compression: ${entry.compression}`);
    if (typeof DecompressionStream === "function") {
      try {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        // Fall back to pako when deflate-raw is unavailable.
      }
    }
    const { inflateRaw } = require("pako");
    return new Uint8Array(inflateRaw(compressed));
  }

  findZipEntry(entries, path) {
    if (!path) return null;
    const normalized = this.normalizeZipPath(path);
    if (entries.has(normalized)) return normalized;
    const lower = normalized.toLowerCase();
    return Array.from(entries.keys()).find((entry) => entry.toLowerCase() === lower) || null;
  }

  normalizeZipPath(path) {
    const parts = [];
    for (const part of String(path || "").replace(/\\/g, "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return parts.join("/");
  }

  decodeEpubHref(href) {
    const clean = String(href || "").split("#")[0];
    try {
      return decodeURIComponent(clean);
    } catch {
      return clean;
    }
  }

  getImageMime(path) {
    const extension = path.split(".").pop()?.toLowerCase();
    if (extension === "png") return "image/png";
    if (extension === "webp") return "image/webp";
    if (extension === "svg") return "image/svg+xml";
    if (extension === "gif") return "image/gif";
    return "image/jpeg";
  }

  releaseCoverUrls() {
    for (const url of this.coverUrls || []) URL.revokeObjectURL(url);
    this.coverUrls = new Set();
  }

  cleanBookTitle(title) {
    return title.replace(/[_]+/g, " ").trim();
  }

  getDraggedVaultEpubs(event) {
    const dragged = this.app.dragManager?.draggable;
    const candidates = [
      dragged?.file,
      ...(Array.isArray(dragged?.files) ? dragged.files : [])
    ];
    const plainText = event.dataTransfer?.getData("text/plain") || "";
    for (const value of plainText.split(/\r?\n/)) {
      const path = value.replace(/^obsidian:\/\/open\?[^#]*file=/, "");
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        // Keep the original value when a dragged path contains a stray percent sign.
      }
      const file = this.app.vault.getAbstractFileByPath(decoded.replace(/\\/g, "/"));
      if (file instanceof TFile) candidates.push(file);
    }
    return Array.from(new Map(candidates
      .filter((file) => file instanceof TFile && file.extension.toLowerCase() === "epub")
      .map((file) => [file.path, file])).values());
  }

  hasDroppedEpub(event) {
    if (this.getDraggedVaultEpubs(event).length) return true;
    return Array.from(event.dataTransfer?.items || [])
      .some((item) => item.kind === "file"
        && (item.getAsFile()?.name.toLowerCase().endsWith(".epub")
          || item.type.toLowerCase().includes("epub")));
  }

  handleEpubDragOver(event) {
    if (!this.hasDroppedEpub(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    this.viewport.classList.add("is-epub-drag-over");
  }

  handleEpubDragLeave(event) {
    if (event.relatedTarget && this.viewport.contains(event.relatedTarget)) return;
    this.viewport.classList.remove("is-epub-drag-over");
  }

  async handleEpubDrop(event) {
    this.viewport.classList.remove("is-epub-drag-over");
    const vaultFiles = this.getDraggedVaultEpubs(event);
    const externalFiles = vaultFiles.length
      ? []
      : Array.from(event.dataTransfer?.files || [])
        .filter((file) => file.name.toLowerCase().endsWith(".epub"));
    if (!vaultFiles.length && !externalFiles.length) return;

    event.preventDefault();
    event.stopPropagation();

    const addedPaths = vaultFiles.map((file) => file.path);
    for (const file of externalFiles) {
      addedPaths.push(await this.importEpub(file));
    }
    this.books = await this.loadBooks();
    this.renderBooks();
    this.updateCanvasPosition();
    new Notice(`已添加 ${new Set(addedPaths).size} 本 EPUB`);
  }

  async importEpub(file) {
    const folder = this.app.vault.getAbstractFileByPath(EPUB_BOOK_FOLDER);
    if (!folder) await this.app.vault.createFolder(EPUB_BOOK_FOLDER);
    const stem = file.name.replace(/\.epub$/i, "");
    let path = `${EPUB_BOOK_FOLDER}/${file.name}`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `${EPUB_BOOK_FOLDER}/${stem} ${suffix}.epub`;
      suffix++;
    }
    await this.app.vault.createBinary(path, await file.arrayBuffer());
    return path;
  }

  renderBooks() {
    if (!this.canvas) return;
    this.canvas.empty();
    const count = this.contentEl.querySelector("[data-gallery-count]");
    if (count) count.setText(String(this.books.length));
    this.renderBookCatalog();
    if (!this.books.length) {
      this.canvas.createDiv({ cls: "reading-gallery-empty", text: "书籍目录中暂未发现 EPUB" });
      return;
    }

    const layout = createGalleryLayout(this.books.length);
    const { columns, rows } = layout;
    const stepX = 340;
    const stepY = 320;
    this.tileWidth = columns * stepX;
    this.tileHeight = rows * stepY;
    this.canvas.style.width = `${this.tileWidth * 3}px`;
    this.canvas.style.height = `${this.tileHeight * 3}px`;
    this.bookPlacements = [];

    for (let tileY = 0; tileY < 3; tileY++) {
      for (let tileX = 0; tileX < 3; tileX++) {
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) {
            const index = row * columns + column;
            const book = this.books[layout.bookIndices[index]];
            const x = tileX * this.tileWidth + column * stepX + (row % 2) * stepX / 2;
            const y = tileY * this.tileHeight + row * stepY;
            if (tileX === 0 && tileY === 0) {
              this.bookPlacements.push({ path: book.path, x, y });
            }
            this.createBook(book, x, y, index);
          }
        }
      }
    }
  }

  createBook(book, x, y, index) {
    const button = this.canvas.createEl("button", {
      cls: `reading-gallery-book${book.cover ? "" : " is-fallback"}`,
      attr: {
        type: "button",
        "data-book-path": book.path,
        "data-variant": String(index % 6),
        "aria-label": `阅读《${book.title}》`,
        title: book.title
      }
    });
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    if (book.cover) {
      button.createEl("img", { attr: { src: book.cover, alt: "" } });
    } else {
      button.createDiv({ cls: "reading-gallery-fallback-shape", attr: { "aria-hidden": "true" } });
      button.createSpan({ cls: "reading-gallery-fallback-index", text: String(index % this.books.length + 1).padStart(2, "0") });
      button.createSpan({ cls: "reading-gallery-fallback-title", text: book.title });
    }
  }

  renderBookCatalog() {
    const list = this.contentEl.querySelector("[data-gallery-catalog-list]");
    if (!list) return;
    list.empty();
    for (const [index, book] of this.books.entries()) {
      const item = list.createEl("button", {
        cls: "reading-gallery-catalog-item",
        attr: {
          type: "button",
          "data-gallery-action": "locate",
          "data-book-path": book.path,
          title: `定位《${book.title}》`
        }
      });
      item.createSpan({
        cls: "reading-gallery-catalog-index",
        text: String(index + 1).padStart(2, "0")
      });
      item.createSpan({ cls: "reading-gallery-catalog-title", text: book.title });
      item.createSpan({ cls: "reading-gallery-catalog-arrow", text: "↘" });
    }
  }

  handlePointerDown(event) {
    if (this.focusState) {
      if (event.target.closest(".reading-gallery-focus-cover, .constructivist-reader-book, .constructivist-reader-backdrop")) return;
      event.preventDefault();
      if (this.focusState.phase === "focused" || this.focusState.phase === "focusing") {
        this.cancelBookFocus();
      }
      return;
    }
    if (event.button !== 0 || event.target.closest("[data-gallery-search], [data-gallery-action], [data-book-path]")) return;
    this.toggleCatalog(false);
    this.clearScrollEnding();
    window.cancelAnimationFrame(this.motionFrame);
    this.motionFrame = null;
    this.lastMotionTime = 0;
    this.pointerId = event.pointerId;
    this.dragDistance = 0;
    this.marqueeSpeed = 0;
    this.marqueePlaybackRate = null;
    this.motionMode = "drag";
    this.targetOffsetX = this.offsetX;
    this.targetOffsetY = this.offsetY;
    this.velocityX = 0;
    this.velocityY = 0;
    this.lastPointer = { x: event.clientX, y: event.clientY, time: performance.now() };
    this.viewport.setPointerCapture(event.pointerId);
    this.viewport.classList.remove("is-scrolling", "is-inertial");
    this.viewport.classList.add("is-dragging", "is-camera-raised");
    this.setMarqueeState("DRAG", this.horizontalDirection, this.verticalDirection);
    this.updatePointerIndicator(event);
  }

  handlePointerMove(event) {
    if (event.pointerId !== this.pointerId || !this.lastPointer) return;
    const now = performance.now();
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    const elapsed = Math.max(1, now - this.lastPointer.time);
    this.dragDistance += Math.hypot(dx, dy);
    this.targetOffsetX += dx;
    this.targetOffsetY += dy;
    const frameScale = 16.67 / elapsed;
    this.velocityX = this.velocityX * 0.58 + dx * frameScale * 0.42;
    this.velocityY = this.velocityY * 0.58 + dy * frameScale * 0.42;
    this.velocityX = Math.max(-72, Math.min(72, this.velocityX));
    this.velocityY = Math.max(-72, Math.min(72, this.velocityY));
    this.updateMotionDirection(dx, dy, "drag");
    this.lastPointer = { x: event.clientX, y: event.clientY, time: now };
    this.scheduleMotion();
    this.updatePointerIndicator(event);
    event.preventDefault();
  }

  handlePointerUp(event) {
    if (event.pointerId !== this.pointerId) return;
    if (this.viewport.hasPointerCapture(event.pointerId)) this.viewport.releasePointerCapture(event.pointerId);
    if (this.dragDistance > 6) this.suppressClickUntil = performance.now() + 260;
    this.pointerId = null;
    this.lastPointer = null;
    this.viewport.classList.remove("is-dragging");
    if (Math.hypot(this.velocityX, this.velocityY) > 0.35) {
      this.viewport.classList.add("is-inertial");
      this.scheduleMotion();
    } else {
      this.finishMotion();
    }
  }

  handleWheel(event) {
    if (this.focusState) {
      event.preventDefault();
      return;
    }
    if (this.pointerId !== null || event.target.closest("[data-gallery-search]")) return;
    event.preventDefault();
    this.clearScrollEnding();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1;
    const wheelDelta = Math.max(-180, Math.min(180, event.deltaY * unit));
    if (!wheelDelta) return;
    if (this.motionMode !== "scroll") {
      this.targetOffsetX = this.offsetX;
      this.targetOffsetY = this.offsetY;
      this.velocityX = 0;
      this.velocityY = 0;
      this.marqueePlaybackRate = null;
    }
    const canvasDelta = -wheelDelta;
    this.lastWheelTime = performance.now();
    this.motionMode = "scroll";
    this.targetOffsetY += canvasDelta * 0.82;
    this.velocityY = Math.max(-34, Math.min(34, this.velocityY * 0.52 + canvasDelta * 0.085));
    this.viewport.classList.remove("is-dragging", "is-inertial");
    this.viewport.classList.add("is-scrolling", "is-camera-raised");
    this.updateMotionDirection(0, canvasDelta, "scroll");
    this.scheduleMotion();
  }

  scheduleMotion() {
    if (this.motionFrame) return;
    this.motionFrame = window.requestAnimationFrame((time) => this.animateMotion(time));
  }

  animateMotion(time) {
    this.motionFrame = null;
    const elapsed = this.lastMotionTime ? Math.min(40, time - this.lastMotionTime) : 16.67;
    const frameScale = elapsed / 16.67;
    this.lastMotionTime = time;

    if (this.pointerId === null && this.motionMode) {
      this.targetOffsetX += this.velocityX * frameScale;
      this.targetOffsetY += this.velocityY * frameScale;
      const friction = Math.pow(this.motionMode === "scroll" ? 0.86 : 0.92, frameScale);
      this.velocityX *= friction;
      this.velocityY *= friction;
    }

    const ease = 1 - Math.pow(this.motionMode === "locate" ? 0.9 : 0.48, frameScale);
    const previousX = this.offsetX;
    const previousY = this.offsetY;
    this.offsetX += (this.targetOffsetX - this.offsetX) * ease;
    this.offsetY += (this.targetOffsetY - this.offsetY) * ease;
    const stepX = this.offsetX - previousX;
    const stepY = this.offsetY - previousY;
    this.updateCanvasPosition();
    this.updateMotionDirection(stepX, stepY, this.motionMode);
    this.updateMarqueeSpeed(stepX, stepY, elapsed);

    const remaining = Math.hypot(this.targetOffsetX - this.offsetX, this.targetOffsetY - this.offsetY);
    const speed = Math.hypot(this.velocityX, this.velocityY);
    const wheelInputEnded = this.motionMode !== "scroll" || time - (this.lastWheelTime || 0) > 120;
    if (this.pointerId === null && wheelInputEnded && remaining < 3.5 && speed < 0.9) {
      this.viewport.classList.remove("is-camera-raised");
    }
    if (remaining > 0.06 || (this.pointerId === null && speed > 0.06)) {
      this.scheduleMotion();
    } else if (this.pointerId === null) {
      this.finishMotion();
    } else {
      this.lastMotionTime = 0;
    }
  }

  updateMarqueeSpeed(dx, dy, elapsed) {
    const speed = Math.hypot(dx, dy) / Math.max(1, elapsed);
    this.marqueeSpeed = this.marqueeSpeed * 0.68 + speed * 0.32;
    const playbackRate = Math.max(0.65, Math.min(7.5, 0.72 + this.marqueeSpeed * 6.2));
    if (Math.abs(playbackRate - (this.marqueePlaybackRate || 0)) < 0.025) return;
    this.marqueePlaybackRate = playbackRate;
    if (!this.marqueeAnimations?.length) {
      this.marqueeAnimations = Array.from(
        this.viewport.querySelectorAll(".reading-gallery-edge span"),
        (span) => span.getAnimations()
      ).flat();
    }
    for (const animation of this.marqueeAnimations) {
      if (typeof animation.updatePlaybackRate === "function") {
        animation.updatePlaybackRate(playbackRate);
      } else {
        animation.playbackRate = playbackRate;
      }
    }
  }

  updateMotionDirection(dx, dy, mode) {
    if (mode !== "scroll") {
      this.setMarqueeState("DRAG", "left", "up");
      return;
    }
    let horizontal = this.horizontalDirection;
    let vertical = this.verticalDirection;
    if (Math.abs(dy) > 0.08) {
      const canvasDirection = dy > 0 ? "down" : "up";
      vertical = canvasDirection;
    }
    this.setMarqueeState("SCROLL", horizontal, vertical);
  }

  setMarqueeState(word, horizontal, vertical) {
    if (word === this.edgeWord && horizontal === this.horizontalDirection && vertical === this.verticalDirection) return;
    this.edgeWord = word;
    this.horizontalDirection = horizontal;
    this.verticalDirection = vertical;
    this.marqueePlaybackRate = null;
    this.refreshMarqueeContent();
  }

  refreshMarqueeContent() {
    if (!this.viewport) return;
    this.marqueeAnimations = null;
    this.viewport.classList.toggle("is-horizontal-left", this.horizontalDirection === "left");
    this.viewport.classList.toggle("is-horizontal-right", this.horizontalDirection === "right");
    this.viewport.classList.toggle("is-vertical-up", this.verticalDirection === "up");
    this.viewport.classList.toggle("is-vertical-down", this.verticalDirection === "down");
    const dragDirections = { top: "←", right: "↑", bottom: "→", left: "↓" };
    const scrollArrow = this.verticalDirection === "down" ? "↓" : "↑";
    for (const edge of this.viewport.querySelectorAll("[data-gallery-edge]")) {
      const side = edge.dataset.galleryEdge;
      const arrow = this.edgeWord === "DRAG" ? dragDirections[side] : scrollArrow;
      const repetitions = side === "top" || side === "bottom" ? 10 : 8;
      for (const runner of edge.children) {
        runner.replaceChildren();
        for (let index = 0; index < repetitions; index++) {
          const arrowElement = document.createElement("i");
          arrowElement.className = "reading-gallery-edge-arrow";
          arrowElement.textContent = arrow;
          runner.append(document.createTextNode(`${this.edgeWord}　`), arrowElement, document.createTextNode("　"));
        }
      }
    }
  }

  finishMotion() {
    const wasScrolling = this.motionMode === "scroll";
    this.velocityX = 0;
    this.velocityY = 0;
    this.targetOffsetX = this.offsetX;
    this.targetOffsetY = this.offsetY;
    this.lastMotionTime = 0;
    this.motionMode = null;
    this.viewport?.classList.remove("is-camera-raised");
    if (wasScrolling && this.viewport) {
      window.clearTimeout(this.scrollEndTimer);
      this.viewport.classList.add("is-scroll-ending");
      this.viewport.classList.remove("is-inertial", "is-scrolling");
      this.scrollEndTimer = window.setTimeout(() => {
        this.viewport?.classList.remove("is-scroll-ending");
        this.scrollEndTimer = null;
      }, 1360);
    } else {
      this.viewport?.classList.remove("is-inertial", "is-scrolling");
    }
  }

  clearScrollEnding() {
    window.clearTimeout(this.scrollEndTimer);
    this.scrollEndTimer = null;
    this.viewport?.classList.remove("is-scroll-ending");
  }

  updatePointerIndicator(event) {
    const box = this.viewport.getBoundingClientRect();
    this.contentEl.style.setProperty("--gallery-pointer-x", `${event.clientX - box.left}px`);
    this.contentEl.style.setProperty("--gallery-pointer-y", `${event.clientY - box.top}px`);
  }

  updateCanvasPosition() {
    if (!this.canvas || !this.tileWidth || !this.tileHeight) return;
    const phaseX = ((this.offsetX % this.tileWidth) + this.tileWidth) % this.tileWidth;
    const phaseY = ((this.offsetY % this.tileHeight) + this.tileHeight) % this.tileHeight;
    this.canvas.style.transform = `translate3d(${phaseX - this.tileWidth}px, ${phaseY - this.tileHeight}px, 0)`;
  }

  toggleCatalog(force) {
    if (!this.search) return;
    const isOpen = typeof force === "boolean" ? force : !this.search.classList.contains("is-open");
    this.search.classList.toggle("is-open", isOpen);
    this.search.querySelector("[data-gallery-action='catalog']")
      ?.setAttribute("aria-expanded", String(isOpen));
    this.catalog?.setAttribute("aria-hidden", String(!isOpen));
  }

  locateBook(path) {
    if (this.focusState) return;
    const placements = (this.bookPlacements || []).filter((placement) => placement.path === path);
    if (!placements.length || !this.tileWidth || !this.tileHeight) return;

    const sample = Array.from(this.canvas.querySelectorAll("[data-book-path]"))
      .find((book) => book.dataset.bookPath === path);
    const halfWidth = (sample?.offsetWidth || 172) / 2;
    const halfHeight = (sample?.offsetHeight || 252) / 2;
    const centerX = this.viewport.clientWidth / 2;
    const centerY = this.viewport.clientHeight / 2;
    let nearest = null;

    for (const placement of placements) {
      const bookCenterX = placement.x + halfWidth;
      const bookCenterY = placement.y + halfHeight;
      const repeatX = Math.round((centerX - bookCenterX - this.offsetX) / this.tileWidth);
      const repeatY = Math.round((centerY - bookCenterY - this.offsetY) / this.tileHeight);
      const offsetX = centerX - bookCenterX - repeatX * this.tileWidth;
      const offsetY = centerY - bookCenterY - repeatY * this.tileHeight;
      const distance = Math.hypot(offsetX - this.offsetX, offsetY - this.offsetY);
      if (!nearest || distance < nearest.distance) nearest = { offsetX, offsetY, distance };
    }

    this.toggleCatalog(false);
    this.clearScrollEnding();
    window.cancelAnimationFrame(this.motionFrame);
    this.motionFrame = null;
    this.lastMotionTime = 0;
    this.pointerId = null;
    this.lastPointer = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.marqueeSpeed = 0;
    this.marqueePlaybackRate = null;
    this.motionMode = "locate";
    this.targetOffsetX = nearest.offsetX;
    this.targetOffsetY = nearest.offsetY;
    this.viewport.classList.remove("is-dragging", "is-scrolling");
    this.viewport.classList.add("is-inertial", "is-camera-raised");
    this.setMarqueeState("DRAG", "left", "up");
    this.scheduleMotion();
  }

  focusBook(book) {
    if (this.focusState || !book || !this.viewport) return;
    this.toggleCatalog(false);
    this.clearScrollEnding();
    window.cancelAnimationFrame(this.motionFrame);
    this.motionFrame = null;
    this.motionMode = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.targetOffsetX = this.offsetX;
    this.targetOffsetY = this.offsetY;
    this.viewport.classList.remove("is-dragging", "is-inertial", "is-scrolling", "is-camera-raised");

    const viewportBox = this.viewport.getBoundingClientRect();
    const bookBox = book.getBoundingClientRect();
    const startLeft = bookBox.left - viewportBox.left;
    const startTop = bookBox.top - viewportBox.top;
    const targetHeight = Math.min(viewportBox.height * 0.62, 620);
    const targetWidth = targetHeight * bookBox.width / Math.max(1, bookBox.height);
    const layer = this.viewport.createDiv({ cls: "reading-gallery-focus-layer" });
    const cover = book.cloneNode(true);
    cover.classList.remove("is-gallery-hidden");
    cover.classList.add("reading-gallery-focus-cover");
    if (cover.querySelector("img")) cover.classList.add("has-book-volume");
    cover.removeAttribute("style");
    cover.setAttribute("data-gallery-focused-book", "true");
    cover.style.setProperty("--focus-start-left", `${startLeft}px`);
    cover.style.setProperty("--focus-start-top", `${startTop}px`);
    cover.style.setProperty("--focus-start-width", `${bookBox.width}px`);
    cover.style.setProperty("--focus-start-height", `${bookBox.height}px`);
    cover.style.setProperty("--focus-target-width", `${targetWidth}px`);
    cover.style.setProperty("--focus-target-height", `${targetHeight}px`);
    layer.append(cover);

    const hiddenBooks = Array.from(this.canvas.querySelectorAll(".reading-gallery-book"));
    for (const item of hiddenBooks) {
      const isSource = item === book;
      item.style.setProperty(
        "--gallery-hide-delay",
        isSource ? "0ms" : `${Math.round(Math.random() * 520)}ms`
      );
      item.classList.toggle("is-focus-source", isSource);
      item.classList.add("is-gallery-hidden");
    }

    this.focusState = {
      path: book.dataset.bookPath,
      phase: "focusing",
      layer,
      cover,
      hiddenBooks,
      source: book
    };
    this.viewport.classList.add("is-book-focused");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => layer.classList.add("is-centered"));
    });
    window.clearTimeout(this.focusTimer);
    this.focusTimer = window.setTimeout(() => {
      if (this.focusState?.layer === layer && this.focusState.phase === "focusing") {
        this.focusState.phase = "focused";
      }
    }, 920);
  }

  cancelBookFocus() {
    const state = this.focusState;
    if (!state || state.phase === "reading" || state.phase === "opening") return;
    state.phase = "closing";
    window.clearTimeout(this.focusTimer);
    state.layer.classList.remove("is-centered", "is-opening");
    for (const item of state.hiddenBooks) {
      if (item === state.source) continue;
      item.style.setProperty("--gallery-hide-delay", `${Math.round(Math.random() * 480)}ms`);
      item.classList.add("is-gallery-restoring");
      item.classList.remove("is-gallery-hidden");
    }
    this.focusTimer = window.setTimeout(() => {
      if (this.focusState !== state) return;
      state.layer.remove();
      for (const item of state.hiddenBooks) {
        item.classList.remove("is-gallery-hidden", "is-gallery-restoring", "is-focus-source");
        item.style.removeProperty("--gallery-hide-delay");
      }
      this.viewport?.classList.remove("is-book-focused", "is-book-reading");
      this.focusState = null;
    }, 980);
  }

  async openFocusedBook() {
    const state = this.focusState;
    if (!state || state.phase !== "focused") return;
    const reader = this.plugin;
    if (typeof reader.openEmbedded !== "function") {
      new Notice("书场阅读器尚未就绪，请重新打开书场后重试。");
      return;
    }

    state.phase = "opening";
    state.layer.classList.add("is-opening");
    this.viewport.classList.add("is-book-reading");
    try {
      await reader.openEmbedded({
        host: this.viewport,
        path: state.path,
        onClose: () => {
          if (this.focusState !== state) return;
          state.phase = "cover-turning";
          state.layer.classList.remove("is-opening");
          state.layer.classList.add("is-cover-turning");
          this.viewport?.classList.remove("is-book-reading");
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              if (this.focusState === state) state.layer.classList.add("is-cover-front");
            });
          });
          window.clearTimeout(this.focusTimer);
          this.focusTimer = window.setTimeout(() => {
            if (this.focusState !== state || state.phase !== "cover-turning") return;
            state.phase = "focused";
            state.layer.classList.remove("is-cover-turning", "is-cover-front");
            window.requestAnimationFrame(() => this.cancelBookFocus());
          }, 820);
        }
      });
      if (this.focusState === state) state.phase = "reading";
    } catch (error) {
      console.error("Unable to open embedded EPUB reader.", error);
      state.phase = "focused";
      state.layer.classList.remove("is-opening");
      this.viewport.classList.remove("is-book-reading");
      new Notice("无法打开这本 EPUB，请确认文件未损坏或加密。");
    }
  }

  async handleClick(event) {
    const focusedBook = event.target.closest("[data-gallery-focused-book]");
    if (focusedBook) {
      event.preventDefault();
      await this.openFocusedBook();
      return;
    }

    if (this.focusState) return;
    const action = event.target.closest("[data-gallery-action]");
    if (action?.dataset.galleryAction === "catalog") {
      event.preventDefault();
      this.toggleCatalog();
      return;
    }

    if (action?.dataset.galleryAction === "locate") {
      event.preventDefault();
      this.locateBook(action.dataset.bookPath);
      return;
    }


    if (!event.target.closest("[data-gallery-search]")) this.toggleCatalog(false);
    const book = event.target.closest("[data-book-path]");
    if (!book) return;
    event.preventDefault();
    if (performance.now() < (this.suppressClickUntil || 0)) return;
    this.focusBook(book);
  }
}


class InfiniteReadingGalleryReaderView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return READER_VIEW_TYPE; }
  getDisplayText() { return "EPUB 双页阅读器"; }
  getIcon() { return "book-open"; }
  async onOpen() {
    const state = this.getState();
    const path = state?.path || state?.file || this.pendingPath;
    if (!path) { this.contentEl.setText("请从命令面板打开一个 EPUB 文件。"); return; }
    await this.plugin.openEmbedded({ host: this.contentEl, path, onClose: () => this.leaf.detach() });
  }
  async setState(state, result) {
    this.pendingPath = state?.path || state?.file;
    await super.setState(state, result);
    if (this.contentEl.isConnected && this.pendingPath) await this.onOpen();
  }
  async onClose() { await this.plugin.closeEmbedded("view-close"); }
}

module.exports = class InfiniteReadingGalleryPlugin extends Plugin {
  async onload() {
    const loaded = await this.loadData();
    this.readerData = loaded && typeof loaded === "object" ? loaded : null;
    if (!this.readerData?.books || Object.keys(this.readerData.books).length === 0) {
      try {
        const legacyPath = `${this.app.vault.configDir}/plugins/constructivist-epub-reader/data.json`;
        const legacyData = JSON.parse(await this.app.vault.adapter.read(legacyPath));
        if (legacyData && typeof legacyData.books === "object") {
          this.readerData = legacyData;
          await this.saveData(this.readerData);
        }
      } catch {
        // No previous reader data to migrate.
      }
    }
    if (!this.readerData) this.readerData = { version: 1, books: {} };
    if (!this.readerData.books) this.readerData.books = {};
    this.registerView(VIEW_TYPE, (leaf) => new InfiniteReadingGalleryView(leaf, this));
    this.registerView(READER_VIEW_TYPE, (leaf) => new InfiniteReadingGalleryReaderView(leaf, this));
    this.registerExtensions(["epub"], READER_VIEW_TYPE);
    this.addCommand({ id: "open-infinite-reading-gallery", name: "打开无限书场", callback: () => this.activateGallery() });
    this.addCommand({
      id: "open-active-epub", name: "打开当前 EPUB",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const supported = file instanceof TFile && this.supports(file.path);
        if (supported && !checking) void this.openStandalone(file.path);
        return supported;
      }
    });
    this.ribbon = this.addRibbonIcon("library-big", "打开无限书场", () => this.activateGallery());
    this.ribbon.addClass("infinite-reading-gallery-ribbon");
    void this.setRibbonImage(this.ribbon);
  }

  async setRibbonImage(ribbon) {
    try {
      const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/assets/infinite-reading-gallery.png`;
      const bytes = await this.app.vault.adapter.readBinary(path);
      this.ribbonImageUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      const image = document.createElement("img");
      image.src = this.ribbonImageUrl;
      image.alt = "";
      image.setAttribute("aria-hidden", "true");
      ribbon.querySelector("svg")?.replaceWith(image);
    } catch (error) {
      console.warn("Unable to load the Infinite Reading Gallery icon.", error);
    }
  }

  supports(path) { return normalizeEpubPath(path).toLowerCase().endsWith(".epub"); }
  async openEmbedded(options) {
    if (!options?.host || !this.supports(options.path)) throw new Error("需要有效的 EPUB 路径和挂载容器。");
    await this.closeEmbedded("view-close");
    this.activeSession = new ReaderSession(this, options);
    return this.activeSession.open();
  }
  async closeEmbedded(reason = "close") {
    const session = this.activeSession;
    if (!session) return;
    this.activeSession = null;
    await session.close(reason);
  }
  async openStandalone(path) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: READER_VIEW_TYPE, active: true, state: { path: normalizeEpubPath(path) } });
    this.app.workspace.revealLeaf(leaf);
  }
  resolveProgress(path, identity) {
    const key = normalizeEpubPath(path);
    const exact = this.readerData.books[key];
    if (exact) return exact;
    if (!identity?.fingerprint) return null;
    const match = Object.entries(this.readerData.books).find(([, record]) => record?.size === identity.size && record?.fingerprint === identity.fingerprint);
    if (!match) return null;
    this.readerData.books[key] = { ...match[1], movedFrom: match[0] };
    return this.readerData.books[key];
  }
  updateMemoryProgress(path, cfi, identity, percentage) {
    if (!cfi) return;
    const key = normalizeEpubPath(path);
    this.readerData.books[key] = {
      ...(this.readerData.books[key] || {}), cfi,
      percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(1, percentage)) : this.readerData.books[key]?.percentage,
      size: identity?.size ?? this.readerData.books[key]?.size ?? null,
      fingerprint: identity?.fingerprint ?? this.readerData.books[key]?.fingerprint ?? null
    };
  }
  getAnnotations(path) {
    const record = this.readerData.books[normalizeEpubPath(path)];
    return Array.isArray(record?.annotations) ? record.annotations.filter((annotation) => annotation?.id && annotation?.cfiRange) : [];
  }
  async addAnnotation(path, annotation) {
    if (!annotation?.id || !annotation?.cfiRange) return;
    const key = normalizeEpubPath(path); const book = this.readerData.books[key] || {};
    this.readerData.books[key] = { ...book, annotations: upsertAnnotation(book.annotations, annotation) };
    await this.saveData(this.readerData);
  }
  async removeAnnotation(path, id) {
    const key = normalizeEpubPath(path); const book = this.readerData.books[key];
    if (!book || !Array.isArray(book.annotations)) return;
    this.readerData.books[key] = { ...book, annotations: removeAnnotationById(book.annotations, id) };
    await this.saveData(this.readerData);
  }
  async persistProgress(path, reason, cfi, percentage) {
    if (!shouldPersistProgress(reason) || !cfi) return;
    const key = normalizeEpubPath(path); const file = this.app.vault.getAbstractFileByPath(key);
    this.readerData.books[key] = {
      ...(this.readerData.books[key] || {}), cfi,
      percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(1, percentage)) : this.readerData.books[key]?.percentage,
      size: file instanceof TFile ? file.stat.size : null,
      mtime: file instanceof TFile ? file.stat.mtime : null,
      savedAt: Date.now()
    };
    await this.saveData(this.readerData);
  }
  async activateGallery() {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existingLeaf) { this.app.workspace.setActiveLeaf(existingLeaf); return; }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf);
  }
  async onunload() {
    await this.closeEmbedded("unload");
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(READER_VIEW_TYPE);
    if (this.ribbonImageUrl) URL.revokeObjectURL(this.ribbonImageUrl);
  }
};
