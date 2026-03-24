/**
 * In-app PDF processing pipeline.
 * Extracts text page-by-page, detects chapters, language, headers/footers,
 * and builds a structured result ready for chunking and playback.
 *
 * This is the JS equivalent of tools/prep.py, adapted for the constraints
 * of expo-pdf-text-extract (plain text per page, no bounding boxes).
 */

import { franc } from 'franc';
import { francToBcp47 } from './languageMap';

let extractText: any = null;
try {
  const mod = require('expo-pdf-text-extract');
  extractText = mod.extractTextFromPage ?? mod.default?.extractTextFromPage;
} catch {
  // Not available — will use tesseract.js fallback
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
// Chapter detection (ported from prep.py)
// ---------------------------------------------------------------------------

function detectChapters(pages: LogicalPage[]): ProcessedChapter[] {
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

        // Extract title from lines after the chapter heading
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
// Main pipeline
// ---------------------------------------------------------------------------

export async function processPdf(
  pdfUri: string,
  filename: string,
  onProgress?: ProgressCallback,
): Promise<ProcessedBook> {
  if (!extractText || !getPageCount) {
    throw new Error(
      'PDF text extraction is not available. ' +
      'Please use a dev build (not Expo Go) with expo-pdf-text-extract installed.'
    );
  }

  // 1. Get page count
  onProgress?.(0, 'Analyzing PDF…');
  const totalPages: number = await getPageCount(pdfUri);
  if (totalPages === 0) throw new Error('PDF has no pages');

  // 2. Extract raw text from every page
  const rawTexts: string[] = [];
  for (let i = 0; i < totalPages; i++) {
    const text: string = await extractText(pdfUri, i);
    rawTexts.push(text ?? '');
    const pct = Math.round(((i + 1) / totalPages) * 70);
    onProgress?.(pct, `Extracting text (page ${i + 1}/${totalPages})…`);

    // Yield to UI thread every 10 pages
    if (i % 10 === 9) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // 3. Build header/footer patterns and detect page numbers
  onProgress?.(72, 'Cleaning text…');
  const { headers, footers } = buildHeaderFooterPatterns(rawTexts);

  // 4. Build logical pages
  const logicalPages: LogicalPage[] = [];
  let lpIdx = 0;

  for (let pdfPage = 0; pdfPage < totalPages; pdfPage++) {
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

  // 5. Filter front-matter
  onProgress?.(78, 'Filtering front matter…');
  const filtered = filterFrontMatter(logicalPages);
  // Re-index
  for (let i = 0; i < filtered.length; i++) {
    filtered[i].logicalPage = i;
  }

  // 6. Detect chapters
  onProgress?.(82, 'Detecting chapters…');
  const chapters = detectChapters(filtered);

  // 7. Detect language
  onProgress?.(88, 'Detecting language…');
  const language = detectLanguage(filtered);

  // 8. Parse title/author
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
