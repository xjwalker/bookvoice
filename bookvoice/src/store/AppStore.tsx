import React, { createContext, useContext, useReducer, useEffect, useMemo, ReactNode } from 'react';
import { BookMeta, BookLibrary, PlaybackProgress, PlaybackState, UserSettings } from '../types';
import { getTheme, Theme } from '../theme';
import * as Storage from '../services/storage';
import { preloadBiblesIfNeeded } from '../services/biblePreload';

const DEFAULT_SETTINGS: UserSettings = {
  textSize: 16,
  accentColor: '#c0392b',
  appTheme: 'dark',
  libraryView: 'grid',
};

interface AppState {
  library: BookLibrary;
  progress: PlaybackProgress;
  nowPlaying: PlaybackState | null;
  settings: UserSettings;
  isLoaded: boolean;
}

type Action =
  | { type: 'INIT'; library: BookLibrary; progress: PlaybackProgress; settings: UserSettings }
  | { type: 'ADD_BOOK'; book: BookMeta }
  | { type: 'UPDATE_BOOK'; book: BookMeta }
  | { type: 'DELETE_BOOK'; bookId: string }
  | { type: 'SET_PROGRESS'; bookId: string; chunkIndex: number }
  | { type: 'SET_NOW_PLAYING'; state: PlaybackState | null }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<UserSettings> };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'INIT':
      return { ...state, library: action.library, progress: action.progress, settings: { ...DEFAULT_SETTINGS, ...action.settings }, isLoaded: true };
    case 'ADD_BOOK':
    case 'UPDATE_BOOK':
      return { ...state, library: { ...state.library, [action.book.id]: action.book } };
    case 'DELETE_BOOK': {
      const lib = { ...state.library };
      delete lib[action.bookId];
      const prog = { ...state.progress };
      delete prog[action.bookId];
      return { ...state, library: lib, progress: prog };
    }
    case 'SET_PROGRESS':
      return { ...state, progress: { ...state.progress, [action.bookId]: { chunkIndex: action.chunkIndex, lastUpdated: Date.now() } } };
    case 'SET_NOW_PLAYING':
      return { ...state, nowPlaying: action.state };
    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.settings } };
    default:
      return state;
  }
}

const initial: AppState = { library: {}, progress: {}, nowPlaying: null, settings: DEFAULT_SETTINGS, isLoaded: false };
const StoreContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    (async () => {
      try {
        await Storage.migrateChunksIfNeeded();
      } catch {} // Migration is best-effort
      try {
        const [library, progress, settings] = await Promise.all([
          Storage.loadLibrary(), Storage.loadProgress(), Storage.loadSettings(),
        ]);
        dispatch({ type: 'INIT', library, progress, settings: settings ?? DEFAULT_SETTINGS });
        // Preload bundled Bibles on first launch (non-blocking)
        preloadBiblesIfNeeded(dispatch).catch(() => {});
      } catch {
        // If storage is corrupted, start fresh
        dispatch({ type: 'INIT', library: {}, progress: {}, settings: DEFAULT_SETTINGS });
      }
    })();
  }, []);
  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be inside StoreProvider');
  return ctx;
}

export function useLibrary() {
  const { state } = useStore();
  return useMemo(
    () => Object.values(state.library).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    [state.library],
  );
}

export function useBookMeta(id: string) {
  const { state } = useStore();
  return state.library[id] ?? null;
}

/** @deprecated Use useBookMeta for metadata, loadChunks for text */
export function useBook(id: string) {
  return useBookMeta(id);
}

export function useProgress(bookId: string) {
  const { state } = useStore();
  return state.progress[bookId]?.chunkIndex ?? 0;
}

export function useNowPlaying() {
  const { state } = useStore();
  return state.nowPlaying;
}

export function useSettings() {
  const { state } = useStore();
  return state.settings;
}

export function useTheme(): Theme {
  const { state } = useStore();
  return useMemo(() => getTheme(state.settings.appTheme), [state.settings.appTheme]);
}
