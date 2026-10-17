"""Test installers without real pip, downloads or Blender processes."""
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
from typing import Any
from unittest.mock import patch
from importlib.metadata import PackageNotFoundError


def check_setup_wrappers(payload: dict[str, Any]) -> dict[str, Any]:
    """Run a missing-only install and verified synthetic Blender extraction."""
    root = Path(payload["root"])
    versions = {"present": "1.0.0"}
    pip_calls = 0
    archive_reads = 0
    checksum = payload["sha256"]
    blender_output = (
        "Blender 5.2.2 LTS (hash d13f752e3b9c built 2026-09-15 01:34:58)\n"
        "Blender 5.2.2 LTS\n"
    )
    version_errors: list[str | None] = []
    archive_data = io.BytesIO()
    folder = "blender-5.2.2-linux-x64"
    with tarfile.open(fileobj=archive_data, mode="w:xz") as archive:
        member = tarfile.TarInfo(folder + "/blender")
        member.size = 6
        member.mode = 0o755
        archive.addfile(member, io.BytesIO(b"binary"))

    def package_version(name: str) -> str:
        """Report only distributions installed in the synthetic environment."""
        if name not in versions:
            raise PackageNotFoundError(name)
        return versions[name]

    def run(command: list[str], **kwargs: Any) -> Any:
        """Record safe pip arguments or return a fixed Blender version."""
        nonlocal pip_calls
        if "pip" in command:
            assert command[-1] == "missing"
            assert "present" not in command
            assert "--upgrade" not in command
            assert "--only-binary=:all:" in command
            assert kwargs["timeout"] == 300
            assert kwargs["stdout"] == subprocess.DEVNULL
            pip_calls += 1
            versions["missing"] = "2.0.0"
            return subprocess.CompletedProcess(command, 0)
        assert Path(command[0]).is_file()
        return subprocess.CompletedProcess(command, 0, blender_output)

    class Digest:
        """Provide controlled checksums for the tiny synthetic tarball."""

        def update(self, chunk: bytes) -> None:
            """Consume no real data in this fixture-only checksum stub."""

        def hexdigest(self) -> str:
            """Return the expected checksum, or a deliberate mismatch."""
            return checksum

    class Opener:
        """Return one in-memory archive instead of accessing the network."""

        def open(self, request: Any, timeout: int) -> io.BytesIO:
            """Assert the exact official source and bounded socket wait."""
            nonlocal archive_reads
            assert request.full_url == payload["url"]
            assert timeout == 20
            archive_reads += 1
            return io.BytesIO(archive_data.getvalue())

    with patch("importlib.metadata.version", package_version), \
            patch("subprocess.run", run), \
            patch("platform.system", return_value="Linux"), \
            patch("platform.machine", return_value="x86_64"), \
            patch("urllib.request.build_opener", return_value=Opener()), \
            patch("hashlib.sha256", Digest):
        for index, source in enumerate(payload["wrappers"]):
            if index == 3:
                shutil.rmtree(root / "colab_tools" / folder)
                checksum = "0" * 64
            source = source.replace('Path("/content")', f"Path({str(root)!r})")
            compile(source, "setup_wrapper.py", "exec")
            namespace: dict[str, Any] = {}
            exec(source, namespace)
        binary = root / "version-blender"
        binary.write_bytes(b"binary")
        for blender_output in ("Blender 5.2.20 LTS\n",
                               "Blender 5.2.2 beta\n",
                               "Blender 5.2.2-beta\n"):
            try:
                namespace["check_blender"](binary, "5.2.2")
            except namespace["SetupFailure"] as error:
                version_errors.append(error.code)
            else:
                version_errors.append(None)
    results = [json.loads(path.read_text(encoding="utf-8"))
               for path in sorted(root.glob("colab_setup/*/*/result.json"))]
    return {"results": results, "pip_calls": pip_calls,
            "archive_reads": archive_reads, "version_errors": version_errors}
