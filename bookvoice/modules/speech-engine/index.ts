import { requireNativeModule, EventEmitter } from 'expo-modules-core';

interface SpeechEngineModuleType {
  speak(text: string, options: Record<string, any>): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): boolean;
  isSpeaking(): boolean;
  getVoices(): { identifier: string; name: string; language: string; quality: number }[];
}

interface WordBoundaryEvent {
  charStart: number;
  charLength: number;
  word: string;
  wordIndex: number;
}

interface FinishEvent {
  cancelled?: boolean;
}

let SpeechEngine: SpeechEngineModuleType | null = null;
let emitter: any = null;

try {
  SpeechEngine = requireNativeModule('SpeechEngine');
  emitter = new EventEmitter(SpeechEngine as any);
} catch {
  // Native module not available
}

export function isAvailable(): boolean {
  return SpeechEngine !== null;
}

export async function speak(
  text: string,
  options: {
    rate?: number;
    pitch?: number;
    language?: string;
    voice?: string;
  } = {},
): Promise<void> {
  if (!SpeechEngine) throw new Error('SpeechEngine not available');
  // AVSpeechUtterance rate: 0.0–1.0, default 0.5. Map our 0.75–2.0 range.
  // expo-speech rate 1.0 ≈ AVSpeech 0.5
  const avRate = Math.max(0.0, Math.min(1.0, (options.rate ?? 1.0) * 0.5));
  await SpeechEngine.speak(text, {
    rate: avRate,
    pitch: options.pitch ?? 1.0,
    language: options.language ?? 'en-US',
    voice: options.voice ?? '',
  });
}

export function stop(): void {
  SpeechEngine?.stop();
}

export function pause(): void {
  SpeechEngine?.pause();
}

export function resume(): boolean {
  return SpeechEngine?.resume() ?? false;
}

export function isSpeaking(): boolean {
  return SpeechEngine?.isSpeaking() ?? false;
}

export function getVoices() {
  return SpeechEngine?.getVoices() ?? [];
}

export function onWordBoundary(callback: (event: WordBoundaryEvent) => void) {
  if (!emitter) return { remove: () => {} };
  return emitter.addListener('onWordBoundary', callback);
}

export function onFinish(callback: (event: FinishEvent) => void) {
  if (!emitter) return { remove: () => {} };
  return emitter.addListener('onFinish', callback);
}
