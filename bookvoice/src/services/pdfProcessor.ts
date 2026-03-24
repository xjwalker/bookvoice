/**
 * In-app PDF processing pipeline.
 * Extracts text page-by-page, detects chapters, language, headers/footers,
 * and builds a structured result ready for chunking and playback.
 *
 * This is the JS equivalent of tools/prep.py. It uses expo-pdf-text-extract
 * for digital PDFs (with a text layer) and falls back to tesseract.js OCR
 * for scanned/image PDFs. Spread pages (two logical pages per PDF page)
 * are detected by aspect ratio and split automatically.
 */

import { franc } from 'franc';
import { francToBcp47 } from './languageMap';
import {
  isOcrAvailable,
  ocrPdfPage,
  renderPdfPage,
  isSpreadPage,
  disposeOcrWorker,
  type OcrPageResult,
} from './ocrEngine';

let extractText: any = null;
try {
  const mod = require('expo-pdf-text-extract');
  extractText = mod.extractTextFromPage ?? mod.default?.extractTextFromPage;
} catch {
  // Not available — will use OCR fallback
}

let getPageCount: ((uri: string) => Promise<number>) | null = null;
try {
  const mod = require('expo-pdf-text-extract');
  getPageCount = mod.getPageCount ?? mod.default?.getPageCount;
} catch {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogicalPage {
  logicalPage: number;
  pdfPage: number;
  side: 'left' | 'right' | 'full';
  text: string;
  pageNumber: number | null;
  isChapterStart: boolean;
  chapterTitle: string | null;
}

export interface ProcessedChapter {
  number: number | null;
  title: string;
  logicalPage: number;
}

export interface ProcessedBook {
  title: string;
  author: string;
  language: string;
  pages: LogicalPage[];
  chapters: ProcessedChapter[];
  totalPdfPages: number;
}

export type ProgressCallback = (percent: number, stage: string) => void;

// ---------------------------------------------------------------------------
// Chapter patterns (ported from prep.py)
// ---------------------------------------------------------------------------

const CHAPTER_PATTERNS = [
  // Spanish
  /^CAP[ÍI]TULO\s+(\d+)/im,
  // English
  /^CHAPTER\s+(\d+)/im,
  // French
  /^CHAPITRE\s+(\d+)/im,
  // Roman numeral chapters
  /^(?:CHAPTER|CAP[ÍI]TULO|CHAPITRE)\s+(I{1,3}|IV|V|VI{0,3}|IX|X{1,3}|XI{1,3}|XIV|XV)/im,
  // Simple number-only chapter headings (e.g. just "1" or "12" at start of page)
  /^(\d{1,3})\s*$/m,
];

const ROMAN_MAP: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9,
  X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15,
};

// ---------------------------------------------------------------------------
// Header/Footer detection (plain-text heuristic)
// ---------------------------------------------------------------------------

function buildHeaderFooterPatterns(pageTexts: string[]): { headers: Set<string>; footers: Set<string> } {
  const headerCounts: Record<string, number> = {};
  const footerCounts: Record<string, number> = {};

  // Sample pages 3–30 (skip first few which may be title pages)
  const sample = pageTexts.slice(3, 30);

  for (const text of sample) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 3) continue;

    const firstLine = lines[0].trim();
    const lastLine = lines[lines.length - 1].trim();

    if (firstLine.length < 60) {
      headerCounts[firstLine] = (headerCounts[firstLine] || 0) + 1;
    }
    if (lastLine.length < 60) {
      footerCounts[lastLine] = (footerCounts[lastLine] || 0) + 1;
    }
  }

  const threshold = Math.max(2, Math.floor(sample.length * 0.15));
  const headers = new Set<string>();
  const footers = new Set<string>();

  for (const [line, count] of Object.entries(headerCounts)) {
    if (count >= threshold) headers.add(line);
  }
  for (const [line, count] of Object.entries(footerCounts)) {
    if (count >= threshold) footers.add(line);
  }

  return { headers, footers };
}

function stripHeaderFooter(text: string, headers: Set<string>, footers: Set<string>): string {
  const lines = text.split('\n');
  const trimmedLines = lines.map(l => l.trim());

  let start = 0;
  let end = lines.length;

  // Strip matching headers from top
  while (start < end) {
    const line = trimmedLines[start];
    if (!line) { start++; continue; }
    if (headers.has(line) || /^\d{1,4}$/.test(line)) {
      start++;
    } else {
      break;
    }
  }

  // Strip matching footers from bottom
  while (end > start) {
    const line = trimmedLines[end - 1];
    if (!line) { end--; continue; }
    if (footers.has(line) || /^\d{1,4}$/.test(line)) {
      end--;
    } else {
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// Page number detection
// ---------------------------------------------------------------------------

function detectPageNumber(text: string): number | null {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  // Check first and last line for isolated numbers
  for (const line of [lines[0], lines[lines.length - 1]]) {
    const trimmed = line.trim();
    if (/^\d{1,4}$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Front-matter filtering (ported from prep.py)
// ---------------------------------------------------------------------------

function filterFrontMatter(pages: LogicalPage[]): LogicalPage[] {
  let firstChapterIdx: number | null = null;

  for (let i = 0; i < pages.length; i++) {
    const first300 = pages[i].text.trim().slice(0, 300);
    for (const pattern of CHAPTER_PATTERNS) {
      if (pattern.test(first300)) {
        firstChapterIdx = i;
        break;
      }
    }
    if (firstChapterIdx !== null) break;
  }

  if (firstChapterIdx === null) return pages;

  const cleanFront: LogicalPage[] = [];
  for (const lp of pages.slice(0, firstChapterIdx)) {
    const text = lp.text.trim();
    if (!text || text.length < 50) continue;

    const alphaCount = [...text].filter(c => /\p{L}/u.test(c)).length;
    const alphaRatio = alphaCount / Math.max(text.length, 1);
    const noiseChars = [...text].filter(c => '•·○°~<>[]{}|\\'.includes(c)).length;
    const noiseRatio = noiseChars / Math.max(text.length, 1);
    const hasOcrNoise = /[~<>\[\]{}|]/.test(text);

    if (alphaRatio < 0.7 || noiseRatio > 0.03 || hasOcrNoise) continue;
    cleanFront.push(lp);
  }

  return [...cleanFront, ...pages.slice(firstChapterIdx)];
}

// ---------------------------------------------------------------------------
// Chapter detection (ported from prep.py) + section/article fallbacks
// ---------------------------------------------------------------------------

function detectChapters(pages: LogicalPage[]): ProcessedChapter[] {
  // Strategy 1: Classic CHAPTER/CAPÍTULO patterns
  const chapters = detectChapterPatterns(pages);
  if (chapters.length > 0) return chapters;

  // Strategy 2: ALL-CAPS section headers at the top of pages
  const sections = detectUppercaseSections(pages);
  if (sections.length > 0) return sections;

  // Strategy 3: TOC-based detection — parse a table of contents page
  const tocSections = detectFromToc(pages);
  if (tocSections.length > 0) return tocSections;

  // Strategy 4: Article-style headers (short title lines + author name)
  const articles = detectArticleHeaders(pages);
  if (articles.length > 0) return articles;

  return [];
}

/**
 * Strategy 1: Match explicit CHAPTER/CAPÍTULO/CHAPITRE + number patterns.
 */
function detectChapterPatterns(pages: LogicalPage[]): ProcessedChapter[] {
  const chapters: ProcessedChapter[] = [];

  for (const lp of pages) {
    const text = lp.text.trim();
    if (!text) continue;

    const first300 = text.slice(0, 300);
    for (const pattern of CHAPTER_PATTERNS) {
      const match = first300.match(pattern);
      if (match) {
        let num: number | null = null;
        const raw = match[1];
        if (/^\d+$/.test(raw)) {
          num = parseInt(raw, 10);
        } else if (ROMAN_MAP[raw.toUpperCase()]) {
          num = ROMAN_MAP[raw.toUpperCase()];
        }

        const afterMatch = text.slice((match.index ?? 0) + match[0].length).trim();
        const titleBlock = afterMatch.split('\n\n')[0].trim();
        const titleLines = titleBlock.split('\n').filter(l => l.trim()).slice(0, 2);
        let title = titleLines.join(' ');
        if (title.length > 80) title = title.slice(0, 80);

        chapters.push({ number: num, title, logicalPage: lp.logicalPage });
        lp.isChapterStart = true;
        lp.chapterTitle = num != null
          ? `Chapter ${num}${title ? ': ' + title : ''}`
          : title || 'Chapter';
        break;
      }
    }
  }

  return chapters;
}

/**
 * Strategy 2: Detect ALL-CAPS section headers at the start of a page.
 * Matches lines like "ENTENDIENDO EL APEGO AFECTIVO" or "PART ONE: THE BEGINNING".
 * Requires the line to be mostly uppercase, >10 chars, and at the very top.
 */
function detectUppercaseSections(pages: LogicalPage[]): ProcessedChapter[] {
  const candidates: ProcessedChapter[] = [];

  for (const lp of pages) {
    const text = lp.text.trim();
    if (!text) continue;

    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0) continue;

    const firstLine = lines[0].trim();
    if (firstLine.length < 10 || firstLine.length > 120) continue;

    const alphaChars = [...firstLine].filter(c => /\p{L}/u.test(c));
    if (alphaChars.length < 5) continue;

    const upperCount = alphaChars.filter(c => c === c.toUpperCase()).length;
    const upperRatio = upperCount / alphaChars.length;

    // Must be >70% uppercase to be considered a section header
    if (upperRatio < 0.7) continue;

    // Skip pages that are just short fragments (like page number + footer text)
    if (text.length < 100) continue;

    // Skip if it looks like a running header (same text repeats on many pages)
    // This is handled later by deduplication

    const title = firstLine;
    candidates.push({ number: null, title, logicalPage: lp.logicalPage });
    lp.isChapterStart = true;
    lp.chapterTitle = title;
  }

  // Filter: need at least 2 sections for this to be a real pattern
  // (a single uppercase line could just be a title page)
  if (candidates.length < 2) return [];

  return candidates;
}

/**
 * Strategy 3: Parse a Table of Contents page to extract section entries.
 * Looks for pages with multiple lines matching "Title text NUMBER" or
 * "Title text NUMBER Author" patterns.
 */
function detectFromToc(pages: LogicalPage[]): ProcessedChapter[] {
  // Only search the first ~10 pages for a TOC
  const tocCandidatePages = pages.slice(0, Math.min(10, pages.length));

  // Collect TOC entries across consecutive pages (TOC may span 2-3 pages)
  const tocEntries: { title: string; pageNum: number }[] = [];
  let tocStarted = false;

  for (const tocPage of tocCandidatePages) {
    const text = tocPage.text.trim();
    if (!text) continue;

    const lines = text.split('\n').filter(l => l.trim());

    const pageEntries: { title: string; pageNum: number }[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Match: text followed by a number (1-4 digits), optionally followed by author
      // e.g. "Los diáconos: amortiguadores y siervos 6 Jamie Dunlop"
      // e.g. "NOTA DEL EDITOR 4 Daniel Puerto"
      const match = trimmed.match(/^(.{5,}?)\s+(\d{1,4})\s*(.*)$/);
      if (match) {
        const title = match[1].trim();
        const num = parseInt(match[2], 10);
        if (num > 0 && num < 1000 && title.length > 3) {
          pageEntries.push({ title, pageNum: num });
        }
      }
    }

    // A TOC page has a high density of entries relative to its line count.
    // A page with 3+ entries where >30% of non-empty lines match is a TOC page.
    const nonEmptyLines = text.split('\n').filter(l => l.trim()).length;
    const entryDensity = nonEmptyLines > 0 ? pageEntries.length / nonEmptyLines : 0;

    if (pageEntries.length >= 3 && entryDensity > 0.25) {
      tocStarted = true;
      tocEntries.push(...pageEntries);
    } else if (tocStarted && pageEntries.length >= 2 && entryDensity > 0.2) {
      // Continuation of a multi-page TOC (slightly relaxed threshold)
      tocEntries.push(...pageEntries);
    } else if (tocStarted) {
      // TOC ended — density dropped, we're in body text now
      break;
    }
  }

  // Need at least 3 TOC entries total
  if (tocEntries.length < 3) return [];

  // Map TOC page numbers to logical pages
  const chapters: ProcessedChapter[] = [];
  let sectionNum = 1;

  for (const entry of tocEntries) {
    // Skip section group headings (ALL CAPS lines in TOC that are categories)
    // These usually don't have a matching content page
    const isGroupHeading = entry.title === entry.title.toUpperCase() &&
      entry.title.length > 5 &&
      [...entry.title].filter(c => /\p{L}/u.test(c)).length > 3;

    // Find the logical page whose pageNumber matches the TOC entry,
    // or whose content starts with similar text
    let targetPage: LogicalPage | undefined;

    // First try matching by printed page number
    targetPage = pages.find(p => p.pageNumber === entry.pageNum);

    // If no page number match, try matching by content similarity
    if (!targetPage) {
      const normalizedTitle = entry.title.toLowerCase().replace(/[^a-záéíóúñü\s]/g, '').trim();
      targetPage = pages.find(p => {
        const first200 = p.text.trim().slice(0, 200).toLowerCase();
        const titleWords = normalizedTitle.split(/\s+/).filter(w => w.length > 3);
        const matchCount = titleWords.filter(w => first200.includes(w)).length;
        return titleWords.length > 0 && matchCount >= titleWords.length * 0.6;
      });
    }

    if (targetPage && !isGroupHeading) {
      chapters.push({
        number: sectionNum,
        title: entry.title,
        logicalPage: targetPage.logicalPage,
      });
      targetPage.isChapterStart = true;
      targetPage.chapterTitle = entry.title;
      sectionNum++;
    }
  }

  return chapters.length >= 2 ? chapters : [];
}

/**
 * Strategy 4: Detect article-style headers — pages that start with
 * short title lines (1-4 lines, each <60 chars) followed by an author name.
 * Common in magazines, journals, and essay collections.
 */
function detectArticleHeaders(pages: LogicalPage[]): ProcessedChapter[] {
  const candidates: ProcessedChapter[] = [];

  // Name pattern: 1-3 capitalized words (author name)
  const namePattern = /^[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+(?:\s+[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+){0,3}$/;

  for (const lp of pages) {
    const text = lp.text.trim();
    if (!text || text.length < 200) continue;

    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 4) continue;

    // Look for pattern: 1-4 short title lines, then an author name line
    let titleEnd = -1;
    let authorLine = '';

    for (let i = 0; i < Math.min(6, lines.length - 1); i++) {
      const line = lines[i].trim();
      if (line.length > 60) break; // Title lines should be short

      // Check if next line looks like an author name
      const nextLine = lines[i + 1]?.trim() ?? '';
      if (namePattern.test(nextLine) && nextLine.length < 40) {
        titleEnd = i;
        authorLine = nextLine;
        break;
      }
    }

    if (titleEnd < 0) continue;

    const titleLines = lines.slice(0, titleEnd + 1).map(l => l.trim());
    let title = titleLines.join(' ');
    if (title.length > 100) title = title.slice(0, 100);

    // Skip very short titles (likely not a real article header)
    if (title.length < 5) continue;

    candidates.push({
      number: null,
      title: `${title} — ${authorLine}`,
      logicalPage: lp.logicalPage,
    });
    lp.isChapterStart = true;
    lp.chapterTitle = title;
  }

  // Need at least 2 articles for this to be a real pattern
  if (candidates.length < 2) return [];

  return candidates;
}

// ---------------------------------------------------------------------------
// Title / Author parsing (ported from prep.py)
// ---------------------------------------------------------------------------

function parseTitleAuthorFromFilename(filename: string): { title: string; author: string } {
  const stem = filename.replace(/\.pdf$/i, '');
  if (stem.includes(' - ')) {
    const [first, ...rest] = stem.split(' - ');
    return { title: rest.join(' - ').trim(), author: first.trim() };
  }
  return { title: stem, author: '' };
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(pages: LogicalPage[]): string {
  let sample = '';
  for (const lp of pages) {
    if (lp.text.trim()) sample += lp.text + ' ';
    if (sample.length > 3000) break;
  }
  if (sample.length < 50) return 'en-US';

  try {
    const code = franc(sample);
    if (code === 'und') return 'en-US';
    return francToBcp47(code);
  } catch {
    return 'en-US';
  }
}

// ---------------------------------------------------------------------------
// Minimum text threshold — pages with less text than this are considered
// empty and will be sent to OCR if available.
// ---------------------------------------------------------------------------

const MIN_TEXT_LENGTH = 20;

/**
 * Check if extracted text is essentially empty (needs OCR).
 */
function isTextEmpty(text: string | undefined | null): boolean {
  if (!text) return true;
  const stripped = text.replace(/\s+/g, '');
  return stripped.length < MIN_TEXT_LENGTH;
}

// ---------------------------------------------------------------------------
// Spread-aware page dimensions (check first few pages for aspect ratio)
// ---------------------------------------------------------------------------

interface PageDimensions {
  width: number;
  height: number;
  isSpread: boolean;
}

async function probePageDimensions(
  pdfUri: string,
  samplePages: number[],
): Promise<Map<number, PageDimensions>> {
  const dims = new Map<number, PageDimensions>();
  for (const pageIdx of samplePages) {
    const img = await renderPdfPage(pdfUri, pageIdx);
    if (img) {
      dims.set(pageIdx, {
        width: img.width,
        height: img.height,
        isSpread: isSpreadPage(img.width, img.height),
      });
    }
  }
  return dims;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function processPdf(
  pdfUri: string,
  filename: string,
  onProgress?: ProgressCallback,
): Promise<ProcessedBook> {
  const hasTextExtract = !!(extractText && getPageCount);
  const hasOcr = isOcrAvailable();

  if (!hasTextExtract && !hasOcr) {
    throw new Error(
      'No PDF processing capability available. ' +
      'Install expo-pdf-text-extract (for digital PDFs) or ' +
      'react-native-pdf-thumbnail + tesseract.js (for scanned PDFs) in a dev build.'
    );
  }

  // 1. Get page count
  onProgress?.(0, 'Analyzing PDF…');
  let totalPages: number;
  if (getPageCount) {
    totalPages = await getPageCount(pdfUri);
  } else {
    // No native page count — probe by rendering pages until we fail
    // (fallback for OCR-only path where expo-pdf-text-extract isn't installed)
    totalPages = await probePageCount(pdfUri);
  }
  if (totalPages === 0) throw new Error('PDF has no pages');

  // 2. First pass: extract text with expo-pdf-text-extract
  const rawTexts: string[] = [];
  const emptyPages: number[] = [];

  if (hasTextExtract) {
    for (let i = 0; i < totalPages; i++) {
      const text: string = await extractText(pdfUri, i);
      rawTexts.push(text ?? '');
      if (isTextEmpty(text)) {
        emptyPages.push(i);
      }
      const pct = Math.round(((i + 1) / totalPages) * 40);
      onProgress?.(pct, `Extracting text (page ${i + 1}/${totalPages})…`);

      if (i % 10 === 9) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } else {
    // No text extractor — all pages need OCR
    for (let i = 0; i < totalPages; i++) {
      rawTexts.push('');
      emptyPages.push(i);
    }
  }

  // 3. Determine if OCR is needed and if pages are spreads
  const needsOcr = emptyPages.length > 0 && hasOcr;
  const ocrRatio = emptyPages.length / totalPages;
  const isScannedBook = ocrRatio > 0.5;

  // Probe page dimensions on a few sample pages to detect spreads
  let spreadDetected = false;
  if (needsOcr && emptyPages.length > 0) {
    const sampleIdxs = emptyPages.slice(0, Math.min(5, emptyPages.length));
    const dims = await probePageDimensions(pdfUri, sampleIdxs);
    spreadDetected = [...dims.values()].some(d => d.isSpread);
  }

  // 4. OCR empty pages (with spread handling)
  const ocrResults = new Map<number, OcrPageResult[]>();

  if (needsOcr) {
    const ocrTotal = emptyPages.length;
    onProgress?.(42, `Running OCR on ${ocrTotal} scanned page${ocrTotal > 1 ? 's' : ''}…`);

    for (let i = 0; i < ocrTotal; i++) {
      const pageIdx = emptyPages[i];
      try {
        const results = await ocrPdfPage(pdfUri, pageIdx);
        ocrResults.set(pageIdx, results);
        // Backfill rawTexts with combined OCR text for header/footer detection
        rawTexts[pageIdx] = results.map(r => r.text).join('\n\n');
      } catch {
        // OCR failed for this page — leave it empty
      }

      const pct = 42 + Math.round(((i + 1) / ocrTotal) * 28);
      onProgress?.(pct, `OCR page ${i + 1}/${ocrTotal}…`);

      // Yield to UI thread every 5 pages
      if (i % 5 === 4) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Clean up OCR worker memory
    await disposeOcrWorker();
  }

  // 5. Build header/footer patterns
  onProgress?.(72, 'Cleaning text…');
  const { headers, footers } = buildHeaderFooterPatterns(rawTexts);

  // 6. Build logical pages (handling spreads from OCR)
  const logicalPages: LogicalPage[] = [];
  let lpIdx = 0;

  for (let pdfPage = 0; pdfPage < totalPages; pdfPage++) {
    const ocrResult = ocrResults.get(pdfPage);

    if (ocrResult && ocrResult.length > 0) {
      // This page was OCR'd — may be split into left/right for spreads
      for (const result of ocrResult) {
        const text = result.text.trim();
        if (!text || text.length < MIN_TEXT_LENGTH) continue;

        const pageNumber = detectPageNumber(text);
        const cleaned = stripHeaderFooter(text, headers, footers).trim();
        if (!cleaned) continue;

        logicalPages.push({
          logicalPage: lpIdx,
          pdfPage,
          side: result.side,
          text: cleaned,
          pageNumber,
          isChapterStart: false,
          chapterTitle: null,
        });
        lpIdx++;
      }
    } else {
      // Digital text extraction path
      const raw = rawTexts[pdfPage];
      if (!raw.trim()) continue;

      const pageNumber = detectPageNumber(raw);
      const cleaned = stripHeaderFooter(raw, headers, footers).trim();
      if (!cleaned) continue;

      logicalPages.push({
        logicalPage: lpIdx,
        pdfPage,
        side: 'full',
        text: cleaned,
        pageNumber,
        isChapterStart: false,
        chapterTitle: null,
      });
      lpIdx++;
    }
  }

  // 7. Filter front-matter
  onProgress?.(78, 'Filtering front matter…');
  const filtered = filterFrontMatter(logicalPages);
  for (let i = 0; i < filtered.length; i++) {
    filtered[i].logicalPage = i;
  }

  // 8. Detect chapters
  onProgress?.(82, 'Detecting chapters…');
  const chapters = detectChapters(filtered);

  // 9. Detect language
  onProgress?.(88, 'Detecting language…');
  const language = detectLanguage(filtered);

  // 10. Parse title/author
  onProgress?.(92, 'Finalizing…');
  const { title, author } = parseTitleAuthorFromFilename(filename);

  // Try to refine title from first pages
  let refinedTitle = title;
  for (const lp of filtered.slice(0, 10)) {
    const text = lp.text.trim();
    if (!text || text.length > 200) continue;
    const alphaCount = [...text].filter(c => /\p{L}/u.test(c)).length;
    if (alphaCount / Math.max(text.length, 1) < 0.85) continue;
    if (/[~<>\[\]{}|\\]/.test(text)) continue;
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length > 0 && lines[0].length < 80) {
      refinedTitle = lines[0];
      break;
    }
  }

  onProgress?.(100, 'Done');

  return {
    title: refinedTitle || title,
    author,
    language,
    pages: filtered,
    chapters,
    totalPdfPages: totalPages,
  };
}

/**
 * Fallback page count detection: render pages sequentially until
 * react-native-pdf-thumbnail fails (for when expo-pdf-text-extract
 * is not installed).
 */
async function probePageCount(pdfUri: string): Promise<number> {
  let count = 0;
  // Probe up to 2000 pages max
  for (let i = 0; i < 2000; i++) {
    const img = await renderPdfPage(pdfUri, i);
    if (!img) break;
    count++;
  }
  return count;
}
