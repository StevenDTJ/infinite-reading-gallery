import { stackWidthsFromProgress } from "./reader-state.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function isEditableTarget(target) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

export function createReaderShell(host, callbacks) {
  const root = element("section", "constructivist-epub-reader");
  root.setAttribute("aria-label", "EPUB 阅读器");
  root.tabIndex = -1;

  const backdrop = element("button", "constructivist-reader-backdrop");
  backdrop.type = "button";
  backdrop.setAttribute("aria-label", "合上书本");

  const book = element("article", "constructivist-reader-book is-loading");
  const header = element("header", "constructivist-reader-header");
  const chapter = element("span", "constructivist-reader-chapter", "正在打开书本");
  const progress = element("span", "constructivist-reader-progress", "00%");
  const tocToggle = element("button", "constructivist-reader-toc-toggle", "目录 / CONTENTS");
  tocToggle.type = "button";
  tocToggle.setAttribute("aria-expanded", "false");
  header.append(chapter, progress, tocToggle);

  const spread = element("div", "constructivist-reader-spread");
  const leftStack = element("button", "constructivist-reader-stack is-left");
  const rightStack = element("button", "constructivist-reader-stack is-right");
  leftStack.type = "button";
  rightStack.type = "button";
  leftStack.setAttribute("aria-label", "向前跳页");
  rightStack.setAttribute("aria-label", "向后跳页");

  const pages = element("div", "constructivist-reader-pages");
  const renditionHost = element("div", "constructivist-reader-rendition");
  const leftTap = element("button", "constructivist-reader-page-tap is-left");
  const rightTap = element("button", "constructivist-reader-page-tap is-right");
  const leftFolio = element("span", "constructivist-reader-folio is-left", "—");
  const rightFolio = element("span", "constructivist-reader-folio is-right", "—");
  leftTap.type = "button";
  rightTap.type = "button";
  leftTap.setAttribute("aria-label", "向前翻一页");
  rightTap.setAttribute("aria-label", "向后翻一页");
  pages.append(renditionHost, leftTap, rightTap, leftFolio, rightFolio);
  spread.append(leftStack, pages, rightStack);

  const toc = element("aside", "constructivist-reader-toc");
  const tocHeading = element("div", "constructivist-reader-toc-heading");
  tocHeading.append(
    element("b", "", "CONTENTS"),
    element("span", "", "目录")
  );
  const tocList = element("div", "constructivist-reader-toc-list");
  toc.append(tocHeading, tocList);

  const error = element("div", "constructivist-reader-error");
  error.hidden = true;
  const footnotePanel = element("aside", "constructivist-reader-footnote");
  const footnoteTitle = element("div", "constructivist-reader-footnote-title", "脚注");
  const footnoteText = element("p", "constructivist-reader-footnote-text");
  const footnoteClose = element("button", "constructivist-reader-footnote-close", "×");
  footnoteClose.type = "button";
  footnoteClose.setAttribute("aria-label", "关闭脚注");
  footnotePanel.hidden = true;
  footnotePanel.append(footnoteTitle, footnoteText, footnoteClose);
  book.append(header, spread, toc, footnotePanel, error);
  root.append(backdrop, book);
  host.append(root);

  const handlePageTap = async (event, direction) => {
    if (await callbacks.footnoteAtPoint?.(event.clientX, event.clientY)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    callbacks.flip(direction, 1);
  };
  backdrop.addEventListener("click", () => callbacks.close());
  leftTap.addEventListener("click", (event) => handlePageTap(event, "previous"));
  rightTap.addEventListener("click", (event) => handlePageTap(event, "next"));
  leftStack.addEventListener("click", (event) => {
    const box = leftStack.getBoundingClientRect();
    const ratio = 1 - (event.clientX - box.left) / Math.max(1, box.width);
    callbacks.stack("previous", ratio);
  });
  rightStack.addEventListener("click", (event) => {
    const box = rightStack.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / Math.max(1, box.width);
    callbacks.stack("next", ratio);
  });
  tocToggle.addEventListener("click", () => {
    const isOpen = book.classList.toggle("is-toc-open");
    tocToggle.setAttribute("aria-expanded", String(isOpen));
  });
  toc.addEventListener("wheel", (event) => {
    const delta = event.deltaY || event.deltaX;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tocList.clientHeight : 1;
    tocList.scrollTop += delta * unit;
  }, { passive: false });
  footnoteClose.addEventListener("click", () => {
    footnotePanel.hidden = true;
    book.classList.remove("has-footnote");
  });

  const inputWindows = new Set();
  let wheelAccumulated = 0;
  let lastWheelFlipAt = 0;
  const flipOnePage = (direction) => callbacks.flip(direction, 1);
  const handleKeydown = (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      flipOnePage("previous");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      flipOnePage("next");
    }
  };
  const handleWheel = (event) => {
    if (event.target?.closest?.(".constructivist-reader-toc")) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const dominantDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!dominantDelta) return;
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 320 : 1;
    wheelAccumulated += dominantDelta * unit;
    const now = performance.now();
    if (Math.abs(wheelAccumulated) < 80 || now - lastWheelFlipAt < 260) return;
    flipOnePage(wheelAccumulated > 0 ? "next" : "previous");
    wheelAccumulated = 0;
    lastWheelFlipAt = now;
  };
  const bindInputWindow = (targetWindow) => {
    if (!targetWindow || inputWindows.has(targetWindow)) return;
    inputWindows.add(targetWindow);
    targetWindow.addEventListener("keydown", handleKeydown, true);
    targetWindow.addEventListener("wheel", handleWheel, { passive: false, capture: true });
  };
  root.addEventListener("keydown", handleKeydown, true);
  root.addEventListener("wheel", handleWheel, { passive: false, capture: true });
  window.requestAnimationFrame(() => root.focus({ preventScroll: true }));

  let closingPromise = null;
  return {
    root,
    book,
    pages,
    renditionHost,
    setReady() {
      book.classList.remove("is-loading");
    },
    setPosition(title, percentage) {
      const normalized = Math.max(0, Math.min(1, Number(percentage) || 0));
      const stackWidths = stackWidthsFromProgress(normalized);
      chapter.textContent = title || "未命名章节";
      progress.textContent = `${String(Math.round(normalized * 100)).padStart(2, "0")}%`;
      spread.style.setProperty("--reader-left-stack-width", `${stackWidths.left}%`);
      spread.style.setProperty("--reader-right-stack-width", `${stackWidths.right}%`);
    },
    setBounds(atStart, atEnd) {
      leftStack.disabled = Boolean(atStart);
      rightStack.disabled = Boolean(atEnd);
      leftTap.disabled = Boolean(atStart);
      rightTap.disabled = Boolean(atEnd);
      book.classList.toggle("is-at-start", Boolean(atStart));
      book.classList.toggle("is-at-end", Boolean(atEnd));
    },
    renderToc(items) {
      tocList.replaceChildren();
      const appendItems = (entries, depth = 0) => {
        for (const item of entries || []) {
          const button = element("button", "constructivist-reader-toc-item", item.label || "未命名章节");
          button.type = "button";
          button.style.setProperty("--toc-depth", String(depth));
          button.addEventListener("click", async () => {
            const didNavigate = await callbacks.chapter(item.href);
            if (didNavigate === false) return;
            book.classList.remove("is-toc-open");
            tocToggle.setAttribute("aria-expanded", "false");
          });
          tocList.append(button);
          appendItems(item.subitems, depth + 1);
        }
      };
      appendItems(items);
    },
    setPageNumbers(startPage, endPage, totalPages) {
      const format = (page) => Number.isFinite(page) && page > 0
        ? String(Math.round(page)).padStart(2, "0")
        : "—";
      leftFolio.textContent = format(startPage);
      rightFolio.textContent = format(endPage);
      const total = Number.isFinite(totalPages) && totalPages > 0 ? Math.round(totalPages) : null;
      leftFolio.title = total ? `全书第 ${format(startPage)} / ${total} 页` : "";
      rightFolio.title = total ? `全书第 ${format(endPage)} / ${total} 页` : "";
    },
    setFixedLayout(isFixed) {
      book.classList.toggle("is-fixed-layout", Boolean(isFixed));
    },
    bindContentWindow(targetWindow) {
      bindInputWindow(targetWindow);
    },
    showFootnote(label, text) {
      const cleanText = String(text || "").replace(/\s+/g, " ").trim();
      if (!cleanText) return;
      footnoteTitle.textContent = label ? `脚注 ${label}` : "脚注";
      footnoteText.textContent = cleanText;
      footnotePanel.hidden = false;
      book.classList.add("has-footnote");
    },
    hideFootnote() {
      footnotePanel.hidden = true;
      book.classList.remove("has-footnote");
    },
    showError(message) {
      error.hidden = false;
      error.replaceChildren(
        element("b", "", "EPUB / ERROR"),
        element("p", "", message || "无法打开这本书。")
      );
      book.classList.remove("is-loading");
      book.classList.add("has-error");
    },
    startClosing() {
      if (closingPromise) return closingPromise;
      root.classList.add("is-closing");
      closingPromise = new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        book.addEventListener("animationend", (event) => {
          if (event.animationName === "constructivist-reader-book-close") finish();
        });
        window.setTimeout(finish, 800);
      });
      return closingPromise;
    },
    destroy() {
      root.removeEventListener("keydown", handleKeydown, true);
      root.removeEventListener("wheel", handleWheel, true);
      for (const targetWindow of inputWindows) {
        targetWindow.removeEventListener("keydown", handleKeydown, true);
        targetWindow.removeEventListener("wheel", handleWheel, true);
      }
      inputWindows.clear();
      root.remove();
    }
  };
}
