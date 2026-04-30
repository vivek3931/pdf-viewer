import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { toast } from 'sonner';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import axios from 'axios';
import {
  FilePdf,
  MagnifyingGlass,
  ArrowsOutSimple,
  ArrowsInSimple,
  List,
  DownloadSimple,
  Printer,
  Highlighter,
  X,
  CloudArrowUp,
  Link as LinkIcon,
  File as FileIcon,
  Minus,
  Plus,
  ArrowCounterClockwise,
  CaretUp,
  CaretDown,
  BookmarkSimple,
  Bookmarks,
  Trash,
  Clock
} from '@phosphor-icons/react';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Zoom configuration
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300, 400];
const MIN_ZOOM = 25;
const MAX_ZOOM = 500;

// Storage keys
const BOOKMARKS_KEY = 'pdf_viewer_bookmarks';
const HISTORY_KEY = 'pdf_viewer_history';

// ========== TRUE DOUBLE BUFFERING COMPONENT ==========
// This prevents the "blink" by rendering the new zoom level in the background
// and only swapping it to the front when it has successfully painted.
const VisiblePage = ({ pageNumber, targetScale, renderedScale, isBookmarked, pageRef }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 }); // Default A4 fallback
  
  // Track all scales currently in the DOM. Old scales stay mounted until new ones finish.
  const [mountedScales, setMountedScales] = useState([renderedScale]);
  const [activeScale, setActiveScale] = useState(renderedScale);
  
  const containerRef = useRef(null);
  const renderedScaleRef = useRef(renderedScale);

  // Keep a ref of the latest requested scale to avoid stale closures
  useEffect(() => {
    renderedScaleRef.current = renderedScale;
  }, [renderedScale]);

  // Lazy loading observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setIsVisible(true); },
      { rootMargin: '1000px', threshold: 0 }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { if (containerRef.current) observer.unobserve(containerRef.current); };
  }, []);

  // When a new zoom finishes its 300ms debounce, mount it in the background
  useEffect(() => {
    setMountedScales(prev => {
      if (!prev.includes(renderedScale)) return [...prev, renderedScale];
      return prev;
    });
  }, [renderedScale]);

  const onPageLoadSuccess = (page) => {
    setPageSize({ width: page.width / renderedScale, height: page.height / renderedScale });
  };

  const handleRenderSuccess = useCallback((scale) => {
    // The new high-res page is ready. Make it active.
    setActiveScale(scale);
    
    // Unmount all older versions to free up memory, keeping ONLY the newly active one 
    // and the target one (if the user kept zooming while this was rendering).
    setMountedScales(prev => prev.filter(s => s === scale || s === renderedScaleRef.current));
  }, []);

  return (
    <div 
      ref={(el) => {
        containerRef.current = el;
        if (pageRef) pageRef(el);
      }} 
      className="pdf-page-wrapper"
      style={{ 
        width: pageSize.width * targetScale,
        height: pageSize.height * targetScale,
        margin: '0 auto 40px auto',
        position: 'relative'
      }}
    >
      {isVisible ? mountedScales.map((scale) => {
        const isVisibleLayer = scale === activeScale;
        const visualScale = targetScale / scale;
        
        return (
          <div 
            key={scale}
            className="pdf-page-content"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              transform: visualScale === 1 ? 'none' : `scale(${visualScale})`,
              transformOrigin: 'top left',
              width: pageSize.width * scale,
              height: pageSize.height * scale,
              background: 'white',
              boxShadow: isVisibleLayer ? '0 8px 30px rgba(0, 0, 0, 0.12)' : 'none',
              borderRadius: '4px',
              overflow: 'hidden',
              // The active layer sits on top and is visible. Rendering layers are hidden beneath.
              zIndex: isVisibleLayer ? 2 : 1,
              opacity: isVisibleLayer ? 1 : 0,
              pointerEvents: isVisibleLayer ? 'auto' : 'none'
            }}
          >
            {isVisibleLayer && (
              <div className="pdf-page-indicators">
                <span className="pdf-page-number">{pageNumber}</span>
                {isBookmarked && <BookmarkSimple size={14} weight="fill" className="pdf-page-bookmark" />}
              </div>
            )}
            
            <Page 
              pageNumber={pageNumber} 
              scale={scale} 
              devicePixelRatio={window.devicePixelRatio || 1}
              onLoadSuccess={onPageLoadSuccess}
              onRenderSuccess={() => handleRenderSuccess(scale)}
              renderTextLayer={true} 
              renderAnnotationLayer={true} 
              loading={null}
            />
          </div>
        );
      }) : (
        <div className="pdf-page-loading-placeholder" style={{ position: 'absolute', inset: 0 }}>
          <div className="pdf-loading-spinner" />
        </div>
      )}
    </div>
  );
};

const PDFViewer = () => {
  // Core state
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfName, setPdfName] = useState('');
  const [numPages, setNumPages] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [renderedZoom, setRenderedZoom] = useState(100);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState('pages');
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const [pageTexts, setPageTexts] = useState({});
  const [highlightedText, setHighlightedText] = useState('');
  
  // UI state
  const [isDragging, setIsDragging] = useState(false);
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotations, setAnnotations] = useState([]);
  const [highlightColor, setHighlightColor] = useState('yellow');
  const [urlInput, setUrlInput] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  
  // Bookmarks & History state
  const [bookmarks, setBookmarks] = useState([]);
  const [history, setHistory] = useState([]);

  // Refs
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const fileInputRef = useRef(null);
  const pageRefs = useRef({});
  const zoomMenuRef = useRef(null);
  const controlsTimeoutRef = useRef(null);
  const zoomTimeoutRef = useRef(null);
  const pdfDocRef = useRef(null);
  const pendingScrollRef = useRef(null);

  useEffect(() => {
    try {
      const savedBookmarks = localStorage.getItem(BOOKMARKS_KEY);
      const savedHistory = localStorage.getItem(HISTORY_KEY);
      if (savedBookmarks) setBookmarks(JSON.parse(savedBookmarks));
      if (savedHistory) setHistory(JSON.parse(savedHistory));
    } catch (e) {
      console.error('Error loading from localStorage:', e);
    }
  }, []);

  useEffect(() => {
    try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks)); } 
    catch (e) { console.error('Error saving bookmarks:', e); }
  }, [bookmarks]);

  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } 
    catch (e) { console.error('Error saving history:', e); }
  }, [history]);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (!showZoomMenu) setControlsVisible(false);
    }, 3000);
  }, [showZoomMenu]);

  useEffect(() => {
    const handleInteraction = () => showControls();
    window.addEventListener('mousemove', handleInteraction);
    window.addEventListener('touchstart', handleInteraction);
    window.addEventListener('scroll', handleInteraction, true);
    return () => {
      window.removeEventListener('mousemove', handleInteraction);
      window.removeEventListener('touchstart', handleInteraction);
      window.removeEventListener('scroll', handleInteraction, true);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [showControls]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (zoomMenuRef.current && !zoomMenuRef.current.contains(e.target)) {
        setShowZoomMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focal Point Scroll Compensation
  useLayoutEffect(() => {
    if (pendingScrollRef.current && viewerRef.current) {
      viewerRef.current.scrollLeft = pendingScrollRef.current.left;
      viewerRef.current.scrollTop = pendingScrollRef.current.top;
      pendingScrollRef.current = null;
    }
  }, [zoom]);

  // Debounce the high-res render to prevent destroying the CPU
  useEffect(() => {
    if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    zoomTimeoutRef.current = setTimeout(() => setRenderedZoom(zoom), 300);
    return () => { if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current); };
  }, [zoom]);

  const onDocumentLoadSuccess = async (pdf) => {
    setNumPages(pdf.numPages);
    setCurrentPage(1);
    setIsLoading(false);
    setError(null);
    pdfDocRef.current = pdf;
    toast.success(`PDF loaded: ${pdf.numPages} pages`);
    extractAllText(pdf);
    
    if (pdfName) addToHistory(pdfName, pdf.numPages);
  };

  const addToHistory = useCallback((name, pages) => {
    const newEntry = { id: Date.now(), name: name, pages: pages, timestamp: new Date().toISOString(), lastPage: 1 };
    setHistory(prev => {
      const filtered = prev.filter(h => h.name !== name);
      return [newEntry, ...filtered].slice(0, 20);
    });
  }, []);

  const updateHistoryPage = useCallback((page) => {
    if (!pdfName) return;
    setHistory(prev => prev.map(h => h.name === pdfName ? { ...h, lastPage: page } : h));
  }, [pdfName]);

  const extractAllText = async (pdf) => {
    const texts = {};
    for (let i = 1; i <= pdf.numPages; i++) {
      try {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        texts[i] = textContent.items.map(item => ({ str: item.str, transform: item.transform }));
      } catch (err) {
        console.error(`Error extracting text from page ${i}:`, err);
        texts[i] = [];
      }
    }
    setPageTexts(texts);
  };

  const onDocumentLoadError = (error) => {
    console.error('PDF load error:', error);
    setIsLoading(false);
    setError('Failed to load PDF.');
    toast.error('Failed to load PDF');
  };

  const handleFileSelect = (file) => {
    if (file && file.type === 'application/pdf') {
      setIsLoading(true);
      setPdfFile(file);
      setPdfUrl('');
      setPdfName(file.name);
      resetState();
    } else if (file) {
      toast.error('Please select a valid PDF file');
    }
  };

  const resetState = () => {
    setAnnotations([]);
    setSearchQuery('');
    setSearchResults([]);
    setPageTexts({});
    setZoom(100);
    setRenderedZoom(100);
    setHighlightedText('');
    setCurrentSearchIndex(0);
  };

  const handleFileInputChange = (e) => handleFileSelect(e.target.files?.[0]);

  const handleUrlLoad = async () => {
    if (!urlInput.trim()) return;
    const url = urlInput.trim();
    
    if (url.toLowerCase().endsWith('.pdf') || url.includes('pdf')) {
      setIsLoading(true);
      setError(null);
      setPdfFile(null);
      setPdfName(url.split('/').pop() || 'document.pdf');
      resetState();
      
      try {
        const response = await axios.post(`${API}/pdf/proxy`, { url }, { responseType: 'blob', timeout: 60000 });
        const blob = new Blob([response.data], { type: 'application/pdf' });
        setPdfUrl(URL.createObjectURL(blob));
        setUrlInput('');
      } catch (err) {
        console.error('Failed to load PDF:', err);
        setIsLoading(false);
        setError('Failed to load PDF from URL.');
        toast.error('Failed to load PDF');
      }
    } else {
      toast.error('Please enter a valid PDF URL');
    }
  };

  const handleDragEnter = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setIsDragging(false); };
  const handleDragOver = (e) => { e.preventDefault(); };
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files?.[0]);
  };

  // ========== FOCAL ZOOM ENGINE ==========
  const applyZoom = useCallback((zoomModifier, focalX, focalY) => {
    setZoom(prev => {
      let nextZoom = typeof zoomModifier === 'function' ? zoomModifier(prev) : zoomModifier;
      const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(nextZoom)));
      if (clampedZoom === prev) return prev;

      const viewer = viewerRef.current;
      if (viewer) {
        const zoomRatio = clampedZoom / prev;
        
        let cX, cY;
        if (focalX !== undefined && focalY !== undefined) {
           cX = focalX;
           cY = focalY;
        } else {
           const rect = viewer.getBoundingClientRect();
           cX = rect.width / 2;
           cY = rect.height / 2;
        }

        const contentX = cX + viewer.scrollLeft;
        const contentY = cY + viewer.scrollTop;

        pendingScrollRef.current = {
          left: (contentX * zoomRatio) - cX,
          top: (contentY * zoomRatio) - cY
        };
      }

      return clampedZoom;
    });
    showControls();
  }, [showControls]);

  const handleZoomChange = useCallback((newZoom) => applyZoom(newZoom), [applyZoom]);
  
  const handleZoomIn = useCallback(() => {
    applyZoom(prev => ZOOM_PRESETS.find(p => p > prev) || prev + 25);
  }, [applyZoom]);

  const handleZoomOut = useCallback(() => {
    applyZoom(prev => [...ZOOM_PRESETS].reverse().find(p => p < prev) || prev - 25);
  }, [applyZoom]);

  const handleZoomReset = useCallback(() => applyZoom(100), [applyZoom]);

  const pinchRef = useRef({ distance: 0, zoom: 100, active: false, mouseX: 0, mouseY: 0 });

  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      e.preventDefault(); 
      const viewer = viewerRef.current;
      if (!viewer) return;

      const rect = viewer.getBoundingClientRect();
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      const clientX = (touch1.clientX + touch2.clientX) / 2;
      const clientY = (touch1.clientY + touch2.clientY) / 2;
      
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;
      const dist = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);

      pinchRef.current = { distance: dist, zoom, active: true, mouseX, mouseY };
    }
  }, [zoom]);

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && pinchRef.current.active) {
      e.preventDefault();
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
      
      const scale = dist / pinchRef.current.distance;
      applyZoom(pinchRef.current.zoom * scale, pinchRef.current.mouseX, pinchRef.current.mouseY);
    }
  }, [applyZoom]);

  const handleTouchEnd = useCallback(() => { pinchRef.current.active = false; }, []);

  const handleWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const viewer = viewerRef.current;
      if (!viewer) return;

      const rect = viewer.getBoundingClientRect();
      const focalX = e.clientX - rect.left;
      const focalY = e.clientY - rect.top;
      const delta = -e.deltaY * 0.1; 
      
      applyZoom(prev => prev + delta, focalX, focalY);
    }
  }, [applyZoom]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer) {
      viewer.addEventListener('wheel', handleWheel, { passive: false });
      viewer.addEventListener('touchstart', handleTouchStart, { passive: false });
      viewer.addEventListener('touchmove', handleTouchMove, { passive: false });
      viewer.addEventListener('touchend', handleTouchEnd);
      return () => {
        viewer.removeEventListener('wheel', handleWheel);
        viewer.removeEventListener('touchstart', handleTouchStart);
        viewer.removeEventListener('touchmove', handleTouchMove);
        viewer.removeEventListener('touchend', handleTouchEnd);
      };
    }
  }, [handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

  // Search Logic
  const performSearch = useCallback((query) => {
    if (!query.trim() || Object.keys(pageTexts).length === 0) {
      setSearchResults([]);
      setCurrentSearchIndex(0);
      setHighlightedText('');
      return;
    }

    const searchTerm = query.toLowerCase();
    const results = [];

    Object.entries(pageTexts).forEach(([pageNum, items]) => {
      const pageText = items.map(item => item.str).join('').toLowerCase();
      let index = 0;
      while ((index = pageText.indexOf(searchTerm, index)) !== -1) {
        results.push({ page: parseInt(pageNum), index });
        index += searchTerm.length;
      }
    });

    setSearchResults(results);
    setCurrentSearchIndex(0);
    setHighlightedText(query);

    if (results.length > 0) {
      toast.success(`Found ${results.length} results`);
      scrollToPage(results[0].page);
      highlightSearchInPage(results[0].page, query);
    } else {
      toast.info('No results found');
    }
  }, [pageTexts]);

  const highlightSearchInPage = useCallback((pageNum, query) => {
    setTimeout(() => {
      const pageEl = pageRefs.current[pageNum];
      if (!pageEl) return;

      document.querySelectorAll('.search-highlight-marker').forEach(el => el.remove());
      const textLayer = pageEl.querySelector('.react-pdf__Page__textContent');
      if (!textLayer) return;

      const spans = textLayer.querySelectorAll('span');
      const searchLower = query.toLowerCase();

      spans.forEach(span => {
        const text = span.textContent.toLowerCase();
        if (text.includes(searchLower)) {
          const highlight = document.createElement('div');
          highlight.className = 'search-highlight-marker';
          const rect = span.getBoundingClientRect();
          const pageRect = pageEl.getBoundingClientRect();
          highlight.style.cssText = `
            position: absolute;
            left: ${rect.left - pageRect.left}px;
            top: ${rect.top - pageRect.top}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            background: rgba(255, 213, 0, 0.4);
            border-radius: 2px;
            pointer-events: none;
            z-index: 5;
          `;
          pageEl.style.position = 'relative';
          pageEl.appendChild(highlight);
        }
      });
    }, 100);
  }, []);

  const handleSearch = useCallback((query) => setSearchQuery(query), []);

  const executeSearch = useCallback(() => performSearch(searchQuery), [searchQuery, performSearch]);

  const navigateSearch = useCallback((direction) => {
    if (searchResults.length === 0) return;
    const newIndex = direction === 'next' 
      ? (currentSearchIndex + 1) % searchResults.length
      : (currentSearchIndex - 1 + searchResults.length) % searchResults.length;
    setCurrentSearchIndex(newIndex);
    const result = searchResults[newIndex];
    scrollToPage(result.page);
    highlightSearchInPage(result.page, searchQuery);
  }, [searchResults, currentSearchIndex, searchQuery, highlightSearchInPage]);

  useEffect(() => {
    if (!searchQuery) {
      document.querySelectorAll('.search-highlight-marker').forEach(el => el.remove());
    }
  }, [searchQuery]);

  // Bookmarks & History
  const isPageBookmarked = useCallback((page) => {
    return bookmarks.some(b => b.pdfName === pdfName && b.page === page);
  }, [bookmarks, pdfName]);

  const toggleBookmark = useCallback((page = currentPage) => {
    if (!pdfName) return;
    const existing = bookmarks.find(b => b.pdfName === pdfName && b.page === page);
    if (existing) {
      setBookmarks(prev => prev.filter(b => b.id !== existing.id));
      toast.info(`Removed bookmark from page ${page}`);
    } else {
      const newBookmark = { id: Date.now(), pdfName: pdfName, page: page, timestamp: new Date().toISOString(), label: `Page ${page}` };
      setBookmarks(prev => [...prev, newBookmark]);
      toast.success(`Bookmarked page ${page}`);
    }
  }, [bookmarks, pdfName, currentPage]);

  const getCurrentPdfBookmarks = useMemo(() => {
    return bookmarks.filter(b => b.pdfName === pdfName).sort((a, b) => a.page - b.page);
  }, [bookmarks, pdfName]);

  const deleteBookmark = useCallback((id) => {
    setBookmarks(prev => prev.filter(b => b.id !== id));
    toast.info('Bookmark deleted');
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    toast.info('History cleared');
  }, []);

  // UI Navigation & Tools
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen();
    else document.exitFullscreen();
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const scrollToPage = useCallback((pageNum) => {
    setCurrentPage(pageNum);
    pageRefs.current[pageNum]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (isMobile) setSidebarOpen(false);
    updateHistoryPage(pageNum);
  }, [isMobile, updateHistoryPage]);

  const handleScroll = useCallback(() => {
    if (!numPages || !viewerRef.current) return;
    const viewerTop = viewerRef.current.getBoundingClientRect().top;
    let closest = 1, minDist = Infinity;

    for (let i = 1; i <= numPages; i++) {
      const el = pageRefs.current[i];
      if (el) {
        const dist = Math.abs(el.getBoundingClientRect().top - viewerTop);
        if (dist < minDist) { minDist = dist; closest = i; }
      }
    }
    setCurrentPage(closest);
    showControls();
  }, [numPages, showControls]);

  const handleDownload = useCallback(() => {
    const url = pdfFile ? URL.createObjectURL(pdfFile) : pdfUrl;
    const a = document.createElement('a');
    a.href = url;
    a.download = pdfName || 'document.pdf';
    a.click();
    if (pdfFile) URL.revokeObjectURL(url);
    toast.success('Download started');
  }, [pdfFile, pdfUrl, pdfName]);

  const handlePrint = useCallback(() => {
    const url = pdfFile ? URL.createObjectURL(pdfFile) : pdfUrl;
    const win = window.open(url, '_blank');
    win?.addEventListener('load', () => setTimeout(() => win.print(), 500));
    toast.info('Opening print dialog...');
  }, [pdfFile, pdfUrl]);

  const toggleAnnotationMode = useCallback(() => {
    setAnnotationMode(prev => !prev);
    if (!annotationMode) toast.info('Annotation mode enabled');
  }, [annotationMode]);

  const handleTextSelection = useCallback(() => {
    if (!annotationMode) return;
    const selection = window.getSelection();
    if (selection?.toString().trim()) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const viewerRect = viewerRef.current?.getBoundingClientRect();
      if (viewerRect) {
        setAnnotations(prev => [...prev, {
          id: Date.now(),
          color: highlightColor,
          rect: {
            top: rect.top - viewerRect.top + viewerRef.current.scrollTop,
            left: rect.left - viewerRect.left,
            width: rect.width,
            height: rect.height
          },
          page: currentPage
        }]);
        toast.success('Highlighted');
        selection.removeAllRanges();
      }
    }
  }, [annotationMode, highlightColor, currentPage]);

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') {
        if (isFullscreen) document.exitFullscreen();
        if (sidebarOpen && isMobile) setSidebarOpen(false);
        setShowZoomMenu(false);
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); handleZoomIn(); }
        if (e.key === '-') { e.preventDefault(); handleZoomOut(); }
        if (e.key === '0') { e.preventDefault(); handleZoomReset(); }
        if (e.key === 'b') { e.preventDefault(); toggleBookmark(); }
        if (e.key === 'f') { e.preventDefault(); executeSearch(); }
      }
      if (e.key === 'ArrowLeft' && currentPage > 1) scrollToPage(currentPage - 1);
      if (e.key === 'ArrowRight' && currentPage < numPages) scrollToPage(currentPage + 1);
      if (e.key === 'Enter' && searchQuery) executeSearch();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFullscreen, currentPage, numPages, scrollToPage, handleZoomIn, handleZoomOut, handleZoomReset, sidebarOpen, isMobile, searchQuery, executeSearch, toggleBookmark]);

  const pdfSource = pdfFile || pdfUrl;

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div ref={containerRef} className={`pdf-app-container ${isFullscreen ? 'pdf-viewer-fullscreen' : ''}`} data-testid="pdf-viewer-container">
      <header className="pdf-header">
        <div className="flex items-center gap-2 md:gap-4">
          <div className="pdf-logo">
            <div className="pdf-logo-icon"><FilePdf size={18} weight="fill" /></div>
            <span className="hidden sm:inline">PDF Viewer</span>
          </div>
          {pdfSource && (
            <button className="pdf-toolbar-btn" onClick={() => setSidebarOpen(!sidebarOpen)} data-testid="toggle-sidebar-btn">
              <List size={20} weight={sidebarOpen ? 'fill' : 'regular'} />
            </button>
          )}
        </div>

        {pdfSource && (
          <div className="pdf-toolbar">
            <div className="pdf-search-wrapper">
              <MagnifyingGlass size={16} className="pdf-search-icon" />
              <input type="text" placeholder="Search..." className="pdf-search-input" value={searchQuery} onChange={(e) => handleSearch(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && executeSearch()} data-testid="search-input" />
              {searchResults.length > 0 && (
                <div className="pdf-search-nav">
                  <span className="text-xs text-zinc-500">{currentSearchIndex + 1}/{searchResults.length}</span>
                  <button onClick={() => navigateSearch('prev')} className="pdf-search-nav-btn"><CaretUp size={14} /></button>
                  <button onClick={() => navigateSearch('next')} className="pdf-search-nav-btn"><CaretDown size={14} /></button>
                </div>
              )}
            </div>

            <button className="pdf-toolbar-btn md:hidden" onClick={() => setShowMobileSearch(true)} data-testid="mobile-search-btn">
              <MagnifyingGlass size={20} />
            </button>

            <div className="pdf-toolbar-divider hidden sm:block" />

            <button className={`pdf-toolbar-btn ${isPageBookmarked(currentPage) ? 'active' : ''}`} onClick={() => toggleBookmark()} data-testid="bookmark-btn" title="Bookmark page">
              <BookmarkSimple size={20} weight={isPageBookmarked(currentPage) ? 'fill' : 'regular'} />
            </button>

            <button className={`pdf-toolbar-btn ${annotationMode ? 'active' : ''}`} onClick={toggleAnnotationMode} data-testid="annotation-toggle-btn">
              <Highlighter size={20} weight={annotationMode ? 'fill' : 'regular'} />
            </button>

            <div className="pdf-toolbar-divider hidden sm:block" />

            <button className="pdf-toolbar-btn" onClick={handleDownload} data-testid="download-btn">
              <DownloadSimple size={20} />
            </button>

            <button className="pdf-toolbar-btn hidden sm:flex" onClick={handlePrint} data-testid="print-btn">
              <Printer size={20} />
            </button>

            <div className="pdf-toolbar-divider" />

            <button className="pdf-toolbar-btn" onClick={toggleFullscreen} data-testid="fullscreen-btn">
              {isFullscreen ? <ArrowsInSimple size={20} /> : <ArrowsOutSimple size={20} />}
            </button>
          </div>
        )}
      </header>

      <div className="pdf-main-content">
        {pdfSource && (
          <aside className={`pdf-sidebar ${sidebarOpen ? 'open' : ''} ${isMobile ? 'mobile' : ''}`} data-testid="pdf-sidebar">
            <div className="pdf-sidebar-tabs">
              <button className={`pdf-sidebar-tab ${sidebarTab === 'pages' ? 'active' : ''}`} onClick={() => setSidebarTab('pages')} data-testid="tab-pages">
                <List size={16} /> Pages
              </button>
              <button className={`pdf-sidebar-tab ${sidebarTab === 'bookmarks' ? 'active' : ''}`} onClick={() => setSidebarTab('bookmarks')} data-testid="tab-bookmarks">
                <Bookmarks size={16} /> Bookmarks
              </button>
              <button className={`pdf-sidebar-tab ${sidebarTab === 'history' ? 'active' : ''}`} onClick={() => setSidebarTab('history')} data-testid="tab-history">
                <Clock size={16} /> History
              </button>
              {isMobile && (
                <button className="pdf-sidebar-close" onClick={() => setSidebarOpen(false)} data-testid="close-sidebar-btn">
                  <X size={18} />
                </button>
              )}
            </div>

            <ScrollArea className="flex-1">
              {sidebarTab === 'pages' && (
                <div className="p-2">
                  {numPages && Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                    <div key={pageNum} className={`pdf-thumbnail ${currentPage === pageNum ? 'active' : ''}`} onClick={() => scrollToPage(pageNum)} data-testid={`thumbnail-page-${pageNum}`}>
                      <div className="pdf-thumbnail-image">
                        <Document file={pdfSource} loading="">
                          <Page pageNumber={pageNum} width={120} renderTextLayer={false} renderAnnotationLayer={false} />
                        </Document>
                      </div>
                      <div className="pdf-thumbnail-info">
                        <span className="pdf-thumbnail-label">{pageNum}</span>
                        {isPageBookmarked(pageNum) && <BookmarkSimple size={12} weight="fill" className="text-[#002FA7]" />}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {sidebarTab === 'bookmarks' && (
                <div className="p-3">
                  {getCurrentPdfBookmarks.length === 0 ? (
                    <div className="pdf-empty-tab">
                      <BookmarkSimple size={32} className="text-zinc-300" />
                      <p className="text-sm text-zinc-500 mt-2">No bookmarks yet</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {getCurrentPdfBookmarks.map((bookmark) => (
                        <div key={bookmark.id} className="pdf-bookmark-item" data-testid={`bookmark-${bookmark.id}`}>
                          <button className="pdf-bookmark-link" onClick={() => scrollToPage(bookmark.page)}>
                            <BookmarkSimple size={16} weight="fill" className="text-[#002FA7]" />
                            <span>Page {bookmark.page}</span>
                          </button>
                          <button className="pdf-bookmark-delete" onClick={() => deleteBookmark(bookmark.id)} title="Delete bookmark">
                            <Trash size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {sidebarTab === 'history' && (
                <div className="p-3">
                  {history.length === 0 ? (
                    <div className="pdf-empty-tab">
                      <Clock size={32} className="text-zinc-300" />
                      <p className="text-sm text-zinc-500 mt-2">No history yet</p>
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-xs text-zinc-500">Recent PDFs</span>
                        <button className="text-xs text-zinc-400 hover:text-red-500" onClick={clearHistory}>Clear all</button>
                      </div>
                      <div className="space-y-2">
                        {history.map((item) => (
                          <div key={item.id} className="pdf-history-item" data-testid={`history-${item.id}`}>
                            <FilePdf size={18} className="text-zinc-400" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{item.name}</p>
                              <p className="text-xs text-zinc-400">{item.pages} pages • {formatDate(item.timestamp)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </ScrollArea>
          </aside>
        )}

        <div ref={viewerRef} className="pdf-viewer-area" onScroll={handleScroll} onMouseUp={handleTextSelection} data-testid="pdf-viewer-area">
          {!pdfSource && (
            <div className="pdf-empty-state" style={{ backgroundImage: `url(https://static.prod-images.emergentagent.com/jobs/8248c193-920c-4494-bce3-111b50039e46/images/4b2fbfc9c77d955963e21222c8d3a58428cbfc2e786b75e064da7f89cf0f4531.png)` }}>
              <div className={`pdf-dropzone ${isDragging ? 'drag-active' : ''}`} onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()} data-testid="pdf-upload-dropzone">
                <CloudArrowUp size={56} className="pdf-dropzone-icon" />
                <h2 className="text-xl font-semibold text-zinc-900 mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>Upload PDF</h2>
                <p className="text-sm text-zinc-500 mb-6">Drag & drop or click to browse</p>
                <input ref={fileInputRef} type="file" accept="application/pdf" onChange={handleFileInputChange} className="hidden" data-testid="pdf-file-input" />
                <div className="flex items-center gap-2 text-xs text-zinc-400 mb-6"><FileIcon size={14} /><span>PDF files up to 100MB</span></div>
                <div className="w-full max-w-sm">
                  <div className="relative flex items-center gap-2">
                    <div className="relative flex-1">
                      <LinkIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                      <Input type="url" placeholder="Or paste PDF URL..." value={urlInput} onChange={(e) => setUrlInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleUrlLoad()} className="pl-9 h-10 bg-white/50" data-testid="pdf-url-input" onClick={(e) => e.stopPropagation()} />
                    </div>
                    <Button onClick={(e) => { e.stopPropagation(); handleUrlLoad(); }} disabled={!urlInput.trim()} className="h-10 px-4 bg-[#002FA7] hover:bg-[#001D66] text-white" data-testid="load-url-btn">Load</Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {isLoading && !pdfSource && (
            <div className="pdf-loading" data-testid="pdf-loading"><div className="pdf-loading-spinner" /><p className="mt-4 text-sm">Loading PDF...</p></div>
          )}
          
          {error && (
            <div className="pdf-loading text-red-500" data-testid="pdf-error">
              <p>{error}</p>
              <Button onClick={() => { setError(null); setPdfFile(null); setPdfUrl(''); }} className="mt-4" variant="outline">Try Again</Button>
            </div>
          )}

          {pdfSource && !error && (
            <div className="pdf-pages-container">
              {isLoading && <div className="pdf-loading"><div className="pdf-loading-spinner" /></div>}
              <Document file={pdfSource} onLoadSuccess={onDocumentLoadSuccess} onLoadError={onDocumentLoadError} loading={<div className="pdf-loading"><div className="pdf-loading-spinner" /></div>}>
                {numPages && Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                  <VisiblePage 
                    key={pageNum}
                    pageNumber={pageNum}
                    targetScale={zoom / 100}
                    renderedScale={renderedZoom / 100}
                    isBookmarked={isPageBookmarked(pageNum)}
                    pageRef={(el) => (pageRefs.current[pageNum] = el)}
                  />
                ))}
              </Document>
            </div>
          )}

          {annotationMode && pdfSource && (
            <div className="pdf-annotation-bar" data-testid="annotation-toolbar">
              <div className="pdf-color-picker">
                {['yellow', 'green', 'blue', 'pink'].map((color) => (
                  <button key={color} className={`pdf-color-swatch ${highlightColor === color ? 'selected' : ''}`} style={{ backgroundColor: color === 'yellow' ? '#FFEB3B' : color === 'green' ? '#4CAF50' : color === 'blue' ? '#2196F3' : '#E91E63' }} onClick={() => setHighlightColor(color)} data-testid={`color-${color}-btn`} />
                ))}
              </div>
              <button className="pdf-annotation-btn" onClick={() => { setAnnotations([]); toast.info('Cleared'); }} data-testid="clear-annotations-btn"><X size={18} /></button>
            </div>
          )}
        </div>
      </div>

      {pdfSource && numPages && (
        <div className={`pdf-bottom-controls ${controlsVisible ? 'visible' : 'hidden'}`} data-testid="bottom-controls" ref={zoomMenuRef}>
          <button className="pdf-ctrl-btn" onClick={handleZoomOut} disabled={zoom <= MIN_ZOOM} data-testid="zoom-out-btn"><Minus size={16} weight="bold" /></button>
          <button className="pdf-zoom-display" onClick={() => setShowZoomMenu(!showZoomMenu)} data-testid="zoom-level">{zoom}%</button>
          <button className="pdf-ctrl-btn" onClick={handleZoomIn} disabled={zoom >= MAX_ZOOM} data-testid="zoom-in-btn"><Plus size={16} weight="bold" /></button>
          <button className="pdf-ctrl-btn" onClick={handleZoomReset} data-testid="zoom-reset-btn"><ArrowCounterClockwise size={16} /></button>
          {showZoomMenu && (
            <div className="pdf-zoom-menu" data-testid="zoom-menu">
              {ZOOM_PRESETS.map(p => (
                <button key={p} onClick={() => { handleZoomChange(p); setShowZoomMenu(false); }} className={`pdf-zoom-menu-item ${zoom === p ? 'active' : ''}`}>{p}%</button>
              ))}
            </div>
          )}
        </div>
      )}

      {showMobileSearch && (
        <div className="pdf-mobile-search" onClick={() => setShowMobileSearch(false)} data-testid="mobile-search-modal">
          <div className="pdf-mobile-search-card" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Search in PDF</h3>
              <button onClick={() => setShowMobileSearch(false)}><X size={20} /></button>
            </div>
            <div className="flex gap-2">
              <Input type="text" placeholder="Search..." value={searchQuery} onChange={(e) => handleSearch(e.target.value)} autoFocus data-testid="mobile-search-input" className="flex-1" />
              <Button onClick={executeSearch} className="bg-[#002FA7]">Search</Button>
            </div>
            {searchResults.length > 0 && (
              <div className="flex items-center justify-between mt-4">
                <span className="text-sm text-zinc-500">{currentSearchIndex + 1} of {searchResults.length}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => navigateSearch('prev')}><CaretUp size={16} /></Button>
                  <Button size="sm" variant="outline" onClick={() => navigateSearch('next')}><CaretDown size={16} /></Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PDFViewer;