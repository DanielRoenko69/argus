/** Split text into ~size-char windows with overlap. Trims, drops empty chunks. */
export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length === 0) return [];
  if (clean.length <= size) return [clean];
  const out: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < clean.length; i += step) {
    const piece = clean.slice(i, i + size).trim();
    if (piece.length > 0) out.push(piece);
    if (i + size >= clean.length) break;
  }
  return out;
}
