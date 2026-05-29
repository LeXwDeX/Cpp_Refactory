"""Analyzer: lightweight call graph for a given function.

Returns functions called by the target function (callees) and
functions that call the target function (callers, limited to same file).
"""
from __future__ import annotations

from typing import Optional

from clang import cindex


_FUNCTION_KINDS = {
    cindex.CursorKind.FUNCTION_DECL,
    cindex.CursorKind.CXX_METHOD,
    cindex.CursorKind.CONSTRUCTOR,
    cindex.CursorKind.DESTRUCTOR,
    cindex.CursorKind.CONVERSION_FUNCTION,
    cindex.CursorKind.FUNCTION_TEMPLATE,
}


def _walk(cursor: cindex.Cursor):
    """Pre-order DFS over a cursor's subtree."""
    yield cursor
    for c in cursor.get_children():
        yield from _walk(c)


def _find_function(tu: cindex.TranslationUnit, func_name: str, target_file: str):
    """Find a function definition by name in the target file."""
    import os
    target_abs = os.path.realpath(target_file)

    for node in _walk(tu.cursor):
        if node.kind not in _FUNCTION_KINDS:
            continue
        if not node.is_definition():
            continue
        if node.spelling != func_name:
            continue
        loc = node.location
        if loc.file and str(loc.file.name) == target_abs:
            return node
    return None


def callees_in_function(
    tu: cindex.TranslationUnit,
    target_file: str,
    func_name: str,
) -> list[dict]:
    """Find all function calls within a given function.

    Returns a list of called functions with their locations.
    """
    import os
    target_abs = os.path.realpath(target_file)

    func_node = _find_function(tu, func_name, target_file)
    if func_node is None:
        return []

    calls = []
    seen = set()

    for node in _walk(func_node):
        if node.kind == cindex.CursorKind.CALL_EXPR:
            # Get the referenced function
            ref = node.get_definition()
            if ref is None:
                ref = node.referenced

            if ref and ref.kind in _FUNCTION_KINDS:
                name = ref.spelling
                if name not in seen:
                    seen.add(name)

                    # Determine if it's in the same file
                    ref_file = None
                    if ref.location.file:
                        ref_file = str(ref.location.file.name)

                    calls.append({
                        "name": name,
                        "qualified_name": ref.displayname or name,
                        "call_line": node.location.line,
                        "defined_in": ref_file,
                        "is_same_file": ref_file == target_abs,
                        "is_definition": ref.is_definition(),
                    })

    calls.sort(key=lambda x: x["call_line"])
    return calls


def callers_in_file(
    tu: cindex.TranslationUnit,
    target_file: str,
    func_name: str,
) -> list[dict]:
    """Find all call sites of a given function within the same file.

    Returns a list of calling functions with call site locations.
    Limited to same-file analysis (cross-file requires codegraph).
    """
    import os
    target_abs = os.path.realpath(target_file)

    callers = []

    for node in _walk(tu.cursor):
        if node.kind not in _FUNCTION_KINDS:
            continue
        if not node.is_definition():
            continue

        loc = node.location
        if not loc.file or str(loc.file.name) != target_abs:
            continue

        # Skip the target function itself
        if node.spelling == func_name:
            continue

        # Search for calls to func_name within this function
        for child in _walk(node):
            if child.kind == cindex.CursorKind.CALL_EXPR:
                ref = child.get_definition()
                if ref is None:
                    ref = child.referenced

                if ref and ref.spelling == func_name:
                    callers.append({
                        "caller": node.spelling,
                        "caller_line": node.location.line,
                        "call_site_line": child.location.line,
                    })

    callers.sort(key=lambda x: x["call_site_line"])
    return callers
