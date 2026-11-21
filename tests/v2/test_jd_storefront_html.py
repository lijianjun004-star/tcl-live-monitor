"""Simulated storefront responses only. The global offline fixture blocks real sockets."""

from email.message import Message
import json
from unittest.mock import Mock
from urllib.parse import urlsplit

import pytest

from experiments.jd_cookie_live import storefront
from experiments.jd_cookie_live.fixtures import FLAGSHIP, LIGHTING, SKU
from experiments.jd_cookie_live.run import ENTRIES


ROOM = "87654321"
LINK = f'<a href="https://lives.jd.com/#/{ROOM}"><span>看直播</span></a>'
SECRET_FIELD = "private-test-field"
SECRET_VALUE = "private-test-value"
HEADER = f"{SECRET_FIELD}={SECRET_VALUE}; second-fixture=second-value"
SHOP = "<main><h1>TCL官方旗舰店</h1><p>全部商品</p></main>"
ITEM = "<main><h1>TCL空调</h1><p>规格参数</p></main>"
LIGHTS = "<main><h1>TCL灯饰照明京东自营旗舰店</h1><p>商品分类</p></main>"


def reply(body="", status=200, headers=None):
    fields = Message()
    for name, value in (headers or {"Content-Type": "text/html; charset=utf-8"}).items():
        fields[name] = value
    raw = body.encode() if isinstance(body, str) else body
    response = Mock(status=status, headers=fields, getheader=fields.get)
    response.read.side_effect = lambda size: raw[:size]
    return response


@pytest.fixture
def connections(monkeypatch):
    def install(*responses):
        objects = []
        for response in responses:
            connection = Mock()
            connection.getresponse.return_value = response
            objects.append(connection)
        factory = Mock(side_effect=objects)
        monkeypatch.setattr(storefront.http.client, "HTTPSConnection", factory)
        return factory, objects
    return install


def scoped(header=HEADER):
    session = Mock()
    session.header_for.return_value = header
    return session


@pytest.mark.parametrize("entry_id,body", [(SKU, ITEM), (FLAGSHIP, SHOP), (LIGHTING, LIGHTS)])
def test_read_guest_first_then_only_same_exact_document_with_cookie(connections, entry_id, body):
    url = next(url for ident, _, url in ENTRIES if ident == entry_id)
    parts = urlsplit(url)
    target = parts.path + ("?" + parts.query if parts.query else "")
    factory, objects = connections(reply(body), reply(body + LINK + '<script src="https://never.invalid/a.js"></script>'))
    session = scoped()
    result = storefront.observe_entry(entry_id, session)
    assert [call.args for call in factory.call_args_list] == [(parts.hostname,), (parts.hostname,)]
    for conn in objects:
        assert conn.request.call_args.args == ("GET", target)
        conn.close.assert_called_once()
        conn.set_debuglevel.assert_called_once_with(0)
    assert "Cookie" not in objects[0].request.call_args.kwargs["headers"]
    assert objects[1].request.call_args.kwargs["headers"]["Cookie"] == HEADER
    session.header_for.assert_called_once_with(url)
    assert result["scope_available"] is True and result["authenticated_request_sent"] is True
    assert result["cookie_injected_count"] == 2 and result["candidate_live_ids"] == [ROOM]
    assert result["html_only"] and result["page_observed"] and result["gate"] is None
    assert result["observed_function_ids"] == []


@pytest.mark.parametrize("response,gate", [
    (reply(status=302, headers={"Location": "https://plogin.m.jd.com/login/"}), "LOGIN_REQUIRED"),
    (reply(status=307, headers={"Location": "//safe.jd.com/page"}), "CAPTCHA_X5SEC"),
    (reply(status=302, headers={"Location": f"/?shopId={LIGHTING}"}), "ACCESS_RESTRICTED"),
    (reply(status=301, headers={"Location": "https://unrelated.invalid/"}), "ACCESS_RESTRICTED"),
    (reply(status=304), "ACCESS_RESTRICTED"),
    (reply(SHOP, headers={"Refresh": "0; URL=https://unknown.invalid/page"}), "ACCESS_RESTRICTED"),
    (reply(SHOP + '<meta http-equiv="refresh" content="0; url=https://jcap.m.jd.com/"/>'), "CAPTCHA_X5SEC"),
    (reply(SHOP + '<iframe src="//passport.jd.com/"/>'), "LOGIN_REQUIRED"),
    (reply(SHOP + '<iframe src="/verify/index"/>'), "CAPTCHA_X5SEC"),
    (reply(SHOP + '<iframe title="安全验证" src="/"/>'), "CAPTCHA_X5SEC"),
    (reply(SHOP + '<div>请先登录后查看</div>'), "LOGIN_REQUIRED"),
    (reply(SHOP + '<p>拖动滑块</p>'), "CAPTCHA_X5SEC"),
    (reply(SHOP + '<p>Access denied</p>'), "ACCESS_RESTRICTED"),
    (reply(SHOP + '<form><input type="password"/></form>'), "LOGIN_REQUIRED"),
    (reply(status=401), "ACCESS_RESTRICTED"),
    (reply(status=403), "ACCESS_RESTRICTED"),
    (reply(status=429), "ACCESS_RESTRICTED"),
    (reply(status=451), "ACCESS_RESTRICTED"),
])
def test_denial_and_navigation_are_terminal_even_with_usable_later_html(connections, response, gate):
    factory, _ = connections(response, reply(SHOP + LINK))
    session = scoped()
    result = storefront.observe_entry(FLAGSHIP, session)
    assert result["gate"] == gate
    assert result["candidate_live_ids"] == [] and not result["page_observed"]
    assert result["scope_available"] is None and result["cookie_injected_count"] == 0
    assert not result["authenticated_request_sent"] and factory.call_count == 1
    session.header_for.assert_not_called()


@pytest.mark.parametrize("response", [
    reply(""), reply("<script>document.body.innerText='TCL官方旗舰店全部商品'</script>"),
    reply("<title>TCL官方旗舰店全部商品</title><div>Loading...</div>"),
    reply("<h1>TCL官方旗舰店</h1><script src='/bundle.js'></script>"),
    reply(SHOP + "<div>正在加载</div>"), reply('<div hidden>' + SHOP + '</div>'),
    reply('<div aria-hidden="true">' + SHOP + '</div>'),
    reply('<div style="display: none">' + SHOP + '</div>'), reply('<noscript>' + SHOP + '</noscript>'),
    reply(SHOP + '<iframe src="/unread-document"/>'), reply(ITEM),
    reply(SHOP, headers={"Content-Type": "application/json"}),
    reply(SHOP, headers={"Content-Type": "text/html", "Content-Encoding": "gzip"}),
    reply(b"\xff"), reply(SHOP + ("x" * storefront._MAX_HTML)),
    reply(SHOP, status=206), reply(SHOP, status=503),
])
def test_uncertain_guest_page_never_receives_credentials(connections, response):
    factory, _ = connections(response)
    session = scoped()
    result = storefront.observe_entry(FLAGSHIP, session)
    assert result["scope_available"] is None and result["gate"] is None
    assert not result["page_observed"] and not result["authenticated_request_sent"]
    assert result["cookie_injected_count"] == 0 and factory.call_count == 1
    session.header_for.assert_not_called()


def test_credential_outside_scope_leaves_only_guest_sample(connections):
    factory, _ = connections(reply(SHOP))
    result = storefront.observe_entry(FLAGSHIP, scoped(None))
    assert factory.call_count == 1 and result["page_observed"]
    assert result["scope_available"] is False and result["cookie_injected_count"] == 0
    assert not result["authenticated_request_sent"]


@pytest.mark.parametrize("response,gate", [
    (reply('<div id="app"></div>'), None),
    (reply(status=302, headers={"Location": "https://else.invalid/"}), "ACCESS_RESTRICTED"),
    (reply(SHOP + '<iframe src="https://jcap.jd.com/"/>'), "CAPTCHA_X5SEC"),
])
def test_second_response_controls_observation_and_never_follows(connections, response, gate):
    factory, _ = connections(reply(SHOP + LINK), response)
    result = storefront.observe_entry(FLAGSHIP, scoped())
    assert factory.call_count == 2 and result["authenticated_request_sent"]
    assert result["gate"] == gate and result["cookie_injected_count"] == 2
    assert not result["page_observed"] and result["candidate_live_ids"] == []


def test_only_visible_natural_room_links_and_no_echoed_secret(connections, capsys):
    private_room = "87654329"
    html = SHOP + LINK + f"""
    <p>{SECRET_FIELD} {SECRET_VALUE}</p>
    <a hidden href="https://lives.jd.com/#/88888888">隐藏</a>
    <script>const url="https://lives.jd.com/#/77777777"</script>
    <a href="https://lives.jd.com/#/66666666"></a>
    <a href="https://lives.jd.com/#/{private_room}">看直播</a>
    <a href="https://api.m.jd.com/api?functionId={SECRET_VALUE}">接口</a>
    """
    connections(reply(SHOP), reply(html, headers={"Content-Type": "text/html", "Set-Cookie": HEADER}))
    result = storefront.observe_entry(FLAGSHIP, scoped(HEADER + "; numeric-fixture=" + private_room))
    assert result["candidate_live_ids"] == [ROOM] and result["cookie_injected_count"] == 3
    output = json.dumps(result) + "".join(capsys.readouterr())
    assert not any(value in output for value in (SECRET_FIELD, SECRET_VALUE, private_room, "numeric-fixture"))


def test_transport_failure_drops_message_and_does_not_retry(connections):
    factory, objects = connections(reply(SHOP), reply(SHOP))
    objects[1].getresponse.side_effect = OSError(HEADER)
    with pytest.raises(storefront.StorefrontError) as caught:
        storefront.observe_entry(FLAGSHIP, scoped())
    assert str(caught.value) == "STOREFRONT_READ_FAILED" and factory.call_count == 2
    objects[1].close.assert_called_once()


def test_unknown_entry_cannot_open_connection_or_reflect_input(connections):
    factory, _ = connections()
    with pytest.raises(storefront.StorefrontError) as caught:
        storefront.observe_entry("https://else.invalid/" + SECRET_VALUE, scoped())
    assert str(caught.value) == "UNKNOWN_STOREFRONT_ENTRY"
    factory.assert_not_called()
