/** Extract plain text from an uploaded file buffer. Supports .txt, .md, .pdf. */
export async function extractText(name: string, buffer: Buffer): Promise<string> {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'txt' || ext === 'md') return buffer.toString('utf8');
  if (ext === 'pdf') {
    // pdf-parse loads a native canvas binding. Keep it lazy so text/markdown
    // ingestion and short-lived CLI/test processes do not create its CustomGC
    // handle when no PDF is being processed.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  throw new Error(`kb: unsupported file type ".${ext}" (txt, md, pdf only)`);
}
