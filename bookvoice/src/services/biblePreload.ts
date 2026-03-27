import AsyncStorage from '@react-native-async-storage/async-storage';
import { BookMeta, TextChunk, ChapterMark } from '../types';
import { generateId, generateCoverColor } from '../utils/id';
import { chunkText } from './ocr';
import { saveBookMeta, saveChunks, loadLibrary } from './storage';

const BIBLES_LOADED_KEY = 'bookvoice_bibles_loaded_v2';

export interface BibleDef {
  key: string;
  title: string;
  language: string;
  loader: () => any;
}

export const BUNDLED_BIBLES: BibleDef[] = [
  {
    key: 'kjv',
    title: 'Holy Bible (KJV)',
    language: 'en-US',
    loader: () => require('../../assets/bible-kjv.bookvoice.json'),
  },
  {
    key: 'rva1909',
    title: 'Santa Biblia (Reina-Valera 1909)',
    language: 'es',
    loader: () => require('../../assets/bible-rva1909.bookvoice.json'),
  },
];

/**
 * On first launch, import bundled Bible .bookvoice.json files into the library.
 * Skips any Bible whose title is already in the library.
 */
export async function preloadBiblesIfNeeded(
  dispatch: (action: any) => void,
): Promise<void> {
  const loaded = await AsyncStorage.getItem(BIBLES_LOADED_KEY);
  if (loaded) return;

  const library = await loadLibrary();
  const existingTitles = new Set(Object.values(library).map(b => b.title));
  let allSucceeded = true;

  for (const bible of BUNDLED_BIBLES) {
    if (existingTitles.has(bible.title)) continue;

    try {
      const bundle = bible.loader();
      await importBibleBundle(bundle, bible, dispatch);
    } catch (err) {
      console.warn(`Failed to preload ${bible.title}:`, err);
      allSucceeded = false;
    }
  }

  // Only mark as done if all succeeded — retry on next launch otherwise
  if (allSucceeded) {
    await AsyncStorage.setItem(BIBLES_LOADED_KEY, Date.now().toString());
  }
}

/**
 * Import a single Bible bundle. Exported so it can be called from UI buttons.
 */
export async function importBibleBundle(
  bundle: any,
  bible: { title: string; language: string },
  dispatch: (action: any) => void,
): Promise<void> {
  const bookId = generateId();
  const title = bundle.title || bible.title;
  const author = bundle.author || undefined;
  const language = bundle.language || bible.language;

  const allChunks: TextChunk[] = [];
  const pages: any[] = bundle.pages || [];

  for (const page of pages) {
    const text = page.text?.trim();
    if (!text) continue;
    const pageNum = page.page_number ?? page.logical_page + 1;
    const pageChunks = chunkText(text, pageNum, bookId, allChunks.length);
    for (const c of pageChunks) allChunks.push(c);
  }

  const chapters: ChapterMark[] = [];
  if (bundle.chapters) {
    for (const ch of bundle.chapters) {
      const chapterPage = pages[ch.logical_page];
      if (!chapterPage) continue;
      const pageNum = chapterPage.page_number ?? chapterPage.logical_page + 1;
      const chunkIdx = allChunks.findIndex(c => c.pageNumber === pageNum);
      if (chunkIdx >= 0) {
        chapters.push({
          number: ch.number ?? null,
          title: ch.title || `Book ${ch.number}`,
          chunkIndex: chunkIdx,
        });
      }
    }
  }

  const totalCharCount = allChunks.reduce((s, c) => s + c.charCount, 0);

  const meta: BookMeta = {
    id: bookId,
    title,
    author,
    coverColor: generateCoverColor(title),
    totalPages: bundle.total_logical_pages ?? pages.length,
    totalChunks: allChunks.length,
    totalCharCount,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    ocrStatus: 'done',
    ocrProgress: 100,
    language,
    sourceType: 'preprocessed',
    chapters: chapters.length > 0 ? chapters : undefined,
  };

  dispatch({ type: 'ADD_BOOK', book: meta });
  await Promise.all([
    saveBookMeta(meta),
    saveChunks(bookId, allChunks),
  ]);
}
