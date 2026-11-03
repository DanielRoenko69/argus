const ALLOWED = /^data:image\/(png|jpe?g|webp|gif);base64,/i;
const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB per image
const MAX_IMAGES = 4;

/** Validate + collect image attachments (dataUrl). Throws Error('image: …') on violation. */
export function collectValidImages(
  attachments?: Array<{ name?: string; dataUrl?: string; content?: string }>,
): { dataUrl: string; name?: string }[] {
  const imgs = (attachments ?? []).filter((a) => a.dataUrl);
  if (imgs.length === 0) return [];
  if (imgs.length > MAX_IMAGES) throw new Error(`image: max ${MAX_IMAGES} images`);
  for (const a of imgs) {
    if (!ALLOWED.test(a.dataUrl!)) throw new Error('image: unsupported type (png/jpeg/webp/gif only)');
    const b64 = a.dataUrl!.split(',')[1] ?? '';
    if ((b64.length * 3) / 4 > MAX_BYTES) throw new Error('image: exceeds 5 MB');
  }
  return imgs.map((a) => ({ dataUrl: a.dataUrl!, name: a.name }));
}

/**
 * Defence-in-depth capability gate: image content may only be sent to a vision-capable model.
 * The SPA also disables the upload button for non-vision agents, but a direct API client could
 * bypass that — the server is the real gate. Throws Error('image: …') when images are present
 * but the (effective) model has supports_vision = false.
 */
export function assertVisionAllowed(imageCount: number, supportsVision: boolean): void {
  if (imageCount > 0 && !supportsVision) {
    throw new Error('image: agent model does not support vision');
  }
}
