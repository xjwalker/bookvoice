import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Image,
  SafeAreaView, StatusBar, Modal, FlatList, SectionList, Animated, ActivityIndicator, AppState,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useBookMeta, useProgress, useStore, useSettings, useTheme, useNowPlaying } from '../store/AppStore';
import { saveProgress, saveSettings, saveBookMeta, loadChunks } from '../services/storage';
import * as TTS from '../services/tts';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { estimateMinutes } from '../utils/id';
import { ChapterMark, TextChunk } from '../types';
import {
  setRemoteHandlers, clearRemoteHandlers,
  updateNowPlaying, setMediaPlaying, setMediaPaused, clearMediaSession,
} from '../services/mediaSession';
import SettingsModal from '../components/SettingsModal';

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
  const book = useBookMeta(bookId!);
  const savedChunkIndex = useProgress(bookId!);
  const { dispatch } = useStore();
  const settings = useSettings();
  const theme = useTheme();
  const router = useRouter();

  // Ref for voice so TTS loop always uses latest without restart
  const voiceRef = useRef(settings.voiceId);
  voiceRef.current = settings.voiceId;

  // Lazy-load chunks — only when opening the player
  const [chunks, setChunks] = useState<TextChunk[] | null>(null);
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    loadChunks(bookId).then(c => { if (!cancelled) setChunks(c); });
    return () => { cancelled = true; };
  }, [bookId]);

  const [currentChunk, setCurrentChunk] = useState(savedChunkIndex);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [showIndex, setShowIndex] = useState(false);
  const [showSpeedPicker, setShowSpeedPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [indexMode, setIndexMode] = useState<'chapters' | 'sections'>('chapters');
  const currentSpeedRef = useRef(SPEEDS[speedIndex]);
  currentSpeedRef.current = SPEEDS[speedIndex];
  const pulseAnim = useRef(new Animated.Value(0.6)).current;
  const [charPos, setCharPos] = useState<{ start: number; end: number } | null>(null);
  const textScrollRef = useRef<ScrollView>(null);
  const textLenRef = useRef(0);
  const contentHeightRef = useRef(0);
  const scrollViewHeightRef = useRef(0);
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

  // Debounced progress save — update state immediately, batch AsyncStorage writes
  const pendingProgressRef = useRef<number | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushProgress = useCallback(() => {
    if (pendingProgressRef.current !== null && bookId) {
      saveProgress(bookId, pendingProgressRef.current);
      pendingProgressRef.current = null;
    }
  }, [bookId]);

  const persistProgress = useCallback((idx: number) => {
    if (!bookId) return;
    dispatch({ type: 'SET_PROGRESS', bookId, chunkIndex: idx });
    pendingProgressRef.current = idx;
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    progressTimerRef.current = setTimeout(flushProgress, 2000);
  }, [bookId, dispatch, flushProgress]);

  // Flush pending progress on unmount or app background; clear dangling timer
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushProgress();
    });
    return () => {
      sub.remove();
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
      flushProgress();
    };
  }, [flushProgress]);

  // Sync now-playing state to global store so mini-player can show on library screen
  useEffect(() => {
    if (!book || !bookId) return;
    if (isPlaying) {
      dispatch({
        type: 'SET_NOW_PLAYING',
        state: {
          bookId,
          title: book.title,
          coverColor: book.coverColor,
          coverImageUri: book.coverImageUri,
          chunkIndex: currentChunk,
          totalChunks: book.totalChunks,
          isPlaying: true,
          playbackRate: SPEEDS[speedIndex],
        },
      });
    } else {
      dispatch({ type: 'SET_NOW_PLAYING', state: null });
    }
  }, [isPlaying, currentChunk]);

  // Pulse animation for active reading indicator
  useEffect(() => {
    if (isPlaying) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 0.6, duration: 800, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(0.6);
    }
  }, [isPlaying]);

  const resetCharPos = useCallback((full = true) => {
    if (full) setCharPos(null);
  }, []);

  // Throttle word boundary updates to ~15fps — avoids excessive re-renders during fast speech
  const lastWordUpdateRef = useRef(0);
  const throttledSetCharPos = useCallback((pos: { start: number; end: number }) => {
    const now = Date.now();
    if (now - lastWordUpdateRef.current < 66) return; // ~15fps
    lastWordUpdateRef.current = now;
    setCharPos(pos);
  }, []);

  // Auto-scroll as character position advances
  useEffect(() => {
    if (!charPos || textLenRef.current === 0) return;
    const maxScroll = contentHeightRef.current - scrollViewHeightRef.current;
    if (maxScroll <= 0) return;
    const ratio = charPos.start / textLenRef.current;
    textScrollRef.current?.scrollTo({ y: ratio * maxScroll, animated: true });
  }, [charPos]);

  // Track last known char position for mid-chunk resume
  const lastCharPosRef = useRef<number>(0);

  async function play(fromChunk: number, charOffset?: number) {
    if (!book || !chunks || chunks.length === 0) return;
    fromChunk = Math.max(0, Math.min(fromChunk, chunks.length - 1));
    setIsPlaying(true);
    setMediaPlaying();
    await TTS.playChunks({
      chunks, startChunkIndex: fromChunk,
      startCharOffset: charOffset,
      rate: () => currentSpeedRef.current,
      language: book.language, voice: () => voiceRef.current,
      onWordBoundary: (wordIndex, charStart, charLength) => {
        lastCharPosRef.current = charStart ?? 0;
        throttledSetCharPos({ start: charStart ?? 0, end: (charStart ?? 0) + (charLength ?? 0) });
      },
      onChunkStart: (idx) => {
        setCurrentChunk(idx);
        lastCharPosRef.current = 0;
        const chunkText = chunks[idx]?.text ?? '';
        textLenRef.current = chunkText.length;
        setCharPos(null);
        updateNowPlaying({
          title: book.title,
          artist: book.author,
          chapter: currentChapterForChunk(book.chapters, idx)?.title,
          currentChunk: idx,
          totalChunks: chunks.length,
          coverUri: book.coverImageUri,
        });
      },
      onChunkEnd: (idx) => persistProgress(idx + 1),
      onFinished: () => { resetCharPos(); setIsPlaying(false); setMediaPaused(); setCurrentChunk(0); persistProgress(0); },
      onError: (err) => { resetCharPos(); console.error('TTS error:', err); setIsPlaying(false); setMediaPaused(); },
    });
  }

  async function handlePlayPause() {
    if (isPlayingRef.current) {
      // Keep word position visible when paused
      await TTS.pause(); setIsPlaying(false); setMediaPaused();
    } else {
      // Resume from last known char position within the chunk
      await play(currentChunkRef.current, lastCharPosRef.current || 0);
    }
  }

  async function handlePrev() {
    resetCharPos(); lastCharPosRef.current = 0;
    const target = Math.max(0, currentChunkRef.current - 1);
    await TTS.stop(); setCurrentChunk(target); setIsPlaying(false); setMediaPaused(); persistProgress(target);
  }

  async function handleNext() {
    if (!book || !chunks) return;
    resetCharPos(); lastCharPosRef.current = 0;
    const target = Math.min(chunks.length - 1, currentChunkRef.current + 1);
    await TTS.stop(); setCurrentChunk(target); setIsPlaying(false); setMediaPaused(); persistProgress(target);
  }

  async function handleSpeedChange(newIdx: number) {
    setSpeedIndex(newIdx);
    currentSpeedRef.current = SPEEDS[newIdx];
    setShowSpeedPicker(false);
    // Rate is read via getter — next chunk will use the new rate automatically.
    // No need to stop/restart playback.
  }

  async function handleSeekToChunk(idx: number) {
    lastCharPosRef.current = 0;
    await TTS.stop(); setCurrentChunk(idx); setIsPlaying(false); setMediaPaused(); setShowIndex(false); persistProgress(idx);
  }

  async function handlePickCover() {
    if (!book || !bookId) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [3, 4],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const uri = result.assets[0].uri;
    const destDir = `${FileSystem.documentDirectory}books/${bookId}/`;
    await FileSystem.makeDirectoryAsync(destDir, { intermediates: true });
    const destUri = `${destDir}cover.jpg`;
    await FileSystem.copyAsync({ from: uri, to: destUri });
    const updated = { ...book, coverImageUri: destUri };
    dispatch({ type: 'UPDATE_BOOK', book: updated });
    await saveBookMeta(updated);
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
    if (book && chunks) {
      updateNowPlaying({
        title: book.title,
        artist: book.author,
        chapter: currentChapterForChunk(book.chapters, currentChunk)?.title,
        currentChunk,
        totalChunks: chunks.length,
        coverUri: book.coverImageUri,
      });
    }

    return () => {
      // Always clear stale handlers to prevent stale closures.
      // TTS keeps running — the media session metadata stays visible
      // but commands won't fire stale callbacks.
      clearRemoteHandlers();
      if (!isPlayingRef.current) {
        clearMediaSession();
      }
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

  // All hooks must be above this line — no early returns before hooks
  const remainingChars = useMemo(() => {
    if (!chunks) return 0;
    let sum = 0;
    for (let i = currentChunk; i < chunks.length; i++) sum += chunks[i].charCount;
    return sum;
  }, [chunks, currentChunk]);

  if (!book) {
    return <SafeAreaView style={styles.container}><Text style={styles.errorText}>Book not found.</Text></SafeAreaView>;
  }

  if (!chunks) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={settings.accentColor} size="large" style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  const totalChunks = chunks.length;
  const progress = totalChunks > 0 ? currentChunk / totalChunks : 0;
  const currentText = chunks[currentChunk]?.text ?? '';
  const currentPage = chunks[currentChunk]?.pageNumber ?? 1;
  const remainingMins = estimateMinutes(remainingChars, SPEEDS[speedIndex]);

  const accent = settings.accentColor;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]}>
      <StatusBar barStyle={theme.statusBar} backgroundColor={theme.bg} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Go back to library">
          <Ionicons name="chevron-back" size={24} color={theme.textSecondary} />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={() => setShowSettings(true)} style={[styles.indexBtn, { backgroundColor: theme.surface }]} accessibilityRole="button" accessibilityLabel="Settings">
            <Ionicons name="settings-outline" size={18} color={theme.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowIndex(true)} style={[styles.indexBtn, { backgroundColor: theme.surface }]} accessibilityRole="button" accessibilityLabel="Open book index">
            <Ionicons name="list" size={20} color={theme.textPrimary} />
            <Text style={[styles.indexBtnText, { color: theme.textPrimary }]}>Index</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.coverSection}>
        <TouchableOpacity onPress={handlePickCover} style={[styles.coverArt, { backgroundColor: book.coverColor }]} accessibilityRole="button" accessibilityLabel={`Cover art for ${book.title}. Double tap to change`}>
          {book.coverImageUri ? (
            <Image source={{ uri: book.coverImageUri }} style={styles.coverImage} accessibilityElementsHidden />
          ) : (
            <Text style={styles.coverLetter} accessibilityElementsHidden>{book.title.charAt(0).toUpperCase()}</Text>
          )}
          <View style={styles.coverEditBadge} accessibilityElementsHidden>
            <Ionicons name="camera" size={12} color="#fff" />
          </View>
        </TouchableOpacity>
        <Text style={[styles.bookTitle, { color: theme.textPrimary }]} numberOfLines={2}>{book.title}</Text>
        {currentChapter && (
          <TouchableOpacity onPress={() => setShowIndex(true)} style={[styles.chapterBar, { backgroundColor: theme.surface }]} accessibilityRole="button" accessibilityLabel={`Current chapter: ${currentChapter.title}. Double tap to open index`}>
            <Ionicons name="bookmark" size={14} color={accent} />
            <Text style={[styles.chapterLabel, { color: accent }]} numberOfLines={1}>{currentChapter.title}</Text>
            <Ionicons name="chevron-forward" size={14} color={theme.textDim} />
          </TouchableOpacity>
        )}
        <Text style={[styles.bookMeta, { color: theme.textDim }]} accessibilityLabel={`Page ${currentPage}, section ${currentChunk + 1} of ${totalChunks}, about ${remainingMins} minutes left`}>Page {currentPage} · §{currentChunk + 1}/{totalChunks} · ~{remainingMins}m left</Text>
      </View>
      <ScrollView
        ref={textScrollRef}
        style={[styles.textPreview, { backgroundColor: theme.readerBg }]}
        contentContainerStyle={styles.textPreviewInner}
        onLayout={(e) => { scrollViewHeightRef.current = e.nativeEvent.layout.height; }}
        onContentSizeChange={(_w, h) => { contentHeightRef.current = h; }}
      >
        {isPlaying && (
          <Animated.View style={[styles.readingIndicator, { backgroundColor: accent, opacity: pulseAnim }]} />
        )}
        <HighlightedText
          text={currentText}
          charPos={charPos}
          isPlaying={isPlaying}
          textColor={isPlaying ? theme.readerText : theme.readerTextDim}
          highlightColor={accent}
          fontSize={settings.textSize}
        />
      </ScrollView>
      <View style={styles.progressContainer} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }} accessibilityLabel={`Progress: ${Math.round(progress * 100)}% of ${totalChunks} sections`}>
        <View style={[styles.progressTrack, { backgroundColor: theme.surface }]}>
          <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: accent }]} />
        </View>
        <View style={styles.progressLabels} accessibilityElementsHidden>
          <Text style={[styles.progressLabel, { color: theme.textMuted }]}>{Math.round(progress * 100)}%</Text>
          <Text style={[styles.progressLabel, { color: theme.textMuted }]}>{totalChunks} sections</Text>
        </View>
      </View>
      <View style={styles.controls} accessibilityRole="toolbar" accessibilityLabel="Playback controls">
        <TouchableOpacity onPress={() => setShowSpeedPicker(true)} style={styles.speedBtn} accessibilityRole="button" accessibilityLabel={`Playback speed ${SPEEDS[speedIndex]} times. Double tap to change`}>
          <Text style={[styles.speedText, { color: accent }]}>{SPEEDS[speedIndex]}×</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handlePrev} style={styles.controlBtn} accessibilityRole="button" accessibilityLabel="Previous section">
          <Ionicons name="play-skip-back" size={28} color={theme.readerText} />
        </TouchableOpacity>
        <TouchableOpacity onPress={handlePlayPause} style={[styles.playBtn, { backgroundColor: theme.textPrimary }]} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause' : 'Play'}>
          <Ionicons name={isPlaying ? 'pause' : 'play'} size={32} color={theme.bg} />
        </TouchableOpacity>
        <TouchableOpacity onPress={handleNext} style={styles.controlBtn} accessibilityRole="button" accessibilityLabel="Next section">
          <Ionicons name="play-skip-forward" size={28} color={theme.readerText} />
        </TouchableOpacity>
        <View style={styles.speedBtn} />
      </View>
      <SpeedPicker
        visible={showSpeedPicker}
        speeds={SPEEDS}
        currentIndex={speedIndex}
        accent={accent}
        theme={theme}
        onSelect={handleSpeedChange}
        onClose={() => setShowSpeedPicker(false)}
      />
      <SettingsModal
        visible={showSettings}
        settings={settings}
        theme={theme}
        bookLanguage={book.language}
        onUpdate={(partial) => {
          dispatch({ type: 'UPDATE_SETTINGS', settings: partial });
          saveSettings({ ...settings, ...partial });
        }}
        onClose={() => setShowSettings(false)}
      />
      <BookIndex
        visible={showIndex}
        chunks={chunks}
        chapters={book.chapters}
        currentIndex={currentChunk}
        accentColor={accent}
        coverColor={book.coverColor}
        theme={theme}
        mode={indexMode}
        onModeChange={setIndexMode}
        onSelect={handleSeekToChunk}
        onClose={() => setShowIndex(false)}
      />
    </SafeAreaView>
  );
}

function BookIndex({ visible, chunks, chapters, currentIndex, accentColor, coverColor, theme: t, mode, onModeChange, onSelect, onClose }: any) {
  const hasChapters = chapters && chapters.length > 0;
  const themeColor = accentColor || coverColor;
  const chapterListRef = useRef<FlatList>(null);
  const sectionListRef = useRef<SectionList>(null);

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

  // Auto-scroll to current position when index opens
  useEffect(() => {
    if (!visible) return;
    setTimeout(() => {
      if (mode === 'chapters' && hasChapters && currentChapterIdx > 0) {
        try {
          chapterListRef.current?.scrollToIndex({
            index: currentChapterIdx,
            animated: true,
            viewPosition: 0.3,
          });
        } catch {}
      } else if (mode === 'sections') {
        // Find which section the current chunk is in
        for (let si = 0; si < chapterSections.length; si++) {
          const sec = chapterSections[si];
          const itemIdx = sec.data.findIndex((d: any) => d.index === currentIndex);
          if (itemIdx >= 0) {
            try {
              sectionListRef.current?.scrollToLocation({
                sectionIndex: si,
                itemIndex: itemIdx,
                animated: true,
                viewPosition: 0.3,
              });
            } catch {}
            break;
          }
        }
      }
    }, 400);
  }, [visible, mode]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[indexStyles.container, { backgroundColor: t.bg }]}>
        <View style={[indexStyles.header, { borderBottomColor: t.border }]}>
          <Text style={[indexStyles.title, { color: t.textPrimary }]}>Index</Text>
          <View style={indexStyles.headerRight}>
            {hasChapters && (
              <View style={[indexStyles.modeToggle, { backgroundColor: t.surfaceDeep }]}>
                <TouchableOpacity
                  style={[indexStyles.modeBtn, mode === 'chapters' && { backgroundColor: t.surface }]}
                  onPress={() => onModeChange('chapters')}>
                  <Text style={[indexStyles.modeBtnText, { color: mode === 'chapters' ? coverColor : t.textDim }]}>Chapters</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[indexStyles.modeBtn, mode === 'sections' && { backgroundColor: t.surface }]}
                  onPress={() => onModeChange('sections')}>
                  <Text style={[indexStyles.modeBtnText, { color: mode === 'sections' ? coverColor : t.textDim }]}>Sections</Text>
                </TouchableOpacity>
              </View>
            )}
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }} accessibilityRole="button" accessibilityLabel="Close index">
              <Ionicons name="close" size={24} color={t.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {mode === 'chapters' && hasChapters ? (
          <FlatList
            ref={chapterListRef}
            data={chapters}
            keyExtractor={(_: any, i: number) => `ch-${i}`}
            getItemLayout={(_, index) => ({ length: 72, offset: 72 * index, index })}
            renderItem={({ item, index }: any) => {
              const isCurrent = currentChapterIdx === index;
              const nextStart = index < chapters.length - 1 ? chapters[index + 1].chunkIndex : chunks.length;
              const chunkCount = nextStart - item.chunkIndex;
              const isHeard = nextStart <= currentIndex;
              const isPartial = !isHeard && item.chunkIndex < currentIndex;
              return (
                <TouchableOpacity
                  style={[
                    indexStyles.chapterItem,
                    { borderBottomColor: t.surfaceDeep },
                    isCurrent && { borderLeftColor: themeColor, borderLeftWidth: 3 },
                  ]}
                  onPress={() => onSelect(item.chunkIndex)}>
                  <View style={[indexStyles.chapterNum, { backgroundColor: t.surface }, isHeard && { backgroundColor: themeColor + '30' }]}>
                    {isHeard ? (
                      <Ionicons name="checkmark" size={16} color={themeColor} />
                    ) : (
                      <Text style={[indexStyles.chapterNumText, { color: t.textDim }, isCurrent && { color: themeColor }]}>
                        {item.number ?? index + 1}
                      </Text>
                    )}
                  </View>
                  <View style={indexStyles.chapterBody}>
                    <Text style={[
                      indexStyles.chapterItemTitle,
                      { color: t.readerTextDim },
                      isCurrent && { color: t.textPrimary },
                      isHeard && { color: t.textDim },
                    ]} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text style={[indexStyles.chapterMeta, { color: t.textMuted }]}>
                      {chunkCount} sections{isHeard ? ' · listened' : isPartial ? ' · in progress' : ''}
                    </Text>
                    {isPartial && (
                      <View style={[indexStyles.chapterProgress, { backgroundColor: t.surface }]}>
                        <View style={[indexStyles.chapterProgressFill, {
                          width: `${Math.round(((currentIndex - item.chunkIndex) / chunkCount) * 100)}%`,
                          backgroundColor: themeColor,
                        }]} />
                      </View>
                    )}
                  </View>
                  {isCurrent && <Ionicons name="volume-medium" size={16} color={themeColor} />}
                </TouchableOpacity>
              );
            }}
          />
        ) : (
          <SectionList
            ref={sectionListRef}
            sections={chapterSections.length > 0 ? chapterSections : [{ title: 'All sections', chunkIndex: 0, data: chunks.map((c: any, i: number) => ({ index: i, text: c.text, pageNumber: c.pageNumber })) }]}
            keyExtractor={(item: any) => `s-${item.index}`}
            renderSectionHeader={({ section }: any) => {
              const sectionHeard = section.chunkIndex + section.data.length <= currentIndex;
              return (
                <TouchableOpacity
                  style={[indexStyles.sectionHeader, { backgroundColor: t.bg }]}
                  onPress={() => onSelect(section.chunkIndex)}>
                  {sectionHeard ? (
                    <Ionicons name="checkmark-circle" size={14} color={themeColor} />
                  ) : (
                    <Ionicons name="bookmark" size={12} color={themeColor} />
                  )}
                  <Text style={[indexStyles.sectionHeaderText, { color: themeColor }]}>{section.title}</Text>
                </TouchableOpacity>
              );
            }}
            renderItem={({ item }: any) => {
              const isHeard = item.index < currentIndex;
              const isCurrent = item.index === currentIndex;
              return (
                <TouchableOpacity
                  style={[
                    indexStyles.item,
                    { borderBottomColor: t.surfaceDeep },
                    isCurrent && { borderLeftColor: themeColor, borderLeftWidth: 3 },
                  ]}
                  onPress={() => onSelect(item.index)}>
                  {isHeard ? (
                    <Ionicons name="checkmark" size={14} color={themeColor + '80'} style={{ width: 28 }} />
                  ) : (
                    <Text style={[indexStyles.itemNum, { color: t.textMuted }]}>§{item.index + 1}</Text>
                  )}
                  <View style={indexStyles.itemBody}>
                    <Text style={[indexStyles.itemPage, { color: t.textDim }]}>Page {item.pageNumber}</Text>
                    <Text style={[indexStyles.itemPreview, { color: t.readerTextDim }]} numberOfLines={2}>{item.text.slice(0, 100)}…</Text>
                  </View>
                  {isCurrent && <Ionicons name="volume-medium" size={16} color={themeColor} />}
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

function HighlightedText({ text, charPos, isPlaying, textColor, highlightColor, fontSize }: {
  text: string;
  charPos: { start: number; end: number } | null;
  isPlaying: boolean;
  textColor: string;
  highlightColor: string;
  fontSize: number;
}) {
  const lineHeight = fontSize * 1.6;

  // No position — plain text
  if (!charPos) {
    return (
      <Text style={[styles.chunkText, { color: textColor, fontSize, lineHeight }]}>
        {text}
      </Text>
    );
  }

  // 3-part split: read | active word | upcoming
  const before = text.slice(0, charPos.start);
  const active = text.slice(charPos.start, charPos.end);
  const after = text.slice(charPos.end);

  return (
    <Text style={[styles.chunkText, { fontSize, lineHeight }]}>
      <Text style={{ color: textColor + '50' }}>{before}</Text>
      <Text style={{
        color: highlightColor,
        fontWeight: '700',
        backgroundColor: highlightColor + '18',
      }}>{active}</Text>
      <Text style={{ color: isPlaying ? textColor + 'BB' : textColor + '30' }}>{after}</Text>
    </Text>
  );
}

function SpeedPicker({ visible, speeds, currentIndex, accent, theme: t, onSelect, onClose }: any) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={{ flex: 1, backgroundColor: t.overlay, justifyContent: 'flex-end' }} activeOpacity={1} onPress={onClose}>
        <View style={{ backgroundColor: t.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: t.textPrimary, textAlign: 'center', marginBottom: 20 }}>Playback Speed</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            {speeds.map((s: number, i: number) => (
              <TouchableOpacity
                key={s}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: i === currentIndex ? accent : t.surfaceDeep, alignItems: 'center' }}
                onPress={() => onSelect(i)}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: i === currentIndex ? '#fff' : t.textDim }}>
                  {s}×
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  errorText: { color: '#666', textAlign: 'center', marginTop: 100 },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  backBtn: { padding: 8 },
  indexBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 8, borderRadius: 8 },
  indexBtnText: { fontSize: 12, fontWeight: '600' },
  coverSection: { alignItems: 'center', paddingVertical: 20 },
  coverArt: { width: 120, height: 168, borderRadius: 10, alignItems: 'center', justifyContent: 'center', elevation: 12, overflow: 'hidden' },
  coverImage: { width: '100%', height: '100%', borderRadius: 10 },
  coverLetter: { fontSize: 48, fontWeight: '900', color: 'rgba(255,255,255,0.9)' },
  coverEditBadge: { position: 'absolute', bottom: 6, right: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  bookTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center', paddingHorizontal: 24, marginTop: 16 },
  chapterBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  chapterLabel: { fontSize: 13, flexShrink: 1 },
  bookMeta: { fontSize: 12, marginTop: 6 },
  textPreview: { flex: 1, marginHorizontal: 24, marginVertical: 8, borderRadius: 12, paddingHorizontal: 4 },
  textPreviewInner: { paddingVertical: 8 },
  readingIndicator: { width: 3, position: 'absolute', left: 0, top: 8, bottom: 8, borderRadius: 2 },
  chunkText: { fontSize: 15, lineHeight: 24, paddingLeft: 8 },
  progressContainer: { paddingHorizontal: 24, paddingBottom: 8 },
  progressTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
  progressLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  progressLabel: { fontSize: 11 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 32, paddingTop: 8 },
  controlBtn: { padding: 12 },
  playBtn: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  speedBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  speedText: { fontSize: 13, fontWeight: '700' },
});

const indexStyles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 18, fontWeight: '800' },
  modeToggle: { flexDirection: 'row', borderRadius: 8, overflow: 'hidden' },
  modeBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  modeBtnText: { fontSize: 12, fontWeight: '600' },
  chapterItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1, gap: 12, height: 72 },
  chapterNum: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  chapterNumText: { fontSize: 13, fontWeight: '700' },
  chapterBody: { flex: 1 },
  chapterItemTitle: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  chapterMeta: { fontSize: 11, marginTop: 2 },
  chapterProgress: { height: 3, borderRadius: 2, marginTop: 4, overflow: 'hidden' },
  chapterProgressFill: { height: '100%', borderRadius: 2 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  sectionHeaderText: { fontSize: 13, fontWeight: '700' },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, borderBottomWidth: 1, gap: 12 },
  itemNum: { fontSize: 12, width: 28 },
  itemBody: { flex: 1 },
  itemPage: { fontSize: 11, marginBottom: 2 },
  itemPreview: { fontSize: 13, lineHeight: 18 },
});
