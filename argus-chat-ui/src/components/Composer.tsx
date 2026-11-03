import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '../store/chat.js';
import { Icon } from './Icon.js';

export interface ComposerAttachment {
  name: string;
  type?: string;
  content?: string;
  dataUrl?: string;
}

/** Kept as an alias for callers that only work with image attachments. */
export type ComposerImage = ComposerAttachment;

interface Props {
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  onStop: () => void;
  /** Whether the active agent's model can see images. Text files remain attachable without vision. */
  visionEnabled?: boolean;
  /** Short, agent-specific starting points. They are suggestions, not automatic actions. */
  suggestions?: string[];
  /** Persist an unfinished draft for the active conversation when provided. */
  sessionKey?: string;
}

// Client-side guards mirror the server (`collectValidImages`): keep them in sync.
const MAX_ATTACHMENTS = 4;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'log', 'env',
  'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'py', 'java', 'c', 'h', 'cpp', 'cs',
  'go', 'rs', 'rb', 'php', 'sql', 'sh', 'bash', 'zsh', 'ps1',
]);

function isImage(file: File): boolean {
  return file.type.startsWith('image/');
}

function isTextFile(file: File): boolean {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  return file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXTENSIONS.has(extension);
}

function attachmentType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  return extension === 'json' ? 'application/json' : 'text/plain';
}

export function Composer({ onSend, onStop, visionEnabled = false, suggestions = [], sessionKey }: Props) {
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const streaming = useChatStore((state) => state.streaming);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [draftReadyKey, setDraftReadyKey] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const draftKey = sessionKey ? `argus-chat-draft-${activeAgentId ?? 'none'}-${sessionKey}` : undefined;

  useEffect(() => {
    if (!draftKey) return;
    try { setText(localStorage.getItem(draftKey) ?? ''); } catch { setText(''); }
    setDraftReadyKey(draftKey);
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey || draftReadyKey !== draftKey) return;
    try {
      if (text) localStorage.setItem(draftKey, text);
      else localStorage.removeItem(draftKey);
    } catch { /* drafts are best effort */ }
  }, [draftKey, draftReadyKey, text]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // Images cannot be sent after switching to a non-vision agent, but text files remain valid.
  useEffect(() => {
    if (visionEnabled) return;
    setAttachments((current) => current.filter((attachment) => !attachment.dataUrl));
  }, [visionEnabled]);

  /** Validate files synchronously, then read images/text into the request payload. */
  function readFiles(fileList: FileList | File[]) {
    const all = Array.from(fileList);
    if (all.length === 0) return;
    setAttachmentError(null);
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      setAttachmentError(`Maximum ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const accepted: File[] = [];
    for (const f of all) {
      if (accepted.length >= remaining) {
        setAttachmentError(`Maximum ${MAX_ATTACHMENTS} files.`);
        break;
      }
      if (f.size > MAX_BYTES) {
        setAttachmentError('File exceeds the 5 MB limit.');
        continue;
      }
      if (isImage(f) && (!ALLOWED_TYPES.includes(f.type) || !visionEnabled)) {
        setAttachmentError(!visionEnabled
          ? 'Images require an agent with vision support.'
          : 'Only PNG, JPEG, WebP, or GIF images are supported.');
        continue;
      }
      if (!isImage(f) && !isTextFile(f)) {
        setAttachmentError('This file type is not supported. Use a text, code, JSON, CSV, or image file.');
        continue;
      }
      accepted.push(f);
    }
    for (const f of accepted) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        if (!result) return;
        const attachment: ComposerAttachment = isImage(f)
          ? { name: f.name, dataUrl: result }
          : { name: f.name, type: attachmentType(f), content: result };
        setAttachments((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, attachment]));
      };
      if (isImage(f)) reader.readAsDataURL(f);
      else reader.readAsText(f);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) readFiles(e.target.files);
    e.target.value = ''; // allow re-selecting the same file
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const imgs = Array.from(files).filter((f) => isImage(f));
    if (imgs.length > 0) {
      e.preventDefault();
      readFiles(imgs);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (!activeAgentId || streaming) return;
    readFiles(e.dataTransfer.files);
  }

  function removeImage(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
    setAttachmentError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const trimmed = text.trim();
    // Require text to mirror the server (it rejects an empty message); attachments ride along.
    if (!trimmed || !activeAgentId || streaming) return;
    onSend(trimmed, attachments);
    setText('');
    setAttachments([]);
    setAttachmentError(null);
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  const canSend = !!activeAgentId && text.trim().length > 0 && !streaming;
  const canAttach = !!activeAgentId && !streaming && attachments.length < MAX_ATTACHMENTS;
  const attachTitle = attachments.length >= MAX_ATTACHMENTS
    ? `Maximum ${MAX_ATTACHMENTS} files`
    : 'Attach a file';

  return (
    <div
      className={`composer${isDragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); if (activeAgentId && !streaming) setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {!streaming && suggestions.length > 0 && !text && (
        <div className="composer-suggestions" aria-label="Suggested prompts">
          {suggestions.slice(0, 3).map((suggestion) => (
            <button key={suggestion} type="button" className="composer-suggestion" onClick={() => setText(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-images">
          {attachments.map((attachment, i) => (
            <div key={`${attachment.name}-${i}`} className={`composer-image-chip${attachment.dataUrl ? '' : ' is-file'}`} title={attachment.name}>
              {attachment.dataUrl
                ? <img src={attachment.dataUrl} alt={attachment.name} className="composer-image-thumb" />
                : <span className="composer-file-name">{attachment.name}</span>}
              <button
                type="button"
                className="composer-image-remove"
                onClick={() => removeImage(i)}
                aria-label={`Remove attachment: ${attachment.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachmentError && (
        <div className="composer-img-error" role="alert">
          {attachmentError}
        </div>
      )}

      {isDragging && <div className="composer-dropzone" role="status">Drop files to attach them</div>}
      <div className="composer-inner">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.csv,.json,.xml,.yaml,.yml,.toml,.log,.env,.js,.jsx,.ts,.tsx,.css,.html,.htm,.py,.java,.c,.h,.cpp,.cs,.go,.rs,.rb,.php,.sql,.sh,.bash,.zsh,.ps1"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
          tabIndex={-1}
          aria-hidden="true"
        />
        <button
          type="button"
          className="composer-btn attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canAttach}
          title={attachTitle}
          aria-label="Attach file"
        >
          <Icon name="paperclip" size={18} />
        </button>

        <textarea
          ref={textareaRef}
          className="composer-textarea"
          placeholder={activeAgentId ? 'Send a message… (Enter to send, Shift+Enter for newline)' : 'Select an agent first…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={!activeAgentId}
          rows={1}
          aria-label="Message input"
        />
        {streaming ? (
          <button
            className="composer-btn stop"
            onClick={onStop}
            aria-label="Stop generation"
          >
            <Icon name="stop" size={16} /> Stop
          </button>
        ) : (
          <button
            className="composer-btn send"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
          >
            <Icon name="arrow-right" size={16} /> Send
          </button>
        )}
      </div>
      <div className="composer-hint">Enter to send · Shift+Enter for a new line · Drop files to attach</div>
    </div>
  );
}
