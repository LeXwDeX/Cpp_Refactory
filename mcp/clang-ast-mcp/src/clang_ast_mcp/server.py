"""MCP server entry point for clang-ast-mcp.

Exposes 8 tools for precise C++ AST queries on a given source file
(requires compile_commands.json).
"""
from __future__ import annotations

import functools
import logging
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable, Optional

from mcp.server.fastmcp import FastMCP

from .ast_engine import get_engine
from .analyzers.list_functions import list_functions
from .analyzers.globals_finder import globals_in_file
from .analyzers.virtual_calls import virtual_calls
from .analyzers.macro_jungle import macro_jungle
from .analyzers.call_graph import callees_in_function, callers_in_file


# ---------------------------------------------------------------------------
# Logging — to stderr only (stdout is reserved for MCP JSON-RPC stream)
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=os.environ.get("CLANG_AST_MCP_LOG", "INFO"),
    stream=sys.stderr,
    format="[clang-ast-mcp] %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _resolve_compile_db(compile_db: Optional[str]) -> str:
    """Resolve compile_commands.json path.

    Order:
      1. Explicit argument (file or directory containing compile_commands.json)
      2. CLANG_AST_MCP_COMPILE_DB env
      3. compile_commands.json in cwd
      4. compile_commands.json in any parent dir up to /
    """
    if compile_db:
        p = Path(compile_db).expanduser().resolve()
        if p.is_dir():
            cand = p / "compile_commands.json"
            if not cand.exists():
                raise FileNotFoundError(
                    f"compile_commands.json not found in directory: {p}"
                )
            return str(cand)
        return str(p)
    env = os.environ.get("CLANG_AST_MCP_COMPILE_DB")
    if env:
        return str(Path(env).expanduser().resolve())
    cwd = Path.cwd().resolve()
    for d in [cwd, *cwd.parents]:
        cand = d / "compile_commands.json"
        if cand.exists():
            return str(cand)
    raise FileNotFoundError(
        "compile_commands.json not found. "
        "Pass compile_db=<path-or-dir> or set CLANG_AST_MCP_COMPILE_DB."
    )


def _resolve_source(file: str) -> str:
    if not file:
        raise ValueError("file argument is required and must be non-empty")
    p = Path(file).expanduser()
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    else:
        p = p.resolve()
    if not p.exists():
        raise FileNotFoundError(f"Source file not found: {p}")
    if not p.is_file():
        raise ValueError(f"Path is not a regular file: {p}")
    return str(p)


def _safe_tool(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a tool function so any exception becomes a structured error result.

    MCP clients should never see a transport-level exception from us — that
    would terminate the call without a useful diagnostic. Instead we return
    {"ok": False, "error": {...}} so the agent can decide what to do.
    """

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            result = fn(*args, **kwargs)
            if isinstance(result, dict) and "ok" not in result:
                result = {"ok": True, **result}
            return result
        except FileNotFoundError as e:
            log.warning("%s: %s", fn.__name__, e)
            return {
                "ok": False,
                "error": {"kind": "FileNotFound", "message": str(e)},
            }
        except KeyError as e:
            log.warning("%s: missing compile entry: %s", fn.__name__, e)
            return {
                "ok": False,
                "error": {"kind": "NoCompileEntry", "message": str(e)},
            }
        except ValueError as e:
            log.warning("%s: bad argument: %s", fn.__name__, e)
            return {
                "ok": False,
                "error": {"kind": "BadArgument", "message": str(e)},
            }
        except Exception as e:  # noqa: BLE001
            log.exception("%s failed", fn.__name__)
            return {
                "ok": False,
                "error": {
                    "kind": type(e).__name__,
                    "message": str(e),
                    "traceback": traceback.format_exc(limit=8),
                },
            }

    return wrapper


# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------
mcp = FastMCP(
    name="clang-ast-mcp",
    instructions=(
        "Precise C++ AST queries for legacy code refactoring. "
        "Replaces regex-based heuristics in cpp_refactory's seam-finder. "
        "Requires compile_commands.json (produced by `bear -- make`)."
    ),
)


@mcp.tool(
    name="clang_ast_load",
    description=(
        "Pre-warm the AST cache for a source file. Call this once before "
        "running multiple queries on the same large file (e.g. >5k lines). "
        "Returns parse status and cache stats."
    ),
)
@_safe_tool
def tool_load(file: str, compile_db: Optional[str] = None) -> dict:
    eng = get_engine()
    src = _resolve_source(file)
    db = _resolve_compile_db(compile_db)
    tu = eng.get_tu(src, db, full_bodies=True)
    diags = [
        {"severity": int(d.severity), "msg": d.spelling}
        for d in tu.diagnostics
        if d.severity >= 2  # Warning+
    ][:20]
    return {
        "file": src,
        "compile_db": db,
        "diagnostics": diags,
        "cache": eng.cache_stats(),
    }


@mcp.tool(
    name="clang_ast_list_functions",
    description=(
        "List every function definition in a C++ source file with PRECISE "
        "line boundaries (replaces brace-counting heuristic). Each result "
        "includes line count, cyclomatic complexity, virtual/static flags, "
        "and return type. Use min_lines to filter for refactor candidates."
    ),
)
@_safe_tool
def tool_list_functions(
    file: str,
    min_lines: int = 0,
    compile_db: Optional[str] = None,
) -> dict:
    if min_lines < 0:
        raise ValueError("min_lines must be >= 0")
    eng = get_engine()
    src = _resolve_source(file)
    db = _resolve_compile_db(compile_db)
    tu = eng.get_tu(src, db, full_bodies=True)
    items = list_functions(tu, src, min_lines=min_lines)
    return {
        "file": src,
        "min_lines": min_lines,
        "count": len(items),
        "functions": items,
    }


@mcp.tool(
    name="clang_ast_globals",
    description=(
        "Find all global / file-scope / namespace-scope / class-static "
        "variables in a source file. Distinguishes extern, file-static, "
        "anonymous-namespace, and class-static linkage. Flags variables "
        "with dynamic initialization (the dangerous ones for SIOF)."
    ),
)
@_safe_tool
def tool_globals(file: str, compile_db: Optional[str] = None) -> dict:
    eng = get_engine()
    src = _resolve_source(file)
    db = _resolve_compile_db(compile_db)
    tu = eng.get_tu(src, db, full_bodies=False)
    items = globals_in_file(tu, src)
    return {"file": src, "count": len(items), "globals": items}


@mcp.tool(
    name="clang_ast_virtual_calls",
    description=(
        "Find virtual method call sites in a source file. For each call, "
        "lists the candidate overrides found in the translation unit. "
        "Use 'function' parameter to scope to a single enclosing function."
    ),
)
@_safe_tool
def tool_virtual_calls(
    file: str,
    function: Optional[str] = None,
    compile_db: Optional[str] = None,
) -> dict:
    eng = get_engine()
    src = _resolve_source(file)
    db = _resolve_compile_db(compile_db)
    tu = eng.get_tu(src, db, full_bodies=True)
    items = virtual_calls(tu, src, function_name=function)
    return {
        "file": src,
        "function_filter": function,
        "count": len(items),
        "calls": items,
    }


@mcp.tool(
    name="clang_ast_macro_jungle",
    description=(
        "Per-function preprocessor complexity report. For each function: "
        "counts #ifdef/#if/#elif branches in body, lists macro invocations, "
        "and computes a complexity score. Sorted by score descending — "
        "top entries are prime targets for ifdef-jungle cleanup."
    ),
)
@_safe_tool
def tool_macro_jungle(file: str, compile_db: Optional[str] = None) -> dict:
    eng = get_engine()
    src = _resolve_source(file)
    db = _resolve_compile_db(compile_db)
    tu = eng.get_tu(src, db, full_bodies=True)
    return macro_jungle(tu, src)


@mcp.tool(
    name="clang_ast_call_graph",
    description=(
        "Lightweight call graph analysis for a function. Returns: "
        "(1) callees - functions called by the target function, "
        "(2) callers - functions that call the target (same file only). "
        "For cross-file analysis, use codegraph instead."
    ),
)
@_safe_tool
def tool_call_graph(
    file: str,
    function: str,
    compile_db: Optional[str] = None,
) -> dict:
    eng = get_engine()
    src = _resolve_source(file)
    db = _resolve_compile_db(compile_db)
    tu = eng.get_tu(src, db, full_bodies=True)

    callees = callees_in_function(tu, src, function)
    callers = callers_in_file(tu, src, function)

    return {
        "file": src,
        "function": function,
        "callees": callees,
        "callees_count": len(callees),
        "callers": callers,
        "callers_count": len(callers),
        "note": "callers limited to same file; use codegraph for cross-file analysis",
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
@mcp.tool(
    name="clang_ast_cache_stats",
    description=(
        "Inspect the two-level AST cache: L1 in-memory LRU + L2 on-disk "
        "TU files. Returns hit/miss counters, disk usage, and cached file "
        "list. Useful for verifying that big-file reparses are being "
        "avoided across MCP sessions."
    ),
)
@_safe_tool
def tool_cache_stats() -> dict:
    eng = get_engine()
    return eng.cache_stats()


@mcp.tool(
    name="clang_ast_cache_clear",
    description=(
        "Clear the on-disk TU cache. Use older_than_days to keep recent "
        "entries (default: clear ALL). Returns deleted file count and "
        "freed bytes. Does NOT touch the L1 memory cache (process-local)."
    ),
)
@_safe_tool
def tool_cache_clear(older_than_days: Optional[float] = None) -> dict:
    eng = get_engine()
    return eng.clear_disk_cache(older_than_days=older_than_days)


def main() -> None:
    log.info("Starting clang-ast-mcp on stdio transport")
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
