"""Unit tests for ast_engine.py architectural fixes.

Tests:
1. _normalize_args resolves relative paths to absolute
2. CompileDatabase lazy loading (no load on __init__)
3. get_tu() does not call os.chdir()

Run: pytest tests/test_ast_engine_fixes.py -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Add src to path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from clang_ast_mcp.ast_engine import (
    _normalize_args,
    _PATH_FLAGS,
    CompileDatabase,
    CompileEntry,
)


class TestNormalizeArgsPathResolution:
    """Test that _normalize_args resolves relative paths to absolute."""

    def test_resolves_relative_include_path(self):
        """-I with relative path should become absolute."""
        raw_args = ["g++", "-I", "include", "-c", "test.cpp"]
        directory = "/project/src"
        result = _normalize_args(raw_args, directory)
        
        # Should contain -I followed by absolute path
        assert "-I" in result
        idx = result.index("-I")
        assert idx + 1 < len(result)
        path_arg = result[idx + 1]
        assert os.path.isabs(path_arg), f"Expected absolute path, got {path_arg}"
        assert path_arg == os.path.normpath("/project/src/include")

    def test_preserves_absolute_include_path(self):
        """-I with absolute path should remain unchanged."""
        raw_args = ["g++", "-I", "/usr/include", "-c", "test.cpp"]
        directory = "/project/src"
        result = _normalize_args(raw_args, directory)
        
        assert "-I" in result
        idx = result.index("-I")
        assert result[idx + 1] == "/usr/include"

    def test_resolves_isystem_relative_path(self):
        """-isystem with relative path should become absolute."""
        raw_args = ["g++", "-isystem", "../libs/include", "-c", "test.cpp"]
        directory = "/project/src"
        result = _normalize_args(raw_args, directory)
        
        assert "-isystem" in result
        idx = result.index("-isystem")
        path_arg = result[idx + 1]
        assert os.path.isabs(path_arg)
        assert path_arg == os.path.normpath("/project/src/../libs/include")

    def test_handles_concatenated_flag(self):
        """-I./include (flag+path in one arg) should be resolved."""
        raw_args = ["g++", "-I./include", "-c", "test.cpp"]
        directory = "/project/src"
        result = _normalize_args(raw_args, directory)
        
        # Should have -I<absolute_path> as single arg
        found = False
        for arg in result:
            if arg.startswith("-I") and len(arg) > 2:
                path_part = arg[2:]
                assert os.path.isabs(path_part), f"Expected absolute path in {arg}"
                found = True
                break
        assert found, f"No concatenated -I flag found in {result}"

    def test_strips_c_and_o_flags(self):
        """-c and -o flags should be removed."""
        raw_args = ["g++", "-I", "include", "-c", "test.cpp", "-o", "test.o"]
        directory = "/project"
        result = _normalize_args(raw_args, directory)
        
        assert "-c" not in result
        assert "-o" not in result
        assert "test.cpp" not in result
        assert "test.o" not in result

    def test_empty_args_returns_empty(self):
        """Empty args should return empty tuple."""
        result = _normalize_args([], "/project")
        assert result == ()

    def test_path_flags_constant_defined(self):
        """_PATH_FLAGS should contain expected flags."""
        assert "-I" in _PATH_FLAGS
        assert "-isystem" in _PATH_FLAGS
        assert "-iquote" in _PATH_FLAGS
        assert "-L" in _PATH_FLAGS


class TestCompileDatabaseLazyLoading:
    """Test that CompileDatabase defers loading until first get() call."""

    def test_init_does_not_load(self):
        """__init__ should not call _load() or read JSON."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "compile_commands.json"
            db_path.write_text("[]")
            
            # Patch _load to track calls
            with patch.object(CompileDatabase, "_load") as mock_load:
                db = CompileDatabase(db_path)
                mock_load.assert_not_called()
                assert db._entries is None

    def test_get_triggers_load(self):
        """First get() call should trigger _load()."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "compile_commands.json"
            db_path.write_text("[]")
            
            db = CompileDatabase(db_path)
            assert db._entries is None
            
            # Call get() - should trigger load
            db.get("/nonexistent.cpp")
            assert db._entries is not None

    def test_subsequent_get_does_not_reload(self):
        """Second get() should not reload."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "compile_commands.json"
            db_path.write_text("[]")
            
            db = CompileDatabase(db_path)
            db.get("/nonexistent.cpp")  # First load
            entries_id = id(db._entries)
            
            db.get("/nonexistent.cpp")  # Second call
            assert id(db._entries) == entries_id, "Entries reloaded unnecessarily"

    def test_loads_entries_correctly(self):
        """_load() should parse compile_commands.json correctly."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "compile_commands.json"
            compile_commands = [
                {
                    "directory": tmpdir,
                    "file": "test.cpp",
                    "arguments": ["g++", "-std=c++17", "-I", "include", "-c", "test.cpp"]
                }
            ]
            db_path.write_text(json.dumps(compile_commands))
            
            db = CompileDatabase(db_path)
            entry = db.get(os.path.join(tmpdir, "test.cpp"))
            
            assert entry is not None
            assert entry.file.endswith("test.cpp")
            assert entry.directory == tmpdir
            # Args should have -I resolved to absolute
            assert "-I" in entry.args
            idx = entry.args.index("-I")
            assert os.path.isabs(entry.args[idx + 1])


class TestGetTuNoChdir:
    """Test that get_tu() does not call os.chdir()."""

    def test_get_tu_does_not_chdir(self):
        """get_tu() should not call os.chdir() during parsing."""
        # This test requires a real compile_commands.json and source file
        # We'll use the existing fixtures
        fixtures_dir = HERE / "fixtures"
        sample_cpp = fixtures_dir / "sample.cpp"
        compile_db = fixtures_dir / "compile_commands.json"
        
        if not sample_cpp.exists() or not compile_db.exists():
            pytest.skip("Fixtures not available")
        
        from clang_ast_mcp.ast_engine import ASTEngine
        
        engine = ASTEngine()
        original_cwd = os.getcwd()
        
        # Patch os.chdir to track calls
        with patch("os.chdir") as mock_chdir:
            try:
                tu = engine.get_tu(str(sample_cpp), str(compile_db), full_bodies=True)
                # os.chdir should NOT have been called
                mock_chdir.assert_not_called()
            finally:
                # Restore cwd in case something went wrong
                os.chdir(original_cwd)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
