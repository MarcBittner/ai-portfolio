"""Configurable alerting: per-app threshold → channel, with a dispatch interface.

The model is deliberately small and extensible: an *alert rule* binds a target +
metric + comparator + threshold to a *channel*. When a rolling summary crosses a
rule's threshold, the matching channel's ``send()`` is invoked. Adding a new
channel (PagerDuty, Slack, …) is one subclass + one registry entry — the
evaluator and the rule model never change.

Channel status today:
- ``console`` — fully working now: writes the alert to the server log and the
  ``alert_events`` table, which the dashboard renders. Zero credentials.
- ``webhook`` — working when a URL is supplied (POSTs JSON); the URL is the only
  config, so it ships enabled.
- ``email`` / ``sms`` — the send path is fully coded but requires provider creds.
  Without them it degrades to the console channel and is marked NEEDS-CREDENTIAL,
  so the capability is present and testable, just not live until keys are set.

Deduping: a rule only re-fires when the breach *transitions* (ok→breach), tracked
in-process, so a sustained outage doesn't spam every poll cycle.
"""

from __future__ import annotations

import json
import logging
import os
import smtplib
import urllib.request
from email.mime.text import MIMEText

from vigil import store

log = logging.getLogger("vigil.alerts")

# In-process breach state per (rule_id, slug): True while currently breaching, so
# we only dispatch on the ok→breach edge. Resets on restart (acceptable for a
# single-instance monitor; persist to the DB if HA is ever needed).
_breaching: dict[tuple[int, str], bool] = {}


# --------------------------------------------------------------------------- #
# Channels                                                                      #
# --------------------------------------------------------------------------- #

class Channel:
    """A delivery channel. ``available`` gates whether it can deliver right now;
    ``send`` returns True on delivery. The base contract is all the evaluator
    knows, so new channels drop in without touching it."""

    name = "base"

    def available(self) -> bool:
        return True

    def send(self, addr: str | None, message: str) -> bool:  # pragma: no cover - base
        raise NotImplementedError


class ConsoleChannel(Channel):
    name = "console"

    def send(self, addr: str | None, message: str) -> bool:
        log.warning("ALERT %s", message)
        return True


class WebhookChannel(Channel):
    """POST the alert as JSON to a caller-supplied URL. The URL is the only config,
    so this is live out of the box once a rule provides one."""

    name = "webhook"

    def available(self) -> bool:
        return True

    def send(self, addr: str | None, message: str) -> bool:
        if not addr:
            return False
        try:
            data = json.dumps({"text": message}).encode()
            req = urllib.request.Request(
                addr, data=data, method="POST",
                headers={"content-type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=8)  # noqa: S310 - operator-supplied URL
            return True
        except Exception as exc:  # noqa: BLE001
            log.error("webhook delivery failed: %s", exc)
            return False


class EmailChannel(Channel):
    """SMTP email alert. NEEDS-CREDENTIAL: requires SMTP_HOST / SMTP_USER /
    SMTP_PASS (and optional SMTP_PORT, SMTP_FROM). Fully coded; when unconfigured
    ``available()`` is False and the evaluator falls back to console."""

    name = "email"

    def available(self) -> bool:
        return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_USER")
                    and os.environ.get("SMTP_PASS"))

    def send(self, addr: str | None, message: str) -> bool:
        if not addr or not self.available():
            return False
        host = os.environ["SMTP_HOST"]                      # NEEDS-CREDENTIAL
        port = int(os.environ.get("SMTP_PORT", "587"))
        user = os.environ["SMTP_USER"]                      # NEEDS-CREDENTIAL
        password = os.environ["SMTP_PASS"]                  # NEEDS-CREDENTIAL
        sender = os.environ.get("SMTP_FROM", user)
        msg = MIMEText(message)
        msg["Subject"] = "[vigil] alert"
        msg["From"] = sender
        msg["To"] = addr
        try:
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.starttls()
                s.login(user, password)
                s.sendmail(sender, [addr], msg.as_string())
            return True
        except Exception as exc:  # noqa: BLE001
            log.error("email delivery failed: %s", exc)
            return False


class SmsChannel(Channel):
    """SMS via a Twilio-shaped REST call. NEEDS-CREDENTIAL: TWILIO_ACCOUNT_SID /
    TWILIO_AUTH_TOKEN / TWILIO_FROM. Coded against Twilio's Messages API; when
    unconfigured it is unavailable and the evaluator falls back to console."""

    name = "sms"

    def available(self) -> bool:
        return bool(os.environ.get("TWILIO_ACCOUNT_SID")
                    and os.environ.get("TWILIO_AUTH_TOKEN")
                    and os.environ.get("TWILIO_FROM"))

    def send(self, addr: str | None, message: str) -> bool:
        if not addr or not self.available():
            return False
        import base64
        import urllib.parse

        sid = os.environ["TWILIO_ACCOUNT_SID"]              # NEEDS-CREDENTIAL
        token = os.environ["TWILIO_AUTH_TOKEN"]             # NEEDS-CREDENTIAL
        sender = os.environ["TWILIO_FROM"]                  # NEEDS-CREDENTIAL
        url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
        body = urllib.parse.urlencode(
            {"From": sender, "To": addr, "Body": message[:1500]}
        ).encode()
        auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
        try:
            req = urllib.request.Request(
                url, data=body, method="POST",
                headers={"Authorization": f"Basic {auth}",
                         "content-type": "application/x-www-form-urlencoded"},
            )
            urllib.request.urlopen(req, timeout=15)  # noqa: S310
            return True
        except Exception as exc:  # noqa: BLE001
            log.error("sms delivery failed: %s", exc)
            return False


_CHANNELS: dict[str, Channel] = {
    "console": ConsoleChannel(),
    "webhook": WebhookChannel(),
    "email": EmailChannel(),
    "sms": SmsChannel(),
}

CONSOLE = _CHANNELS["console"]


def channel_status() -> dict[str, bool]:
    """Which channels can deliver right now — drives the UI + NEEDS-CREDENTIAL hints."""
    return {name: ch.available() for name, ch in _CHANNELS.items()}


# --------------------------------------------------------------------------- #
# Rule evaluation                                                               #
# --------------------------------------------------------------------------- #

def _breached(rule: dict, summary: dict) -> bool:
    """Does this summary cross the rule's threshold? ``down`` is a boolean metric;
    the rest are numeric with lt/gt comparators."""
    metric = rule["metric"]
    if metric == "down":
        return summary["status"] == "down"
    value = summary.get(metric)
    if value is None:
        return False
    if rule["comparator"] == "lt":
        return value < rule["threshold"]
    return value > rule["threshold"]


def _dispatch(rule: dict, message: str) -> bool:
    """Send via the rule's channel, degrading email/sms→console when unconfigured."""
    ch = _CHANNELS.get(rule["channel"], CONSOLE)
    if not ch.available():
        log.warning("channel %s unavailable (NEEDS-CREDENTIAL); using console",
                    rule["channel"])
        delivered = CONSOLE.send(None, message)
        store.record_alert_event(rule["id"], rule["slug"], "console", message, delivered)
        return delivered
    delivered = ch.send(rule.get("target_addr"), message)
    if not delivered and rule["channel"] != "console":
        # Best-effort: a transient channel failure still leaves a console trail.
        CONSOLE.send(None, message)
    store.record_alert_event(rule["id"], rule["slug"], rule["channel"], message,
                             delivered)
    return delivered


def evaluate(slug: str, summary: dict) -> list[dict]:
    """Evaluate all enabled rules for a target against its rolling summary.

    Fires only on the ok→breach edge per rule (dedup), returning the events it
    dispatched so callers/tests can assert on them.
    """
    fired: list[dict] = []
    for rule in store.list_alert_rules(slug):
        key = (rule["id"], slug)
        now_breach = _breached(rule, summary)
        was_breach = _breaching.get(key, False)
        _breaching[key] = now_breach
        if now_breach and not was_breach:
            msg = _format(rule, summary)
            delivered = _dispatch(rule, msg)
            fired.append({"rule_id": rule["id"], "slug": slug,
                          "channel": rule["channel"], "message": msg,
                          "delivered": delivered})
    return fired


def _format(rule: dict, summary: dict) -> str:
    metric = rule["metric"]
    if metric == "down":
        return f"{rule['slug']} is DOWN (last error: {summary.get('last_error')})"
    val = summary.get(metric)
    return (f"{rule['slug']} {metric}={val} crossed "
            f"{rule['comparator']} {rule['threshold']}")
