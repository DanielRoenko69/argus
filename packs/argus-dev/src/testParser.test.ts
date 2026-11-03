/**
 * Unit tests for testParser.ts — run via: cd langgraph && npx tsx testParser.test.ts
 * (No jest harness in langgraph subproject; this is a tiny assertion script.)
 */

import {
  MAX_AGENT_TEST_EVIDENCE_CHARS,
  parseTestFailures,
  formatFailuresForCoder,
  formatTestEvidence,
} from './testParser.js';

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

// ── pytest sample ─────────────────────────────────────────────────────
const pytestOutput = `
============================= test session starts ==============================
collected 12 items

backend/tests/api/routes/test_utils.py .F....F                            [ 58%]
backend/tests/models/test_user.py ......                                  [100%]

=================================== FAILURES ===================================
_________________________ test_healthcheck_returns_ok __________________________

    def test_healthcheck_returns_ok():
        response = client.get("/api/v1/utils/health")
>       assert response.status_code == 200
E       AssertionError: assert 503 == 200
E        +  where 503 = <Response [503]>.status_code

backend/tests/api/routes/test_utils.py:42: AssertionError
_________________________ test_timestamp_is_iso8601 __________________________

    def test_timestamp_is_iso8601():
>       from datetime import datetime
E       ModuleNotFoundError: No module named 'datetime_extra'

backend/tests/api/routes/test_utils.py:51: ModuleNotFoundError

=========================== short test summary info ============================
FAILED backend/tests/api/routes/test_utils.py::test_healthcheck_returns_ok - AssertionError: assert 503 == 200
FAILED backend/tests/api/routes/test_utils.py::test_timestamp_is_iso8601 - ModuleNotFoundError: No module named 'datetime_extra'
========================== 2 failed, 10 passed in 1.34s ========================
`;

console.log('--- pytest output ---');
const pytestFailures = parseTestFailures(pytestOutput);
assert(pytestFailures.length === 2, `parsed 2 failures (got ${pytestFailures.length})`);
const f0 = pytestFailures.find(f => f.test_name === 'test_healthcheck_returns_ok');
assert(!!f0, 'found test_healthcheck_returns_ok');
assert(f0?.error_class === 'assertion', `test_healthcheck classified as 'assertion' (got '${f0?.error_class}')`);
assert(f0?.test_file === 'backend/tests/api/routes/test_utils.py', 'pytest file path captured');
const f1 = pytestFailures.find(f => f.test_name === 'test_timestamp_is_iso8601');
assert(f1?.error_class === 'import', `test_timestamp classified as 'import' (got '${f1?.error_class}')`);
assert(!f0?.trace_snippet?.includes('ModuleNotFoundError'), 'adjacent failure does not contaminate assertion trace');

// Regression: NumPy assertions without a summary message followed by warnings.
const numericOutput = `pytest\n================ FAILURES ================
________ test_scalar_parity ________
>       np.testing.assert_allclose(actual, expected, rtol=1e-10, atol=1e-12)
E       AssertionError:
E       Not equal to tolerance rtol=1e-10, atol=1e-12
E       Mismatched elements: 3 / 14
E       Max absolute difference: 3.282873e-05
E       ACTUAL: array([-0.0094673, -0.000019053])
E       DESIRED: array([-0.0094837, 0.000013775])
tests/test_vector.py:45: AssertionError
________ TestVector.test_rows[batch-4 + seed] ________
>       assert rows.shape == (4, 14)
E       AssertionError: row-specific shape mismatch
tests/test_vector.py:72: AssertionError
================ warnings summary ================
src/unrelated.py:13
  SyntaxWarning: invalid escape sequence
================ short test summary info ================
FAILED tests/test_vector.py::test_scalar_parity
FAILED tests/test_vector.py::TestVector::test_rows[batch-4 + seed]
================ 2 failed, 10 passed, 11 warnings ================`;
const numericFailures = parseTestFailures(numericOutput);
assert(numericFailures.length === 2, 'parses parametrized/class tests with hyphens and spaces');
assert(numericFailures[0]?.error_class === 'assertion', 'derives error class from the matching failure without a summary message');
assert(numericFailures[0]?.line === 45 && numericFailures[1]?.line === 72, 'keeps exact per-test locations');
assert(numericFailures[0]?.trace_snippet?.includes('ACTUAL:') === true, 'retains actual numeric values');
assert(numericFailures[0]?.trace_snippet?.includes('DESIRED:') === true, 'retains expected numeric values');
assert(!numericFailures[0]?.trace_snippet?.includes('row-specific'), 'keeps adjacent failure out of first trace');
assert(!formatTestEvidence(numericOutput).includes('src/unrelated.py'), 'warnings are not forwarded as failure targets');
assert(!formatTestEvidence(numericOutput).includes('Run only the failing files'), 'feedback does not override governed test ownership');
assert(formatTestEvidence(numericOutput, [{ test_file: 'src/unrelated.py', error_class: 'unknown', error_message: '' }]).includes('ACTUAL:'), 'reparses retained logs instead of trusting legacy broken parsed feedback');
const collectionFailures = parseTestFailures(`pytest\n________ ERROR collecting tests/test_missing.py ________\nE   ModuleNotFoundError: No module named 'missing'\n================ short test summary info ================\nERROR tests/test_missing.py - ModuleNotFoundError: No module named 'missing'`);
assert(collectionFailures[0]?.error_class === 'import', 'preserves collection errors');
const noHeader = parseTestFailures('pytest\nFAILED tests/test_a.py::test_case[regex.*] - AssertionError: missing header');
assert(noHeader[0]?.error_message === 'AssertionError: missing header', 'summary-only failure stays actionable without guessed trace');
const duplicateNames = parseTestFailures(`pytest\n________ test_same ________\nE AssertionError: first-file\ntests/a.py:10: AssertionError\n________ test_same ________\nE AssertionError: second-file\ntests/b.py:20: AssertionError\n================ short test summary info ================\nFAILED tests/a.py::test_same\nFAILED tests/b.py::test_same`);
assert(duplicateNames[0]?.line === 10 && duplicateNames[1]?.line === 20, 'matches duplicate test names by file');
assert(!duplicateNames[0]?.trace_snippet?.includes('second-file'), 'duplicate names cannot borrow another file failure');
const partial = parseTestFailures('pytest\n________ test_same ________\nE AssertionError: belongs to another file\ntests/a.py:10: AssertionError\n================ short test summary info ================\nFAILED tests/b.py::test_same');
assert(!partial[0]?.trace_snippet, 'incomplete logs cannot attach the sole mismatched-file block');
assert(parseTestFailures(numericOutput.replaceAll('E ', '\u001b[31mE ').replaceAll('\n', '\u001b[0m\r\n'))[0]?.error_class === 'assertion', 'normalizes ANSI and CRLF before parsing');

// ── jest sample ───────────────────────────────────────────────────────
const jestOutput = `
PASS  src/__tests__/sqlTemplate.test.ts
FAIL  src/__tests__/redaction.test.ts
  ● redact — detectors > email

    expect(received).toBe(expected) // Object.is equality

    Expected: "Schreib an [EMAIL]"
    Received: "Schreib an user@example.com"

      42 |   test('email', () => {
      43 |     const r = redact('Schreib an user@example.com');
      44 |     expect(r.text).toBe('Schreib an [EMAIL]');
         |                    ^

      at Object.<anonymous> (src/__tests__/redaction.test.ts:44:20)

Tests: 1 failed, 33 passed
`;

console.log('\n--- jest output ---');
const jestFailures = parseTestFailures(jestOutput);
assert(jestFailures.length === 1, `parsed 1 jest failure (got ${jestFailures.length})`);
const jf = jestFailures[0];
assert(jf?.test_file === 'src/__tests__/redaction.test.ts', 'jest file path captured');
assert(jf?.error_class === 'assertion', `jest classified as 'assertion' (got '${jf?.error_class}')`);

const mochaOutput = `
  1778 passing (2s)
  1 failing

  1) Injector async providers
       should store a resolved async provider in its parent context:
     AssertionError: expected undefined to equal 'ready'
      at Context.<anonymous> (packages/core/test/injector/injector-async-context.spec.ts:37:37)
`;
const mochaFailures = parseTestFailures(mochaOutput);
assert(mochaFailures.length === 1, `parsed 1 Mocha failure (got ${mochaFailures.length})`);
assert(mochaFailures[0]?.test_file === 'packages/core/test/injector/injector-async-context.spec.ts', 'Mocha file path captured');
assert(mochaFailures[0]?.line === 37, 'Mocha line captured');
assert(mochaFailures[0]?.error_class === 'assertion', 'Mocha failure classified as assertion');

// ── Go sample ───────────────────────────────────────────────────────
const goOutput = `
--- FAIL: TestHealthEndpoint (0.00s)
    service_test.go:42: expected status 200, received 503
FAIL
FAIL    example.com/argus/service    0.003s
`;
const goFailures = parseTestFailures(goOutput);
assert(goFailures.length === 1, `parsed 1 Go failure (got ${goFailures.length})`);
assert(goFailures[0]?.test_file === 'service_test.go', 'Go file path captured');
assert(goFailures[0]?.line === 42, 'Go line captured');
assert(goFailures[0]?.error_class === 'assertion', 'Go failure classified as assertion');

// ── Rust sample ─────────────────────────────────────────────────────
const rustOutput = `
---- tests::health_endpoint stdout ----
thread 'tests::health_endpoint' panicked at src/lib.rs:37:9:
assertion \`left == right\` failed
  left: 503
 right: 200

failures:
    tests::health_endpoint
test result: FAILED. 0 passed; 1 failed
`;
const rustFailures = parseTestFailures(rustOutput);
assert(rustFailures.length === 1, `parsed 1 Rust failure (got ${rustFailures.length})`);
assert(rustFailures[0]?.test_file === 'src/lib.rs', 'Rust file path captured');
assert(rustFailures[0]?.line === 37, 'Rust line captured');
assert(rustFailures[0]?.error_class === 'assertion', 'Rust failure classified as assertion');

// ── JVM samples ─────────────────────────────────────────────────────
const jvmOutput = `
[ERROR] com.argus.HealthTest.health -- Time elapsed: 0.010 s <<< FAILURE!
java.lang.AssertionError: expected:<200> but was:<503>
    at com.argus.HealthTest.health(HealthTest.java:42)

CheckoutTest > readyEndpoint FAILED
    java.lang.AssertionError: expected ready
        at CheckoutTest.java:51
`;
const jvmFailures = parseTestFailures(jvmOutput);
assert(jvmFailures.length === 2, `parsed 2 JVM failures (got ${jvmFailures.length})`);
assert(jvmFailures[0]?.test_file === 'HealthTest.java', `Maven/JUnit file captured (got '${jvmFailures[0]?.test_file}')`);
assert(jvmFailures[1]?.test_name === 'CheckoutTest.readyEndpoint', 'Gradle test name captured');

// ── .NET sample ─────────────────────────────────────────────────────
const dotnetOutput = `
  Failed Argus.Tests.HealthTests.ReturnsOk [12 ms]
  Error Message:
   Assert.Equal() Failure: Values differ
Expected: 200
Actual:   503
  Stack Trace:
     at Argus.Tests.HealthTests.ReturnsOk() in /src/HealthTests.cs:line 28
Failed!  - Failed: 1, Passed: 5, Skipped: 0, Total: 6
`;
const dotnetFailures = parseTestFailures(dotnetOutput);
assert(dotnetFailures.length === 1, `parsed 1 .NET failure (got ${dotnetFailures.length})`);
assert(dotnetFailures[0]?.test_file === '/src/HealthTests.cs', '.NET file path captured');
assert(dotnetFailures[0]?.line === 28, '.NET line captured');
assert(dotnetFailures[0]?.error_class === 'assertion', '.NET failure classified as assertion');

// ── formatting ────────────────────────────────────────────────────────
console.log('\n--- format output ---');
const formatted = formatFailuresForCoder(pytestFailures);
assert(formatted.includes('### import'),    'formatted contains import section');
assert(formatted.includes('### assertion'), 'formatted contains assertion section');
assert(formatted.indexOf('### import') < formatted.indexOf('### assertion'),
       'import section comes before assertion (priority ordering)');

const largeUnknownOutput = `unknown runner failed\n${'noise line\n'.repeat(20_000)}final actionable failure`;
const bounded = formatTestEvidence(largeUnknownOutput, []);
assert(bounded.length <= MAX_AGENT_TEST_EVIDENCE_CHARS, 'unknown runner evidence is bounded');
assert(bounded.includes('unknown runner failed'), 'bounded evidence preserves the beginning');
assert(bounded.includes('final actionable failure'), 'bounded evidence preserves the end');

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
