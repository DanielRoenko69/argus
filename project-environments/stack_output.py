"""Bounded diagnostic head/tail capture. Verbose output is not execution failure."""
from stack_contract import MAX_OUTPUT


class OutputCapture:
    def __init__(self, limit=MAX_OUTPUT // 2):
        self.limit = limit
        self.head_limit = limit // 4
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0

    def append(self, data):
        self.total += len(data)
        take = min(len(data), self.head_limit - len(self.head))
        if take:
            self.head.extend(data[:take])
        # Slice BEFORE extending: even a large Docker frame cannot grow storage.
        rest = memoryview(data)[take:]
        tail_limit = self.limit - self.head_limit
        if len(rest) >= tail_limit:
            self.tail = bytearray(rest[-tail_limit:])
        elif rest:
            self.tail.extend(rest)
            del self.tail[:max(0, len(self.tail) - tail_limit)]

    def render(self):
        truncated = self.total > self.limit
        marker = b'\n[Argus log excerpt: middle omitted; execution continued]\n'
        raw = bytes(self.head) + (marker + bytes(self.tail[-(self.limit - len(self.head) - len(marker)):])
                                  if truncated else bytes(self.tail))
        text = raw.decode('utf-8', 'replace')
        # Invalid/mid-codepoint UTF-8 can expand during decoding. Keep the wire
        # byte cap and retain the end of the diagnostic, never a broken encoding.
        encoded = text.encode('utf-8')
        if len(encoded) > self.limit:
            truncated = True
            budget = self.limit - len(marker)
            text = (encoded[:budget // 4].decode('utf-8', 'ignore') + marker.decode()
                    + encoded[-(budget - budget // 4):].decode('utf-8', 'ignore'))
        return text, truncated
