"""One isolated browser context per account group, shared by that group's B and A layers."""

from __future__ import annotations

import asyncio

from .cookie_pool import CookiePool


class AliSession:
    def __init__(self, pool: CookiePool, group_platforms: dict[int, set[str]]):
        self.pool = pool
        self.group_platforms = group_platforms
        self._contexts: dict[int, object] = {}
        self._lock = asyncio.Lock()

    def mode(self, group: int) -> str:
        return self.pool.mode(group)

    async def context(self, factory, group: int):
        async with self._lock:
            if group not in self._contexts:
                context = await factory.new_context("ali_h5_mobile")
                cookies = self.pool.cookies_for(group, self.group_platforms.get(group, set()))
                if cookies:
                    await context.add_cookies(cookies)
                self._contexts[group] = context
            return self._contexts[group]

    async def close(self) -> None:
        contexts, self._contexts = list(self._contexts.values()), {}
        for context in contexts:
            try:
                await context.close()
            except Exception:
                pass
