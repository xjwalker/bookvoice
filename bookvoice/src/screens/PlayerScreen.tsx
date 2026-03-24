import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  SafeAreaView, StatusBar, Modal, FlatList, SectionList,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useBook, useProgress, useStore } from '../store/AppStore';
import { saveProgress } from '../services/storage';
import * as TTS from '../services/tts';
import { estimateMinutes } from '../utils/id';
import { ChapterMark } from '../types';
import {
  setRemoteHandlers, clearRemoteHandlers,
  updateNowPlaying, setMediaPlaying, setMediaPaused, clearMediaSession,
} from '../services/mediaSession';

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

function currentChapterForChunk(chapters: ChapterMark[] | undefined, chunkIndex: number): ChapterMark | null {
  if (!chapters || chapters.length === 0) return null;
  let ch = chapters[0];
  for (const c of chapters) {
    if (c.chunkIndex <= chunkIndex) ch = c;
    else break;
  }
  return ch;
}

export default function PlayerScreen() {
  const { id: bookId } = useLocalSearchParams<{ id: string }>();
  const book = useBook(bookId!);
  const savedChunkIndex = useProgress(bookId!);
  const { dispatch } = useStore();
  const router = useRouter();
  const [currentChunk, setCurrentChunk] = useState(savedChunkIndex);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [showIndex, setShowIndex] = useState(false);
  const [indexMode, setIndexMode] = useState<'chapters' | 'sections'>('chapters');
  const currentSpeedRef = useRef(SPEEDS[speedIndex]);
  currentSpeedRef.current = SPEEDS[speedIndex];
  const hasRestoredRef = useRef(false);
  const currentChunkRef = useRef(currentChunk);
  currentChunkRef.current = currentChunk;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // Restore saved position once store finishes loading from AsyncStorage.
  // savedChunkIndex starts as 0 before INIT, then updates to the real value.
  // We wait for a non-zero value, or accept 0 after store has loaded.
  const { state: { isLoaded: storeLoaded } } = useStore();
  useEffect(() => {
    if (!hasRestoredRef.current && storeLoaded) {
      setCurrentChunk(savedChunkIndex);
      hasRestoredRef.current = true;
    }
  }, [storeLoaded, savedChunkIndex]);

  const persistProgress = useCallback(async (idx: number) => {
    if (!bookId) return;
    dispatch({ type: 'SET_PROGRESS', bookId, chunkIndex: idx });
    await saveProgress(bookId, idx);
  }, [bookId, dispatch]);

  async function play(fromChunk: number) {
    if (!book || book.chunks.length === 0) return;
    setIsPlaying(true);
    setMediaPlaying();
    await TTS.playChunks({
      chunks: book.chunks, startChunkIndex: fromChunk, rate: currentSpeedRef.current, language: book.language,
      onChunkStart: (idx) => {
        setCurrentChunk(idx);
        updateNowPlaying({
          title: book.title,
          artist: book.author,
          chapter: currentChapterForChunk(book.chapters, idx)?.title,
          currentChunk: idx,
          totalChunks: book.chunks.length,
          coverUri: book.coverImageUri,
        });
      },
      onChunkEnd: (idx) => persistProgress(idx + 1),
      onFinished: () => { setIsPlaying(false); setMediaPaused(); setCurrentChunk(0); persistProgress(0); },
      onError: (err) => { console.error('TTS error:', err); setIsPlaying(false); setMediaPaused(); },
    });
  }

  async function handlePlayPause() {
    if (isPlayingRef.current) {
      await TTS.pause(); setIsPlaying(false); setMediaPaused();
    } else {
      await play(currentChunkRef.current);
    }
  }

  async function handlePrev() {
    const target = Math.max(0, currentChunkRef.current - 1);
    await TTS.stop(); setCurrentChunk(target); setIsPlaying(false); setMediaPaused(); persistProgress(target);
  }

  async function handleNext() {
    if (!book) return;
    const target = Math.min(book.chunks.length - 1, currentChunkRef.current + 1);
    await TTS.stop(); setCurrentChunk(target); setIsPlaying(false); setMediaPaused(); persistProgress(target);
  }

  async function handleSeekToChunk(idx: number) {
    await TTS.stop(); setCurrentChunk(idx); setIsPlaying(false); setMediaPaused(); setShowIndex(false); persistProgress(idx);
  }

  // Register lock screen / notification remote control handlers
  useEffect(() => {
    setRemoteHandlers({
      onPlay: () => handlePlayPause(),
      onPause: () => handlePlayPause(),
      onNext: () => handleNext(),
      onPrev: () => handlePrev(),
    });

    // Set initial Now Playing metadata
    if (book) {
      updateNowPlaying({
        title: book.title,
        artist: book.author,
        chapter: currentChapterForChunk(book.chapters, currentChunk)?.title,
        currentChunk,
        totalChunks: book.chunks.length,
        coverUri: book.coverImageUri,
      });
    }

    return () => {
      clearRemoteHandlers();
      clearMediaSession();
    };
  }, [book?.id]);

  // Figure out which chapter the current chunk is in
  const currentChapter = useMemo(() => {
    if (!book?.chapters || book.chapters.length === 0) return null;
    let ch = book.chapters[0];
    for (const c of book.chapters) {
      if (c.chunkIndex <= currentChunk) ch = c;
      else break;
    }
    return ch;
  }, [book?.chapters, currentChunk]);

  if (!book) {
    return <SafeAreaView style={styles.container}><Text style={styles.errorText}>Book not found.</Text></SafeAreaView>;
  }

  const totalChunks = book.chunks.length;
  const progress = totalChunks > 0 ? currentChunk / totalChunks : 0;
  const currentText = book.chunks[currentChunk]?.text ?? '';
  const currentPage = book.chunks[currentChunk]?.pageNumber ?? 1;
  const remainingChars = book.chunks.slice(currentChunk).reduce((s, c) => s + c.charCount, 0);
  const remainingMins = estimateMinutes(remainingChars, SPEEDS[speedIndex]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0f" />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#888" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowIndex(true)} style={styles.indexBtn}>
          <Ionicons name="list" size={20} color="#f0ebe0" />
          <Text style={styles.indexBtnText}>Index</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.coverSection}>
        <View style={[styles.coverArt, { backgroundColor: book.coverColor }]}>
          <Text style={styles.coverLetter}>{book.title.charAt(0).toUpperCase()}</Text>
        </View>
        <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
        {currentChapter && (
          <TouchableOpacity onPress={() => setShowIndex(true)} style={styles.chapterBar}>
            <Ionicons name="bookmark" size={14} color="#c0392b" />
            <Text style={styles.chapterLabel} numberOfLines={1}>{currentChapter.title}</Text>
            <Ionicons name="chevron-forward" size={14} color="#555" />
          </TouchableOpacity>
        )}
        <Text style={styles.bookMeta}>Page {currentPage} · §{currentChunk + 1}/{totalChunks} · ~{remainingMins}m left</Text>
      </View>
      <ScrollView style={styles.textPreview} contentContainerStyle={styles.textPreviewInner}>
        <Text style={styles.chunkText}>{currentText}</Text>
      </ScrollView>
      <View style={styles.progressContainer}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={styles.progressLabels}>
          <Text style={styles.progressLabel}>{Math.round(progress * 100)}%</Text>
          <Text style={styles.progressLabel}>{totalChunks} sections</Text>
        </View>
      </View>
      <View style={styles.controls}>
        <TouchableOpacity onPress={() => setSpeedIndex((p) => (p + 1) % SPEEDS.length)} style={styles.speedBtn}>
          <Text style={styles.speedText}>{SPEEDS[speedIndex]}×</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handlePrev} style={styles.controlBtn}>
          <Ionicons name="play-skip-back" size={28} color="#c8c0b0" />
        </TouchableOpacity>
        <TouchableOpacity onPress={handlePlayPause} style={styles.playBtn}>
          <Ionicons name={isPlaying ? 'pause' : 'play'} size={32} color="#0a0a0f" />
        </TouchableOpacity>
        <TouchableOpacity onPress={handleNext} style={styles.controlBtn}>
          <Ionicons name="play-skip-forward" size={28} color="#c8c0b0" />
        </TouchableOpacity>
        <View style={styles.speedBtn} />
      </View>
      <BookIndex
        visible={showIndex}
        chunks={book.chunks}
        chapters={book.chapters}
        currentIndex={currentChunk}
        coverColor={book.coverColor}
        mode={indexMode}
        onModeChange={setIndexMode}
        onSelect={handleSeekToChunk}
        onClose={() => setShowIndex(false)}
      />
    </SafeAreaView>
  );
}

function BookIndex({ visible, chunks, chapters, currentIndex, coverColor, mode, onModeChange, onSelect, onClose }: any) {
  const hasChapters = chapters && chapters.length > 0;

  // Build chapter sections for the sections view
  const chapterSections = useMemo(() => {
    if (!hasChapters) return [];
    const sections: { title: string; chunkIndex: number; data: { index: number; text: string; pageNumber: number }[] }[] = [];

    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      const nextStart = ci < chapters.length - 1 ? chapters[ci + 1].chunkIndex : chunks.length;
      const sectionChunks = [];
      for (let i = ch.chunkIndex; i < nextStart && i < chunks.length; i++) {
        sectionChunks.push({ index: i, text: chunks[i].text, pageNumber: chunks[i].pageNumber });
      }
      sections.push({
        title: ch.title || `Chapter ${ch.number}`,
        chunkIndex: ch.chunkIndex,
        data: sectionChunks,
      });
    }

    // Add any chunks before the first chapter
    if (chapters[0].chunkIndex > 0) {
      const preChunks = [];
      for (let i = 0; i < chapters[0].chunkIndex; i++) {
        preChunks.push({ index: i, text: chunks[i].text, pageNumber: chunks[i].pageNumber });
      }
      if (preChunks.length > 0) {
        sections.unshift({ title: 'Preface', chunkIndex: 0, data: preChunks });
      }
    }

    return sections;
  }, [chunks, chapters, hasChapters]);

  // Find which chapter the current chunk is in (for auto-scrolling chapters view)
  const currentChapterIdx = useMemo(() => {
    if (!hasChapters) return 0;
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (chapters[i].chunkIndex <= currentIndex) return i;
    }
    return 0;
  }, [chapters, currentIndex, hasChapters]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={indexStyles.container}>
        <View style={indexStyles.header}>
          <Text style={indexStyles.title}>Index</Text>
          <View style={indexStyles.headerRight}>
            {hasChapters && (
              <View style={indexStyles.modeToggle}>
                <TouchableOpacity
                  style={[indexStyles.modeBtn, mode === 'chapters' && { backgroundColor: '#1e1e28' }]}
                  onPress={() => onModeChange('chapters')}>
                  <Text style={[indexStyles.modeBtnText, mode === 'chapters' && { color: coverColor }]}>Chapters</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[indexStyles.modeBtn, mode === 'sections' && { backgroundColor: '#1e1e28' }]}
                  onPress={() => onModeChange('sections')}>
                  <Text style={[indexStyles.modeBtnText, mode === 'sections' && { color: coverColor }]}>Sections</Text>
                </TouchableOpacity>
              </View>
            )}
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
              <Ionicons name="close" size={24} color="#888" />
            </TouchableOpacity>
          </View>
        </View>

        {mode === 'chapters' && hasChapters ? (
          <FlatList
            data={chapters}
            keyExtractor={(_: any, i: number) => `ch-${i}`}
            initialScrollIndex={currentChapterIdx > 2 ? currentChapterIdx - 1 : 0}
            getItemLayout={(_, index) => ({ length: 72, offset: 72 * index, index })}
            renderItem={({ item, index }: any) => {
              const isCurrent = currentChapterIdx === index;
              const chunkCount = index < chapters.length - 1
                ? chapters[index + 1].chunkIndex - item.chunkIndex
                : chunks.length - item.chunkIndex;
              return (
                <TouchableOpacity
                  style={[indexStyles.chapterItem, isCurrent && { borderLeftColor: coverColor, borderLeftWidth: 3 }]}
                  onPress={() => onSelect(item.chunkIndex)}>
                  <View style={indexStyles.chapterNum}>
                    <Text style={[indexStyles.chapterNumText, isCurrent && { color: coverColor }]}>
                      {item.number ?? index + 1}
                    </Text>
                  </View>
                  <View style={indexStyles.chapterBody}>
                    <Text style={[indexStyles.chapterItemTitle, isCurrent && { color: '#f0ebe0' }]} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text style={indexStyles.chapterMeta}>{chunkCount} sections</Text>
                  </View>
                  {isCurrent && <Ionicons name="volume-medium" size={16} color={coverColor} />}
                </TouchableOpacity>
              );
            }}
          />
        ) : (
          <SectionList
            sections={chapterSections.length > 0 ? chapterSections : [{ title: 'All sections', chunkIndex: 0, data: chunks.map((c: any, i: number) => ({ index: i, text: c.text, pageNumber: c.pageNumber })) }]}
            keyExtractor={(item: any) => `s-${item.index}`}
            renderSectionHeader={({ section }: any) => (
              <TouchableOpacity
                style={indexStyles.sectionHeader}
                onPress={() => onSelect(section.chunkIndex)}>
                <Ionicons name="bookmark" size={12} color={coverColor} />
                <Text style={[indexStyles.sectionHeaderText, { color: coverColor }]}>{section.title}</Text>
              </TouchableOpacity>
            )}
            renderItem={({ item }: any) => (
              <TouchableOpacity
                style={[indexStyles.item, item.index === currentIndex && { borderLeftColor: coverColor, borderLeftWidth: 3 }]}
                onPress={() => onSelect(item.index)}>
                <Text style={indexStyles.itemNum}>§{item.index + 1}</Text>
                <View style={indexStyles.itemBody}>
                  <Text style={indexStyles.itemPage}>Page {item.pageNumber}</Text>
                  <Text style={indexStyles.itemPreview} numberOfLines={2}>{item.text.slice(0, 100)}…</Text>
                </View>
                {item.index === currentIndex && <Ionicons name="volume-medium" size={16} color={coverColor} />}
              </TouchableOpacity>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  errorText: { color: '#666', textAlign: 'center', marginTop: 100 },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  backBtn: { padding: 8 },
  indexBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 8, backgroundColor: '#1a1a24', borderRadius: 8 },
  indexBtnText: { fontSize: 12, color: '#f0ebe0', fontWeight: '600' },
  coverSection: { alignItems: 'center', paddingVertical: 20 },
  coverArt: { width: 120, height: 168, borderRadius: 10, alignItems: 'center', justifyContent: 'center', elevation: 12 },
  coverLetter: { fontSize: 48, fontWeight: '900', color: 'rgba(255,255,255,0.9)' },
  bookTitle: { fontSize: 18, fontWeight: '800', color: '#f0ebe0', textAlign: 'center', paddingHorizontal: 24, marginTop: 16 },
  chapterBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#1a1a24', borderRadius: 20 },
  chapterLabel: { fontSize: 13, color: '#c0392b', flexShrink: 1 },
  bookMeta: { fontSize: 12, color: '#555', marginTop: 6 },
  textPreview: { flex: 1, marginHorizontal: 24, marginVertical: 8 },
  textPreviewInner: { paddingVertical: 8 },
  chunkText: { fontSize: 15, color: '#7a7060', lineHeight: 24, fontStyle: 'italic' },
  progressContainer: { paddingHorizontal: 24, paddingBottom: 8 },
  progressTrack: { height: 3, backgroundColor: '#1e1e28', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#c0392b', borderRadius: 2 },
  progressLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  progressLabel: { fontSize: 11, color: '#444' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 32, paddingTop: 8 },
  controlBtn: { padding: 12 },
  playBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#f0ebe0', alignItems: 'center', justifyContent: 'center' },
  speedBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  speedText: { fontSize: 13, fontWeight: '700', color: '#c0392b' },
});

const indexStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d15' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a24' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 18, fontWeight: '800', color: '#f0ebe0' },
  modeToggle: { flexDirection: 'row', backgroundColor: '#111118', borderRadius: 8, overflow: 'hidden' },
  modeBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  modeBtnText: { fontSize: 12, fontWeight: '600', color: '#555' },
  chapterItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#111118', gap: 12, height: 72 },
  chapterNum: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#1a1a24', alignItems: 'center', justifyContent: 'center' },
  chapterNumText: { fontSize: 13, fontWeight: '700', color: '#555' },
  chapterBody: { flex: 1 },
  chapterItemTitle: { fontSize: 14, fontWeight: '600', color: '#7a7060', lineHeight: 20 },
  chapterMeta: { fontSize: 11, color: '#444', marginTop: 2 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8, backgroundColor: '#0d0d15' },
  sectionHeaderText: { fontSize: 13, fontWeight: '700' },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#111118', gap: 12 },
  itemNum: { fontSize: 12, color: '#444', width: 28 },
  itemBody: { flex: 1 },
  itemPage: { fontSize: 11, color: '#555', marginBottom: 2 },
  itemPreview: { fontSize: 13, color: '#7a7060', lineHeight: 18 },
});
