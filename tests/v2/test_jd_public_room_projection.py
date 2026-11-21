import asyncio
import json
from types import SimpleNamespace

import pytest

from experiments.jd_cookie_live import public_room


ROOM = '900000012345'
MARKER = 'synthetic-private-marker'


@pytest.mark.parametrize('live_id', [None, 'not-a-room', '100133134399', 'x/y'])
def test_invalid_candidate_never_launches_browser(monkeypatch, live_id):
    def unexpected(*args, **kwargs):
        pytest.fail('launched a process for invalid input')
    monkeypatch.setattr(public_room.subprocess, 'run', unexpected)
    report = public_room.verify_room(live_id)
    assert report['live_id'] is None
    assert report['live_status'] == 'unknown'


def test_worker_has_no_storefront_credentials_or_debug_environment(monkeypatch):
    monkeypatch.setenv('JD_COOKIES_JSON', MARKER)
    monkeypatch.setenv('DEBUG', MARKER)
    monkeypatch.setenv('HTTPS_PROXY', MARKER)

    def failed(command, **kwargs):
        assert 'JD_COOKIES_JSON' not in kwargs['env'] and 'DEBUG' not in kwargs['env']
        assert MARKER not in repr(command) + repr(kwargs)
        assert kwargs['stderr'] == public_room.subprocess.DEVNULL
        raise OSError(MARKER)

    monkeypatch.setattr(public_room.subprocess, 'run', failed)
    report = public_room.verify_room(ROOM)
    assert report['code'] == 'OBSERVATION_ERROR'
    assert MARKER not in repr(report)


def test_success_only_exposes_evidence_for_this_room(monkeypatch, capsys):
    async def enter(self):
        return self

    async def exit_browser(self, *args):
        pass

    async def collect(self, browser, url, room_id, thumb_path, result, budget):
        assert room_id == ROOM and url == 'https://lives.jd.com/#/' + ROOM
        assert thumb_path is None
        result.update(page_loaded=True, room_id_matched=True, live_status='replay', item_title=MARKER)
        return {'gate_kind': None, 'elapsed_ms': 150, 'detect_ms': 120, 'private': MARKER}

    monkeypatch.setattr(public_room.AnonymousRoomBrowser, '__aenter__', enter)
    monkeypatch.setattr(public_room.AnonymousRoomBrowser, '__aexit__', exit_browser)
    monkeypatch.setattr(public_room.JdLiveMonitor, '_collect', collect)
    report = asyncio.run(public_room._observe(ROOM))
    assert report['code'] == 'OFFLINE' and report['live_status'] == 'replay'
    assert report['room_id_matched'] and report['detect_ms'] == 120 and report['elapsed_ms'] == 150
    assert MARKER not in json.dumps(report)
    assert capsys.readouterr() == ('', '')


@pytest.mark.parametrize('status, expected', [(401, 'LOGIN_REQUIRED'), (403, 'ACCESS_RESTRICTED'),
                                              (429, 'ACCESS_RESTRICTED')])
def test_anonymous_http_gate_stops_and_retains_only_public_sample(status, expected):
    browser = public_room.AnonymousRoomBrowser()
    url = 'https://api.m.jd.com/api?functionId=getImmediatePlayToM&note=' + MARKER
    request = SimpleNamespace(method='GET', url=url, resource_type='xhr', post_data=None)
    response = SimpleNamespace(url=url, request=request, status=status, headers={'fake': MARKER})
    browser.record_response(response)
    assert browser.gate == expected
    assert browser.errors == [{'host': 'api.m.jd.com', 'function_id': 'getImmediatePlayToM', 'http_status': status}]
    assert MARKER not in repr(browser.errors)


@pytest.mark.parametrize('url, method, kind, expected', [
    ('https://passport.jd.com/', 'GET', 'document', 'LOGIN_REQUIRED'),
    ('https://jcap.jd.com/', 'GET', 'xhr', 'CAPTCHA_X5SEC'),
    ('https://other.example/', 'GET', 'document', 'ACCESS_RESTRICTED'),
    ('https://api.m.jd.com/api?functionId=writeAccount', 'POST', 'xhr', None),
])
def test_blocks_gate_and_unapproved_write_before_sending(url, method, kind, expected):
    class Route:
        aborted = False
        request = SimpleNamespace(url=url, method=method, resource_type=kind,
                                  headers={'content-type': 'application/x-www-form-urlencoded'},
                                  post_data='functionId=writeAccount')
        async def abort(self):
            self.aborted = True

    browser = public_room.AnonymousRoomBrowser()
    route = Route()
    asyncio.run(browser.guard(route))
    assert route.aborted and browser.gate == expected
