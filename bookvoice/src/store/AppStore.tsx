import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import { Book, BookLibrary, PlaybackProgress, PlaybackState } from '../types';
import * as Storage from '../services/storage';

interface AppState {
  library: BookLibrary;
  progress: PlaybackProgress;
  nowPlaying: PlaybackState | null;
  isLoaded: boolean;
}

type Action =
  | { type: 'INIT'; library: BookLibrary; progress: PlaybackProgress }
  | { type: 'ADD_BOOK'; book: Book }
  | { type: 'UPDATE_BOOK'; book: Book }
  | { type: 'DELETE_BOOK'; bookId: string }
  | { type: 'SET_PROGRESS'; bookId: string; chunkIndex: number }
  | { type: 'SET_NOW_PLAYING'; state: PlaybackState | null };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'INIT':
      return { ...state, library: action.library, progress: action.progress, isLoaded: true };
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
    default:
      return state;
  }
}

const initial: AppState = { library: {}, progress: {}, nowPlaying: null, isLoaded: false };
const StoreContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    (async () => {
      const [library, progress] = await Promise.all([Storage.loadLibrary(), Storage.loadProgress()]);
      dispatch({ type: 'INIT', library, progress });
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
  return Object.values(state.library).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function useBook(id: string) {
  const { state } = useStore();
  return state.library[id] ?? null;
}

export function useProgress(bookId: string) {
  const { state } = useStore();
  return state.progress[bookId]?.chunkIndex ?? 0;
}

export function useNowPlaying() {
  const { state } = useStore();
  return state.nowPlaying;
}
