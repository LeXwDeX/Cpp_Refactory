"""Analyzer: list functions defined in a given source file.

Returns precise function boundaries, line counts, and a simple cyclomatic
complexity estimate (count of branching constructs).
"""
from __future__ import annotations

from typing import Iterable

from clang import cindex


_BRANCH_KINDS = {
    cindex.CursorKind.IF_STMT,
    cindex.CursorKind.FOR_STMT,
    cindex.CursorKind.WHILE_STMT,
    cindex.CursorKind.DO_STMT,
    cindex.CursorKind.CASE_STMT,
    cindex.CursorKind.CXX_FOR_RANGE_STMT,
    cindex.CursorKind.CXX_CATCH_STMT,
    cindex.CursorKind.CONDITIONAL_OPERATOR,
    cindex.CursorKind.BINARY_OPERATOR,  # filtered below for &&/||
}


_FUNCTION_KINDS = {
    cindex.CursorKind.FUNCTION_DECL,
    cindex.CursorKind.CXX_METHOD,
    cindex.CursorKind.CONSTRUCTOR,
    cindex.CursorKind.DESTRUCTOR,
    cindex.CursorKind.CONVERSION_FUNCTION,
    cindex.CursorKind.FUNCTION_TEMPLATE,
}


def _walk(cursor: cindex.Cursor) -> Iterable[cindex.Cursor]:
    """Pre-order DFS over a cursor's subtree."""
    yield cursor
    for c in cursor.get_children():
        yield from _walk(c)


def _is_short_circuit(cursor: cindex.Cursor) -> bool:
    """Detect && / || which add to cyclomatic complexity.

    Optimization: only scan tokens that belong to this cursor itself,
    skipping tokens inside child node extents.  The operator token
    (&& or ||) sits between the two operands at the top level of the
    BINARY_OPERATOR node and is NOT contained in any child's extent.
    This avoids O(n^2) traversal of the entire subtree.
    """
    if cursor.kind != cindex.CursorKind.BINARY_OPERATOR:
        return False

    # Collect child extents to skip
    child_ranges: list[tuple[int, int]] = []
    for child in cursor.get_children():
        if child.extent.start.file is not None:
            child_ranges.append(
                (child.extent.start.offset, child.extent.end.offset)
            )

    for token in cursor.get_tokens():
        offset = token.extent.start.offset
        # Skip tokens inside child nodes (operands)
        if any(s <= offset <= e for s, e in child_ranges):
            continue
        if token.spelling in ("&&", "||"):
            return True

    return False


def _cyclomatic(cursor: cindex.Cursor) -> int:
    """Approximate cyclomatic complexity = 1 + branching nodes."""
    count = 1
    for node in _walk(cursor):
        if node.kind in _BRANCH_KINDS:
            if node.kind == cindex.CursorKind.BINARY_OPERATOR:
                if _is_short_circuit(node):
                    count += 1
            else:
                count += 1
    return count


def _is_in_target_file(cursor: cindex.Cursor, target_abs: str) -> bool:
    loc = cursor.location
    if loc.file is None:
        return False
    return str(loc.file.name) == target_abs


def list_functions(
    tu: cindex.TranslationUnit, target_file: str, min_lines: int = 0
) -> list[dict]:
    """Return all function definitions in target_file with metadata."""
    import os

    target_abs = os.path.realpath(target_file)
    out: list[dict] = []
    seen_keys: set[tuple] = set()

    for node in _walk(tu.cursor):
        if node.kind not in _FUNCTION_KINDS:
            continue
        if not node.is_definition():
            continue
        if not _is_in_target_file(node, target_abs):
            continue

        extent = node.extent
        start = extent.start.line
        end = extent.end.line
        line_count = max(0, end - start + 1)
        if line_count < min_lines:
            continue

        # Dedup (template specializations may appear twice)
        key = (node.spelling, start, end)
        if key in seen_keys:
            continue
        seen_keys.add(key)

        is_virtual = False
        is_static = False
        if node.kind == cindex.CursorKind.CXX_METHOD:
            try:
                is_virtual = node.is_virtual_method()
            except Exception:
                pass
            try:
                is_static = node.is_static_method()
            except Exception:
                pass

        out.append(
            {
                "name": node.spelling,
                "qualified_name": node.displayname or node.spelling,
                "kind": node.kind.name,
                "start_line": start,
                "end_line": end,
                "line_count": line_count,
                "cyclomatic_complexity": _cyclomatic(node),
                "is_template": node.kind == cindex.CursorKind.FUNCTION_TEMPLATE,
                "is_virtual": is_virtual,
                "is_static": is_static,
                "return_type": node.result_type.spelling if node.result_type else None,
            }
        )

    out.sort(key=lambda x: x["start_line"])
    return out
