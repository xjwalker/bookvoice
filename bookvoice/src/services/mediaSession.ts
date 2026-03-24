/**
 * Media session integration via custom Expo native module.
 * Provides lock screen / Control Center / notification controls for playback.
 *
 * Uses MPNowPlayingInfoCenter and MPRemoteCommandCenter on iOS.
 */

import {
  updateNowPlaying as nativeUpdateNowPlaying,
  setPlaybackState,
  enableCommands,
  clearNowPlaying,
  addCommandListener,
  type RemoteCommand,
} from '../../modules/media-controls';

let _initialized = false;
let _listenerSub: { remove: () => void } | undefined;

// Callbacks set by the PlayerScreen
let _onRemotePlay: (() => void) | null = null;
let _onRemotePause: (() => void) | null = null;
let _onRemoteNext: (() => void) | null = null;
let _onRemotePrev: (() => void) | null = null;

export function setRemoteHandlers(handlers: {
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  _onRemotePlay = handlers.onPlay;
  _onRemotePause = handlers.onPause;
  _onRemoteNext = handlers.onNext;
  _onRemotePrev = handlers.onPrev;
}

export function clearRemoteHandlers() {
  _onRemotePlay = null;
  _onRemotePause = null;
  _onRemoteNext = null;
  _onRemotePrev = null;
}

export function initMediaSession(): void {
  if (_initialized) return;
  _initialized = true;

  try {
    enableCommands();
    _listenerSub = addCommandListener((event: { command: RemoteCommand | 'togglePlayPause' }) => {
      switch (event.command) {
        case 'play':
          _onRemotePlay?.();
          break;
        case 'pause':
          _onRemotePause?.();
          break;
        case 'togglePlayPause':
          // Toggle: if we have a pause handler, assume we're playing
          (_onRemotePause || _onRemotePlay)?.();
          break;
        case 'nextTrack':
          _onRemoteNext?.();
          break;
        case 'previousTrack':
          _onRemotePrev?.();
          break;
      }
    });
  } catch (err) {
    console.warn('Media session init failed:', err);
    _initialized = false;
  }
}

export function updateNowPlaying(opts: {
  title: string;
  artist?: string;
  chapter?: string;
  currentChunk: number;
  totalChunks: number;
  coverUri?: string;
  rate?: number;
}): void {
  if (!_initialized) return;
  try {
    nativeUpdateNowPlaying({
      title: opts.chapter || opts.title,
      artist: opts.artist || 'ReadItForMe',
      album: opts.title,
      duration: opts.totalChunks,
      elapsedTime: opts.currentChunk,
      rate: opts.rate ?? 1,
    });
  } catch {}
}

export function setMediaPlaying(): void {
  if (!_initialized) return;
  try { setPlaybackState(true); } catch {}
}

export function setMediaPaused(): void {
  if (!_initialized) return;
  try { setPlaybackState(false); } catch {}
}

export function clearMediaSession(): void {
  if (!_initialized) return;
  try { clearNowPlaying(); } catch {}
}
