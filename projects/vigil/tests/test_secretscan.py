"""The gitleaks-style secret scanner: planted fakes detected, clean text clean,
never raises. Fixtures build secret-shaped strings from FRAGMENTS so this test
file does not itself trip the repo's pre-commit secret scan."""

import os

from vigil import secretscan

# Build secret-shaped fixtures from fragments + obviously-fake bodies so neither
# this file nor the scanner's own source reads as a real credential.
_FAKE_AWS = "A" + "KIA" + "Z" * 16                         # AWS access key id shape
_FAKE_GH = "gh" + "p_" + "z" * 24                          # GitHub PAT shape
_FAKE_SLACK = "xox" + "b-" + "1111111111" + "abcd"          # Slack token shape
_FAKE_OPENAI = "sk-" + "z" * 24                            # OpenAI key shape
_FAKE_ANTH = "sk-" + "ant-" + "z" * 24                     # Anthropic key shape
_FAKE_RENDER = "rnd_" + "z" * 20                           # Render key shape
_FAKE_PRIV = "-----BEGIN " + "RSA PRIVATE KEY-----"        # private key header
# An opaque, mixed-class, high-entropy token BUILT AT RUNTIME (not a literal), so
# the fixture itself never sits in the file as a secret-shaped constant. Base64 of
# a digest gives genuine high entropy + mixed case + digits (clears the gate).
import base64 as _b64  # noqa: E402
import hashlib as _hl  # noqa: E402

_FAKE_RANDOM = _b64.b64encode(
    _hl.sha256(b"vigil-fixture-seed").digest()
    + _hl.sha256(b"vigil-2").digest()
).decode().replace("+", "a").replace("/", "b").replace("=", "c")[:40]


def _rules_hit(text):
    return {f["rule"] for f in secretscan.scan_text(text)}


def test_detects_aws_key():
    assert "AWS_ACCESS_KEY_ID" in _rules_hit(f'k = "{_FAKE_AWS}"')


def test_detects_github_pat():
    assert "GITHUB_PAT" in _rules_hit(f'token={_FAKE_GH}')


def test_detects_slack_token():
    assert "SLACK_TOKEN" in _rules_hit(_FAKE_SLACK)


def test_detects_provider_keys():
    assert "OPENAI_API_KEY" in _rules_hit(f'key="{_FAKE_OPENAI}"')
    assert "ANTHROPIC_API_KEY" in _rules_hit(f'key="{_FAKE_ANTH}"')
    assert "RENDER_API_KEY" in _rules_hit(f'key="{_FAKE_RENDER}"')


def test_detects_private_key_header():
    assert "PRIVATE_KEY" in _rules_hit(_FAKE_PRIV)


def test_detects_generic_assignment():
    assert "GENERIC_SECRET_ASSIGNMENT" in _rules_hit('api_key = "' + "a1B2" * 8 + '"')


def test_detects_high_entropy_token():
    assert "HIGH_ENTROPY_TOKEN" in _rules_hit(f'tok = "{_FAKE_RANDOM}"')


def test_clean_text_has_no_findings():
    src = ("def compute_rolling_availability(samples):\n"
           "    return sum(samples) / max(1, len(samples))\n"
           "# vigil_last_poll_duration_seconds gauge updated each cycle\n")
    assert secretscan.scan_text(src) == []


def test_wordish_identifiers_are_not_flagged():
    # snake/kebab identifiers have high char-variety but must NOT trip the catch-all
    assert _rules_hit("vigil_last_poll_duration_seconds") == set()
    assert _rules_hit("test_clean_endpoint_has_no_findings") == set()


def test_allowlisted_placeholders_ignored():
    assert _rules_hit("AKIAIOSFODNN7EXAMPLE") == set()
    assert _rules_hit('key = "sk-your-key-here"') == set()


def test_never_raises_on_garbage():
    for bad in (None, 123, "", "\x00\x01\x02", "𝕊𝕖𝕔𝕣𝕖𝕥"):
        assert isinstance(secretscan.scan_text(bad), list)


def test_scan_paths_attributes_source_and_line(tmp_path):
    f = tmp_path / "config.py"
    f.write_text(f'SETTING = 1\nLEAK = "{_FAKE_AWS}"\n')
    (tmp_path / "clean.py").write_text("x = 1\n")
    out = secretscan.scan_paths(tmp_path)
    aws = [f for f in out if f["rule"] == "AWS_ACCESS_KEY_ID"]
    assert aws and aws[0]["source"] == "config.py" and aws[0]["line"] == 2


def test_scan_paths_missing_root_is_empty():
    assert secretscan.scan_paths("/no/such/path/here") == []


def test_vigil_own_tree_is_clean():
    """vigil's own source must not trip its own scanner (false positives would
    make the self-target perpetually 'leaking')."""
    root = os.path.join(os.path.dirname(__file__), "..")
    out = secretscan.scan_paths(root)
    assert out == [], f"vigil flagged itself: {out}"


def test_redaction_never_leaks_full_secret():
    findings = secretscan.scan_text(f'k = "{_FAKE_AWS}"')
    for f in findings:
        assert _FAKE_AWS not in f["match"]  # the raw value is never echoed in full
