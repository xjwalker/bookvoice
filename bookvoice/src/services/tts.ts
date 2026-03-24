import * as Speech from 'expo-speech';
import * as SpeechEngine from '../../modules/speech-engine';
import { TextChunk } from '../types';

const useNative = SpeechEngine.isAvailable();

export interface PlayOptions {
  chunks: TextChunk[];
  startChunkIndex: number;
  /** Character offset within the start chunk to resume from (0 = beginning). */
  startCharOffset?: number;
  /** Static rate or getter for live rate changes. */
  rate: number | (() => number);
  language?: string;
  /** Static voice ID or a getter that returns the current voice (for live switching). */
  voice?: string | (() => string | undefined);
  onChunkStart: (index: number) => void;
  onChunkEnd: (index: number) => void;
  onWordBoundary?: (wordIndex: number, charStart?: number, charLength?: number) => void;
  onFinished: () => void;
  onError: (err: string) => void;
}

let _isPlaying = false;
let _shouldStop = false;
let _playId = 0;

function resolveVoice(voice: string | (() => string | undefined) | undefined): string | undefined {
  return typeof voice === 'function' ? voice() : voice;
}

function resolveRate(rate: number | (() => number)): number {
  return typeof rate === 'function' ? rate() : rate;
}

export async function getVoices() {
  if (useNative) {
    return SpeechEngine.getVoices().map(v => ({
      identifier: v.identifier,
      name: v.name,
      language: v.language,
      quality: v.quality,
    }));
  }
  return Speech.getAvailableVoicesAsync();
}

export async function playChunks(options: PlayOptions): Promise<void> {
  const { chunks, startChunkIndex, startCharOffset, rate, language, voice, onChunkStart, onChunkEnd, onWordBoundary, onFinished, onError } = options;

  const myId = ++_playId;
  _isPlaying = true;
  _shouldStop = false;

  // Set up word boundary listener if using native engine
  let wordSub: { remove: () => void } | null = null;
  if (useNative && onWordBoundary) {
    wordSub = SpeechEngine.onWordBoundary((event) => {
      if (_playId === myId) {
        onWordBoundary(event.wordIndex, event.charStart, event.charLength);
      }
    });
  }

  for (let i = startChunkIndex; i < chunks.length; i++) {
    if (_shouldStop || _playId !== myId) break;
    onChunkStart(i);

    // For the first chunk, optionally skip ahead to startCharOffset
    let text = chunks[i].text;
    if (i === startChunkIndex && startCharOffset && startCharOffset > 0 && startCharOffset < text.length) {
      const sub = text.slice(startCharOffset);
      // Find nearest word boundary; if none found, use the substring as-is
      const ws = sub.search(/\s/);
      text = ws > 0 ? sub.slice(ws).trimStart() : sub.trimStart();
      if (!text) text = chunks[i].text; // fallback: replay full chunk if nothing left
    }

    try {
      // Resolve voice and rate on each chunk so live changes are picked up
      await speakChunk(text, resolveRate(rate), language, resolveVoice(voice));
      if (!_shouldStop && _playId === myId) onChunkEnd(i);
    } catch (err: any) {
      if (_playId === myId) onError(err?.message ?? 'TTS error');
      break;
    }
  }

  wordSub?.remove();

  if (_playId === myId) {
    _isPlaying = false;
    if (!_shouldStop) onFinished();
  }
}

function speakChunk(text: string, rate: number, language?: string, voice?: string): Promise<void> {
  if (useNative) {
    return SpeechEngine.speak(text, { rate, language, voice });
  }
  return new Promise((resolve, reject) => {
    Speech.speak(text, {
      rate, pitch: 1.0,
      language: language ?? 'en-US',
      voice,
      onDone: resolve,
      onError: (err) => reject(new Error(String(err))),
      onStopped: resolve,
    });
  });
}

export async function pause(): Promise<void> {
  _shouldStop = true;
  if (useNative) {
    SpeechEngine.stop();
  } else {
    await Speech.stop();
  }
}

export async function stop(): Promise<void> {
  _shouldStop = true;
  _isPlaying = false;
  if (useNative) {
    SpeechEngine.stop();
  } else {
    await Speech.stop();
  }
}

export function isPlaying(): boolean { return _isPlaying; }
