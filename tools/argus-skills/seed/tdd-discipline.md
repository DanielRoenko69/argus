---
name: tdd-discipline
label: TDD Discipline
description: Red → Green → Refactor. Apply when implementing any feature or bugfix.
category: engineering
icon: "🧪"
---

# TDD Discipline

When you implement a feature or fix a bug, write the failing test FIRST.

## The Loop

1. **Red** — Write a test that captures the desired behavior. Run it. Confirm it fails for the right reason (not a typo, not a missing import).
2. **Green** — Write the minimum code that makes the test pass. Resist the urge to clean up while the bar is red.
3. **Refactor** — Now that you have a green bar, improve names, extract helpers, remove duplication. The test net catches regressions.

## When to Apply

- Implementing a new feature → start with the highest-value behavioral test.
- Fixing a bug → reproduce it with a test first. That test becomes the regression guard.
- Refactoring → keep the test bar green at every step; never refactor with a red bar.

## When NOT to Apply

- Spikes / throwaway exploration → test discipline can come once you commit to a design.
- One-line config tweaks where the test would just re-assert the line.

## Anti-Patterns

- Writing the implementation first and "backfilling" tests — these tests describe what the code does, not what it should do.
- Skipping the "confirm it fails for the right reason" step — silent type errors masquerade as test failures.
- Letting the refactor step lapse — green tests with ugly code is technical debt with a friendly face.
