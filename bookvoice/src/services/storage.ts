import AsyncStorage from '@react-native-async-storage/async-storage';
import { Book, BookMeta, BookLibrary, PlaybackProgress, TextChunk, UserSettings } from '../types';

const LIBRARY_KEY = 'bookvoice_library';
const PROGRESS_KEY = 'bookvoice_progress';
const SETTINGS_KEY = 'bookvoice_settings';

function chunksKey(bookId: string): string {
  return `bookvoice_chunks_${bookId}`;
}

/** Extract metadata (no chunks) from a full Book object. */
export function toMeta(book: Book): BookMeta {
  const { chunks: _chunks, ...meta } = book;
  return meta;
}

// ---------------------------------------------------------------------------
// Simple mutex to serialize storage writes and prevent TOCTOU races
// ---------------------------------------------------------------------------
let _writeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _writeLock;
  let resolve: () => void;
  _writeLock = new Promise(r => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

// ---------------------------------------------------------------------------
// Library (metadata only — no chunk text)
// ---------------------------------------------------------------------------

export async function loadLibrary(): Promise<BookLibrary> {
  try {
    const raw = await AsyncStorage.getItem(LIBRARY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Validate: ensure each entry has required fields
    for (const id of Object.keys(parsed)) {
      const entry = parsed[id];
      if (!entry || !entry.id || !entry.title) { delete parsed[id]; continue; }
      if (typeof entry.totalCharCount !== 'number') entry.totalCharCount = 0;
      if (typeof entry.totalChunks !== 'number') entry.totalChunks = 0;
      if (typeof entry.totalPages !== 'number') entry.totalPages = 0;
      if (!entry.ocrStatus) entry.ocrStatus = 'done';
    }
    return parsed;
  } catch { return {}; }
}

export function saveBookMeta(meta: BookMeta): Promise<void> {
  return withLock(async () => {
    const library = await loadLibrary();
    library[meta.id] = meta;
    await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  });
}

/** Save a full book: metadata goes to library, chunks stored separately. */
export async function saveBook(book: Book): Promise<void> {
  const meta = toMeta(book);
  await Promise.all([
    saveBookMeta(meta),
    saveChunks(book.id, book.chunks),
  ]);
}

export function deleteBook(bookId: string): Promise<void> {
  return withLock(async () => {
    // Use multiGet/multiSet for atomicity
    const keys = [LIBRARY_KEY, PROGRESS_KEY];
    const results = await AsyncStorage.multiGet(keys);
    const library: BookLibrary = results[0][1] ? JSON.parse(results[0][1]) : {};
    const progress: PlaybackProgress = results[1][1] ? JSON.parse(results[1][1]) : {};

    delete library[bookId];
    delete progress[bookId];

    // Invalidate progress cache
    if (_progressCache) delete _progressCache[bookId];

    await Promise.all([
      AsyncStorage.multiSet([
        [LIBRARY_KEY, JSON.stringify(library)],
        [PROGRESS_KEY, JSON.stringify(progress)],
      ]),
      AsyncStorage.removeItem(chunksKey(bookId)),
    ]);
  });
}

// ---------------------------------------------------------------------------
// Chunks (lazy, per-book)
// ---------------------------------------------------------------------------

export async function saveChunks(bookId: string, chunks: TextChunk[]): Promise<void> {
  await AsyncStorage.setItem(chunksKey(bookId), JSON.stringify(chunks));
}

export async function loadChunks(bookId: string): Promise<TextChunk[]> {
  try {
    const raw = await AsyncStorage.getItem(chunksKey(bookId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

// In-memory cache — initialized eagerly on first load
let _progressCache: PlaybackProgress | null = null;
let _progressLoadPromise: Promise<PlaybackProgress> | null = null;

export async function loadProgress(): Promise<PlaybackProgress> {
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    const data = raw ? JSON.parse(raw) : {};
    _progressCache = data;
    return data;
  } catch { return {}; }
}

/** Ensure cache is populated, deduplicating concurrent calls. */
async function ensureProgressCache(): Promise<PlaybackProgress> {
  if (_progressCache) return _progressCache;
  if (!_progressLoadPromise) _progressLoadPromise = loadProgress();
  const result = await _progressLoadPromise;
  _progressLoadPromise = null;
  return result;
}

export async function saveProgress(bookId: string, chunkIndex: number): Promise<void> {
  const cache = await ensureProgressCache();
  cache[bookId] = { chunkIndex, lastUpdated: Date.now() };
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(cache));
}

export async function getProgress(bookId: string): Promise<number> {
  const progress = await ensureProgressCache();
  return progress[bookId]?.chunkIndex ?? 0;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<UserSettings | null> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---------------------------------------------------------------------------
// Migration: if existing library entries have chunks embedded, split them out
// ---------------------------------------------------------------------------

export async function migrateChunksIfNeeded(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(LIBRARY_KEY);
    if (!raw) return;
    const library = JSON.parse(raw);
    let migrated = false;

    for (const bookId of Object.keys(library)) {
      const entry = library[bookId];
      if (!entry?.chunks || !Array.isArray(entry.chunks) || entry.chunks.length === 0) continue;

      // Check if chunks are already stored separately (idempotent)
      const existing = await AsyncStorage.getItem(chunksKey(bookId));
      if (!existing) {
        await AsyncStorage.setItem(chunksKey(bookId), JSON.stringify(entry.chunks));
      }

      if (!entry.totalCharCount) {
        entry.totalCharCount = entry.chunks.reduce((s: number, c: any) => s + (c.charCount || 0), 0);
      }
      delete entry.chunks;
      migrated = true;
    }

    if (migrated) {
      await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    }
  } catch (err) {
    console.warn('Migration failed:', err);
  }
}
