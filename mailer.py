"""Outgoing email for verification and password-reset codes.

With INDRA_SMTP_HOST set, mail goes out over SMTP (STARTTLS on 587 or implicit TLS with
INDRA_SMTP_SSL=1). Without SMTP, INDRA runs in *outbox mode*: messages are stored in the
`email_outbox` table (visible to admins in the Admin console) and the code is printed in the
server log, so a self-hosted demo still works. Every message is also kept in the outbox for audit.
"""
import logging
import smtplib
import ssl
import threading
import time
from email.message import EmailMessage

from . import config
from .store import db

log = logging.getLogger("indra.mail")

SCHEMA = """
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, subject TEXT, body TEXT, purpose TEXT,
  status TEXT, error TEXT, created_at REAL);
"""


def init():
    with db() as con:
        con.executescript(SCHEMA)


def configured():
    return bool(config.SMTP_HOST)


def mode():
    return "smtp" if configured() else "outbox"


def _smtp_send(msg):
    ctx = ssl.create_default_context()
    if config.SMTP_SSL:
        s = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=20, context=ctx)
    else:
        s = smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=20)
        s.ehlo()
        try:
            s.starttls(context=ctx)
            s.ehlo()
        except smtplib.SMTPNotSupportedError:
            pass
    try:
        if config.SMTP_USER:
            s.login(config.SMTP_USER, config.SMTP_PASS)
        s.send_message(msg)
    finally:
        try:
            s.quit()
        except Exception:
            pass


def _record(to, subject, body, purpose, status, error=None):
    with db() as con:
        cur = con.execute("INSERT INTO email_outbox(to_addr,subject,body,purpose,status,error,created_at) VALUES(?,?,?,?,?,?,?)",
                          (to, subject, body, purpose, status, error, time.time()))
        con.execute("DELETE FROM email_outbox WHERE id <= (SELECT MAX(id) FROM email_outbox) - 500")
        return cur.lastrowid


def _update(mid, status, error=None):
    with db() as con:
        con.execute("UPDATE email_outbox SET status=?, error=? WHERE id=?", (status, error, mid))


def send(to, subject, body, purpose="info"):
    """Queue an email. Returns the delivery mode ('smtp' or 'outbox')."""
    if not configured():
        _record(to, subject, body, purpose, "outbox")
        log.warning("EMAIL (outbox mode, no SMTP configured) to=%s subject=%s\n%s", to, subject, body)
        return "outbox"
    mid = _record(to, subject, body, purpose, "sending")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = config.SMTP_FROM, to, subject
    msg.set_content(body)

    def run():
        try:
            _smtp_send(msg)
            _update(mid, "sent")
        except Exception as e:  # keep the error for the admin outbox
            log.error("SMTP send failed to %s: %s", to, e)
            _update(mid, "failed", str(e)[:300])

    threading.Thread(target=run, daemon=True, name="mail").start()
    return "smtp"


def outbox(limit=60):
    with db() as con:
        return [dict(r) for r in con.execute("SELECT * FROM email_outbox ORDER BY id DESC LIMIT ?", (limit,))]
