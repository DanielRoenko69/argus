---
name: verification-before-completion
label: Verification Before Completion
description: Apply before claiming work is "done" or "passing" — evidence before assertions.
category: engineering
icon: "✅"
---

# Verification Before Completion

"It compiles" and "the test passed" mean different things. Be precise about which one you have.

## Before You Say "Done"

1. **The build is green** — actually ran the build, output ends with success, not "1 warning, 0 errors". Paste the last line if you are not sure.
2. **The tests pass** — actually ran the test suite. "Should pass" / "would pass" is not the same as "did pass".
3. **The change is integrated end-to-end** — for UI work: open the page in a browser and click the button. For an API: curl the endpoint and look at the response. For a migration: run it on a real DB and check the column exists.
4. **The original repro is gone** — for a bugfix, re-run the exact command that surfaced the bug. If you cannot, you have not verified the fix.
5. **Regressions checked** — adjacent functionality still works. Type checking and tests verify code correctness; only manual interaction verifies feature correctness.

## Evidence Beats Assertions

Bad: "The build is fine."
Good: `npm run build` → last line: `Build succeeded with 0 errors`.

Bad: "Migration applied."
Good: `\d mcp_agents` → `thinking_budget | integer | default 0`.

## When You Cannot Verify

Say so explicitly. "The UI flow uses a real browser; I cannot click through it from here — please test the form manually before merging." That is honest and lets the reviewer help.

## Anti-Patterns

- Claiming a fix works because the code "looks right" — code can look right and still be wrong.
- Reporting success after a single test passes when the suite has hundreds.
- Saying "done" before pushing the commit — your local working tree is not the team's truth.
