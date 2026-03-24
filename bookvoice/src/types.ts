/** Lightweight metadata kept in memory / library state (no chunk text). */
export interface BookMeta {
  id: string;
  title: string;
  author?: string;
  coverColor: string;
  coverImageUri?: string;
  totalPages: number;
  totalChunks: number;
  totalCharCount: number;
  createdAt: number;
  lastOpenedAt: number;
  ocrStatus: 'pending' | 'processing' | 'done' | 'error';
  ocrProgress: number;
  processingStage?: string;
  sourceType?: 'pdf' | 'preprocessed' | 'sample';
  language?: string;
  chapters?: ChapterMark[];
  tags?: string[];
}

/** Full book with chunks — only loaded when opening the player. */
export interface Book extends BookMeta {
  chunks: TextChunk[];
}

export interface ChapterMark {
  number: number | null;
  title: string;
  chunkIndex: number;
}

export interface TextChunk {
  id: string;
  bookId: string;
  index: number;
  pageNumber: number;
  text: string;
  charCount: number;
}

export interface PlaybackState {
  bookId: string;
  title: string;
  coverColor: string;
  coverImageUri?: string;
  chunkIndex: number;
  totalChunks: number;
  isPlaying: boolean;
  playbackRate: number;
}

export interface BookLibrary {
  [bookId: string]: BookMeta;
}

export interface PlaybackProgress {
  [bookId: string]: {
    chunkIndex: number;
    lastUpdated: number;
  };
}

export type AppTheme = 'dark' | 'dim' | 'light' | 'sepia';
export type LibraryView = 'grid' | 'list';

export interface UserSettings {
  voiceId?: string;
  textSize: number;       // 14–24
  accentColor: string;    // hex
  appTheme: AppTheme;
  libraryView: LibraryView;
  // Legacy — kept for migration, derived from appTheme going forward
  readerBgColor?: string;
  readerTextColor?: string;
}
