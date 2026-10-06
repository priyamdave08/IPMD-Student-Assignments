"""Runs the JavaScript unit tests (tests/js) as part of the normal test run, when Node is installed."""
import re
import shutil
import subprocess
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which('node') is None, reason='Node.js is not installed')
def test_javascript_unit_tests_pass():
    files = [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'tests' / 'js').glob('*.test.mjs'))]
    assert files, 'no JavaScript tests found'
    result = subprocess.run(['node', '--test', '--test-reporter=tap', *files], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=600)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-1500:]
    assert re.search(r'^# fail 0$', result.stdout, re.M) and int(re.search(r'^# pass (\d+)$', result.stdout, re.M).group(1)) >= 20
