import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from bounded_process import bounded_run


class BoundedProcessTests(unittest.TestCase):
    def test_preserves_both_streams_and_failure_exit(self):
        result = bounded_run([sys.executable, '-c', 'import sys;print("out");print("err",file=sys.stderr);sys.exit(3)'])
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout, b'out\n')
        self.assertEqual(result.stderr, b'err\n')

    def test_caps_combined_output_while_child_is_running(self):
        start = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'output exceeded'):
            bounded_run([sys.executable, '-c', 'import os\nwhile True: os.write(2,b"x"*65536)'], max_output=100_000, timeout=10)
        self.assertLess(time.monotonic() - start, 5)

    def test_timeout_stops_the_spawned_session_and_its_child(self):
        with tempfile.TemporaryDirectory() as scratch:
            record = Path(scratch, 'child.pid')
            program = 'import pathlib,subprocess,sys,time\nchild=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(1,flush=True);time.sleep(60)"],stdout=subprocess.PIPE)\nchild.stdout.readline()\npathlib.Path(sys.argv[1]).write_text(str(child.pid))\ntime.sleep(60)'
            with self.assertRaises(subprocess.TimeoutExpired):
                bounded_run([sys.executable, '-c', program, str(record)], timeout=.5)
            pid = int(record.read_text())
            status = Path('/proc', str(pid), 'status')
            deadline = time.monotonic() + 2
            while status.exists() and 'State:\tZ' not in status.read_text() and time.monotonic() < deadline:
                time.sleep(.01)
            if status.exists():
                self.assertIn('State:\tZ', status.read_text())


if __name__ == '__main__':
    unittest.main()
