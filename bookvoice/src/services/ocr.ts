import { TextChunk } from '../types';
import { generateId } from '../utils/id';

const CHUNK_SIZE = 2000;
const MIN_CHUNK_SIZE = 100;

export function chunkText(
  text: string,
  pageNumber: number,
  bookId: string,
  startIndex: number
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const cleaned = text
    .replace(/\f/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned || cleaned.length < MIN_CHUNK_SIZE) return chunks;

  const paragraphs = cleaned.split(/\n\n+/);
  let currentChunk = '';
  let chunkIndex = startIndex;

  for (const para of paragraphs) {
    const candidate = currentChunk ? `${currentChunk}\n\n${para}` : para;
    if (candidate.length <= CHUNK_SIZE) {
      currentChunk = candidate;
    } else {
      if (currentChunk.length >= MIN_CHUNK_SIZE) {
        chunks.push(makeChunk(currentChunk, bookId, chunkIndex++, pageNumber));
      }
      if (para.length > CHUNK_SIZE) {
        const sc = splitBySentence(para, bookId, chunkIndex, pageNumber);
        chunks.push(...sc);
        chunkIndex += sc.length;
        currentChunk = '';
      } else {
        currentChunk = para;
      }
    }
  }
  if (currentChunk.length >= MIN_CHUNK_SIZE) {
    chunks.push(makeChunk(currentChunk, bookId, chunkIndex, pageNumber));
  }
  return chunks;
}

function splitBySentence(text: string, bookId: string, startIndex: number, pageNumber: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  let current = '';
  let idx = startIndex;
  for (const s of sentences) {
    const candidate = current + s;
    if (candidate.length <= CHUNK_SIZE) { current = candidate; }
    else {
      if (current.length >= MIN_CHUNK_SIZE) chunks.push(makeChunk(current.trim(), bookId, idx++, pageNumber));
      current = s;
    }
  }
  if (current.length >= MIN_CHUNK_SIZE) chunks.push(makeChunk(current.trim(), bookId, idx, pageNumber));
  return chunks;
}

function makeChunk(text: string, bookId: string, index: number, pageNumber: number): TextChunk {
  return { id: generateId(), bookId, index, pageNumber, text: text.trim(), charCount: text.length };
}
