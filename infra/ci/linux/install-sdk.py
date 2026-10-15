#!/usr/bin/env python3
"""Build an immutable Android SDK seed from checksum-pinned Google archives."""
import hashlib
import json
from pathlib import Path
import shutil
import stat
import tempfile
import urllib.request
import zipfile

root = Path("/opt/t3-ci/android-sdk")
lock = json.loads(Path(__file__).with_name("android-sdk.lock.json").read_text())
root.mkdir(parents=True, exist_ok=True)
for package in lock["packages"]:
    algorithm = "sha256" if "sha256" in package else "sha1"
    checksum = hashlib.new(algorithm)
    with tempfile.TemporaryDirectory(prefix="t3-ci-sdk-") as temporary:
        archive = Path(temporary, "package.zip")
        print(f"Installing pinned SDK {package['path']} revision {package['revision']}", flush=True)
        with urllib.request.urlopen(package["url"], timeout=120) as response, archive.open("wb") as output:
            while block := response.read(1024 * 1024):
                checksum.update(block)
                output.write(block)
        if checksum.hexdigest() != package[algorithm]:
            raise RuntimeError(f"SDK checksum mismatch: {package['path']}")
        destination = root / package["path"]
        destination.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as bundle:
            for entry in bundle.infolist():
                relative = Path(entry.filename).relative_to(package["archiveRoot"])
                if relative.is_absolute() or ".." in relative.parts:
                    raise RuntimeError("Unsafe SDK archive path")
                target = destination / relative
                mode = entry.external_attr >> 16
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                if stat.S_ISLNK(mode):
                    target.symlink_to(bundle.read(entry).decode())
                    continue
                with bundle.open(entry) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod((mode & 0o777) or 0o644)
        properties = destination / "source.properties"
        if not properties.is_file():
            raise RuntimeError(f"Missing SDK package metadata: {package['path']}")
        revision = next(line.partition("=")[2].strip() for line in properties.read_text().splitlines()
                        if line.partition("=")[0].strip() == "Pkg.Revision")
        if revision != package["revision"]:
            raise RuntimeError(f"Wrong SDK revision: {package['path']}: {revision}")
