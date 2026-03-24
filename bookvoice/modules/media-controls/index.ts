import { NativeModule, requireNativeModule } from 'expo-modules-core';
import { EventEmitter, NativeModulesProxy } from 'expo-modules-core';

interface MediaControlsModuleType extends NativeModule {
  updateNowPlaying(info: {
    title: string;
    artist: string;
    album: string;
    duration: number;
    elapsedTime: number;
    rate: number;
    artworkUrl?: string;
  }): void;
  setPlaybackState(isPlaying: boolean): void;
  enableCommands(): void;
  clearNowPlaying(): void;
}

let _module: MediaControlsModuleType | null = null;

function getModule(): MediaControlsModuleType | null {
  if (_module) return _module;
  try {
    _module = requireNativeModule('MediaControls') as MediaControlsModuleType;
    return _module;
  } catch {
    return null;
  }
}

let _emitter: EventEmitter | null = null;

function getEmitter(): EventEmitter | null {
  const mod = getModule();
  if (!mod) return null;
  if (!_emitter) {
    _emitter = new EventEmitter(mod);
  }
  return _emitter;
}

export function updateNowPlaying(info: {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  elapsedTime?: number;
  rate?: number;
}) {
  getModule()?.updateNowPlaying({
    title: info.title,
    artist: info.artist ?? '',
    album: info.album ?? '',
    duration: info.duration ?? 0,
    elapsedTime: info.elapsedTime ?? 0,
    rate: info.rate ?? 1,
  });
}

export function setPlaybackState(isPlaying: boolean) {
  getModule()?.setPlaybackState(isPlaying);
}

export function enableCommands() {
  getModule()?.enableCommands();
}

export function clearNowPlaying() {
  getModule()?.clearNowPlaying();
}

export type RemoteCommand = 'play' | 'pause' | 'nextTrack' | 'previousTrack';

export function addCommandListener(
  callback: (event: { command: RemoteCommand }) => void
): { remove: () => void } | undefined {
  return getEmitter()?.addListener('onRemoteCommand', callback);
}
