"""FastAPI service: the vigil observability + SOC monitoring console.

Wires every surface: the background poller's lifecycle, the tiered dashboard
(guest / registered / elevated / admin), email-password + OAuth auth, the
monitored-app registry (admin-extensible), the security/compliance posture engine,
configurable alerting, and the LLM incident summarizer. The static SPA at ``/``
renders all of it.

Tiering is enforced server-side by ``require_role`` dependencies, not by the UI —
a guest hitting a registered/elevated endpoint gets 401/403 regardless of what the
client renders. ``/health`` is public and secret-free (vigil probes it like any
other app).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from vigil import (
    __version__,
    alerts,
    auth,
    config,
    incident,
    llm,
    metrics,
    security,
    store,
)
from vigil.config import Target
from vigil.models import (
    AlertRuleRequest,
    HealthResponse,
    IncidentRequest,
    LoginRequest,
    RoleRequest,
    SignupRequest,
    TargetRequest,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("vigil")

STATIC_DIR = Path(__file__).parent / "static"
SESSION_COOKIE = "vigil_session"

_poller_stop = asyncio.Event()
_poller_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Init the DB + registry and launch the background poller; tear it down on
    shutdown. The poller probes the whole fleet (vigil included) on a loop.

    Set ``VIGIL_DISABLE_POLLER=1`` to skip the loop — used by the in-process test
    suite (which drives probes explicitly) so repeated TestClient lifespans don't
    leave a probe task bound to a torn-down event loop."""
    store.init_db()
    # Seed admin from VIGIL_ADMIN_PASSWORD (survives the ephemeral /tmp DB wipes).
    auth.ensure_bootstrap_admin()
    global _poller_task
    _poller_stop.clear()
    if os.environ.get("VIGIL_DISABLE_POLLER") == "1":
        log.info("vigil up: %d targets, poller disabled", len(store.list_targets()))
        yield
        return
    from vigil import probe
    _poller_task = asyncio.create_task(probe.poller_loop(_poller_stop))
    log.info("vigil up: %d targets, poller every %ss",
             len(store.list_targets()), config.POLL_INTERVAL_S)
    try:
        yield
    finally:
        _poller_stop.set()
        if _poller_task:
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(_poller_task, timeout=5)


app = FastAPI(
    title="vigil",
    version=__version__,
    description="Public observability + SOC monitoring for the ai-portfolio fleet.",
    lifespan=lifespan,
)

# --- OAuth registry (authlib) — providers register only when creds exist -------
try:
    from authlib.integrations.starlette_client import OAuth
    from starlette.middleware.sessions import SessionMiddleware

    app.add_middleware(SessionMiddleware, secret_key=config.SECRET_KEY)
    _oauth = OAuth()
    _registered_oauth = auth.register_oauth(_oauth)
except Exception as exc:  # noqa: BLE001 — OAuth is optional; app must still boot
    log.warning("OAuth not initialized: %s", exc)
    _oauth = None
    _registered_oauth = []

# --------------------------------------------------------------------------- #
# Auth dependencies                                                             #
# --------------------------------------------------------------------------- #

def current_user(request: Request) -> dict | None:
    return auth.read_session(request.cookies.get(SESSION_COOKIE))


def require_role(minimum: str):
    """Dependency factory: 401 if anonymous, 403 if under the required role."""
    def _dep(request: Request) -> dict:
        user = current_user(request)
        if not user:
            raise HTTPException(401, "authentication required")
        if not auth.role_at_least(user["role"], minimum):
            raise HTTPException(403, f"requires role >= {minimum}")
        return user
    return _dep


def _set_session(resp: Response, user: dict) -> None:
    resp.set_cookie(
        SESSION_COOKIE, auth.issue_session(user), httponly=True, samesite="lax",
        max_age=auth.SESSION_MAX_AGE, secure=config.SELF_BASE_URL.startswith("https"),
    )


# --------------------------------------------------------------------------- #
# Health + meta                                                                 #
# --------------------------------------------------------------------------- #

@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok", version=__version__, targets=len(store.list_targets()),
        poller_running=bool(_poller_task and not _poller_task.done()),
    )


@app.get("/llm")
def llm_status() -> dict:
    return llm.status()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# --------------------------------------------------------------------------- #
# Auth endpoints                                                                #
# --------------------------------------------------------------------------- #

@app.post("/auth/signup")
def signup(req: SignupRequest, request: Request, response: Response) -> dict:
    ip = request.client.host if request.client else "unknown"
    if not auth.signup_limiter.allow(ip):
        raise HTTPException(429, "signup rate limit exceeded; try again shortly")
    user, info = auth.register(req.email, req.password)
    if user is None:
        raise HTTPException(409, info.get("error", "could not register"))
    # Bootstrap admin (pre-verified) gets an immediate session; others verify first.
    out = {"email": user["email"], "role": user["role"],
           "verified": bool(user["verified"]), "verification": info}
    if user["verified"]:
        _set_session(response, user)
    return out


@app.get("/auth/verify")
def verify(token: str) -> RedirectResponse:
    user = store.verify_user_by_token(token)
    if not user:
        return RedirectResponse("/?verified=invalid", status_code=303)
    resp = RedirectResponse("/?verified=ok", status_code=303)
    _set_session(resp, user)
    return resp


@app.post("/auth/login")
def login(req: LoginRequest, response: Response) -> dict:
    user = auth.authenticate(req.email, req.password)
    if not user:
        raise HTTPException(401, "invalid credentials")
    if not user["verified"]:
        raise HTTPException(403, "email not verified — check the verification link")
    _set_session(response, user)
    return {"email": user["email"], "role": user["role"]}


@app.post("/auth/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@app.get("/auth/me")
def me(request: Request) -> dict:
    user = current_user(request)
    if not user:
        return {"role": "guest", "authenticated": False,
                "oauth_providers": auth.enabled_oauth_providers()}
    return {"email": user["email"], "role": user["role"], "authenticated": True,
            "verified": bool(user["verified"]),
            "oauth_providers": auth.enabled_oauth_providers()}


# ---- Social OAuth (authlib) — NEEDS-CREDENTIAL (client id/secret) -------------

@app.get("/auth/oauth/{provider}/login")
async def oauth_login(provider: str, request: Request):
    if not _oauth or provider not in _registered_oauth:
        raise HTTPException(404, f"{provider} OAuth not configured (NEEDS-CREDENTIAL)")
    client = _oauth.create_client(provider)
    redirect_uri = f"{config.SELF_BASE_URL}/auth/oauth/{provider}/callback"
    return await client.authorize_redirect(request, redirect_uri)


@app.get("/auth/oauth/{provider}/callback")
async def oauth_callback(provider: str, request: Request):
    if not _oauth or provider not in _registered_oauth:
        raise HTTPException(404, f"{provider} OAuth not configured")
    client = _oauth.create_client(provider)
    token = await client.authorize_access_token(request)
    email = None
    if provider == "google":
        email = (token.get("userinfo") or {}).get("email")
    elif provider == "github":
        resp = await client.get("user/emails", token=token)
        emails = resp.json() if resp.status_code == 200 else []
        email = next((e["email"] for e in emails if e.get("primary")), None) \
            or (await client.get("user", token=token)).json().get("email")
    if not email:
        raise HTTPException(400, "could not obtain a verified email from provider")
    user = auth.upsert_oauth_user(email, provider)
    resp = RedirectResponse("/?oauth=ok", status_code=303)
    _set_session(resp, user)
    return resp


# --------------------------------------------------------------------------- #
# Dashboard tiers                                                               #
# --------------------------------------------------------------------------- #

@app.get("/api/status")
def guest_status() -> dict:
    """GUEST tier (public): current status + error rate per app only."""
    return {"apps": metrics.guest_view(), "rollup": metrics.fleet_rollup()}


@app.get("/api/dashboard")
def registered_dashboard(_user=Depends(require_role("registered"))) -> dict:
    """REGISTERED tier: full rolling summary (availability, latency, status)."""
    rows = metrics.fleet_summary()
    return {"apps": rows, "rollup": metrics.fleet_rollup(rows)}


@app.get("/api/app/{slug}")
def app_detail(slug: str, _user=Depends(require_role("registered"))) -> dict:
    """REGISTERED tier: per-app history, response-time series, recent logs."""
    t = store.get_target(slug)
    if not t:
        raise HTTPException(404, "unknown target")
    probes = store.recent_probes(slug, 200)
    return {"target": t.to_dict(), "summary": metrics.summarize(slug),
            "history": probes,
            "response_series": [{"ts": p["ts"], "ms": p["response_ms"],
                                 "up": bool(p["up"])} for p in reversed(probes)]}


@app.get("/api/security")
def fleet_security(_user=Depends(require_role("elevated"))) -> dict:
    """ELEVATED tier: per-app posture + control-mapping across six frameworks."""
    reports = []
    for t in store.list_targets():
        try:
            reports.append(security.scan_target(t.slug, include_repo=False))
        except Exception as exc:  # noqa: BLE001
            log.warning("security scan failed for %s: %s", t.slug, exc)
    reports.sort(key=lambda r: r["posture"]["score"])
    return {"catalog": security.catalog(), "reports": reports}


@app.get("/api/security/{slug}")
def app_security(slug: str, _user=Depends(require_role("elevated"))) -> dict:
    """ELEVATED tier: full posture (live findings + repo-scan stub) for one app."""
    try:
        return security.scan_target(slug, include_repo=True)
    except KeyError:
        raise HTTPException(404, "unknown target") from None


@app.post("/api/incident/summary")
def incident_summary(req: IncidentRequest | None = None,
                     _user=Depends(require_role("registered"))) -> dict:
    """REGISTERED tier: LLM fleet-health narrative + prioritized actions. Code
    decides severity/priority; the model narrates; deterministic offline fallback."""
    req = req or IncidentRequest()
    return incident.summarize(mode=req.mode, client_summary=req.client_summary)


@app.get("/api/incident/state")
def incident_state(_user=Depends(require_role("registered"))) -> dict:
    """The exact inputs the summarizer feeds the model (for the browser→host
    Ollama bridge to build the same prompt client-side)."""
    state = incident.collect_state()
    return {"state": state, "classify": incident.classify(state)}


@app.get("/api/evals")
def evals() -> dict:
    """Score the deterministic incident classifier (public; no secrets)."""
    return incident.evaluate()


# --------------------------------------------------------------------------- #
# Alerting (registered can view; elevated+ can configure)                       #
# --------------------------------------------------------------------------- #

@app.get("/api/alerts")
def list_alerts(_user=Depends(require_role("registered"))) -> dict:
    return {"rules": store.list_alert_rules(), "events": store.recent_alert_events(),
            "channels": alerts.channel_status()}


@app.post("/api/alerts")
def create_alert(req: AlertRuleRequest, _user=Depends(require_role("elevated"))) -> dict:
    if not store.get_target(req.slug):
        raise HTTPException(404, "unknown target")
    return store.add_alert_rule(req.slug, req.metric, req.comparator, req.threshold,
                                req.channel, req.target_addr)


# --------------------------------------------------------------------------- #
# Admin: registry + roles                                                       #
# --------------------------------------------------------------------------- #

@app.get("/api/targets")
def list_targets_api(_user=Depends(require_role("registered"))) -> dict:
    return {"targets": [t.to_dict() for t in store.list_targets()]}


@app.post("/api/admin/targets")
def add_target_api(req: TargetRequest, _user=Depends(require_role("admin"))) -> dict:
    store.add_target(Target(slug=req.slug, name=req.name, url=req.url,
                            health_path=req.health_path, repo=req.repo, tags=req.tags))
    return {"ok": True, "target": store.get_target(req.slug).to_dict()}


@app.delete("/api/admin/targets/{slug}")
def delete_target_api(slug: str, _user=Depends(require_role("admin"))) -> dict:
    if slug == "vigil":
        raise HTTPException(400, "cannot remove the self-monitor entry")
    return {"removed": store.remove_target(slug)}


@app.get("/api/admin/users")
def list_users_api(_user=Depends(require_role("admin"))) -> dict:
    return {"users": store.list_users()}


@app.post("/api/admin/role")
def set_role_api(req: RoleRequest, _user=Depends(require_role("admin"))) -> dict:
    if req.role not in ("registered", "elevated", "admin"):
        raise HTTPException(422, "invalid role")
    user = store.set_user_role(req.email, req.role)
    if not user:
        raise HTTPException(404, "unknown user")
    return {"email": user["email"], "role": user["role"]}


@app.post("/api/admin/probe-now")
async def probe_now(_user=Depends(require_role("admin"))) -> dict:
    """Force an immediate probe cycle (handy for the demo + smoke warm-up)."""
    from vigil import probe
    results = await probe.probe_all()
    return {"probed": len(results), "results": results}


# A tiny CSRF-ish token endpoint kept for completeness of the auth surface.
@app.get("/api/csrf")
def csrf() -> JSONResponse:
    return JSONResponse({"token": secrets.token_urlsafe(16)})
