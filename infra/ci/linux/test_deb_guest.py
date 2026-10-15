import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deb_guest', Path(__file__).with_name('deb-guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


def archive(path):
    entry = {'size': 1, 'offset': '0'}
    for part in reversed(['apps', 'server', 'dist', 'bin.mjs']):
        entry = {'files': {part: entry}}
    header = json.dumps(entry).encode()
    payload_size = (len(header) + 4 + 3) & ~3
    padding = b'\0' * (payload_size - 4 - len(header))
    path.write_bytes(struct.pack('<4I', 4, payload_size + 4, payload_size, len(header)) + header + padding + b'x')


class ServerEntryTests(unittest.TestCase):
    def test_supports_both_retained_and_current_real_layouts(self):
        for name in ['app.asar', 'server.asar']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                resources = Path(root)
                archive(resources / name)
                self.assertEqual(guest.server_entry(resources), resources / name / 'apps/server/dist/bin.mjs')

    def test_rejects_missing_ambiguous_and_truncated_entries(self):
        with tempfile.TemporaryDirectory() as root:
            resources = Path(root)
            with self.assertRaisesRegex(RuntimeError, 'no unique'):
                guest.server_entry(resources)
            archive(resources / 'app.asar')
            archive(resources / 'server.asar')
            with self.assertRaisesRegex(RuntimeError, 'no unique'):
                guest.server_entry(resources)
            (resources / 'server.asar').write_bytes(b'broken')
            with self.assertRaisesRegex(RuntimeError, 'Truncated'):
                guest.server_entry(resources)


if __name__ == '__main__':
    unittest.main()
