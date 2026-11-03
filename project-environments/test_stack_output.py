import unittest
from stack_contract import MAX_OUTPUT
from stack_output import OutputCapture


class CaptureTests(unittest.TestCase):
    def test_small_output_is_exact_and_empty_output_is_valid(self):
        capture = OutputCapture()
        self.assertEqual(capture.render(), ('', False))
        for chunk in [b'hello ', 'Prüfung'.encode(), b'\n']:
            capture.append(chunk)
        self.assertEqual(capture.render(), ('hello Prüfung\n', False))

    def test_streaming_keeps_head_and_tail_in_bounded_memory(self):
        capture = OutputCapture()
        capture.append(b'BEGIN\n')
        for _ in range(1000):
            capture.append(b'x' * 4096)
            self.assertLessEqual(len(capture.head) + len(capture.tail), MAX_OUTPUT // 2)
        capture.append(b'\nACTUAL FAILURE AT END')
        text, truncated = capture.render()
        self.assertTrue(truncated)
        self.assertTrue(text.startswith('BEGIN\n'))
        self.assertTrue(text.endswith('ACTUAL FAILURE AT END'))
        self.assertIn('middle omitted', text)
        self.assertEqual(capture.total, 6 + 1000 * 4096 + 22)
        self.assertLessEqual(len(text.encode()), MAX_OUTPUT // 2)

    def test_one_large_frame_and_invalid_utf8_stay_bounded(self):
        for payload in [b'x' * 2000000, b'\xff' * 16384, ('😀' * 10000).encode()]:
            capture = OutputCapture()
            capture.append(payload)
            self.assertLessEqual(len(capture.head) + len(capture.tail), MAX_OUTPUT // 2)
            text, truncated = capture.render()
            self.assertTrue(truncated)
            self.assertLessEqual(len(text.encode()), MAX_OUTPUT // 2)

    def test_stderr_has_its_own_reservation_despite_noisy_stdout(self):
        stdout, stderr = OutputCapture(), OutputCapture()
        stdout.append(b'x' * 100000)
        stderr.append(b'real error')
        self.assertEqual(stderr.render(), ('real error', False))
        self.assertLessEqual(sum(len(c.render()[0].encode()) for c in [stdout, stderr]), MAX_OUTPUT)


if __name__ == '__main__':
    unittest.main()
