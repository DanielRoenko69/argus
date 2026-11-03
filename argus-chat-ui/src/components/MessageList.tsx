import { useEffect, useRef, useState } from 'react';
import { Message } from './Message.js';
import type { UiMessage } from './types.js';
import { useChatStore } from '../store/chat.js';
import { Icon } from './Icon.js';

interface Props {
  messages: UiMessage[];
  onRegenerate?: () => void;
  onRetry?: () => void;
  onSwitchVariant?: (leafId: string) => void;
  onEditMessage?: (msgId: string, text: string) => void;
}

export function MessageList({ messages, onRegenerate, onRetry, onSwitchVariant, onEditMessage }: Props) {
  const streaming = useChatStore((state) => state.streaming);
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  function isNearBottom() {
    const element = listRef.current;
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 140;
  }

  useEffect(() => {
    if (!nearBottomRef.current) {
      setShowJumpToLatest((current) => current ? current : true);
      return;
    }

    // SSE can deliver dozens of deltas per second. Coalesce auto-follow into
    // one browser frame and avoid repeatedly starting a new smooth-scroll
    // animation, which used to make long answers feel progressively slower.
    const scroll = () => {
      bottomRef.current?.scrollIntoView?.({
        behavior: streaming ? 'auto' : messages.length > 1 ? 'smooth' : 'auto',
      });
    };
    if (typeof window.requestAnimationFrame === 'function') {
      const frame = window.requestAnimationFrame(scroll);
      return () => window.cancelAnimationFrame(frame);
    }
    const timer = window.setTimeout(scroll, 0);
    return () => window.clearTimeout(timer);
  }, [messages, streaming]);

  function handleScroll() {
    const nearBottom = isNearBottom();
    nearBottomRef.current = nearBottom;
    setShowJumpToLatest((current) => current === !nearBottom ? current : !nearBottom);
  }

  function jumpToLatest() {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
    nearBottomRef.current = true;
    setShowJumpToLatest(false);
  }

  if (messages.length === 0) {
    return (
      <div className="message-list" ref={listRef} onScroll={handleScroll}>
        <div className="message-list-empty">
          <span className="message-list-empty-mark"><Icon name="sparkles" size={22} /></span>
          <span className="message-list-empty-title">Start an Argus conversation</span>
          <span>Select an agent and send a message to get started.</span>
        </div>
      </div>
    );
  }

  const lastIdx = messages.length - 1;
  let lastAssistantIdx = -1;
  for (let i = lastIdx; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
  }

  return (
    <div className="message-list" ref={listRef} onScroll={handleScroll} role="log" aria-live="polite">
      {messages.map((msg, i) => (
        <Message
          key={msg.id ?? `${msg.role}-${i}`}
          msg={msg}
          streaming={streaming && i === lastIdx}
          isLastAssistant={i === lastAssistantIdx}
          onRegenerate={onRegenerate}
          onRetry={onRetry}
          onSwitchVariant={onSwitchVariant}
          onEditMessage={onEditMessage}
        />
      ))}
      <div ref={bottomRef} />
      {showJumpToLatest && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <Icon name="arrow-right" size={14} /> New messages
        </button>
      )}
    </div>
  );
}
