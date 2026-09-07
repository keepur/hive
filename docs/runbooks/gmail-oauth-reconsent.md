# Runbook — Restore Muriel's Gmail access (Google OAuth re-consent)

**Owner:** Jim (VP Eng) · **Actor for Step 2:** Mike only · **Written:** 2026-09-07
**Account:** `mikewilliamscfo@gmail.com` · **OAuth client:** `727489179515-...apps.googleusercontent.com`

---

## 0. Diagnosis — verified live 2026-09-07, not from memory

Tony's diagnosis is **correct**. Re-consent is the right fix. Evidence:

| Check | Result |
|---|---|
| Live Gmail API probe | `invalid_grant: "Token has been expired or revoked."` |
| `gog auth doctor` | `status ok` — keyring healthy, 1 readable token |
| Stored token issued | `2026-08-26T18:57:08Z` (frozen; keyring file mtime Aug 26 11:57 PT — same instant) |
| Stored scopes | all 14 services, 36 scopes — **not** a scope problem |
| Keyring layout vs. Jul 6 backup | identical — **not** corruption |

`invalid_grant` is specific to the **refresh token**. A deleted or broken OAuth *client* returns
`invalid_client`, and an unverified-app expiry returns `access_denied`. We see neither. So the
client is intact and the app is fine — only the refresh token was revoked. **Re-consent will work.**

### Two things I checked because they would have broken the fix

1. **Keyring password mismatch.** `gog` encrypts the token with `$GOG_KEYRING_PASSWORD`. If Mike's
   Terminal had a different value than the service, re-consent would "succeed" and Hive still
   couldn't read the token. Compared SHA-256 across all four sources — `~/.zshrc`, `catalyst/.env`,
   `com.hive.catalyst.agent.plist`, and the live service env: **all four match.** No landmine.
2. **Scope narrowing.** `gog login`'s `--services` flag defaults to `user`, which reads like it might
   request identity-only scopes and silently drop Gmail. Dry-ran both forms and diffed:
   `--services=user` and `--services=all` produce **byte-identical 36-scope sets**. Default is safe.
   (I had this wrong before testing it — do not "fix" it by adding `--services`.)

---

## 1. Prep — MINE, already done

Nothing to write server-side. Nothing to restart. Confirmed in `src/google/google-mcp-server.ts`:
every tool shells out via `execFileSync(GOG, ...)`, a **fresh `gog` process per call**, which reads
the keyring from disk each time. The new token is live the instant `gog login` returns.

**Mike has exactly one step. There is no step for him after it.**

---

## 2. Mike's step — one command, ~90 seconds

Paste into Terminal on the Mac Mini:

```
cd ~/services/hive/catalyst && gog login mikewilliamscfo@gmail.com --force-consent
```

`--force-consent` guarantees Google returns a *new refresh token* instead of silently reusing
consent it thinks it already has. `$GOG_KEYRING_PASSWORD` is already exported by `~/.zshrc`, so no
manual export is needed in an interactive Terminal.

### What he'll see, in order

1. **A browser tab opens automatically** to `accounts.google.com`.
   *If no tab opens*, the command prints the URL — copy it into a browser manually.
2. **"Choose an account"** → pick **`mikewilliamscfo@gmail.com`**.
   If it's not listed, "Use another account" and sign in as that address. **The account must be
   exactly this one** — any other Google account produces a token for the wrong mailbox.
3. **"Google hasn't verified this app"** — expected, not an error. Our own internal client.
   Click **Advanced** → **Go to gog (unsafe)**.
4. **Consent screen** listing Gmail, Calendar, Drive, Contacts, Tasks and others → click
   **Continue** / **Allow**. **Approve everything.** Do not untick anything (see §3).
5. Browser shows a success page; **Terminal prints a success line and exits.** Done.

### If he's SSH'd in rather than sitting at the Mini

The localhost browser callback can't work. Use:

```
cd ~/services/hive/catalyst && gog login mikewilliamscfo@gmail.com --force-consent --remote
```

It prints a URL to open on any machine, then prompts to paste the redirect URL back.

---

## 3. Scopes — what breaks if one is missed

The consent screen is all-or-nothing; the risk is Mike deselecting an optional checkbox.

| Scope | Muriel feature that dies without it |
|---|---|
| **Gmail (full, not read-only)** | The 9:30 AM Superhuman archive sweep. Archiving is a *write*. Read-only consent lets her read mail but every archive fails. This is the one that matters most. |
| **Gmail read** | Hourly inbox checks, all search |
| **Calendar** | Scheduling, meeting prep, agenda pulls |
| **Contacts / People** | Attendee and sender lookups |
| Drive / Docs / Sheets / Tasks / Chat / Classroom / Ads | Not used by Muriel today; included because the stored grant already has them. Harmless. |

Partial approval fails **loudly but differently** — a `403 insufficient authentication scopes`,
not `invalid_grant`. If §4 shows that, he under-approved: re-run the same command.

---

## 4. Verification — MINE, and it's a real pass/fail

I run this the moment Mike says he's done. Not "try Muriel and see."

```
gog auth list
gog gmail labels list -a mikewilliamscfo@gmail.com -p --no-input
```

- **PASS** — `auth list` shows an issue timestamp of *today*, not `2026-08-26T18:57:08Z`, and still
  lists all 14 services; the labels call returns actual label rows (INBOX, SENT, ...).
- **FAIL** — labels call returns `invalid_grant` (token still dead) or `403 ... insufficient
  authentication scopes` (under-approved at step 4).

The timestamp moving off `2026-08-26T18:57:08Z` is the single clearest signal. Then I trigger one
live `gmail_search` through Muriel's MCP path to confirm end-to-end and report to Tony and Mike.

---

## 5. If it fails

**Most likely failure: nothing at all happens in the browser.** The OAuth callback listener is
already bound, usually by a half-finished earlier attempt. Close the tab, `Ctrl-C` the command,
re-run it. If it persists: `gog login mikewilliamscfo@gmail.com --force-consent --manual` and paste
the redirect URL back.

**Second: `aes.KeyUnwrap integrity check failed`.** Keyring password mismatch between his shell and
the stored keyring. **Stop and hand it to me** — do not delete anything in
`~/Library/Application Support/gogcli/keyring`. I have a verified-good backup at
`keyring.bak.20260709` and I'll recover from it. (I checked for this today: not currently present.)

**Third: `invalid_client` / "OAuth client was deleted".** Then my §0 diagnosis is wrong, the client
itself is gone, and re-consent cannot work — it needs a new client in Google Cloud Console. Send me
the exact error and stop; that's a different runbook.

**Do not retry more than twice.** Repeated failed consents pile up revoked grants and muddy the
diagnosis. Third failure → escalate to me with the verbatim Terminal output.

---

## 6. This will break again in ~7 days unless we also fix the cause

Re-consent restores service but is **not** a permanent fix. The pattern — Tony logs this as the 9th
occurrence — is the documented Google behavior for an OAuth consent screen in **Testing** publishing
status: refresh tokens are hard-expired after 7 days regardless of use. It fits: token issued
Aug 26, Tony's escalation records the failure on Sep 2, exactly +7 days.

**Permanent fix:** publish the consent screen for project `727489179515` to **Production**
(Cloud Console → APIs & Services → OAuth consent screen → *Publish app*). No re-verification is
needed for an internal-use app with these scopes; it stops the weekly expiry outright.

Only Mike can authorize this, and Tony has asked twice (Aug 17, Sep 2) without an answer. **While
Mike is already at the keyboard for §2 is the cheapest moment to also get this yes/no.** Ask for
both in one message or we will be running this runbook again around Sep 14.

---

## 7. Follow-ups I own (do not block §2 on these)

1. `scripts/gog-health-check.sh` — its orphaned-keyring-file check is a **false positive**. It flags
   a `_gogcli_key_v1_*` file with no sibling token file as orphaned, but that's the normal layout:
   the current keyring *and* the known-good Jul 6 backup both have key files only. As written it
   would alarm on a perfectly healthy keyring. Fix before wiring it to a schedule.
2. Same script greps only `invalid_grant|expired|revoked`, so it would **miss** a 403
   insufficient-scopes failure — precisely the failure mode a partial re-consent produces. Widen it.
3. Outage dating is inconsistent and should be reconciled before it goes to Mike: Tony's brief to me
   says "12 days, dead since Aug 26," but his own Sep 2 escalation says it went down that day. The
   token *was* valid Aug 26 → Sep 2. Actual outage looks like **~5 days (Sep 2 → Sep 7)**.
