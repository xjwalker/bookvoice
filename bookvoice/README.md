# BookVoice

A React Native (Expo) mobile app that converts scanned PDF books into audiobooks using on-device OCR and text-to-speech. Fully offline, fully free.

## Getting Started

```bash
npm install
npm start        # Start Expo dev server
npm run ios      # Run on iOS simulator
npm run android  # Run on Android emulator
```

Requires [Expo CLI](https://docs.expo.dev/get-started/installation/) and either Xcode (iOS) or Android Studio (Android).

## Architecture

### Tech Stack

- **Expo SDK 51** with Expo Router for file-based navigation
- **expo-document-picker** — PDF file import
- **expo-file-system** — Permanent local storage
- **expo-speech** — On-device TTS (iOS AVSpeechSynthesizer / Android TextToSpeech)
- **@react-native-async-storage/async-storage** — Library and progress persistence
- **tesseract.js v5** — OCR for scanned PDFs (not yet integrated, see below)

### Data Flow

```
PDF Import → Copy to app storage → OCR pipeline (per page) → chunkText() → Book with TextChunks
                                                                                    ↓
                                          AsyncStorage ← save progress ← TTS playback (sequential chunks)
```

1. User picks a PDF via DocumentPicker
2. PDF is copied to `{documentDirectory}/books/{bookId}/book.pdf`
3. OCR pipeline processes each page: render page image → extract text → split into chunks
4. Chunks are stored inside the `Book` object in AsyncStorage under key `bookvoice_library`
5. Player reads chunks sequentially via `expo-speech`, saving progress after each chunk to `bookvoice_progress`

### Data Model

- **Book** — Metadata + array of TextChunks. Stored in a `BookLibrary` dictionary keyed by book ID.
- **TextChunk** — ~2000 character paragraph-aware text segment with page number and index.
- **PlaybackProgress** — Per-book `{ chunkIndex, lastUpdated }` persisted to AsyncStorage.

### State Management

React Context + `useReducer` in `src/store/AppStore.tsx`. No external state library.

**Actions:** `INIT`, `ADD_BOOK`, `UPDATE_BOOK`, `DELETE_BOOK`, `SET_PROGRESS`, `SET_NOW_PLAYING`

**Hooks:** `useStore()`, `useLibrary()`, `useBook(id)`, `useProgress(bookId)`, `useNowPlaying()`

Initial state is hydrated from AsyncStorage on app launch.

### Screens

| Screen | Route | File |
|--------|-------|------|
| Library | `/` (index) | `src/screens/LibraryScreen.tsx` |
| Player | `/player/[id]` | `src/screens/PlayerScreen.tsx` |

### Services

| Service | Purpose |
|---------|---------|
| `src/services/ocr.ts` | `chunkText()` — splits extracted text into ~2000 char paragraph/sentence-aware chunks |
| `src/services/tts.ts` | Wraps `expo-speech` — sequential chunk playback with rate control (0.75x–2.0x) |
| `src/services/storage.ts` | AsyncStorage CRUD for books and playback progress |

## Replacing the OCR Stub with Real Tesseract.js

The OCR pipeline in `src/screens/LibraryScreen.tsx` (the `runOCRPipeline` function, line 124) currently uses simulated dummy text. To implement real OCR:

### Step 1: Render PDF Pages to Images

Use `react-native-pdf` (already in dependencies) or a native module to render each page of the PDF as an image. You need a function that takes a PDF URI and page number, and returns a base64-encoded image or a file URI.

```typescript
// Example using a hypothetical page renderer
import { renderPage } from './pdfRenderer';

const pageImage = await renderPage(pdfUri, pageNumber);
// Returns: { uri: string } or { base64: string }
```

> **Note:** `react-native-pdf` is primarily a viewing component. For server-side or headless page rendering, you may need a native module like `react-native-pdf-thumbnail` or a custom native bridge that uses platform PDF APIs (iOS `CGPDFDocument`, Android `PdfRenderer`).

### Step 2: Run Tesseract.js OCR on Each Page Image

`tesseract.js` v5 is already in `package.json`. Use it to extract text from each rendered page image:

```typescript
import Tesseract from 'tesseract.js';

async function ocrPage(imageUri: string): Promise<string> {
  const { data: { text } } = await Tesseract.recognize(imageUri, 'eng');
  return text;
}
```

> **Caveat:** `tesseract.js` runs in a web worker environment. On React Native, you may need to use `tesseract.js` with a custom worker or explore `tesseract.js-react-native` wrappers. Test on a real device — the Expo Go client may have limitations.

### Step 3: Replace the Stub in `runOCRPipeline`

Replace the simulated loop in `LibraryScreen.tsx` with real page rendering + OCR:

```typescript
async function runOCRPipeline(book: Book, pdfUri: string, dispatch: any) {
  const totalPages = await getPDFPageCount(pdfUri); // implement this
  let allChunks: TextChunk[] = [];

  for (let page = 1; page <= totalPages; page++) {
    // 1. Render page to image
    const pageImage = await renderPageToImage(pdfUri, page);

    // 2. OCR the image
    const text = await ocrPage(pageImage.uri);

    // 3. Chunk the extracted text
    const pageChunks = chunkText(text, page, book.id, allChunks.length);
    allChunks = [...allChunks, ...pageChunks];

    // 4. Update progress
    const updated: Book = {
      ...book,
      chunks: allChunks,
      totalChunks: allChunks.length,
      totalPages,
      ocrProgress: Math.round((page / totalPages) * 100),
      ocrStatus: page === totalPages ? 'done' : 'processing',
    };
    dispatch({ type: 'UPDATE_BOOK', book: updated });
    await saveBook(updated);
  }
}
```

### Things to Consider

- **Performance:** OCR is CPU-intensive. Consider running it in a background task or showing clear progress to the user (the progress UI is already built).
- **Memory:** Large PDFs with many pages can consume significant memory. Process and discard page images one at a time.
- **Language:** The current TTS is set to `en-US`. If supporting other languages, pass the appropriate language code to both Tesseract and expo-speech.
- **Error handling:** Wrap individual page processing in try/catch so a single bad page doesn't abort the entire book.
- **Digital PDFs:** Not all PDFs are scanned images. For digital PDFs with selectable text, you could extract text directly (e.g., via `pdf.js`) and skip OCR entirely for a much faster import.
