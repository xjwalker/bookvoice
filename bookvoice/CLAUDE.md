# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ReadItForMe (formerly BookVoice) is a React Native (Expo) mobile app that converts scanned PDFs into audiobooks via OCR and text-to-speech. Themeable UI (Dark/Dim/Light/Sepia), targets iOS and Android.

## Common Commands

- `npm start` — Start Expo dev server
- `npm run ios` — Run on iOS simulator
- `npm run android` — Run on Android emulator
- `python3 tools/prep.py /path/to/book.pdf --verbose` — Preprocess a scanned PDF for import

No test runner, linter, or formatter is currently configured.

## Architecture

**Routing:** Expo Router (file-based). Routes live in `app/` — `app/index.tsx` is the library, `app/player/[id].tsx` is the player.

**State management:** Custom Redux-like store using React Context + useReducer in `src/store/AppStore.tsx`. Key hooks: `useStore()`, `useLibrary()`, `useBook(id)`, `useProgress(bookId)`, `useNowPlaying()`. State is persisted to AsyncStorage.

**Service layer** (`src/services/`):
- `ocr.ts` — Text chunking logic (splits text into ~2000-char chunks respecting paragraph/sentence boundaries)
- `tts.ts` — Wraps Expo Speech API for sequential chunk playback with rate and language control
- `storage.ts` — AsyncStorage persistence for books and playback progress

**Screens** (`src/screens/`):
- `LibraryScreen.tsx` — Book grid, import (PDF or preprocessed .bookvoice.json), delete. Raw PDF import still uses simulated OCR (search for "TODO" comment).
- `PlayerScreen.tsx` — Audio player with play/pause/skip, speed control, progress tracking, section index modal with chapter markers.

**Types** in `src/types.ts`: `Book`, `TextChunk`, `PlaybackState`, `ChapterMark`.

**Utilities** in `src/utils/id.ts`: ID generation, cover color assignment, duration estimation, filename-to-title conversion.

## PDF Preprocessing Pipeline

`tools/prep.py` is a Python CLI tool (requires `pymupdf`, `langdetect`) that preprocesses scanned book PDFs:

1. Detects single vs spread (two-page) layouts by page width
2. Finds the gutter between left/right pages via text block x-position clustering
3. Extracts text in correct reading order (left page then right, top to bottom)
4. Strips headers/footers, extracts printed page numbers
5. Detects language, title, author, and chapter structure
6. Outputs a `.bookvoice.json` bundle that the app imports directly via the file picker

The app's `importPreprocessed()` function in LibraryScreen reads this JSON, chunks the text using the existing `chunkText()` from `ocr.ts`, and maps chapter markers to chunk indices.

## Key Context

- Raw PDF OCR pipeline is still simulated — preprocessed `.bookvoice.json` import is the working path for scanned books.
- Books are stored in the device's DocumentDirectory under `books/{bookId}/`.
- TTS uses `expo-speech` with per-book language (defaults to `en-US`). Rate is configurable 0.75x–2.0x.
- The app uses a 10-color deterministic palette for book cover cards.
