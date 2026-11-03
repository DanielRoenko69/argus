import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useChatStore } from '../../store/chat.js';
import { Composer, type ComposerImage } from '../Composer.js';

/* ── Synchronous FileReader stub: readAsDataURL → onload with a fixed data-URL ── */
class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: null | (() => void) = null;
  readAsDataURL(_file: Blob) {
    this.result = 'data:image/png;base64,QUJD';
    this.onload?.();
  }
  readAsText(_file: Blob) {
    this.result = 'const answer = 42;';
    this.onload?.();
  }
}

function pngFile(name = 'cat.png', type = 'image/png', size = 5): File {
  const f = new File(['x'.repeat(Math.max(1, size))], name, { type });
  // jsdom derives size from content; override only when a specific size is needed
  if (size !== f.size) Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('Composer (image upload + gating)', () => {
  beforeEach(() => {
    useChatStore.setState({ activeAgentId: 1, streaming: false });
    vi.stubGlobal('FileReader', MockFileReader as unknown as typeof FileReader);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('vision disabled → file attachment remains available for text files', () => {
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={false} />);
    const btn = screen.getByRole('button', { name: /attach file/i });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Attach a file');
  });

  it('vision enabled + agent selected → attach button is enabled', () => {
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={true} />);
    expect(screen.getByRole('button', { name: /attach file/i })).not.toBeDisabled();
  });

  it('selecting a file shows a preview chip and send passes the image to onSend', async () => {
    const onSend = vi.fn<(t: string, imgs: ComposerImage[]) => void>();
    const { container } = render(<Composer onSend={onSend} onStop={vi.fn()} visionEnabled={true} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [pngFile('cat.png')] } });
    });

    // Preview chip thumbnail appears
    const thumb = await screen.findByAltText('cat.png');
    expect(thumb).toBeInTheDocument();
    expect(thumb.getAttribute('src')).toBe('data:image/png;base64,QUJD');

    // Type + send → onSend receives text + the staged image
    fireEvent.change(screen.getByRole('textbox', { name: /message input/i }), { target: { value: 'Was ist das?' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Was ist das?', [
      { name: 'cat.png', dataUrl: 'data:image/png;base64,QUJD' },
    ]);
  });

  it('selecting a text file stages its content and sends it as an attachment', async () => {
    const onSend = vi.fn();
    const { container } = render(<Composer onSend={onSend} onStop={vi.fn()} visionEnabled={false} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['hello'], 'notes.md', { type: 'text/markdown' })] } });
    });

    expect(await screen.findByText('notes.md')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /message input/i }), { target: { value: 'Review this file' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });

    expect(onSend).toHaveBeenCalledWith('Review this file', [
      { name: 'notes.md', type: 'text/markdown', content: 'const answer = 42;' },
    ]);
  });

  it('removing a chip drops the image before send', async () => {
    const onSend = vi.fn<(t: string, imgs: ComposerImage[]) => void>();
    const { container } = render(<Composer onSend={onSend} onStop={vi.fn()} visionEnabled={true} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [pngFile('cat.png')] } });
    });
    await screen.findByAltText('cat.png');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remove attachment: cat\.png/i }));
    });
    expect(screen.queryByAltText('cat.png')).not.toBeInTheDocument();

    // Now send with text only → empty image array
    fireEvent.change(screen.getByRole('textbox', { name: /message input/i }), { target: { value: 'hi' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    expect(onSend).toHaveBeenCalledWith('hi', []);
  });

  it('rejects a non-image data type with an inline error and no chip', async () => {
    const { container } = render(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={true} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [pngFile('big.bmp', 'image/bmp')] } });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/only png, jpeg, webp, or gif/i);
    expect(screen.queryByAltText('big.bmp')).not.toBeInTheDocument();
  });

  it('rejects an oversized image (>5 MB) with an inline error', async () => {
    const { container } = render(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={true} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [pngFile('huge.png', 'image/png', 6 * 1024 * 1024)] } });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/5 mb/i);
    expect(screen.queryByAltText('huge.png')).not.toBeInTheDocument();
  });

  it('caps staged images at 4', async () => {
    const { container } = render(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={true} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const five = [1, 2, 3, 4, 5].map((n) => pngFile(`img${n}.png`));
    await act(async () => {
      fireEvent.change(input, { target: { files: five } });
    });
    await waitFor(() => expect(container.querySelectorAll('.composer-image-thumb').length).toBe(4));
    expect(await screen.findByRole('alert')).toHaveTextContent(/maximum 4 files/i);
  });

  it('pasting an image into the textarea stages a preview chip', async () => {
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={true} />);
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: { files: [pngFile('pasted.png')] } });
    });
    expect(await screen.findByAltText('pasted.png')).toBeInTheDocument();
  });

  it('paste is ignored when vision is disabled (gating)', async () => {
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={false} />);
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: { files: [pngFile('blocked.png')] } });
    });
    expect(screen.queryByAltText('blocked.png')).not.toBeInTheDocument();
  });

  it('an image alone does not enable send — text is required (mirrors the server)', async () => {
    const onSend = vi.fn();
    const { container } = render(<Composer onSend={onSend} onStop={vi.fn()} visionEnabled={true} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [pngFile('cat.png')] } });
    });
    await screen.findByAltText('cat.png');
    // Send is disabled with an image but no text
    const sendBtn = screen.getByRole('button', { name: /send message/i });
    expect(sendBtn).toBeDisabled();
    // Enter must not fire an empty send either
    fireEvent.keyDown(screen.getByRole('textbox', { name: /message input/i }), { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('switching to a non-vision model clears staged images', async () => {
    const { container, rerender } = render(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={true} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [pngFile('cat.png')] } });
    });
    await screen.findByAltText('cat.png');

    rerender(<Composer onSend={vi.fn()} onStop={vi.fn()} visionEnabled={false} />);
    await waitFor(() => expect(screen.queryByAltText('cat.png')).not.toBeInTheDocument());
  });
});
