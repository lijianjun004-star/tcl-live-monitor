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


async def bounded_map(items: Iterable, limit: int, worker: Callable[[object], Awaitable[T]], *,
                      should_abort: Callable[[T], bool] | None = None,
                      aborted: Callable[[object, bool], T] | None = None,
                      failed: Callable[[object], T] | None = None) -> list[T]:
    """Run ``worker`` with at most ``limit`` items in flight.

    When ``should_abort(result)`` turns true (e.g. the group breaker opened), every other
    item is cancelled at once - queued ones before they start, in-flight ones mid-request -
    and replaced by ``aborted(item, started)``. Unexpected exceptions become ``failed(item)``
    so no sibling is ever orphaned.
    """
    items = list(items)
    semaphore = asyncio.Semaphore(max(1, limit))
    started: set[int] = set()
    tasks: list[asyncio.Task] = []

    async def run(index, item):
        async with semaphore:
            started.add(index)
            result = await worker(item)
        if should_abort is not None and should_abort(result):
            current = asyncio.current_task()
            for task in tasks:
                if task is not current and not task.done():
                    task.cancel()
        return result

    tasks.extend(asyncio.create_task(run(index, item)) for index, item in enumerate(items))
    results = await asyncio.gather(*tasks, return_exceptions=True)
    out: list[T] = []
    for index, (item, result) in enumerate(zip(items, results)):
        if isinstance(result, asyncio.CancelledError):
            if aborted is None:
                raise result
            out.append(aborted(item, index in started))
        elif isinstance(result, BaseException):
            if failed is None:
                raise result
            out.append(failed(item))
        else:
            out.append(result)
    return out
