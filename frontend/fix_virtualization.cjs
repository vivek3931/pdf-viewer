const fs = require('fs');

const file = 'src/components/PDFViewer.jsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Remove intersection observers
content = content.replace(/const globalPageObserver[\s\S]*?\}, \{ rootMargin: '500px', threshold: 0 \}\);\n\n/m, '');

// 2. Fix VisiblePage signature and remove observer
content = content.replace(
  /const VisiblePage = React\.memo\(\(\{ pageNumber, targetScale, renderedScale, isBookmarked, pageRefs \}\) => \{[\s\S]*?const onPageLoadSuccess = \(page\) => \{/m,
  `const VisiblePage = React.memo(({ pageNumber, targetScale, renderedScale, isBookmarked, onSizeChange }) => {
  const [isRendered, setIsRendered] = useState(false);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 }); // Default A4 fallback
  
  const [mountedScales, setMountedScales] = useState([renderedScale]);
  const [activeScale, setActiveScale] = useState(renderedScale);
  const renderedScaleRef = useRef(renderedScale);

  useEffect(() => {
    renderedScaleRef.current = renderedScale;
  }, [renderedScale]);

  useEffect(() => {
    setMountedScales(prev => {
      if (!prev.includes(renderedScale)) {
        setIsRendered(false);
        return [...prev, renderedScale];
      }
      return prev;
    });
  }, [renderedScale]);

  const onPageLoadSuccess = (page) => {`
);

// 3. Remove ref assignment in VisiblePage wrapper
content = content.replace(
  /ref=\{\(el\) => \{\n\s*containerRef\.current = el;\n\s*if \(pageRefs && pageRefs\.current\) pageRefs\.current\[pageNumber\] = el;\n\s*\}\}/m,
  ''
);

// 4. Update onPageLoadSuccess
content = content.replace(
  /setPageSize\(\{ width: page\.width \/ renderedScale, height: page\.height \/ renderedScale \}\);\n  \};/m,
  `const size = { width: page.width / renderedScale, height: page.height / renderedScale };
    setPageSize(size);
    if (onSizeChange) onSizeChange(pageNumber, size);
  };`
);

// 5. Fix ThumbnailItem
content = content.replace(
  /const ThumbnailItem = React\.memo\(\(\{ pageNum, isActive, scrollToPage, isBookmarked \}\) => \{[\s\S]*?return \(/m,
  `const ThumbnailItem = React.memo(({ pageNum, isActive, scrollToPage, isBookmarked }) => {
  return (`
);

content = content.replace(
  /<div ref=\{containerRef\}/m,
  `<div`
);

content = content.replace(
  /\{isVisible \? <Page/m,
  `<Page`
);

content = content.replace(
  /\} \/> : <div style=\{\{ width: 120, height: 160 \}\} \/>\}/m,
  `/>`
);

// 6. Inject Virtualization logic to PDFViewer
content = content.replace(
  /\/\/ Refs\n  const containerRef = useRef\(null\);\n  const viewerRef = useRef\(null\);\n  const pageRefs = useRef\(\{\}\);\n  const controlsTimeoutRef = useRef\(null\);\n  const zoomTimeoutRef = useRef\(null\);\n  const pdfDocRef = useRef\(null\);\n  const pendingScrollRef = useRef\(null\);/m,
  `// Virtualization state
  const [pageSizes, setPageSizes] = useState({});
  const [scrollTop, setScrollTop] = useState(0);
  const [sidebarScrollTop, setSidebarScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);
  const [sidebarHeight, setSidebarHeight] = useState(800);

  // Refs
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const sidebarRef = useRef(null);
  const controlsTimeoutRef = useRef(null);
  const zoomTimeoutRef = useRef(null);
  const pdfDocRef = useRef(null);
  const pendingScrollRef = useRef(null);

  const DEFAULT_WIDTH = 595;
  const DEFAULT_HEIGHT = 842;
  const GAP = 40;

  const { totalHeight, pageOffsets, containerWidth } = useMemo(() => {
    if (!numPages) return { totalHeight: 0, pageOffsets: [], containerWidth: DEFAULT_WIDTH };
    const offsets = [];
    let currentTop = 0;
    let maxWidth = 0;
    const scale = zoom / 100;
    
    for (let i = 1; i <= numPages; i++) {
      offsets.push(currentTop);
      const size = pageSizes[i] || { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
      currentTop += (size.height * scale) + (GAP * scale);
      if (size.width * scale > maxWidth) maxWidth = size.width * scale;
    }
    return { totalHeight: currentTop, pageOffsets: offsets, containerWidth: maxWidth };
  }, [numPages, pageSizes, zoom]);

  const visiblePages = useMemo(() => {
    if (!numPages || pageOffsets.length === 0) return [];
    let low = 0, high = pageOffsets.length - 1;
    let startIndex = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (pageOffsets[mid] <= scrollTop && (mid === pageOffsets.length - 1 || pageOffsets[mid + 1] > scrollTop)) {
        startIndex = mid; break;
      } else if (pageOffsets[mid] < scrollTop) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    
    let endIndex = startIndex;
    while (endIndex < numPages - 1 && pageOffsets[endIndex] < scrollTop + viewportHeight) {
      endIndex++;
    }
    
    const start = Math.max(0, startIndex - 2);
    const end = Math.min(numPages - 1, endIndex + 2);
    
    const pages = [];
    for (let i = start; i <= end; i++) pages.push(i + 1);
    return pages;
  }, [scrollTop, viewportHeight, pageOffsets, numPages]);

  const THUMB_HEIGHT = 170; // 160 + 10 gap
  const visibleThumbs = useMemo(() => {
    if (!numPages) return [];
    const startIndex = Math.max(0, Math.floor(sidebarScrollTop / THUMB_HEIGHT) - 3);
    const endIndex = Math.min(numPages - 1, Math.floor((sidebarScrollTop + sidebarHeight) / THUMB_HEIGHT) + 3);
    const thumbs = [];
    for (let i = startIndex; i <= endIndex; i++) thumbs.push(i + 1);
    return thumbs;
  }, [sidebarScrollTop, sidebarHeight, numPages]);

  useEffect(() => {
    if (viewerRef.current) setViewportHeight(viewerRef.current.clientHeight);
    if (sidebarRef.current) setSidebarHeight(sidebarRef.current.clientHeight);
    const observer = new ResizeObserver(() => {
      if (viewerRef.current) setViewportHeight(viewerRef.current.clientHeight);
      if (sidebarRef.current) setSidebarHeight(sidebarRef.current.clientHeight);
    });
    if (viewerRef.current) observer.observe(viewerRef.current);
    if (sidebarRef.current) observer.observe(sidebarRef.current);
    return () => observer.disconnect();
  }, [numPages, sidebarOpen]);`
);

// 7. Replace scrollToPage
content = content.replace(
  /const scrollToPage = useCallback\(\(pageNum\) => \{[\s\S]*?\}, \[isMobile, updateHistoryPage\]\);/m,
  `const scrollToPage = useCallback((pageNum) => {
    setCurrentPage(pageNum);
    const top = pageOffsets[pageNum - 1];
    if (viewerRef.current && top !== undefined) {
      viewerRef.current.scrollTo({ top, behavior: 'smooth' });
    }
    if (isMobile) setSidebarOpen(false);
    updateHistoryPage(pageNum);
  }, [pageOffsets, isMobile, updateHistoryPage]);`
);

// 8. Replace handleScroll
content = content.replace(
  /const handleScroll = useCallback\(\(\) => \{[\s\S]*?\}, \[numPages, showControls\]\);/m,
  `const handleScroll = useCallback(() => {
    if (!viewerRef.current) return;
    const top = viewerRef.current.scrollTop;
    setScrollTop(top);
    
    const center = top + (viewerRef.current.clientHeight / 2);
    let low = 0, high = pageOffsets.length - 1;
    let closest = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (pageOffsets[mid] <= center && (mid === pageOffsets.length - 1 || pageOffsets[mid + 1] > center)) {
        closest = mid + 1;
        break;
      } else if (pageOffsets[mid] < center) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    
    setCurrentPage(prev => prev !== closest ? closest : prev);
    showControls();
  }, [pageOffsets, showControls]);`
);

// 9. Update Sidebar rendering
content = content.replace(
  /<ScrollArea className="flex-1">/m,
  `<div className="flex-1 overflow-y-auto" ref={sidebarRef} onScroll={(e) => setSidebarScrollTop(e.target.scrollTop)}>`
);

content = content.replace(
  /<\/ScrollArea>/g,
  `</div>`
);

content = content.replace(
  /<div className="p-2">\n\s*\{numPages && \(\n\s*<Document file=\{pdfSource\} loading="">\n\s*\{Array\.from\(\{ length: numPages \}, \(_, i\) => i \+ 1\)\.map\(\(pageNum\) => \(\n\s*<ThumbnailItem \n\s*key=\{pageNum\}\n\s*pageNum=\{pageNum\}\n\s*isActive=\{currentPage === pageNum\}\n\s*scrollToPage=\{scrollToPage\}\n\s*isBookmarked=\{isPageBookmarked\(pageNum\)\}\n\s*\/>\n\s*\)\)\}\n\s*<\/Document>\n\s*\)\}\n\s*<\/div>/m,
  `<div className="p-2" style={{ height: (numPages || 0) * THUMB_HEIGHT, position: 'relative' }}>
                  {numPages && (
                    <Document file={pdfSource} loading="">
                      {visibleThumbs.map((pageNum) => (
                        <div key={pageNum} style={{ position: 'absolute', top: (pageNum - 1) * THUMB_HEIGHT, left: 8, right: 8 }}>
                          <ThumbnailItem 
                            pageNum={pageNum}
                            isActive={currentPage === pageNum}
                            scrollToPage={scrollToPage}
                            isBookmarked={isPageBookmarked(pageNum)}
                          />
                        </div>
                      ))}
                    </Document>
                  )}
                </div>`
);

// 10. Update Document rendering
content = content.replace(
  /<div className="pdf-pages-container">\n\s*<Document file=\{pdfSource\} onLoadSuccess=\{onDocumentLoadSuccess\} onLoadError=\{onDocumentLoadError\} loading=\{<div className="pdf-loading"><div className="pdf-loading-spinner" \/><\/div>\}>\n\s*\{numPages && Array\.from\(\{ length: numPages \}, \(_, i\) => i \+ 1\)\.map\(\(pageNum\) => \(\n\s*<VisiblePage \n\s*key=\{pageNum\}\n\s*pageNumber=\{pageNum\}\n\s*targetScale=\{zoom \/ 100\}\n\s*renderedScale=\{renderedZoom \/ 100\}\n\s*isBookmarked=\{isPageBookmarked\(pageNum\)\}\n\s*pageRefs=\{pageRefs\}\n\s*\/>\n\s*\)\)\}\n\s*<\/Document>\n\s*<\/div>/m,
  `<div 
              className="pdf-pages-container" 
              style={{ position: 'relative', height: totalHeight, width: Math.max(containerWidth, 595), display: 'inline-block' }}
            >
              <Document file={pdfSource} onLoadSuccess={onDocumentLoadSuccess} onLoadError={onDocumentLoadError} loading={<div className="pdf-loading"><div className="pdf-loading-spinner" /></div>}>
                {visiblePages.map((pageNum) => (
                  <div key={pageNum} style={{ position: 'absolute', top: pageOffsets[pageNum - 1], left: '50%', transform: 'translateX(-50%)' }}>
                    <VisiblePage 
                      pageNumber={pageNum}
                      targetScale={zoom / 100}
                      renderedScale={renderedZoom / 100}
                      isBookmarked={isPageBookmarked(pageNum)}
                      onSizeChange={(pageNumber, size) => setPageSizes(prev => ({ ...prev, [pageNumber]: size }))}
                    />
                  </div>
                ))}
              </Document>
            </div>`
);

fs.writeFileSync(file, content, 'utf8');
console.log('Virtualization engine injected.');
