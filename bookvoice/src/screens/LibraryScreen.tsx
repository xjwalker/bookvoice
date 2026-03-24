import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  SafeAreaView, StatusBar, Alert, ActivityIndicator, Dimensions, Image,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useLibrary, useStore, useProgress } from '../store/AppStore';
import { Book, TextChunk, ChapterMark } from '../types';
import { generateId, generateCoverColor, titleFromFilename, estimateMinutes } from '../utils/id';
import { saveBook } from '../services/storage';
import { chunkText } from '../services/ocr';
import { processPdf } from '../services/pdfProcessor';
import { extractCover } from '../services/coverExtractor';
// DEV: bundled sample book for testing
import sampleBookData from '../../assets/sample-book.json';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - 48) / 2;

export default function LibraryScreen() {
  const books = useLibrary();
  const { dispatch } = useStore();
  const router = useRouter();
  const [importing, setImporting] = useState(false);

  async function handleImport() {
    try {
      // Accept both PDFs and JSON files (.bookvoice.json from prep tool)
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'application/json'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setImporting(true);

      const name = asset.name ?? '';
      if (name.endsWith('.bookvoice.json') || name.endsWith('.json')) {
        await importPreprocessed(asset.uri, dispatch);
      } else {
        await importPDF(asset, dispatch);
      }
    } catch (err: any) {
      Alert.alert('Import failed', err.message ?? 'Unknown error');
    } finally {
      setImporting(false);
    }
  }

  // DEV: load the bundled sample book directly (no file picker needed)
  async function handleLoadSample() {
    try {
      setImporting(true);
      await importPreprocessedFromData(sampleBookData as any, dispatch);
    } catch (err: any) {
      Alert.alert('Import failed', err.message ?? 'Unknown error');
    } finally {
      setImporting(false);
    }
  }

  function handleOpenBook(book: Book) {
    if (book.ocrStatus === 'processing') { Alert.alert('Still processing', 'Please wait...'); return; }
    if (book.ocrStatus === 'error') { Alert.alert('OCR Failed', 'Text extraction failed.'); return; }
    router.push(`/player/${book.id}`);
  }

  function handleDeleteBook(book: Book) {
    Alert.alert('Remove Book', `Remove "${book.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        dispatch({ type: 'DELETE_BOOK', bookId: book.id });
        await FileSystem.deleteAsync(`${FileSystem.documentDirectory}books/${book.id}/`, { idempotent: true });
      }},
    ]);
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0f" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>BookVoice</Text>
        <Text style={styles.headerSub}>Your audio library</Text>
      </View>
      {books.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="book-outline" size={64} color="#333" />
          <Text style={styles.emptyTitle}>No books yet</Text>
          <Text style={styles.emptySub}>Tap + to import a scanned PDF{'\n'}or a preprocessed .bookvoice.json</Text>
          <TouchableOpacity style={styles.sampleBtn} onPress={handleLoadSample} disabled={importing}>
            <Text style={styles.sampleBtnText}>Load Sample Book</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={books} keyExtractor={(b) => b.id} numColumns={2}
          columnWrapperStyle={styles.row} contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <BookCard book={item} onPress={() => handleOpenBook(item)} onLongPress={() => handleDeleteBook(item)} />
          )}
        />
      )}
      <TouchableOpacity style={[styles.fab, importing && styles.fabDisabled]} onPress={handleImport} disabled={importing}>
        {importing ? <ActivityIndicator color="#fff" /> : <Ionicons name="add" size={28} color="#fff" />}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function BookCard({ book, onPress, onLongPress }: { book: Book; onPress: () => void; onLongPress: () => void }) {
  const totalChars = book.chunks.reduce((s, c) => s + c.charCount, 0);
  const progress = useProgress(book.id);
  const isProcessing = book.ocrStatus === 'processing';
  const hasProgress = progress > 0 && book.totalChunks > 0;
  const progressPct = hasProgress ? Math.round((progress / book.totalChunks) * 100) : 0;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} onLongPress={onLongPress} activeOpacity={0.8}>
      <View style={[styles.cover, { backgroundColor: book.coverColor }]}>
        {book.coverImageUri && !isProcessing ? (
          <Image source={{ uri: book.coverImageUri }} style={styles.coverImage} />
        ) : isProcessing ? (
          <View style={styles.processingOverlay}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.processingText}>{book.ocrProgress}%</Text>
            {book.processingStage ? (
              <Text style={styles.processingStage}>{book.processingStage}</Text>
            ) : null}
          </View>
        ) : (
          <Text style={styles.coverInitial}>{book.title.charAt(0).toUpperCase()}</Text>
        )}
        {hasProgress && !isProcessing && (
          <View style={styles.progressBadge}>
            <Text style={styles.progressBadgeText}>{progressPct}%</Text>
          </View>
        )}
      </View>
      <View style={styles.cardInfo}>
        <Text style={styles.cardTitle} numberOfLines={2}>{book.title}</Text>
        {book.author ? <Text style={styles.cardAuthor} numberOfLines={1}>{book.author}</Text> : null}
        {!isProcessing && book.totalChunks > 0 && (
          <Text style={styles.cardMeta}>~{estimateMinutes(totalChars)} min · {book.totalChunks} sections</Text>
        )}
        {hasProgress && !isProcessing && (
          <Text style={styles.cardResume}>Continue §{progress + 1}/{book.totalChunks}</Text>
        )}
        {isProcessing && <Text style={styles.cardMeta}>Processing…</Text>}
      </View>
    </TouchableOpacity>
  );
}

/**
 * Import from a parsed bundle object (used for bundled sample books).
 */
async function importPreprocessedFromData(bundle: any, dispatch: any) {
  return importPreprocessedBundle(bundle, dispatch);
}

/**
 * Import a preprocessed .bookvoice.json bundle produced by tools/prep.py.
 * The JSON contains metadata + pages array with extracted text.
 */
async function importPreprocessed(uri: string, dispatch: any) {
  const raw = await FileSystem.readAsStringAsync(uri);
  const bundle = JSON.parse(raw);
  return importPreprocessedBundle(bundle, dispatch);
}

async function importPreprocessedBundle(bundle: any, dispatch: any) {
  const bookId = generateId();
  const title = bundle.title || 'Untitled';
  const author = bundle.author || undefined;
  const language = bundle.language || undefined;

  // Chunk all page texts using the existing chunking logic
  let allChunks: TextChunk[] = [];
  const pages: any[] = bundle.pages || [];

  for (const page of pages) {
    const text = page.text?.trim();
    if (!text) continue;
    const pageNum = page.page_number ?? page.logical_page + 1;
    const pageChunks = chunkText(text, pageNum, bookId, allChunks.length);
    allChunks = [...allChunks, ...pageChunks];
  }

  // Map chapter markers to chunk indices
  const chapters: ChapterMark[] = [];
  if (bundle.chapters) {
    for (const ch of bundle.chapters) {
      // Find the chunk that corresponds to this chapter's logical page
      const chapterPage = pages[ch.logical_page];
      if (!chapterPage) continue;
      // Find the first chunk whose pageNumber matches
      const pageNum = chapterPage.page_number ?? chapterPage.logical_page + 1;
      const chunkIdx = allChunks.findIndex(c => c.pageNumber === pageNum);
      if (chunkIdx >= 0) {
        chapters.push({
          number: ch.number ?? null,
          title: ch.title || `Chapter ${ch.number}`,
          chunkIndex: chunkIdx,
        });
      }
    }
  }

  const book: Book = {
    id: bookId,
    title,
    author,
    coverColor: generateCoverColor(title),
    totalPages: bundle.total_logical_pages ?? pages.length,
    totalChunks: allChunks.length,
    chunks: allChunks,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    ocrStatus: 'done',
    ocrProgress: 100,
    language,
    sourceType: 'preprocessed',
    chapters: chapters.length > 0 ? chapters : undefined,
  };

  dispatch({ type: 'ADD_BOOK', book });
  await saveBook(book);
}

/**
 * Import a raw PDF — copies file to app storage and runs the text extraction pipeline.
 */
async function importPDF(asset: DocumentPicker.DocumentPickerAsset, dispatch: any) {
  const bookId = generateId();
  const destDir = `${FileSystem.documentDirectory}books/${bookId}/`;
  await FileSystem.makeDirectoryAsync(destDir, { intermediates: true });
  const destUri = `${destDir}book.pdf`;
  await FileSystem.copyAsync({ from: asset.uri, to: destUri });

  const title = titleFromFilename(asset.name ?? 'Untitled');
  const book: Book = {
    id: bookId, title, coverColor: generateCoverColor(title),
    totalPages: 0, totalChunks: 0, chunks: [],
    createdAt: Date.now(), lastOpenedAt: Date.now(),
    ocrStatus: 'processing', ocrProgress: 0,
    processingStage: 'Analyzing PDF…',
    sourceType: 'pdf',
  };
  dispatch({ type: 'ADD_BOOK', book });
  await saveBook(book);

  await runPdfPipeline(book, destUri, asset.name ?? 'Untitled', dispatch);
}

async function runPdfPipeline(book: Book, pdfUri: string, filename: string, dispatch: any) {
  try {
    // Extract cover in parallel (fire and forget)
    extractCover(pdfUri, book.id).then(coverUri => {
      if (coverUri) {
        dispatch({ type: 'UPDATE_BOOK', book: { ...book, coverImageUri: coverUri } });
      }
    }).catch(() => {});

    // Process PDF text
    const processed = await processPdf(pdfUri, filename, (pct, stage) => {
      dispatch({
        type: 'UPDATE_BOOK',
        book: { ...book, ocrProgress: pct, processingStage: stage },
      });
    });

    // Chunk all page texts
    let allChunks: TextChunk[] = [];
    for (const page of processed.pages) {
      if (!page.text.trim()) continue;
      const pageNum = page.pageNumber ?? page.logicalPage + 1;
      const pageChunks = chunkText(page.text, pageNum, book.id, allChunks.length);
      allChunks = [...allChunks, ...pageChunks];
    }

    // Map chapters to chunk indices
    const chapters: ChapterMark[] = [];
    if (processed.chapters.length > 0) {
      for (const ch of processed.chapters) {
        const chapterPage = processed.pages.find(p => p.logicalPage === ch.logicalPage);
        if (!chapterPage) continue;
        const pageNum = chapterPage.pageNumber ?? chapterPage.logicalPage + 1;
        const chunkIdx = allChunks.findIndex(c => c.pageNumber === pageNum);
        if (chunkIdx >= 0) {
          chapters.push({
            number: ch.number,
            title: ch.title || `Chapter ${ch.number}`,
            chunkIndex: chunkIdx,
          });
        }
      }
    }

    // Finalize book
    const finalBook: Book = {
      ...book,
      title: processed.title || book.title,
      author: processed.author || undefined,
      language: processed.language || undefined,
      totalPages: processed.pages.length,
      totalChunks: allChunks.length,
      chunks: allChunks,
      ocrStatus: 'done',
      ocrProgress: 100,
      processingStage: undefined,
      sourceType: 'pdf',
      chapters: chapters.length > 0 ? chapters : undefined,
    };
    dispatch({ type: 'UPDATE_BOOK', book: finalBook });
    await saveBook(finalBook);
  } catch (err: any) {
    dispatch({
      type: 'UPDATE_BOOK',
      book: { ...book, ocrStatus: 'error', processingStage: err.message ?? 'Processing failed' },
    });
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  headerTitle: { fontSize: 28, fontWeight: '800', color: '#f0ebe0', letterSpacing: -0.5 },
  headerSub: { fontSize: 13, color: '#555', marginTop: 2 },
  grid: { paddingHorizontal: 16, paddingBottom: 100 },
  row: { justifyContent: 'space-between', marginBottom: 16 },
  card: { width: CARD_WIDTH },
  cover: { width: CARD_WIDTH, height: CARD_WIDTH * 1.4, borderRadius: 10, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  coverImage: { width: '100%', height: '100%', borderRadius: 10 },
  coverInitial: { fontSize: 52, fontWeight: '900', color: 'rgba(255,255,255,0.9)' },
  processingOverlay: { alignItems: 'center', gap: 8 },
  processingText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  processingStage: { color: 'rgba(255,255,255,0.6)', fontSize: 10, textAlign: 'center', paddingHorizontal: 8 },
  cardInfo: { paddingTop: 8 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#e0dbd0', lineHeight: 18 },
  cardAuthor: { fontSize: 11, color: '#666', marginTop: 1 },
  cardMeta: { fontSize: 11, color: '#555', marginTop: 3 },
  cardResume: { fontSize: 11, color: '#c0392b', marginTop: 2, fontWeight: '600' },
  progressBadge: { position: 'absolute', bottom: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  progressBadgeText: { fontSize: 10, color: '#f0ebe0', fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#444' },
  emptySub: { fontSize: 13, color: '#333', textAlign: 'center', paddingHorizontal: 40 },
  sampleBtn: { marginTop: 20, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#1a1a24', borderRadius: 8 },
  sampleBtnText: { fontSize: 13, color: '#c0392b', fontWeight: '600' },
  fab: { position: 'absolute', bottom: 32, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#c0392b', alignItems: 'center', justifyContent: 'center', elevation: 8 },
  fabDisabled: { backgroundColor: '#444' },
});
