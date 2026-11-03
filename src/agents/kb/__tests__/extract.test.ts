import { describe, it, expect, jest } from '@jest/globals';
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: jest.fn(async () => ({ text: 'PDF TEXT CONTENT', pages: [] })),
    destroy: jest.fn(async () => {}),
  })),
}));
import { extractText } from '../extract.js';

describe('extractText', () => {
  it('decodes txt and md as utf8', async () => {
    expect(await extractText('a.txt', Buffer.from('hello txt'))).toBe('hello txt');
    expect(await extractText('a.md', Buffer.from('# title'))).toBe('# title');
  });
  it('extracts pdf via the PDFParse class', async () => {
    expect(await extractText('a.pdf', Buffer.from('%PDF-1.4'))).toBe('PDF TEXT CONTENT');
  });
  it('throws on an unsupported type', async () => {
    await expect(extractText('a.docx', Buffer.from('x'))).rejects.toThrow(/unsupported/i);
  });
});
