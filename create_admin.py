"""Create or reset an INDRA administrator from the command line.

    python create_admin.py                      # asks for email and password
    python create_admin.py you@example.com      # asks for the password
    python create_admin.py you@example.com "My-Pass-2026" --owner

The account becomes a verified Professional administrator with every feature.
If the email already exists, its password is reset and it is promoted to admin.
--owner also marks it as the protected owner account.
Works on Windows, macOS and Linux. Stop the server first or restart it afterwards (not required).
"""
import getpass
import sys
import time

from werkzeug.security import generate_password_hash

from indra import auth, config
from indra.store import db


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    owner = "--owner" in argv
    email = (args[0] if args else input("Admin email: ")).strip().lower()
    if not auth._valid_email(email):
        sys.exit("That does not look like a valid email address.")
    pw = args[1] if len(args) > 1 else getpass.getpass("New password (8+ characters, letters and numbers): ")
    if len(pw) < 8 or pw.isdigit() or pw.isalpha():
        sys.exit("Password must be at least 8 characters and mix letters with numbers or symbols.")
    auth.init()
    now = time.time()
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if u:
            con.execute("UPDATE users SET pw_hash=?, is_admin=1, tier='professional', verified=1, disabled=0, "
                        "verified_at=COALESCE(verified_at, ?), is_owner=CASE WHEN ? THEN 1 ELSE is_owner END WHERE id=?",
                        (generate_password_hash(pw), now, 1 if owner else 0, u["id"]))
            con.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
            what = "updated"
        else:
            con.execute("INSERT INTO users(email,name,pw_hash,tier,org,role,created_at,verified,verified_at,is_admin,is_owner,disabled) "
                        "VALUES(?,?,?,'professional','INDRA','Administrator',?,1,?,1,?,0)",
                        (email, "Owner" if owner else "Administrator", generate_password_hash(pw), now, now, 1 if owner else 0))
            what = "created"
    print(f"\n  Admin account {what}: {email}{' (owner)' if owner else ''}")
    print(f"  Database: {config.DB_PATH}")
    print("  Start INDRA (python app.py), choose Professional on the sign-in screen and sign in.\n")


if __name__ == "__main__":
    main(sys.argv[1:])
