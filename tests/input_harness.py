"""Exercise attachment download code with no network or real credentials."""
import io
import json
from pathlib import Path
import socket
from typing import Any
from unittest.mock import MagicMock
from unittest.mock import patch


def check_input_wrappers(payload: dict[str, Any]) -> dict[str, Any]:
    """Run generated wrappers against synthetic HTTPS responses."""
    root = Path(payload["root"])
    downloads = 0
    status = 200
    data = b"group,value\na,1\nb,2\na,3\n"

    class Response(io.BytesIO):
        """Expose the bounded subset of an HTTP response the wrapper uses."""

        def __init__(self) -> None:
            """Create one in-memory synthetic response."""
            super().__init__(data)
            self.status = status

        def getheader(self, name: str) -> str | None:
            """Return the known fixture length, without URL metadata."""
            return str(len(data)) if name == "Content-Length" else None

    class Connection:
        """Record safe request headers instead of making a TLS request."""

        def __init__(self, host: str, timeout: float) -> None:
            """Accept the already validated connection parameters."""
            self.sock: Any = None

        def request(self, method: str, target: str,
                    headers: dict[str, str]) -> None:
            """Assert that no account credentials are forwarded."""
            nonlocal downloads
            assert method == "GET"
            assert set(headers) == {
                "User-Agent", "Accept-Encoding", "Connection",
            }
            downloads += 1

        def getresponse(self) -> Response:
            """Return a wholly synthetic response body."""
            return Response()

        def close(self) -> None:
            """Release no external resources in this synthetic fixture."""

    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "",
                  ("93.184.216.34", 443))]
    with patch("socket.getaddrinfo", return_value=addresses), \
            patch("socket.create_connection", return_value=MagicMock()), \
            patch("ssl.create_default_context", return_value=MagicMock()), \
            patch("http.client.HTTPSConnection", Connection):
        for index, source in enumerate(payload["wrappers"]):
            status = 403 if index == 2 else 200
            source = source.replace('Path("/content")', f"Path({str(root)!r})")
            compile(source, "input_wrapper.py", "exec")
            exec(source, {})
    results = [json.loads(path.read_text(encoding="utf-8"))
               for path in sorted(root.glob("colab_inputs/*/*/result.json"))]
    files = [path for path in root.glob("*/inputs/*/data.csv")]
    assert len(files) == 2
    assert all(path.read_bytes() == data for path in files)
    return {"results": results, "downloads": downloads}
