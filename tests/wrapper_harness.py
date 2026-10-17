"""Exercise generated Python I/O with a synthetic shell, not real IPython."""
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any


class SyntheticShell:
    """Reuse one namespace with the wrapper's narrow shell contract."""

    def __init__(self) -> None:
        """Initialize namespace, count and replaceable display hooks."""
        self.user_ns: dict[str, Any] = {}
        self.execution_count = 1
        self.display_pub = SimpleNamespace(
            publish=lambda *args, **kwargs: None,
        )
        self.displayhook = SimpleNamespace(
            write_format_data=lambda *args, **kwargs: None,
        )
        self.user_ns['get_ipython'] = lambda: self

    def run_cell(self, code: str, store_history: bool,
                 silent: bool) -> SimpleNamespace:
        """Execute ordinary Python and return an IPython-like result."""
        assert store_history is True
        assert silent is False
        count = self.execution_count
        self.execution_count += 1
        error = None
        try:
            exec(compile(code, '<synthetic-user-cell>', 'exec'), self.user_ns)
        except BaseException as caught:
            error = caught
        return SimpleNamespace(
            execution_count=count, error_before_exec=None, error_in_exec=error,
        )


def check_wrappers(payload: dict[str, Any]) -> dict[str, Any]:
    """Run wrappers in a temporary directory and return bounded JSON."""
    root = Path(payload['root'])
    shell = SyntheticShell()
    results = []
    namespaces = []
    for index, source in enumerate(payload['wrappers']):
        compile(source, '<generated-wrapper>', 'exec')
        target = root / str(index) / 'result.json'
        prefix, remainder = source.split('root = Path(', 1)
        _, suffix = remainder.split(').parent', 1)
        local = (
            prefix + 'root = Path(' + repr(str(target)) + ').parent' + suffix
        )
        prefix, remainder = local.split('workspace = Path(', 1)
        _, suffix = remainder.split(')\n', 1)
        local = (
            prefix + 'workspace = Path('
            + repr(str(root / 'workspace')) + ')\n' + suffix
        )
        namespace = {'get_ipython': lambda: shell}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(local, '<generated-wrapper>', 'exec'), namespace)
        results.append(json.loads(target.read_text(encoding='utf-8')))
        namespaces.append(namespace)
    # A late flush must not turn a terminal record back into running.
    final = namespaces[-1]
    final['last_write'] = 0
    final['BoundedWriter']('stdout').flush()
    last = root / str(len(results) - 1) / 'result.json'
    assert json.loads(last.read_text(encoding='utf-8')) == results[-1]
    return {
        'results': results,
        'shared_value': shell.user_ns.get('shared_value'),
    }
