import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PlaybackState } from '../types';
import { Theme } from '../theme';
import * as TTS from '../services/tts';

interface Props {
  nowPlaying: PlaybackState;
  accent: string;
  theme: Theme;
  onTap: () => void;
}

export default function MiniPlayer({ nowPlaying, accent, theme: t, onTap }: Props) {
  const progress = nowPlaying.totalChunks > 0
    ? nowPlaying.chunkIndex / nowPlaying.totalChunks
    : 0;

  return (
    <TouchableOpacity
      style={[styles.container, { backgroundColor: t.surface, borderTopColor: t.border }]}
      onPress={onTap} activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`Now playing: ${nowPlaying.title}, section ${nowPlaying.chunkIndex + 1} of ${nowPlaying.totalChunks}`}
      accessibilityHint="Double tap to open player"
    >
      <View style={styles.progressBar} accessibilityElementsHidden>
        <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: accent }]} />
      </View>
      <View style={styles.content}>
        {nowPlaying.coverImageUri ? (
          <Image source={{ uri: nowPlaying.coverImageUri }} style={[styles.cover, { backgroundColor: nowPlaying.coverColor }]} accessibilityElementsHidden />
        ) : (
          <View style={[styles.cover, { backgroundColor: nowPlaying.coverColor }]} accessibilityElementsHidden>
            <Text style={styles.coverLetter}>{nowPlaying.title.charAt(0).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.info} accessibilityElementsHidden>
          <Text style={[styles.title, { color: t.textPrimary }]} numberOfLines={1}>{nowPlaying.title}</Text>
          <Text style={[styles.meta, { color: t.textDim }]}>
            §{nowPlaying.chunkIndex + 1}/{nowPlaying.totalChunks}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.stopBtn, { backgroundColor: accent }]}
          onPress={(e) => { e.stopPropagation(); TTS.stop(); }}
          accessibilityRole="button"
          accessibilityLabel="Stop playback"
        >
          <Ionicons name="stop" size={16} color="#fff" />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopWidth: 1 },
  progressBar: { height: 2, overflow: 'hidden' },
  progressFill: { height: '100%' },
  content: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  cover: { width: 40, height: 52, borderRadius: 6, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  coverLetter: { fontSize: 18, fontWeight: '900', color: 'rgba(255,255,255,0.9)' },
  info: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700' },
  meta: { fontSize: 11, marginTop: 2 },
  stopBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
