export interface Book {
  id: string;
  title: string;
  author?: string;
  coverColor: string;
  coverImageUri?: string;
  totalPages: number;
  totalChunks: number;
  chunks: TextChunk[];
  createdAt: number;
  lastOpenedAt: number;
  ocrStatus: 'pending' | 'processing' | 'done' | 'error';
  ocrProgress: number;
  processingStage?: string;
  sourceType?: 'pdf' | 'preprocessed' | 'sample';
  language?: string;
  chapters?: ChapterMark[];
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
  chunkIndex: number;
  isPlaying: boolean;
  playbackRate: number;
  lastUpdated: number;
}

export interface BookLibrary {
  [bookId: string]: Book;
}

export interface PlaybackProgress {
  [bookId: string]: {
    chunkIndex: number;
    lastUpdated: number;
  };
}
