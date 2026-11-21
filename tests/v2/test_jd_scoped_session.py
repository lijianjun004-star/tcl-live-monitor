"""Offline checks for the live experiment, using deliberately invented inputs."""

import json
import traceback

import pytest

from experiments.jd_cookie_live import scoped_session as scope


ITEM = "https://item.m.jd.com/product/100133134399.html"
SHOP_A = "https://shop.m.jd.com/?shopId=721631"
SHOP_B = "https://shop.m.jd.com/?shopId=1000194977"
NAME = "synthetic_private_field"
VALUE = "synthetic_private_material"
PAIR = f"{NAME}={VALUE}"


def row(**updates):
    return {"name": NAME, "value": VALUE, "domain": "item.m.jd.com", "path": "/", **updates}


def rejected(raw, code="invalid_jd_cookie", **kwargs):
    with pytest.raises(scope.CookieConfigError) as error:
        scope.load_session(raw, **kwargs)
    assert str(error.value) == error.value.code == code
    assert error.value.__context__ is None
    diagnostic = repr(error.value) + "".join(traceback.format_exception(error.value))
    assert all(s not in diagnostic for s in (NAME, VALUE))


def test_raw_header_binds_to_one_origin_and_preserves_wire_order(capsys):
    wire = f"{PAIR}==; another=value; {PAIR}"
    session = scope.load_session("Cookie: " + wire + ";")
    assert session.cookie_format_detected == "raw_header"
    assert session.cookie_injected_count == 3
    assert session.header_for(ITEM) == wire
    assert session.header_for(SHOP_A) is None
    assert session.header_for(SHOP_B) is None
    assert all(s not in repr(session) for s in (NAME, VALUE))
    assert capsys.readouterr() == ("", "")


def test_shop_origin_and_scope_selector():
    session = scope.load_session(PAIR, raw_origin="shop.m.jd.com")
    assert session.header_for(ITEM) is None
    assert session.header_for(SHOP_A) == session.header_for(SHOP_B) == PAIR
    for origin in (".jd.com", "https://item.m.jd.com", "api.m.jd.com", "item.m.jd.com:443"):
        rejected(PAIR, raw_origin=origin)


def test_json_browser_scopes_replacement_and_path_order(capsys):
    records = [row(domain=".JD.COM", name="shared", secure=True, sameSite="Lax", httpOnly=True),
               row(path="/product", value="old"), row(path="/product", value="new"),
               row(domain="m.jd.com"), row(domain=".com"), row(domain="example.org"),
               row(path="/prod"), row(domain=".shop.m.jd.com", name="store")]
    session = scope.load_session(json.dumps(records, indent=2))
    assert session.cookie_format_detected == "json_array"
    assert session.cookie_injected_count == 3
    assert session.header_for(ITEM) == f"{NAME}=new; shared={VALUE}"
    assert session.header_for(SHOP_A) == session.header_for(SHOP_B) == f"shared={VALUE}; store={VALUE}"
    assert all(s not in repr(session) for s in (NAME, VALUE))
    assert capsys.readouterr() == ("", "")


def test_expiry_checked_when_loading_and_at_each_request(monkeypatch):
    monkeypatch.setattr(scope.time, "time", lambda: 100)
    session = scope.load_session(json.dumps([row(expires=102), row(name="gone"), row(name="gone", expires=99),
                                             row(name="always", expires=-1)]))
    assert session.cookie_injected_count == 2
    assert session.header_for(ITEM) == f"{PAIR}; always={VALUE}"
    monkeypatch.setattr(scope.time, "time", lambda: 102)
    assert session.header_for(ITEM) == f"always={VALUE}"


def test_url_form_preserves_host_and_directory_scope():
    record = {"name": NAME, "value": VALUE, "url": "https://item.m.jd.com/product/another.html"}
    session = scope.load_session(json.dumps([record]))
    assert session.header_for(ITEM) == PAIR
    assert session.header_for(SHOP_A) is None
    for url in (SHOP_A, "https://shop.m.jd.com"):
        session = scope.load_session(json.dumps([{**record, "url": url}]))
        assert session.header_for(SHOP_A) == session.header_for(SHOP_B) == PAIR
        assert session.header_for(ITEM) is None


def test_exact_destination_check_precedes_any_url_normalization():
    session = scope.load_session(json.dumps([row(domain=".jd.com", secure=True)]))
    for destination in (ITEM.replace("https:", "http:"), ITEM.replace("item.", "name@item."),
                        ITEM.replace(".com/", ".com:443/"), ITEM.replace(".com/", ".com.other/"),
                        ITEM.replace("item.", "sub.item."), ITEM + "?next=elsewhere", ITEM + "#",
                        ITEM + "\n", " " + ITEM, ITEM.replace("/product/", "/tmp/../product/"),
                        SHOP_A + "&shopId=0", SHOP_A + "&x=1", SHOP_A.replace("shopId", "shop%49d"),
                        "https://api.m.jd.com/", "https://lives.jd.com/", "", None):
        assert session.header_for(destination) is None


def test_missing_inputs():
    for raw in (None, "", " \r\n\t"):
        rejected(raw, "missing_jd_cookie")


def test_invalid_inputs_do_not_enter_diagnostics(capsys):
    invalid = ["bad name=" + VALUE, PAIR + "\r\nOther: ignored", PAIR + "\n", PAIR + "\x00",
               "Set-Cookie: " + PAIR, PAIR + ";no_separator", "[" + NAME, "[]", "{}", 1,
               "x=" + "x" * 49_152, ";".join([PAIR] * 513), json.dumps([row()] * 513),
               json.dumps([row(expires=True)]), json.dumps([row(expires=float("nan"))]),
               json.dumps([row(value=VALUE + ";other=v")]), json.dumps([row(secure="false")]),
               json.dumps([row(expires=-2)]), json.dumps([row(sameSite="wrong")]),
               json.dumps([row(hostOnly=True)]), json.dumps([row(name="__Host-example", domain=".jd.com", secure=True)]),
               json.dumps([row(name="__Secure-example", secure=False)]), '[{"name":"' + NAME + '","name":"x"}]']
    for raw in invalid:
        rejected(raw)
    assert capsys.readouterr() == ("", "")


def test_invalid_creation_url_cannot_widen_scope():
    record = {"name": NAME, "value": VALUE}
    for url in (ITEM.replace("https:", "http:"), "https://account.invalid/", "https://item.m.jd.com:443/",
                "https://user@item.m.jd.com/", "https://item.m.jd.com/else/../file", ITEM + "?next=x",
                ITEM + "#fragment", ITEM.replace("/product/", "/%2e/"), "\t" + ITEM):
        rejected(json.dumps([{**record, "url": url}]))
    for extra in ({"domain": "item.m.jd.com"}, {"path": "/"}):
        rejected(json.dumps([{**record, "url": ITEM, **extra}]))


def test_well_formed_but_inapplicable_records_are_reported_without_identity():
    for record in (row(domain=".com"), row(path="/products"), row(expires=0),
                   row(domain="jd.com"), row(partitionKey="https://other.test")):
        rejected(json.dumps([record]), "no_scoped_jd_cookie")
