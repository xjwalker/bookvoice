import * as FileSystem from 'expo-file-system/legacy';

let PdfThumbnail: any = null;
try {
  PdfThumbnail = require('react-native-pdf-thumbnail').default;
} catch {
  // Not available (e.g. Expo Go) — cover extraction will be skipped
}

/**
 * Extract a cover image from the first page of a PDF.
 * Returns the local file URI on success, or null if extraction fails.
 */
export async function extractCover(pdfUri: string, bookId: string): Promise<string | null> {
  if (!PdfThumbnail) return null;

  try {
    const result = await PdfThumbnail.generate(pdfUri, 0);
    if (!result?.uri) return null;

    const destDir = `${FileSystem.documentDirectory}books/${bookId}/`;
    await FileSystem.makeDirectoryAsync(destDir, { intermediates: true });
    const destUri = `${destDir}cover.jpg`;

    await FileSystem.copyAsync({ from: result.uri, to: destUri });
    return destUri;
  } catch {
    return null;
  }
}
