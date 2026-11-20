"""Per-room isolation: one room's timeout or exception never stops the others."""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, Iterable, TypeVar

from .errors import Code

T = TypeVar("T")
Failure = Callable[[Code, str], T]


async def guarded(factory: Callable[[], Awaitable[T]], timeout: float, on_failure: Failure) -> T:
    try:
        return await asyncio.wait_for(factory(), timeout=timeout)
    except asyncio.CancelledError:
        raise
    except asyncio.TimeoutError:
        return on_failure(Code.NAV_TIMEOUT, "room_timeout")
    except Exception:
        return on_failure(Code.NAV_TIMEOUT, "runtime_exception")


async def bounded_map(items: Iterable, limit: int, worker: Callable[[object], Awaitable[T]]) -> list[T]:
    semaphore = asyncio.Semaphore(max(1, limit))

    async def run(item):
        async with semaphore:
            return await worker(item)

    return list(await asyncio.gather(*(run(item) for item in items)))
