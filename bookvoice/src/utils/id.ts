export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const COVER_PALETTE = [
  '#c0392b','#16a085','#8e44ad','#d35400',
  '#27ae60','#2471a3','#b7950b','#943126',
  '#1a5276','#6c3483',
];

export function generateCoverColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COVER_PALETTE[Math.abs(hash) % COVER_PALETTE.length];
}

export function estimateMinutes(charCount: number, rate = 1.0): number {
  return Math.ceil(charCount / (900 * rate));
}

export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
