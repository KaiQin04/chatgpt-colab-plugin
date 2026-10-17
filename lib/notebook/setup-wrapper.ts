/** Predefined VM-side installers. No owner code, tokens or Worker background work. */
import { base64 } from "../platform/security.ts";
import { BLENDER_EXECUTABLE, BLENDER_SHA256, BLENDER_URL, BLENDER_VERSION, setupPath } from "./setup.ts";
import type { SetupRow } from "./setup.ts";

export function setupWrapperSource(job: SetupRow): string {
  setupPath(job.notebook_id, job.id);
  const encoded = base64(new TextEncoder().encode(JSON.stringify({ notebookId: job.notebook_id, jobId: job.id,
    kind: job.kind, packages: JSON.parse(job.config_json), blenderVersion: BLENDER_VERSION,
    blenderUrl: BLENDER_URL, blenderSha256: BLENDER_SHA256, blenderExecutable: BLENDER_EXECUTABLE })));
  const literal = encoded.match(/.{1,68}/g)!.map((line) => `    "${line}"`).join("\n");
  return String.raw`"""Prepare only missing distributions or one verified Blender release."""
import base64
import hashlib
import importlib
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import time
from typing import Any
from urllib.request import build_opener
from urllib.request import HTTPRedirectHandler
from urllib.request import Request


class SetupFailure(Exception):
    """Carry only an allowlisted category and optional process exit code."""

    def __init__(self, code: str, exit_code: int | None = None) -> None:
        """Keep diagnostic categories without subprocess/network output."""
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


class NoRedirect(HTTPRedirectHandler):
    """Require the single verified official archive endpoint."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        """Refuse alternate mirrors or protocol downgrades."""
        return None


def directory(path: Path) -> None:
    """Create an installation/control directory without following links."""
    if path.is_symlink():
        raise SetupFailure("setup_path_invalid")
    path.mkdir(exist_ok=True)
    if not path.is_dir():
        raise SetupFailure("setup_path_invalid")


def check_blender(binary: Path, expected: str) -> None:
    """Verify the official binary reports the exact configured release."""
    if not binary.is_file() or binary.is_symlink():
        raise SetupFailure("blender_verification_failed")
    result = subprocess.run(
        [str(binary), "--background", "--factory-startup", "--version"],
        capture_output=True, text=True, timeout=20, check=False,
    )
    if result.returncode:
        raise SetupFailure("blender_verification_failed", result.returncode)
    lines = result.stdout.splitlines()
    pattern = (r"Blender " + re.escape(expected) +
               r"(?: LTS)?(?: \(hash [0-9a-f]+ built [^)]+\))?")
    if not lines or re.fullmatch(pattern, lines[0]) is None:
        raise SetupFailure("blender_version_mismatch")


def prepare_runtime(config: dict[str, Any]) -> None:
    """Persist progress and terminal metadata for one exclusive setup job."""
    base = Path("/content")
    control = base / "colab_setup"
    try:
        directory(control)
        control = control / config["notebookId"]
        directory(control)
        control = control / config["jobId"]
        control.mkdir(exist_ok=False)
    except BaseException:
        return
    value: dict[str, Any] = {
        "protocol": 1, "jobId": config["jobId"], "status": "running",
        "phase": "checking", "packages": [], "blender": None,
        "error": None, "startedAt": int(time.time() * 1000),
        "finishedAt": None,
    }

    def save(phase: str) -> None:
        """Atomically write bounded progress without raw installer logs."""
        value["phase"] = phase
        temporary = control / "result.json.tmp"
        temporary.write_text(json.dumps(value), encoding="utf-8")
        os.replace(temporary, control / "result.json")

    staging: Path | None = None
    try:
        save("checking")
        if config["kind"] == "packages":
            missing: list[str] = []
            for name in config["packages"]:
                try:
                    version(name)
                except PackageNotFoundError:
                    missing.append(name)
            if missing:
                save("installing_packages")
                environment = {
                    key: item for key, item in os.environ.items()
                    if not key.startswith("PIP_")
                }
                environment["PIP_CONFIG_FILE"] = os.devnull
                result = subprocess.run(
                    [sys.executable, "-m", "pip", "install", "--no-input",
                     "--disable-pip-version-check", "--no-cache-dir",
                     "--only-binary=:all:", "--index-url",
                     "https://pypi.org/simple", *missing],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=300, check=False, env=environment,
                )
                if result.returncode:
                    raise SetupFailure("packages_install_failed",
                                       result.returncode)
            importlib.invalidate_caches()
            for name in config["packages"]:
                try:
                    installed_version = version(name)
                except PackageNotFoundError:
                    raise SetupFailure("package_verification_failed")
                value["packages"].append({
                    "name": name, "version": installed_version,
                    "installed": name in missing,
                })
        else:
            if (platform.system() != "Linux" or
                    platform.machine() not in ("x86_64", "AMD64")):
                raise SetupFailure("unsupported_runtime")
            tools = base / "colab_tools"
            directory(tools)
            final = tools / ("blender-" + config["blenderVersion"] +
                             "-linux-x64")
            if final.is_symlink():
                raise SetupFailure("setup_path_invalid")
            binary = final / "blender"
            downloaded = not binary.exists()
            if downloaded:
                staging = tools / (".setup-" + config["jobId"])
                staging.mkdir(exist_ok=False)
                archive = staging / "archive.tar.xz"
                save("downloading_blender")
                deadline = time.monotonic() + 600
                digest = hashlib.sha256()
                total = 0
                request = Request(config["blenderUrl"], headers={
                    "User-Agent": "colab-compute-mcp-setup",
                })
                with build_opener(NoRedirect()).open(
                    request, timeout=20,
                ) as response, archive.open("xb") as stream:
                    while True:
                        if time.monotonic() >= deadline:
                            raise SetupFailure("blender_download_timeout")
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > 1024 * 1024 * 1024:
                            raise SetupFailure("blender_archive_limit")
                        stream.write(chunk)
                        digest.update(chunk)
                if digest.hexdigest() != config["blenderSha256"]:
                    raise SetupFailure("blender_checksum_mismatch")
                save("extracting_blender")
                with tarfile.open(archive, "r:xz") as bundle:
                    members = bundle.getmembers()
                    if (len(members) > 20000 or
                            sum(item.size for item in members) >
                            4 * 1024 * 1024 * 1024):
                        raise SetupFailure("blender_archive_limit")
                    for item in members:
                        parts = PurePosixPath(item.name).parts
                        if (not parts or parts[0] != final.name or
                                ".." in parts or item.name.startswith("/")):
                            raise SetupFailure("blender_archive_invalid")
                    bundle.extractall(staging, members=members,
                                      filter="data")
                os.rename(staging / final.name, final)
            save("verifying_blender")
            check_blender(binary, config["blenderVersion"])
            value["blender"] = {
                "version": config["blenderVersion"],
                "executable": str(binary),
                "sha256": config["blenderSha256"],
                "downloaded": downloaded,
            }
        value["status"] = "ready"
    except SetupFailure as error:
        value.update(status="error", error={"code": error.code})
        if error.exit_code is not None:
            value["error"]["exitCode"] = error.exit_code
    except subprocess.TimeoutExpired:
        category = ("packages_install_timeout" if config["kind"] ==
                    "packages" else "blender_verification_failed")
        value.update(status="error", error={"code": category})
    except TimeoutError:
        value.update(status="error", error={
            "code": "blender_download_timeout",
        })
    except KeyboardInterrupt:
        value.update(status="error", error={"code": "setup_interrupted"})
    except BaseException:
        value.update(status="error", error={"code": "setup_failed"})
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
        value["finishedAt"] = int(time.time() * 1000)
        try:
            save("ready" if value["status"] == "ready" else "error")
        except BaseException:
            pass


prepare_runtime(json.loads(base64.b64decode(
${literal}
)))
`;
}
export function setupWrapper(job: SetupRow): string {
  return `exec(__import__('base64').b64decode('${base64(new TextEncoder().encode(setupWrapperSource(job)))}'), {})`;
}
