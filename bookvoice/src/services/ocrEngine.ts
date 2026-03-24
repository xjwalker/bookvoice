/**
 * OCR Engine — renders PDF pages to images and extracts text via tesseract.js.
 * Used as a fallback when expo-pdf-text-extract returns no text (scanned PDFs).
 *
 * Also handles spread detection (two logical pages per PDF page) and
 * image cropping for left/right halves.
 */

import * as FileSystem from 'expo-file-system/legacy';

// ---------------------------------------------------------------------------
// Optional native dependencies (graceful degradation)
// ---------------------------------------------------------------------------

let PdfThumbnail: any = null;
try {
  PdfThumbnail = require('react-native-pdf-thumbnail').default;
} catch {}

let ImageManipulator: any = null;
try {
  ImageManipulator = require('expo-image-manipulator');
} catch {}

let Tesseract: any = null;
try {
  Tesseract = require('tesseract.js');
} catch {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageImage {
  uri: string;
  width: number;
  height: number;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Tesseract worker management
// ---------------------------------------------------------------------------

let workerInstance: any = null;
let workerLang: string = '';

async function getWorker(lang: string = 'eng'): Promise<any> {
  if (!Tesseract) {
    throw new Error('tesseract.js is not available');
  }

  // Reuse worker if same language
  if (workerInstance && workerLang === lang) {
    return workerInstance;
  }

  // Terminate old worker if language changed
  if (workerInstance) {
    try { await workerInstance.terminate(); } catch {}
    workerInstance = null;
  }

  workerInstance = await Tesseract.createWorker(lang);
  workerLang = lang;
  return workerInstance;
}

/**
 * Terminate the OCR worker to free memory. Call after processing is complete.
 */
export async function disposeOcrWorker(): Promise<void> {
  if (workerInstance) {
    try { await workerInstance.terminate(); } catch {}
    workerInstance = null;
    workerLang = '';
  }
}

// ---------------------------------------------------------------------------
// PDF page → image rendering
// ---------------------------------------------------------------------------

/**
 * Render a PDF page as a JPEG image.
 * Returns the image URI and dimensions, or null if rendering fails.
 */
export async function renderPdfPage(
  pdfUri: string,
  pageIndex: number,
  quality?: number,
): Promise<PageImage | null> {
  if (!PdfThumbnail) return null;

  try {
    const result = await PdfThumbnail.generate(pdfUri, pageIndex, {
      quality: quality ?? 80,
    });
    if (!result?.uri) return null;
    return {
      uri: result.uri,
      width: result.width ?? 0,
      height: result.height ?? 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Spread detection
// ---------------------------------------------------------------------------

const SPREAD_ASPECT_RATIO = 1.3;

/**
 * Returns true if the page dimensions suggest a two-page spread
 * (width significantly greater than height).
 */
export function isSpreadPage(width: number, height: number): boolean {
  if (!width || !height) return false;
  return (width / height) > SPREAD_ASPECT_RATIO;
}

// ---------------------------------------------------------------------------
// Image cropping (for splitting spread pages)
// ---------------------------------------------------------------------------

/**
 * Crop an image to its left or right half.
 */
export async function cropHalf(
  imageUri: string,
  side: 'left' | 'right',
  width: number,
  height: number,
): Promise<string | null> {
  if (!ImageManipulator) return null;

  try {
    const halfWidth = Math.floor(width / 2);
    const crop = {
      originX: side === 'left' ? 0 : halfWidth,
      originY: 0,
      width: halfWidth,
      height,
    };

    const manipulateAsync = ImageManipulator.manipulateAsync ?? ImageManipulator.default?.manipulateAsync;
    if (!manipulateAsync) return null;

    const result = await manipulateAsync(imageUri, [{ crop }]);
    return result?.uri ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

/**
 * Run OCR on an image and return the extracted text.
 * Uses tesseract.js with the specified language (default: eng).
 */
export async function ocrImage(
  imageUri: string,
  lang: string = 'eng',
): Promise<OcrResult> {
  const worker = await getWorker(lang);
  const { data } = await worker.recognize(imageUri);
  return {
    text: data.text ?? '',
    confidence: data.confidence ?? 0,
  };
}

// ---------------------------------------------------------------------------
// High-level: OCR a full PDF page (handles spreads)
// ---------------------------------------------------------------------------

export interface OcrPageResult {
  side: 'full' | 'left' | 'right';
  text: string;
  confidence: number;
}

/**
 * Render a PDF page to an image, detect if it's a spread,
 * and OCR it (splitting into left/right for spreads).
 *
 * Returns 1 result for single pages, 2 for spreads.
 */
export async function ocrPdfPage(
  pdfUri: string,
  pageIndex: number,
  lang?: string,
): Promise<OcrPageResult[]> {
  const image = await renderPdfPage(pdfUri, pageIndex);
  if (!image) {
    throw new Error(`Failed to render PDF page ${pageIndex} as image`);
  }

  const spread = isSpreadPage(image.width, image.height);

  if (!spread) {
    // Single page — OCR the whole image
    const result = await ocrImage(image.uri, lang);
    cleanupTempImage(image.uri);
    return [{ side: 'full', text: result.text, confidence: result.confidence }];
  }

  // Spread page — crop into left and right halves, OCR each
  const results: OcrPageResult[] = [];

  const leftUri = await cropHalf(image.uri, 'left', image.width, image.height);
  if (leftUri) {
    const leftResult = await ocrImage(leftUri, lang);
    results.push({ side: 'left', text: leftResult.text, confidence: leftResult.confidence });
    cleanupTempImage(leftUri);
  }

  const rightUri = await cropHalf(image.uri, 'right', image.width, image.height);
  if (rightUri) {
    const rightResult = await ocrImage(rightUri, lang);
    results.push({ side: 'right', text: rightResult.text, confidence: rightResult.confidence });
    cleanupTempImage(rightUri);
  }

  cleanupTempImage(image.uri);
  return results;
}

/**
 * Check whether the OCR engine is available (all required native modules present).
 */
export function isOcrAvailable(): boolean {
  return !!(PdfThumbnail && Tesseract);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanupTempImage(uri: string): void {
  FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}
