"""The offline session accepts only dummy pairs and never exposes them in diagnostics."""

import json
import traceback

import pytest

from experiments.jd_cookie_live.fixture_session import (
    FixtureCookieError, JSON_COOKIE_FIXTURE, RAW_COOKIE_FIXTURE, load_fixture_session,
)


def test_raw_cookie_is_split_and_bound_to_its_declared_exact_origin(capsys):
    session = load_fixture_session(RAW_COOKIE_FIXTURE, origin="https://shop.m.jd.com")
    assert session.cookie_format_detected == "raw_header"
    assert session.cookie_injected_count == 2
    assert session.count_for("https://shop.m.jd.com/?shopId=721631") == 2
    assert session.count_for("http://shop.m.jd.com/") == 0
    assert session.count_for("https://item.m.jd.com/") == 0
    assert session.count_for("https://sub.shop.m.jd.com/") == 0
    assert "fixture_one" not in repr(session)
    assert "example-a" not in repr(session)
    assert capsys.readouterr() == ("", "")


def test_json_scopes_and_duplicate_cookie_replacement():
    records = json.loads(JSON_COOKIE_FIXTURE)
    records[0]["path"] = "/product"
    records.append(records[0])
    session = load_fixture_session(json.dumps(records))
    assert session.cookie_format_detected == "json_array"
    assert session.cookie_injected_count == 2
    assert session.count_for("https://item.m.jd.com/product/100.html") == 1
    assert session.count_for("https://item.m.jd.com/products") == 0
    assert session.count_for("https://shop.m.jd.com/") == 1


def test_url_form_retains_hostname_and_directory_scope():
    raw = json.dumps([{"name": "fixture_one", "value": "example-a",
                       "url": "https://item.m.jd.com/product/sample.html"}])
    session = load_fixture_session(raw)
    assert session.count_for("https://item.m.jd.com/product/another.html") == 1
    assert session.count_for("https://item.m.jd.com/") == 0


@pytest.mark.parametrize("raw", [None, "", "  "])
def test_missing_cookie_has_explicit_diagnostic(raw):
    with pytest.raises(FixtureCookieError, match="^missing_jd_cookie$"):
        load_fixture_session(raw)


@pytest.mark.parametrize("raw", [
    "private_key=NEVER_OUTPUT_THIS", "fixture_one=NEVER_OUTPUT_THIS",
    '[{"name": "NEVER_OUTPUT_THIS"}]',
    '[{"name":"fixture_one","value":"example-a","domain":".jd.com","path":"/"}]',
], ids=["unlisted-pair", "wrong-value", "malformed-record", "wider-scope"])
def test_reject_nonfixture_values_or_widened_scope_without_leaking(raw, capsys):
    with pytest.raises(FixtureCookieError, match="^invalid_cookie_fixture$") as error:
        load_fixture_session(raw)
    assert "NEVER_OUTPUT_THIS" not in "".join(traceback.format_exception(error.value))
    assert capsys.readouterr() == ("", "")
