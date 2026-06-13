"""Flask application factory: the instrumented outreach service.

A simulated outreach-send API wrapped in RED metrics (real ``prometheus_client``
exposition at ``/metrics``), SLIs/SLOs with a multiwindow burn-rate policy, an
injectable deterministic incident to burn and recover the budget, TaskTiger-shaped
background tasks on Redis, and an LLM incident-summary surface. Stateless, no
secrets, runs offline.

``create_app()`` is the factory (``flask --app burnrate:create_app run`` or the
``app`` module-level instance for gunicorn: ``burnrate.app:app``).
"""

from __future__ import annotations

from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from burnrate import __version__, incident, llm, service, slo, tasks
from burnrate.metrics import CONTENT_TYPE, registry

STATIC_DIR = Path(__file__).parent / "static"


def _num(value, default: float, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(value)))
    except (TypeError, ValueError):
        return default


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)

    # ---- dashboard -----------------------------------------------------------
    @app.get("/")
    def index() -> Response:
        return send_from_directory(STATIC_DIR, "index.html")

    # ---- health --------------------------------------------------------------
    @app.get("/healthz")
    def healthz():
        s = service.snapshot()
        return jsonify(
            status="ok", version=__version__,
            window_requests=s["window_requests"],
            slo_status=s["overall_status"],
            burn_action=s["burn_policy"]["action"],
            task_backend=tasks.backend(),
            fault_active=(service.fault.error_rate > 0
                          or service.fault.latency_ms > 0),
        )

    # ---- the instrumented "business" API -------------------------------------
    @app.post("/v1/outreach")
    def outreach():
        body = request.get_json(silent=True) or {}
        status, payload = service.send_outreach(
            body.get("channel", "email"), body.get("to", "user@example.com"),
            str(body.get("body", "hello"))[:10_000])
        return jsonify(payload), status

    @app.get("/v1/outreach")
    def outbox():
        return jsonify(sent=service.outbox())

    # ---- observability -------------------------------------------------------
    @app.get("/metrics")
    def metrics() -> Response:
        # publish the current SLO-derived gauges, then serve real exposition
        service.snapshot()
        return Response(registry.prometheus(), mimetype=CONTENT_TYPE)

    @app.get("/slo")
    def slo_status():
        return jsonify(service.snapshot())

    # ---- background tasks (TaskTiger/Redis) ----------------------------------
    @app.get("/tasks")
    def tasks_status():
        return jsonify(backend=tasks.backend(), queue_depth=tasks.queue_depth(),
                       registered=sorted(tasks._REGISTRY), periodic=tasks.PERIODIC)

    @app.post("/tasks/process_batch")
    def tasks_process_batch():
        body = request.get_json(silent=True) or {}
        n = int(_num(body.get("n", 50), 50, 1, 2000))
        res = tasks.process_batch.delay(n=n, channel=body.get("channel", "email"))
        worker = tasks.Worker()
        drained = worker.run(max_jobs=10, block_ms=500) if res.deferred else 0
        return jsonify(task=res.task, backend=res.backend, deferred=res.deferred,
                       drained=drained, result=res.result,
                       slo=service.snapshot())

    @app.post("/tasks/rollup")
    def tasks_rollup():
        res = tasks.rollup.delay()
        drained = tasks.Worker().run(max_jobs=10, block_ms=500) if res.deferred else 0
        return jsonify(task=res.task, backend=res.backend, deferred=res.deferred,
                       drained=drained, result=res.result)

    # ---- on-call: incident summary (LLM) -------------------------------------
    @app.post("/incident/summary")
    def incident_summary():
        body = request.get_json(silent=True) or {}
        return jsonify(incident.summarize(mode=body.get("mode")))

    @app.get("/evals")
    def evals():
        return jsonify(incident.evaluate())

    @app.get("/llm")
    def llm_status():
        return jsonify(llm.status())

    # ---- operator controls (the incident demo) ------------------------------
    @app.post("/admin/inject")
    def admin_inject():
        body = request.get_json(silent=True) or {}
        f = service.set_fault(_num(body.get("error_rate", 0.0), 0.0, 0.0, 1.0),
                              _num(body.get("latency_ms", 0.0), 0.0, 0.0, 10_000))
        return jsonify(fault={"error_rate": f.error_rate, "latency_ms": f.latency_ms},
                       slo=service.snapshot())

    @app.post("/admin/loadtest")
    def admin_loadtest():
        body = request.get_json(silent=True) or {}
        n = int(_num(body.get("n", 200), 200, 1, 5000))
        return jsonify(service.loadtest(n))

    @app.post("/admin/reset")
    def admin_reset():
        service.reset()
        return jsonify(reset=True, slo=service.snapshot())

    return app


# Module-level instance for gunicorn (burnrate.app:app) and `flask --app`.
app = create_app()

# Make slo importable at app scope for readers grepping the wiring.
__all__ = ["app", "create_app", "slo"]
