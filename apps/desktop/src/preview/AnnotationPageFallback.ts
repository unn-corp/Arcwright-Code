/** Self-contained page-world extraction, independent of the picker preload and React internals. */
export const ANNOTATION_PAGE_FALLBACK_SCRIPT = `(() => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pageUrl = location.href;
  const pageTitle = document.title.trim() || null;
  const createdAt = new Date().toISOString();
  const candidates = [];
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const deadline = performance.now() + 150;
    let visited = 0;
    let element;
    while ((element = walker.nextNode()) && visited++ < 4096 && performance.now() < deadline) {
      if (element.closest('[data-t3code-annotation-ui]') || element.matches('script,style,link,meta,noscript')) continue;
      try {
        const rect = element.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0 && rect.left < width && rect.top < height && rect.right > 0 && rect.bottom > 0)) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        candidates.push({ rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          element: { pageUrl, pageTitle, pickedAt: createdAt, tagName: element.tagName.toLowerCase(),
            selector: element.id ? '#' + CSS.escape(element.id) : null,
            htmlPreview: element.outerHTML.slice(0, 500), componentName: null, source: null, stack: [],
            styles: 'color: ' + style.color + '; background-color: ' + style.backgroundColor + ';' } });
      } catch { /* One unusual element must not discard the page snapshot. */ }
    }
  }
  candidates.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
  return { pageUrl, pageTitle, createdAt, width, height,
    elements: candidates.slice(0, 256).map((target, index) => ({ id: 'snapshot-dom-' + index, ...target })) };
})()`;
