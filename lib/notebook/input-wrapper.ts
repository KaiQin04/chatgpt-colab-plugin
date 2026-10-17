/** Transient download code: silent Jupyter execution with no history or URL ledger. */
import { base64 } from "../platform/security.ts";
import { inputName, inputResultPath, MAX_INPUT_BYTES } from "./inputs.ts";
import type { InputFile } from "./inputs.ts";

export function inputWrapperSource(notebookId: string, inputId: string, file: InputFile): string {
  inputResultPath(notebookId, inputId);
  const encoded = base64(new TextEncoder().encode(JSON.stringify({ notebookId, inputId,
    url: file.download_url, name: inputName(file.file_name), maxBytes: MAX_INPUT_BYTES })));
  const literal = encoded.match(/.{1,68}/g)!.map((line) => `    "${line}"`).join("\n");
  return String.raw`"""Download one transient attachment without retaining its signed URL."""
import base64
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import time
from typing import Any
from urllib.parse import urljoin
from urllib.parse import urlsplit


class InputFailure(Exception):
    """Carry a fixed error code without URL-bearing exception text."""

    def __init__(self, code: str, status: int | None = None) -> None:
        """Store a safe category and optional HTTP status."""
        super().__init__(code)
        self.code = code
        self.status = status


def make_directory(path: Path) -> None:
    """Create a directory while refusing symbolic links."""
    if path.is_symlink():
        raise InputFailure("input_path_invalid")
    path.mkdir(exist_ok=True)
    if not path.is_dir():
        raise InputFailure("input_path_invalid")


def open_response(url: str, deadline: float) -> tuple[Any, Any]:
    """Connect to a public IP while retaining TLS hostname checks."""
    parsed = urlsplit(url)
    host = parsed.hostname
    if (parsed.scheme != "https" or not host or parsed.username or
            parsed.password or parsed.fragment or parsed.port not in
            (None, 443) or "." not in host):
        raise InputFailure("download_url_invalid")
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(
        not ipaddress.ip_address(item[4][0]).is_global
        for item in addresses
    ):
        raise InputFailure("download_address_not_public")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise InputFailure("download_timeout")
    timeout = min(5.0, remaining)
    raw = socket.create_connection((addresses[0][4][0], 443), timeout)
    try:
        secure = ssl.create_default_context().wrap_socket(
            raw, server_hostname=host,
        )
    except BaseException:
        raw.close()
        raise
    connection = http.client.HTTPSConnection(host, timeout=timeout)
    connection.sock = secure
    target = parsed.path or "/"
    if parsed.query:
        target += "?" + parsed.query
    try:
        connection.request("GET", target, headers={
            "User-Agent": "colab-compute-mcp-input",
            "Accept-Encoding": "identity", "Connection": "close",
        })
        return connection, connection.getresponse()
    except BaseException:
        connection.close()
        raise


def download_input(config: dict[str, Any]) -> None:
    """Stream one bounded file and persist only safe terminal metadata."""
    base = Path("/content")
    control = base / "colab_inputs"
    try:
        make_directory(control)
        control = control / config["notebookId"]
        make_directory(control)
        control = control / config["inputId"]
        control.mkdir(exist_ok=False)
    except BaseException:
        return
    started = int(time.time() * 1000)
    value: dict[str, Any] = {
        "protocol": 1, "inputId": config["inputId"], "status": "running",
        "size": None, "sha256": None, "startedAt": started,
        "finishedAt": None, "error": None,
    }

    def save() -> None:
        """Atomically replace this import's metadata without signed URLs."""
        temporary = control / "result.json.tmp"
        temporary.write_text(json.dumps(value), encoding="utf-8")
        os.replace(temporary, control / "result.json")

    partial: Path | None = None
    try:
        save()
        workspace = base / config["notebookId"]
        make_directory(workspace)
        inputs = workspace / "inputs"
        make_directory(inputs)
        destination = inputs / config["inputId"]
        destination.mkdir(exist_ok=False)
        partial = destination / ".download.part"
        target = destination / config["name"]
        deadline = time.monotonic() + 20.0
        url = config["url"]
        total = 0
        digest = hashlib.sha256()
        for redirects in range(4):
            connection, response = open_response(url, deadline)
            try:
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if not location or redirects == 3:
                        raise InputFailure("download_url_invalid")
                    url = urljoin(url, location)
                    continue
                if response.status in (401, 403, 404, 410):
                    raise InputFailure("download_expired", response.status)
                if response.status != 200:
                    raise InputFailure("download_http_error", response.status)
                length = response.getheader("Content-Length")
                if length is not None and int(length) > config["maxBytes"]:
                    raise InputFailure("download_too_large")
                with partial.open("xb") as stream:
                    while True:
                        if time.monotonic() >= deadline:
                            raise InputFailure("download_timeout")
                        chunk = response.read(65536)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > config["maxBytes"]:
                            raise InputFailure("download_too_large")
                        stream.write(chunk)
                        digest.update(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
                if length is not None and total != int(length):
                    raise InputFailure("download_incomplete")
                os.link(partial, target)
                partial.unlink()
                value.update(status="ready", size=total,
                             sha256=digest.hexdigest())
                break
            finally:
                response.close()
                connection.close()
    except InputFailure as error:
        value.update(status="error", error={"code": error.code})
        if error.status is not None:
            value["error"]["httpStatus"] = error.status
    except FileExistsError:
        value.update(status="error", error={"code": "input_already_exists"})
    except (TimeoutError, socket.timeout):
        value.update(status="error", error={"code": "download_timeout"})
    except KeyboardInterrupt:
        value.update(status="error", error={"code": "download_interrupted"})
    except BaseException:
        value.update(status="error", error={"code": "download_failed"})
    finally:
        if partial is not None:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
        value["finishedAt"] = int(time.time() * 1000)
        try:
            save()
        except BaseException:
            pass


download_input(json.loads(base64.b64decode(
${literal}
)))
`;
}

export function inputWrapper(notebookId: string, inputId: string, file: InputFile): string {
  return `exec(__import__('base64').b64decode('${base64(new TextEncoder().encode(
    inputWrapperSource(notebookId, inputId, file),
  ))}'), {})`;
}
