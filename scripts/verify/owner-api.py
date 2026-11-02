#!/usr/bin/env python3
"""Owner-session request helper for verification scripts (never prints the key).

    owner-api.py <base-url> <owner-key-file> <METHOD> <path> [json-body]

Logs in with the key from the file (POST /api/auth/login, remember=false), reads the CSRF token from
GET /api/auth/session, performs the request with Origin + X-Blackbox-CSRF, prints status and body.
"""
import json, sys, urllib.request, urllib.error, http.cookiejar

base, keyfile, method, path = sys.argv[1:5]
body = sys.argv[5] if len(sys.argv) > 5 else None
key = open(keyfile).read().strip()
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(m, p, data=None, headers=None):
    h = {"content-type": "application/json", "origin": base}
    h.update(headers or {})
    r = urllib.request.Request(base + p, data=(json.dumps(data).encode() if data is not None else None), method=m, headers=h)
    try:
        with opener.open(r, timeout=300) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")

st, _ = req("POST", "/api/auth/login", {"key": key, "remember": False})
if st != 204:
    print(f"login failed: {st}", file=sys.stderr); sys.exit(2)
st, sess = req("GET", "/api/auth/session")
csrf = json.loads(sess)["csrf_token"]
st, out = req(method.upper(), path, json.loads(body) if body else None, {"x-blackbox-csrf": csrf})
print(st)
print(out)
