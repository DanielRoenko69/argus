---
name: root-cause-debugging
label: Root-Cause Debugging
description: Systematic debugging. Apply when facing any bug, test failure, or unexpected behavior.
category: engineering
icon: "🔬"
---

# Root-Cause Debugging

Surface fixes mask the real problem. They come back later as a different bug.

## The Loop

1. **Reproduce reliably** — capture the exact command, input, and environment that triggers the failure. If you cannot reproduce it, you cannot fix it.
2. **Localize** — bisect: comment out, git-bisect, or binary-split the input until the smallest reproducer remains.
3. **Form a hypothesis** — state it as a falsifiable claim ("Y happens because X"). Vague gut feelings ("it's flaky") are not hypotheses.
4. **Test the hypothesis** — instrument with a log, breakpoint, or assertion that would prove the claim WRONG. If it does, you saved yourself a wrong fix.
5. **Fix the root cause** — not the symptom. Then re-run the original reproducer.
6. **Regression-test** — add a test that would have caught the bug before the fix. If the bug is untestable, write down why.

## Heuristics

- A bug in concurrent code is rarely "the lock is wrong" — it is usually "the lock protects the wrong thing." Check what the invariant is, not where the mutex is.
- A bug that "disappears" after a retry is not fixed; it is timing-shifted. Track it.
- If two recent commits could have caused it, `git bisect` will tell you in O(log n). Don't read both diffs in full first.

## Anti-Patterns

- Adding a `try/except` that swallows the error so the test passes. The bug is still there.
- "Fixing" a flaky test by increasing the timeout. Find why it was slow.
- Believing the bug is in someone else's code (framework, dependency) before exhausting your own.
