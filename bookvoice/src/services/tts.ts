import * as Speech from 'expo-speech';
import { TextChunk } from '../types';

export interface PlayOptions {
  chunks: TextChunk[];
  startChunkIndex: number;
  rate: number;
  language?: string;
  onChunkStart: (index: number) => void;
  onChunkEnd: (index: number) => void;
  onFinished: () => void;
  onError: (err: string) => void;
}

let _isPlaying = false;
let _shouldStop = false;

export async function playChunks(options: PlayOptions): Promise<void> {
  const { chunks, startChunkIndex, rate, language, onChunkStart, onChunkEnd, onFinished, onError } = options;
  _isPlaying = true;
  _shouldStop = false;

  for (let i = startChunkIndex; i < chunks.length; i++) {
    if (_shouldStop) break;
    onChunkStart(i);
    try {
      await speakChunk(chunks[i].text, rate, language);
      if (!_shouldStop) onChunkEnd(i);
    } catch (err: any) {
      onError(err?.message ?? 'TTS error');
      break;
    }
  }
  _isPlaying = false;
  if (!_shouldStop) onFinished();
}

function speakChunk(text: string, rate: number, language?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    Speech.speak(text, {
      rate, pitch: 1.0, language: language ?? 'en-US',
      onDone: resolve,
      onError: (err) => reject(new Error(String(err))),
      onStopped: resolve,
    });
  });
}

export async function pause(): Promise<void> {
  _shouldStop = true;
  await Speech.stop();
}

export async function stop(): Promise<void> {
  _shouldStop = true;
  _isPlaying = false;
  await Speech.stop();
}

export function isPlaying(): boolean { return _isPlaying; }
