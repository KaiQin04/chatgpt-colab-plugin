/** No credentials enter this Python wrapper. Only UUIDs and saved cell source. */
import { MAX_OUTPUT_BYTES } from "./types.ts";
import { MAX_ARTIFACT_FILES, MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_RUN_BYTES } from "./policy.ts";
import { base64 } from "../platform/security.ts";

export function resultPath(notebookId: string, runId: string): string {
  if (![notebookId, runId].every((id) => /^[a-f0-9-]{36}$/.test(id))) {
    throw new Error("invalid_internal_run_path");
  }
  return `content/colab_notebooks/${notebookId}/${runId}/result.json`;
}

export function pythonWrapperSource(notebookId: string, runId: string, source: string): string {
  resultPath(notebookId, runId);
  const source64 = base64(new TextEncoder().encode(source));
  const sourceLiteral = (source64.match(/.{1,64}/g) ?? [""]).map((part) => `        '${part}'`).join("\n");
  return `"""Run a saved cell and persist bounded output without credentials."""
import base64
import contextlib
import hashlib
import io
import json
import os
import time
import traceback
from pathlib import Path
from typing import Any

root = Path(
    '/content/colab_notebooks/'
    '${notebookId}/'
    '${runId}/result.json'
).parent
root.parent.mkdir(parents=True, exist_ok=True)
# A duplicate dispatch cannot execute the same run directory twice.
root.mkdir(exist_ok=False)
workspace = Path('/content/${notebookId}')
output_root = workspace / 'outputs'
shell = globals()['get_ipython']()
started = int(time.time() * 1000)
outputs: list[dict[str, Any]] = []
used = 0
truncated = False
last_write = 0.0
execution_count = int(getattr(shell, 'execution_count', 0))
finalized = False
finished_at = None
artifacts: dict[str, Any] = dict(files=[], errors=[])


def save(status: str = 'running') -> None:
    """Atomically save output; late writers cannot undo terminal state."""
    global last_write
    if finalized and status == 'running':
        return
    payload = dict(
        protocol=1, runId=${JSON.stringify(runId)},
        status=status,
        outputs=outputs, truncated=truncated, startedAt=started,
        finishedAt=finished_at, executionCount=execution_count,
    )
    if status != 'running':
        payload['artifacts'] = artifacts
    temp = root / 'result.tmp'
    with temp.open('w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(temp, root / 'result.json')
    last_write = time.monotonic()


def clipped(text: Any) -> str:
    """Consume the byte budget without encoding an unbounded input first."""
    global used, truncated
    value = str(text)
    remaining = max(0, ${MAX_OUTPUT_BYTES} - used)
    if len(value) > remaining:
        truncated = True
    data = value[:remaining].encode('utf-8', errors='replace')
    if len(data) > remaining:
        truncated = True
    data = data[:remaining]
    value = data.decode('utf-8', errors='ignore')
    used += len(value.encode('utf-8'))
    return value


def capture(data: dict[str, Any], metadata: Any = None,
            **kwargs: Any) -> None:
    """Retain text and whole PNGs, never HTML, SVG or remote resource URLs."""
    global truncated
    if len(outputs) >= 64:
        truncated = True
        return
    safe = {}
    for mime in ('text/plain', 'image/png'):
        if mime in data:
            if mime == 'image/png':
                image = str(data[mime])
                if not image.isascii() or len(image) > max(
                        0, ${MAX_OUTPUT_BYTES} - used):
                    truncated = True
                    continue
            value = clipped(data[mime])
            if value:
                safe[mime] = value
    if safe:
        outputs.append(dict(
            output_type='display_data', data=safe, metadata={},
        ))
    if time.monotonic() - last_write >= 1:
        save()


class BoundedWriter(io.TextIOBase):
    """Capture bounded text with opportunistic progress snapshots."""

    def __init__(self, name: str) -> None:
        """Bind the stdout or stderr stream name."""
        self.name = name

    def writable(self) -> bool:
        """Allow stream writes."""
        return True

    def write(self, text: str) -> int:
        """Append only the remaining output budget."""
        global truncated
        value = clipped(text)
        if value:
            if outputs and outputs[-1].get('name') == self.name:
                outputs[-1]['text'] += value
            elif len(outputs) < 64:
                outputs.append(dict(
                    output_type='stream', name=self.name, text=value,
                ))
            else:
                truncated = True
        if time.monotonic() - last_write >= 1:
            save()
        return len(text)

    def flush(self) -> None:
        """Publish progress without changing a finalized result."""
        if time.monotonic() - last_write >= 1:
            save()


def record_error(error: BaseException) -> None:
    """Keep a bounded exception record alongside any preceding output."""
    if len(outputs) < 64:
        formatted = ''.join(traceback.format_exception(
            type(error), error, error.__traceback__,
        ))
        outputs.append(dict(
            output_type='error', ename=type(error).__name__[:120],
            evalue=clipped(str(error)[:4000]),
            traceback=[clipped(formatted[:8000])],
        ))


def collect_artifacts() -> dict[str, Any]:
    """Hash bounded output files; reject links and traversal."""
    files: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    total = 0
    visited = 0
    stack = [output_root]
    if (workspace.is_symlink() or output_root.is_symlink()
            or not output_root.is_dir()):
        return dict(
            files=[], errors=[dict(code='artifact_directory_missing')],
        )
    while stack:
        directory = stack.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                visited += 1
                if visited > ${MAX_ARTIFACT_FILES * 8}:
                    errors.append(dict(code='artifact_file_count_exceeded'))
                    return dict(files=files, errors=errors)
                target = Path(entry.path)
                relative = target.relative_to(output_root).as_posix()
                parts = relative.split('/')
                invalid = (
                    len(relative) > 240 or len(parts) > 8
                    or any(not part or part in ('.', '..')
                           or len(part) > 100 for part in parts)
                    or any(ord(char) < 32 or ord(char) == 127
                           or char in ('\\\\', '%') for char in relative)
                )
                if invalid:
                    errors.append(dict(code='artifact_path_invalid'))
                elif entry.is_symlink():
                    errors.append(dict(
                        code='artifact_symlink_rejected', path=relative,
                    ))
                elif entry.is_dir(follow_symlinks=False):
                    stack.append(target)
                elif entry.is_file(follow_symlinks=False):
                    if len(files) >= ${MAX_ARTIFACT_FILES}:
                        errors.append(dict(
                            code='artifact_file_count_exceeded',
                        ))
                        return dict(files=files, errors=errors)
                    size = entry.stat(follow_symlinks=False).st_size
                    code = None
                    if size > ${MAX_ARTIFACT_FILE_BYTES}:
                        code = 'artifact_file_too_large'
                    elif total + size > ${MAX_ARTIFACT_RUN_BYTES}:
                        code = 'artifact_run_too_large'
                    if code:
                        errors.append(dict(code=code, path=relative))
                    else:
                        resolved = target.resolve(strict=True)
                        inside = resolved.is_relative_to(output_root.resolve())
                        if not inside:
                            errors.append(dict(
                                code='artifact_symlink_rejected',
                            ))
                            continue
                        checksum = hashlib.sha256()
                        counted = 0
                        fd = os.open(resolved, os.O_RDONLY | os.O_NOFOLLOW)
                        with os.fdopen(fd, 'rb') as handle:
                            while chunk := handle.read(64 * 1024):
                                counted += len(chunk)
                                if counted > ${MAX_ARTIFACT_FILE_BYTES}:
                                    raise ValueError('artifact_grew')
                                checksum.update(chunk)
                        if counted != size:
                            raise ValueError('artifact_size_changed')
                        total += size
                        files.append(dict(
                            path=relative, size=size,
                            sha256=checksum.hexdigest(),
                        ))
                else:
                    errors.append(dict(
                        code='artifact_io_failed', path=relative,
                    ))
                if len(errors) >= ${MAX_ARTIFACT_FILES}:
                    return dict(files=files, errors=errors)
    return dict(files=files, errors=errors)


old_publish = shell.display_pub.publish
old_format = shell.displayhook.write_format_data
status = 'error'
save()
try:
    if (workspace.is_symlink() or (workspace / 'inputs').is_symlink()
            or output_root.is_symlink()):
        raise RuntimeError('notebook_directory_symlink_rejected')
    (workspace / 'inputs').mkdir(parents=True, exist_ok=True)
    output_root.mkdir(parents=True, exist_ok=True)
    os.chdir(workspace)
    shell.display_pub.publish = capture
    shell.displayhook.write_format_data = capture
    code = base64.b64decode(
${sourceLiteral}
    ).decode('utf-8')
    with contextlib.redirect_stdout(BoundedWriter('stdout')):
        with contextlib.redirect_stderr(BoundedWriter('stderr')):
            outcome = shell.run_cell(
                code, store_history=True, silent=False,
            )
    execution_count = outcome.execution_count
    error = outcome.error_before_exec or outcome.error_in_exec
    if error is None:
        status = 'ok'
    else:
        status = (
            'interrupted' if isinstance(error, KeyboardInterrupt) else 'error'
        )
        record_error(error)
except BaseException as error:
    status = 'interrupted' if isinstance(error, KeyboardInterrupt) else 'error'
    record_error(error)
finally:
    shell.display_pub.publish = old_publish
    shell.displayhook.write_format_data = old_format
    finished_at = int(time.time() * 1000)
    try:
        artifacts = collect_artifacts()
    except BaseException:
        artifacts = dict(files=[], errors=[dict(code='artifact_io_failed')])
    finalized = True
    save(status)
`;
}

export function pythonWrapper(notebookId: string, runId: string, source: string): string {
  const wrapper = pythonWrapperSource(notebookId, runId, source);
  const encoded = base64(new TextEncoder().encode(wrapper));
  return `exec(compile(__import__('base64').b64decode('${encoded}'), '<notebook-wrapper>', 'exec'), {'get_ipython': get_ipython})`;
}
