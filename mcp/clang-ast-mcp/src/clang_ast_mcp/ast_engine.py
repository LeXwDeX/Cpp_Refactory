"""AST engine: libclang wrapper + 两级缓存（内存 LRU + 磁盘持久化）。

Single responsibility: 给定一个源文件路径 + compile_commands.json,
返回一个可复用的 TranslationUnit。隐藏所有 libclang 细节。

两级缓存：
  L1: 内存 OrderedDict (LRU, 默认 8 个 TU)
  L2: 磁盘 .tu 文件（libclang TU.save/from_ast_file）
       目录：$CPP_REFACTORY_CACHE_DIR/tu/  默认 ~/.cache/clang-ast-mcp/tu/
       文件：<sha256(src+args+ver+mode)>.tu  + 同名 .meta.json

失效条件（按顺序）：
  1) 源文件 mtime 变化 → 失效
  2) compile args 变化 → 自动失效（hash key 已含 args）
  3) libclang 版本变化 → 自动失效（hash key 已含版本字符串）
  4) full_bodies 模式不匹配 → 自动失效
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from clang import cindex

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# libclang 库加载 — 必须在使用 cindex 之前
# ---------------------------------------------------------------------------
_LIBCLANG_CANDIDATES = [
    "/lib/x86_64-linux-gnu/libclang-18.so.1",
    "/lib/x86_64-linux-gnu/libclang-18.so",
    "/usr/lib/x86_64-linux-gnu/libclang-18.so.1",
    "/usr/lib/llvm-18/lib/libclang.so.1",
]


def _ensure_libclang_loaded() -> None:
    """显式指向 libclang-18，避免 Python binding 找不到 .so。

    幂等：若 libclang 已在当前进程中加载（Config.loaded），跳过设置。
    这在同一进程中多次 import 本模块时（如 pytest 中删除 sys.modules 后重新导入）
    是正常情况，不应视为错误。
    """
    if cindex.Config.loaded:
        log.debug("libclang already loaded in this process, skipping set_library_file")
        return
    for path in _LIBCLANG_CANDIDATES:
        if Path(path).exists():
            try:
                cindex.Config.set_library_file(path)
                log.info("libclang loaded from %s", path)
                return
            except cindex.LibclangError:
                continue
    # 兜底：让 cindex 自己找
    log.warning("No explicit libclang found; relying on default discovery")


_ensure_libclang_loaded()


# ---------------------------------------------------------------------------
# Disk cache helpers
# ---------------------------------------------------------------------------
def _libclang_version() -> str:
    """从已加载库读取版本字符串，作为 cache key 的一部分。

    优先调用 clang_getClangVersion()，回退到 library_file 路径。
    """
    try:
        from ctypes import c_char_p
        lib = cindex.conf.lib
        lib.clang_getClangVersion.restype = c_char_p
        ver = lib.clang_getClangVersion()
        if ver:
            return ver.decode("utf-8", errors="replace")
    except Exception:
        pass
    return cindex.Config.library_file or "unknown"


def _get_cache_dir() -> Path:
    """返回 TU 持久化缓存目录（确保存在）。"""
    base = os.environ.get("CPP_REFACTORY_CACHE_DIR")
    if base:
        d = Path(base) / "tu"
    else:
        d = Path.home() / ".cache" / "clang-ast-mcp" / "tu"
    d.mkdir(parents=True, exist_ok=True)
    return d


_LIBCLANG_VER_CACHED = _libclang_version()


def _compute_cache_key(src: str, args: tuple[str, ...], full_bodies: bool) -> str:
    """sha256(src_abs + sorted(args) + libclang_path + mode) → hex 摘要。

    注意：args 不排序——顺序对编译有意义（-D 顺序、宏覆盖）。
    """
    h = hashlib.sha256()
    h.update(src.encode())
    h.update(b"\x00")
    for a in args:
        h.update(a.encode())
        h.update(b"\x00")
    h.update(_LIBCLANG_VER_CACHED.encode())
    h.update(b"\x00")
    h.update(b"full" if full_bodies else b"skip")
    return h.hexdigest()


def _disk_paths(cache_key: str) -> tuple[Path, Path]:
    """返回 (.tu, .meta.json) 路径。"""
    d = _get_cache_dir()
    return d / f"{cache_key}.tu", d / f"{cache_key}.meta.json"


# ---------------------------------------------------------------------------
# Compile commands
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class CompileEntry:
    """One entry from compile_commands.json, normalized."""

    file: str
    directory: str
    args: tuple[str, ...]


# Path flags whose next argument is a directory that may need resolution
_PATH_FLAGS: frozenset[str] = frozenset({"-I", "-isystem", "-iquote", "-idirafter", "-L", "-isysroot"})


def _normalize_args(raw_args: list[str], directory: str) -> tuple[str, ...]:
    """Normalize compile args: resolve relative paths to absolute.

    剔除 compile_commands 中不能传给 libclang 的参数，并将相对路径
    参数（-I, -isystem 等）转换为绝对路径，消除对 os.chdir() 的依赖。

    需要剔除：
    - 第一个参数（编译器路径）
    - -c <file> 输入文件参数
    - -o <output> 输出参数
    """
    if not raw_args:
        return ()

    out: list[str] = []
    skip_next = False
    # 跳过编译器本身
    args = raw_args[1:]
    for i, a in enumerate(args):
        if skip_next:
            skip_next = False
            continue
        if a in ("-c", "-o"):
            skip_next = True
            continue
        if a.startswith("-o"):
            continue
        
        # Resolve relative paths for -I, -isystem, etc.
        if a in _PATH_FLAGS and i + 1 < len(args):
            out.append(a)
            path_arg = args[i + 1]
            if not os.path.isabs(path_arg):
                path_arg = os.path.normpath(os.path.join(directory, path_arg))
            out.append(path_arg)
            skip_next = True
            continue
        
        # Handle -I./include (flag and path in one arg)
        for flag in _PATH_FLAGS:
            if a.startswith(flag) and len(a) > len(flag) and not a[len(flag):].startswith("/"):
                rel_path = a[len(flag):]
                abs_path = os.path.normpath(os.path.join(directory, rel_path))
                out.append(f"{flag}{abs_path}")
                break
        else:
            out.append(a)
    
    return tuple(out)


class CompileDatabase:
    """轻量级 compile_commands.json 解析器。

    懒加载：构造时不解析 JSON，首次 get() 调用时才加载。
    """

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path).resolve()
        if not self.db_path.exists():
            raise FileNotFoundError(f"compile_commands.json not found: {self.db_path}")
        self._mtime = self.db_path.stat().st_mtime
        self._entries: dict[str, CompileEntry] | None = None  # Lazy: None = not loaded

    def _ensure_loaded(self) -> None:
        """Lazy load entries on first access."""
        if self._entries is None:
            self._load()

    def _load(self) -> None:
        self._entries = {}
        with open(self.db_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        for item in raw:
            file_abs = str(Path(item["directory"]) / item["file"])
            file_abs = str(Path(file_abs).resolve())
            if "arguments" in item:
                args = item["arguments"]
            elif "command" in item:
                # 简单 shell 拆分；对绝大多数 compile command 足够
                import shlex
                args = shlex.split(item["command"])
            else:
                continue
            self._entries[file_abs] = CompileEntry(
                file=file_abs,
                directory=item["directory"],
                args=_normalize_args(args, item["directory"]),
            )
        log.info("Loaded %d compile entries from %s", len(self._entries), self.db_path)

    def get(self, source_file: str | Path) -> Optional[CompileEntry]:
        self._ensure_loaded()
        assert self._entries is not None  # Type guard: _ensure_loaded guarantees this
        path = str(Path(source_file).resolve())
        return self._entries.get(path)

    def is_stale(self) -> bool:
        try:
            return self.db_path.stat().st_mtime != self._mtime
        except FileNotFoundError:
            return True


# ---------------------------------------------------------------------------
# TU cache
# ---------------------------------------------------------------------------
@dataclass
class CachedTU:
    tu: cindex.TranslationUnit
    source_mtime: float
    source_path: str


class ASTEngine:
    """Translation Unit cache with LRU eviction + mtime guard.

    - Max 8 TUs in memory (each ~50MB for big files).
    - On query: validate source mtime, reparse if stale.
    - Uses CXTranslationUnit_PrecompiledPreamble for incremental reparse speed.
    """

    DEFAULT_PARSE_OPTIONS = (
        cindex.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD
        | cindex.TranslationUnit.PARSE_PRECOMPILED_PREAMBLE
        | cindex.TranslationUnit.PARSE_CACHE_COMPLETION_RESULTS
        | cindex.TranslationUnit.PARSE_SKIP_FUNCTION_BODIES  # fast pass; we'll override per-need
    )

    # Full-fidelity options (no skip bodies) — used when callers need bodies (for call graphs etc).
    FULL_PARSE_OPTIONS = (
        cindex.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD
        | cindex.TranslationUnit.PARSE_PRECOMPILED_PREAMBLE
        | cindex.TranslationUnit.PARSE_CACHE_COMPLETION_RESULTS
    )

    def __init__(self, max_tus: int = 8):
        self._index = cindex.Index.create()
        self._cache: OrderedDict[tuple[str, str], CachedTU] = OrderedDict()
        self._max = max_tus
        self._lock = threading.Lock()
        self._dbs: dict[str, CompileDatabase] = {}
        # Counters for observability
        self._stats = {"l1_hit": 0, "l2_hit": 0, "miss": 0, "saved": 0, "save_errors": 0}

    # ---------------- compile db ----------------
    def get_db(self, db_path: str | Path) -> CompileDatabase:
        key = str(Path(db_path).resolve())
        db = self._dbs.get(key)
        if db is None or db.is_stale():
            db = CompileDatabase(key)
            self._dbs[key] = db
        return db

    # ---------------- TU acquire ----------------
    def get_tu(
        self,
        source_file: str | Path,
        compile_db: str | Path,
        full_bodies: bool = True,
    ) -> cindex.TranslationUnit:
        """Get (cached or fresh) TU for source_file using args from compile_db.

        full_bodies=True (default) 解析函数体；False 时跳过函数体加快首次解析。
        """
        src = str(Path(source_file).resolve())
        if not Path(src).exists():
            raise FileNotFoundError(f"Source file not found: {src}")

        db = self.get_db(compile_db)
        entry = db.get(src)
        if entry is None:
            raise KeyError(
                f"No compile entry for {src} in {db.db_path}. "
                f"Hint: ensure bear captured this file."
            )

        cur_mtime = Path(src).stat().st_mtime
        cache_key = (src, "full" if full_bodies else "skip")
        disk_key = _compute_cache_key(src, entry.args, full_bodies)

        with self._lock:
            # ── L1: 内存命中 ──────────────────────────────
            cached = self._cache.get(cache_key)
            if cached is not None and cached.source_mtime == cur_mtime:
                self._cache.move_to_end(cache_key)
                self._stats["l1_hit"] += 1
                return cached.tu

            # ── L2: 磁盘命中 ──────────────────────────────
            tu_path, meta_path = _disk_paths(disk_key)
            if tu_path.exists() and meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    if (
                        meta.get("source_mtime") == cur_mtime
                        and meta.get("libclang_ver") == _LIBCLANG_VER_CACHED
                    ):
                        log.info("L2 disk hit for %s (key=%s)", src, disk_key[:12])
                        tu = cindex.TranslationUnit.from_ast_file(
                            str(tu_path), index=self._index
                        )
                        self._cache[cache_key] = CachedTU(
                            tu=tu, source_mtime=cur_mtime, source_path=src
                        )
                        self._cache.move_to_end(cache_key)
                        while len(self._cache) > self._max:
                            self._cache.popitem(last=False)
                        self._stats["l2_hit"] += 1
                        return tu
                    else:
                        log.debug("L2 stale (mtime/ver mismatch), reparsing")
                except Exception as e:
                    log.warning("L2 load failed (%s); reparsing fresh", e)

            # ── L3: 重新解析 ──────────────────────────────
            self._stats["miss"] += 1
            options = self.FULL_PARSE_OPTIONS if full_bodies else self.DEFAULT_PARSE_OPTIONS
            log.info("Parsing TU for %s (full_bodies=%s)", src, full_bodies)
            # No chdir needed: _normalize_args resolves all relative paths to absolute
            tu = self._index.parse(
                src,
                args=list(entry.args),
                options=options,
            )

            if tu is None:
                raise RuntimeError(f"libclang failed to parse {src}")

            for diag in tu.diagnostics:
                if diag.severity >= cindex.Diagnostic.Error:
                    log.warning("Parse diag: %s", diag.spelling)

            # ── 写回 L2 ──────────────────────────────────
            try:
                tu.save(str(tu_path))
                meta = {
                    "source_path": src,
                    "source_mtime": cur_mtime,
                    "args": list(entry.args),
                    "libclang_ver": _LIBCLANG_VER_CACHED,
                    "full_bodies": full_bodies,
                    "created": time.time(),
                    "size_bytes": tu_path.stat().st_size,
                }
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta, f, indent=2)
                self._stats["saved"] += 1
            except Exception as e:
                log.warning("Failed to persist TU to %s: %s", tu_path, e)
                self._stats["save_errors"] += 1

            self._cache[cache_key] = CachedTU(
                tu=tu, source_mtime=cur_mtime, source_path=src
            )
            self._cache.move_to_end(cache_key)
            while len(self._cache) > self._max:
                self._cache.popitem(last=False)

            return tu

    def cache_stats(self) -> dict:
        with self._lock:
            disk_dir = _get_cache_dir()
            disk_files = list(disk_dir.glob("*.tu"))
            disk_size = sum(f.stat().st_size for f in disk_files)
            return {
                "l1_memory": {
                    "cached_tus": len(self._cache),
                    "max": self._max,
                    "files": [k[0] for k in self._cache.keys()],
                },
                "l2_disk": {
                    "dir": str(disk_dir),
                    "tu_count": len(disk_files),
                    "total_bytes": disk_size,
                    "total_mb": round(disk_size / (1024 * 1024), 2),
                },
                "counters": dict(self._stats),
                "libclang": _LIBCLANG_VER_CACHED,
            }

    def clear_disk_cache(self, older_than_days: Optional[float] = None) -> dict:
        """清理磁盘缓存。older_than_days=None 时清空全部。返回删除统计。"""
        d = _get_cache_dir()
        deleted = 0
        freed = 0
        cutoff = time.time() - (older_than_days * 86400) if older_than_days else None
        for f in list(d.iterdir()):
            if cutoff is not None and f.stat().st_mtime > cutoff:
                continue
            try:
                size = f.stat().st_size
                f.unlink()
                deleted += 1
                freed += size
            except Exception as e:
                log.warning("Failed to delete %s: %s", f, e)
        return {"deleted_files": deleted, "freed_bytes": freed, "dir": str(d)}


# ---------------------------------------------------------------------------
# Singleton engine
# ---------------------------------------------------------------------------
_engine: Optional[ASTEngine] = None


def get_engine() -> ASTEngine:
    global _engine
    if _engine is None:
        _engine = ASTEngine()
    return _engine
