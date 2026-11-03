---
name: code-review-rigor
label: Code Review Rigor
description: Disciplined code review. Apply when reviewing a PR or completed task.
category: engineering
icon: "🔍"
---

# Code Review Rigor

A review that only says "LGTM" is not a review.

## Layers (cheapest to most expensive — go in order)

1. **Build & tests** — does CI pass? Are there new tests for new behavior?
2. **Diff scan** — read every changed line. Look for: dropped error handling, leaking secrets, unbounded loops, N+1 queries, unbounded user input.
3. **Surrounding context** — read 30 lines around each change. Does the change fit the conventions of the file?
4. **Architectural fit** — does it belong here? Does it duplicate logic that already exists elsewhere?
5. **Operational impact** — what happens in production at scale? At failure? What does the on-call see?

## Comments You Owe the Author

- **Blocking** — must fix before merge. Be precise about the failure mode and ideally point to a test that would catch it.
- **Non-blocking suggestion** — prefix with `nit:` so the author knows it is optional.
- **Question** — when you do not understand the intent. Often "why did you choose X over Y?" surfaces a hidden constraint.

## Anti-Patterns

- Bikeshedding (style/naming) before catching real correctness issues.
- "I would have done this differently" comments without explaining what would actually go wrong.
- Approving because the diff is small — small diffs can still break production.
- Demanding rewrites without a tangible defect — the bar is "is this safe to ship?" not "would I have written it this way?"

## What to Verify Beyond the Diff

- Is there a rollback path? (Migration, feature flag, deploy strategy.)
- Are observability hooks present? (Metrics, logs, traces — especially for new code paths.)
- Is the test new behavior or pinning current behavior? Tests that lock in implementation details rot fast.
