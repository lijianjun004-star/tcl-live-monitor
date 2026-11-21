"""Optional cookie groups: dual-domain injection for Tmall, isolation per group, no value leaks."""

import asyncio

import pytest

from platforms.ali_live.cookie_pool import CookieError, CookiePool, domains_for, parse_cookie_header
from platforms.ali_live.session import AliSession

SECRET = "t=SECRET_T_VALUE; _m_h5_tk=SECRET_TK_1700000000000; cookie2=SECRET_C2"


def test_tmall_groups_get_both_domains_and_taobao_only_one():
    assert domains_for({"tmall"}) == (".taobao.com", ".tmall.com")
    assert domains_for({"tmall", "taobao"}) == (".taobao.com", ".tmall.com")
    assert domains_for({"taobao"}) == (".taobao.com",)
    pool = CookiePool.from_env({"ALI_COOKIE_GROUP_1": SECRET})
    cookies = pool.cookies_for(1, {"tmall"})
    assert len(cookies) == 6
    assert {c["domain"] for c in cookies} == {".taobao.com", ".tmall.com"}
    for name in ("t", "_m_h5_tk", "cookie2"):
        assert {c["domain"] for c in cookies if c["name"] == name} == {".taobao.com", ".tmall.com"}
    assert all(c["secure"] and c["path"] == "/" for c in cookies)
    assert {c["domain"] for c in pool.cookies_for(1, {"taobao"})} == {".taobao.com"}


def test_groups_without_secret_run_as_guest_and_groups_are_isolated():
    pool = CookiePool.from_env({"ALI_COOKIE_GROUP_1": SECRET, "ALI_COOKIE_GROUP_2": "a=1"})
    assert pool.mode(1) == "cookie" and pool.mode(2) == "cookie" and pool.mode(3) == "guest"
    assert pool.cookies_for(3, {"tmall"}) == []
    assert {c["value"] for c in pool.cookies_for(2, {"taobao"})} == {"1"}


def test_values_never_appear_in_repr_or_errors():
    group = parse_cookie_header(SECRET, 1)
    pool = CookiePool({1: group})
    for text in (repr(group), str(group), repr(pool)):
        assert "SECRET" not in text
    assert group.names == ["_m_h5_tk", "cookie2", "t"]
    for bad in ("novalue", "a=1\r\nb=2", "bad name=1", "a=has space", "a=back\\slash"):
        with pytest.raises(CookieError) as error:
            parse_cookie_header(bad, 2)
        assert "ALI_COOKIE_GROUP_2" in str(error.value) and bad not in str(error.value)
    with pytest.raises(CookieError):
        CookiePool.from_env({"ALI_COOKIE_GROUP_3": ";;"})


class FakeContext:
    def __init__(self):
        self.cookies, self.closed = [], False

    async def add_cookies(self, cookies):
        self.cookies.extend(cookies)

    async def close(self):
        self.closed = True


class FakeFactory:
    def __init__(self):
        self.created = []

    async def new_context(self, profile, **_):
        assert profile == "ali_h5_mobile"
        context = FakeContext()
        self.created.append(context)
        return context


def test_session_creates_one_isolated_context_per_group():
    pool = CookiePool.from_env({"ALI_COOKIE_GROUP_1": SECRET})
    session = AliSession(pool, {1: {"tmall"}, 2: {"taobao"}})
    factory = FakeFactory()

    async def scenario():
        first = await session.context(factory, 1)
        again = await session.context(factory, 1)
        guest = await session.context(factory, 2)
        await session.close()
        return first, again, guest

    first, again, guest = asyncio.run(scenario())
    assert first is again and first is not guest and len(factory.created) == 2
    assert {c["domain"] for c in first.cookies} == {".taobao.com", ".tmall.com"}
    assert guest.cookies == []           # group 2 has no secret: guest mode, nothing leaks across
    assert first.closed and guest.closed
