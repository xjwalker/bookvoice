import React, { useState, useMemo, useCallback, memo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  SafeAreaView, StatusBar, Alert, ActivityIndicator, Dimensions, Image,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useLibrary, useStore, useProgress, useSettings, useTheme, useNowPlaying } from '../store/AppStore';
import { BookMeta, TextChunk, ChapterMark } from '../types';
import { generateId, generateCoverColor, titleFromFilename, estimateMinutes } from '../utils/id';
import { saveBookMeta, saveChunks, saveSettings, deleteBook as deleteBookStorage } from '../services/storage';
import { chunkText } from '../services/ocr';
import { processPdf } from '../services/pdfProcessor';
import { extractCover } from '../services/coverExtractor';
import SettingsModal from '../components/SettingsModal';
import MiniPlayer from '../components/MiniPlayer';
// DEV: bundled sample books for testing
import sampleBookData from '../../assets/sample-book.json';
import losDiaconosData from '../../assets/los-diaconos.bookvoice.json';
import amarODependerData from '../../assets/amar-o-depender.bookvoice.json';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - 48) / 2;
const keyExtractor = (b: BookMeta) => b.id;

const LIST_ITEM_HEIGHT = 80;

type SortMode = 'recent' | 'title' | 'added';

export default function LibraryScreen() {
  const allBooks = useLibrary();
  const { dispatch } = useStore();
  const settings = useSettings();
  const theme = useTheme();
  const nowPlaying = useNowPlaying();
  const router = useRouter();
  const [importing, setImporting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const isGrid = settings.libraryView !== 'list';

  // Filter and sort books
  const books = useMemo(() => {
    let filtered = allBooks;
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = allBooks.filter(b =>
        b.title.toLowerCase().includes(q) ||
        b.author?.toLowerCase().includes(q) ||
        b.tags?.some(t => t.toLowerCase().includes(q))
      );
    }
    const sorted = [...filtered];
    if (sortMode === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sortMode === 'added') sorted.sort((a, b) => b.createdAt - a.createdAt);
    // 'recent' is already the default sort from useLibrary (lastOpenedAt desc)
    return sorted;
  }, [allBooks, search, sortMode]);

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

  function isDuplicate(title: string): boolean {
    const normalized = title.toLowerCase().trim();
    return allBooks.some(b => b.title.toLowerCase().trim() === normalized);
  }

  // DEV: load the bundled sample book directly (no file picker needed)
  async function handleLoadSample() {
    try {
      const title = (sampleBookData as any).title || 'Sample';
      if (isDuplicate(title)) { Alert.alert('Already imported', `"${title}" is already in your library.`); return; }
      setImporting(true);
      await importPreprocessedFromData(sampleBookData as any, dispatch);
    } catch (err: any) {
      Alert.alert('Import failed', err.message ?? 'Unknown error');
    } finally {
      setImporting(false);
    }
  }

  const handleOpenBook = useCallback((book: BookMeta) => {
    if (book.ocrStatus === 'processing') { Alert.alert('Still processing', 'Please wait...'); return; }
    if (book.ocrStatus === 'error') { Alert.alert('OCR Failed', 'Text extraction failed.'); return; }
    router.push(`/player/${book.id}`);
  }, [router]);

  const handleDeleteBook = useCallback((book: BookMeta) => {
    Alert.alert('Remove Book', `Remove "${book.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        dispatch({ type: 'DELETE_BOOK', bookId: book.id });
        await Promise.all([
          deleteBookStorage(book.id),
          FileSystem.deleteAsync(`${FileSystem.documentDirectory}books/${book.id}/`, { idempotent: true }),
        ]);
      }},
    ]);
  }, [dispatch]);

  const accent = settings.accentColor;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]}>
      <StatusBar barStyle={theme.statusBar} backgroundColor={theme.bg} />
      <View style={styles.header}>
        <View>
          <Text style={[styles.headerTitle, { color: theme.textPrimary }]}>ReadItForMe</Text>
          <Text style={[styles.headerSub, { color: theme.textDim }]}>Your audio library</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {books.length > 0 && (
            <TouchableOpacity
              style={[styles.headerBtn, { backgroundColor: theme.surface }]}
              onPress={() => {
                const next = isGrid ? 'list' as const : 'grid' as const;
                dispatch({ type: 'UPDATE_SETTINGS', settings: { libraryView: next } });
                saveSettings({ ...settings, libraryView: next });
              }}
              accessibilityRole="button"
              accessibilityLabel={isGrid ? 'Switch to list view' : 'Switch to grid view'}
            >
              <Ionicons name={isGrid ? 'list' : 'grid'} size={18} color={theme.textPrimary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.headerBtn, { backgroundColor: theme.surface }]}
            onPress={() => setShowSettings(true)}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Ionicons name="settings-outline" size={18} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>
      {/* Search & Sort bar */}
      {allBooks.length > 0 && (
        <View style={[styles.filterBar, { borderBottomColor: theme.border }]}>
          <View style={[styles.searchBox, { backgroundColor: theme.surfaceDeep }]}>
            <Ionicons name="search" size={16} color={theme.textDim} />
            <TextInput
              style={[styles.searchInput, { color: theme.textPrimary }]}
              placeholder="Search books..."
              placeholderTextColor={theme.textDim}
              value={search}
              onChangeText={setSearch}
              returnKeyType="search"
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')}>
                <Ionicons name="close-circle" size={16} color={theme.textDim} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={[styles.sortBtn, { backgroundColor: theme.surfaceDeep }]}
            onPress={() => setSortMode(m => m === 'recent' ? 'title' : m === 'title' ? 'added' : 'recent')}>
            <Ionicons name={sortMode === 'title' ? 'text' : sortMode === 'added' ? 'calendar' : 'time'} size={14} color={theme.textSecondary} />
            <Text style={[styles.sortLabel, { color: theme.textSecondary }]}>
              {sortMode === 'recent' ? 'Recent' : sortMode === 'title' ? 'A–Z' : 'Added'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {books.length === 0 && search.trim() ? (
        <View style={styles.empty}>
          <Ionicons name="search" size={48} color={theme.textMuted} />
          <Text style={[styles.emptyTitle, { color: theme.textMuted }]}>No matches</Text>
          <Text style={[styles.emptySub, { color: theme.textDim }]}>Try a different search term</Text>
        </View>
      ) : books.length === 0 && allBooks.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="book-outline" size={64} color={theme.textMuted} />
          <Text style={[styles.emptyTitle, { color: theme.textMuted }]}>No books yet</Text>
          <Text style={[styles.emptySub, { color: theme.textDim }]}>Tap + to import a scanned PDF{'\n'}or a preprocessed .bookvoice.json</Text>
          {__DEV__ && <SampleButtons accent={accent} theme={theme} importing={importing} dispatch={dispatch} setImporting={setImporting} onLoadSample={handleLoadSample} isDuplicate={isDuplicate} />}
        </View>
      ) : isGrid ? (
        <FlatList
          key="grid"
          data={books} keyExtractor={keyExtractor} numColumns={2}
          columnWrapperStyle={styles.row} contentContainerStyle={styles.grid}
          maxToRenderPerBatch={8}
          windowSize={5}
          ListHeaderComponent={
            __DEV__ ? <SampleButtons accent={accent} theme={theme} importing={importing} dispatch={dispatch} setImporting={setImporting} onLoadSample={handleLoadSample} isDuplicate={isDuplicate} /> : undefined
          }
          renderItem={({ item }) => (
            <BookCard book={item} theme={theme} accent={accent} onPress={() => handleOpenBook(item)} onDelete={() => handleDeleteBook(item)} />
          )}
        />
      ) : (
        <FlatList
          key="list"
          data={books} keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
          maxToRenderPerBatch={12}
          windowSize={7}
          ListHeaderComponent={__DEV__ ? <SampleButtons accent={accent} theme={theme} importing={importing} dispatch={dispatch} setImporting={setImporting} onLoadSample={handleLoadSample} isDuplicate={isDuplicate} /> : undefined}
          renderItem={({ item }) => (
            <BookListItem book={item} theme={theme} accent={accent} onPress={() => handleOpenBook(item)} onDelete={() => handleDeleteBook(item)} />
          )}
        />
      )}
      {/* Mini player for background playback */}
      {nowPlaying && nowPlaying.isPlaying && (
        <MiniPlayer
          nowPlaying={nowPlaying}
          accent={accent}
          theme={theme}
          onTap={() => router.push(`/player/${nowPlaying.bookId}`)}
        />
      )}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: accent, bottom: nowPlaying?.isPlaying ? 100 : 32 }, importing && styles.fabDisabled]}
        onPress={handleImport} disabled={importing}
        accessibilityRole="button"
        accessibilityLabel={importing ? 'Importing book' : 'Import a book'}
        accessibilityState={{ busy: importing }}
      >
        {importing ? <ActivityIndicator color="#fff" /> : <Ionicons name="add" size={28} color="#fff" />}
      </TouchableOpacity>
      <SettingsModal
        visible={showSettings}
        settings={settings}
        theme={theme}
        onUpdate={(partial) => {
          dispatch({ type: 'UPDATE_SETTINGS', settings: partial });
          saveSettings({ ...settings, ...partial });
        }}
        onClose={() => setShowSettings(false)}
      />
    </SafeAreaView>
  );
}

const BookCard = memo(function BookCard({ book, theme: t, accent, onPress, onDelete }: { book: BookMeta; theme: any; accent: string; onPress: () => void; onDelete: () => void }) {
  const totalChars = book.totalCharCount || 0;
  const progress = useProgress(book.id);
  const isProcessing = book.ocrStatus === 'processing';
  const hasProgress = progress > 0 && book.totalChunks > 0;
  const progressPct = hasProgress ? Math.round((progress / book.totalChunks) * 100) : 0;

  return (
    <TouchableOpacity
      style={styles.card} onPress={onPress} activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${book.title}${book.author ? ` by ${book.author}` : ''}${isProcessing ? `, processing ${book.ocrProgress}%` : ''}${hasProgress ? `, ${progressPct}% complete` : ''}${!isProcessing && book.totalChunks > 0 ? `, about ${estimateMinutes(totalChars)} minutes` : ''}`}
      accessibilityHint="Double tap to open"
    >
      <View style={[styles.cover, { backgroundColor: book.coverColor }]} accessibilityElementsHidden>
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
        <TouchableOpacity
          style={styles.deleteBtn} onPress={onDelete} hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${book.title}`}
        >
          <Ionicons name="close-circle" size={22} color="rgba(255,255,255,0.8)" />
        </TouchableOpacity>
      </View>
      <View style={styles.cardInfo} accessibilityElementsHidden>
        <Text style={[styles.cardTitle, { color: t.textPrimary }]} numberOfLines={2}>{book.title}</Text>
        {book.author ? <Text style={[styles.cardAuthor, { color: t.textDim }]} numberOfLines={1}>{book.author}</Text> : null}
        {!isProcessing && book.totalChunks > 0 && (
          <Text style={[styles.cardMeta, { color: t.textDim }]}>~{estimateMinutes(totalChars)} min · {book.totalChunks} sections</Text>
        )}
        {hasProgress && !isProcessing && (
          <Text style={[styles.cardResume, { color: accent }]}>Continue §{progress + 1}/{book.totalChunks}</Text>
        )}
        {isProcessing && <Text style={[styles.cardMeta, { color: t.textDim }]}>Processing…</Text>}
      </View>
    </TouchableOpacity>
  );
});

const BookListItem = memo(function BookListItem({ book, theme: t, accent, onPress, onDelete }: { book: BookMeta; theme: any; accent: string; onPress: () => void; onDelete: () => void }) {
  const totalChars = book.totalCharCount || 0;
  const progress = useProgress(book.id);
  const isProcessing = book.ocrStatus === 'processing';
  const hasProgress = progress > 0 && book.totalChunks > 0;
  const progressPct = hasProgress ? Math.round((progress / book.totalChunks) * 100) : 0;

  return (
    <TouchableOpacity
      style={[styles.listItem, { borderBottomColor: t.border }]} onPress={onPress} activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${book.title}${book.author ? ` by ${book.author}` : ''}${isProcessing ? `, processing ${book.ocrProgress}%` : ''}${hasProgress ? `, ${progressPct}% complete` : ''}${!isProcessing && book.totalChunks > 0 ? `, about ${estimateMinutes(totalChars)} minutes` : ''}`}
      accessibilityHint="Double tap to open"
    >
      <View style={[styles.listCover, { backgroundColor: book.coverColor }]} accessibilityElementsHidden>
        {book.coverImageUri && !isProcessing ? (
          <Image source={{ uri: book.coverImageUri }} style={styles.listCoverImage} />
        ) : (
          <Text style={styles.listCoverInitial}>{book.title.charAt(0).toUpperCase()}</Text>
        )}
      </View>
      <View style={styles.listInfo} accessibilityElementsHidden>
        <Text style={[styles.listTitle, { color: t.textPrimary }]} numberOfLines={1}>{book.title}</Text>
        {book.author ? <Text style={[styles.listAuthor, { color: t.textSecondary }]} numberOfLines={1}>{book.author}</Text> : null}
        <View style={styles.listMeta}>
          {!isProcessing && book.totalChunks > 0 && (
            <Text style={[styles.listMetaText, { color: t.textDim }]}>~{estimateMinutes(totalChars)} min</Text>
          )}
          {hasProgress && !isProcessing && (
            <Text style={[styles.listMetaText, { color: accent }]}>{progressPct}%</Text>
          )}
          {isProcessing && <Text style={[styles.listMetaText, { color: t.textDim }]}>Processing… {book.ocrProgress}%</Text>}
        </View>
      </View>
      <TouchableOpacity
        onPress={onDelete} hitSlop={8} style={{ padding: 4 }}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${book.title}`}
      >
        <Ionicons name="trash-outline" size={18} color={t.textMuted} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
});

// DEV: sample book loader buttons — shown as header in the book list
function SampleButtons({ accent, theme: t, importing, dispatch, setImporting, onLoadSample, isDuplicate }: any) {
  const loadBundle = (data: any) => {
    const title = data.title || 'Untitled';
    if (isDuplicate?.(title)) { Alert.alert('Already imported', `"${title}" is already in your library.`); return; }
    setImporting(true);
    importPreprocessedFromData(data, dispatch)
      .catch((e: any) => Alert.alert('Import failed', e.message))
      .finally(() => setImporting(false));
  };
  return (
    <View style={styles.sampleRow}>
      <TouchableOpacity style={[styles.sampleBtn, { backgroundColor: t.surface }]} onPress={onLoadSample} disabled={importing}>
        <Text style={[styles.sampleBtnText, { color: accent }]}>+ Sample</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.sampleBtn, { backgroundColor: t.surface }]} onPress={() => loadBundle(losDiaconosData)} disabled={importing}>
        <Text style={[styles.sampleBtnText, { color: accent }]}>+ Diáconos</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.sampleBtn, { backgroundColor: t.surface }]} onPress={() => loadBundle(amarODependerData)} disabled={importing}>
        <Text style={[styles.sampleBtnText, { color: accent }]}>+ Amar</Text>
      </TouchableOpacity>
    </View>
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
  const allChunks: TextChunk[] = [];
  const pages: any[] = bundle.pages || [];

  for (const page of pages) {
    const text = page.text?.trim();
    if (!text) continue;
    const pageNum = page.page_number ?? page.logical_page + 1;
    const pageChunks = chunkText(text, pageNum, bookId, allChunks.length);
    for (const c of pageChunks) allChunks.push(c);
  }

  // Map chapter markers to chunk indices
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
          title: ch.title || `Chapter ${ch.number}`,
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

  // Dispatch lightweight metadata to state, save chunks separately
  dispatch({ type: 'ADD_BOOK', book: meta });
  await Promise.all([
    saveBookMeta(meta),
    saveChunks(bookId, allChunks),
  ]);
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
  const meta: BookMeta = {
    id: bookId, title, coverColor: generateCoverColor(title),
    totalPages: 0, totalChunks: 0, totalCharCount: 0,
    createdAt: Date.now(), lastOpenedAt: Date.now(),
    ocrStatus: 'processing', ocrProgress: 0,
    processingStage: 'Analyzing PDF…',
    sourceType: 'pdf',
  };
  dispatch({ type: 'ADD_BOOK', book: meta });
  await saveBookMeta(meta);

  await runPdfPipeline(meta, destUri, asset.name ?? 'Untitled', dispatch);
}

async function runPdfPipeline(meta: BookMeta, pdfUri: string, filename: string, dispatch: any) {
  try {
    // Extract cover in parallel (fire and forget)
    extractCover(pdfUri, meta.id).then(coverUri => {
      if (coverUri) {
        dispatch({ type: 'UPDATE_BOOK', book: { ...meta, coverImageUri: coverUri } });
      }
    }).catch(() => {});

    // Process PDF text
    const processed = await processPdf(pdfUri, filename, (pct, stage) => {
      dispatch({
        type: 'UPDATE_BOOK',
        book: { ...meta, ocrProgress: pct, processingStage: stage },
      });
    });

    // Chunk all page texts (push instead of spread to avoid O(n^2) allocations)
    const allChunks: TextChunk[] = [];
    for (const page of processed.pages) {
      if (!page.text.trim()) continue;
      const pageNum = page.pageNumber ?? page.logicalPage + 1;
      const pageChunks = chunkText(page.text, pageNum, meta.id, allChunks.length);
      for (const c of pageChunks) allChunks.push(c);
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

    const totalCharCount = allChunks.reduce((s, c) => s + c.charCount, 0);

    // Finalize — dispatch metadata to state, save chunks separately
    const finalMeta: BookMeta = {
      ...meta,
      title: processed.title || meta.title,
      author: processed.author || undefined,
      language: processed.language || undefined,
      totalPages: processed.pages.length,
      totalChunks: allChunks.length,
      totalCharCount,
      ocrStatus: 'done',
      ocrProgress: 100,
      processingStage: undefined,
      sourceType: 'pdf',
      chapters: chapters.length > 0 ? chapters : undefined,
    };
    dispatch({ type: 'UPDATE_BOOK', book: finalMeta });
    await Promise.all([
      saveBookMeta(finalMeta),
      saveChunks(meta.id, allChunks),
    ]);
  } catch (err: any) {
    dispatch({
      type: 'UPDATE_BOOK',
      book: { ...meta, ocrStatus: 'error', processingStage: err.message ?? 'Processing failed' },
    });
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  headerTitle: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  headerSub: { fontSize: 13, marginTop: 2 },
  headerBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  // Search & sort
  filterBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, gap: 8, borderBottomWidth: 1 },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', borderRadius: 8, paddingHorizontal: 10, height: 36, gap: 6 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 36, borderRadius: 8 },
  sortLabel: { fontSize: 11, fontWeight: '600' },
  // Grid view
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
  cardTitle: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  cardAuthor: { fontSize: 11, marginTop: 1 },
  cardMeta: { fontSize: 11, marginTop: 3 },
  cardResume: { fontSize: 11, marginTop: 2, fontWeight: '600' },
  deleteBtn: { position: 'absolute', top: 6, right: 6 },
  progressBadge: { position: 'absolute', bottom: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  progressBadgeText: { fontSize: 10, color: '#f0ebe0', fontWeight: '700' },
  // List view
  listContent: { paddingBottom: 100 },
  listItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, height: LIST_ITEM_HEIGHT, gap: 12 },
  listCover: { width: 48, height: 64, borderRadius: 6, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  listCoverImage: { width: '100%', height: '100%', borderRadius: 6 },
  listCoverInitial: { fontSize: 22, fontWeight: '900', color: 'rgba(255,255,255,0.9)' },
  listInfo: { flex: 1 },
  listTitle: { fontSize: 14, fontWeight: '700' },
  listAuthor: { fontSize: 12, marginTop: 1 },
  listMeta: { flexDirection: 'row', gap: 8, marginTop: 3 },
  listMetaText: { fontSize: 11 },
  // Empty state
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  emptySub: { fontSize: 13, textAlign: 'center', paddingHorizontal: 40 },
  sampleRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8, flexWrap: 'wrap' },
  sampleBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  sampleBtnText: { fontSize: 13, fontWeight: '600' },
  fab: { position: 'absolute', right: 24, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 8 },
  fabDisabled: { backgroundColor: '#444' },
});
