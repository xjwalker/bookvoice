import AsyncStorage from '@react-native-async-storage/async-storage';
import { Book, BookLibrary, PlaybackProgress } from '../types';

const LIBRARY_KEY = 'bookvoice_library';
const PROGRESS_KEY = 'bookvoice_progress';

export async function loadLibrary(): Promise<BookLibrary> {
  try {
    const raw = await AsyncStorage.getItem(LIBRARY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export async function saveBook(book: Book): Promise<void> {
  const library = await loadLibrary();
  library[book.id] = book;
  await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
}

export async function deleteBook(bookId: string): Promise<void> {
  const library = await loadLibrary();
  delete library[bookId];
  await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  const progress = await loadProgress();
  delete progress[bookId];
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

export async function getBook(bookId: string): Promise<Book | null> {
  const library = await loadLibrary();
  return library[bookId] ?? null;
}

export async function loadProgress(): Promise<PlaybackProgress> {
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export async function saveProgress(bookId: string, chunkIndex: number): Promise<void> {
  const progress = await loadProgress();
  progress[bookId] = { chunkIndex, lastUpdated: Date.now() };
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

export async function getProgress(bookId: string): Promise<number> {
  const progress = await loadProgress();
  return progress[bookId]?.chunkIndex ?? 0;
}
