/** Machine-consumed outcomes must never be silently replaced by UI previews. */
export function completeRuntimeResult(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > 256 * 1024) {
    throw new Error('Runtime final response exceeds 256 KiB; return a shorter complete result. No truncated outcome was delivered.');
  }
  return value;
}
