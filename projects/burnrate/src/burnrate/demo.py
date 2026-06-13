"""Offline demo: steady traffic → inject an incident (the multiwindow budget
burns) → generate an incident summary (LLM) → recover. No network required.

Run: python -m burnrate.demo
"""

from burnrate import incident, llm, service, tasks


def _line(label: str) -> None:
    s = service.snapshot()
    a, lt, p = s["availability"], s["latency"], s["burn_policy"]
    print(f"  {label:<22} overall={s['overall_status']:<8} "
          f"avail={a['sli']*100:6.2f}% budget_left={a['budget_remaining']*100:5.1f}% "
          f"burn={a['burn_rate']:>5}x  policy={p['action']:<6} "
          f"p95={lt['p95_ms']:>5}ms ({lt['status']})")


def main() -> None:
    print("Outreach service SLOs (availability 99.5% · latency 95% under 250ms)")
    print(f"task backend: {tasks.backend()} (TaskTiger→Redis→inline)\n")

    service.reset()
    # Drive steady traffic via the TaskTiger-shaped background batch task.
    res = tasks.process_batch.delay(n=400)
    if res.deferred:
        tasks.Worker().run(max_jobs=20, block_ms=1000)
    _line("steady (batch task)")

    print("\n-- incident: upstream starts failing 8% + adds 450ms latency --")
    service.set_fault(error_rate=0.08, latency_ms=450)
    service.loadtest(400)
    _line("during incident")

    print("\n-- on-call: compress the telemetry into an incident summary (LLM) --")
    st = llm.status()
    active = next((p for p, ok in st["providers"].items() if ok), "offline")
    print(f"   routing mode={st['mode']}  active={active}  "
          f"(chain: Anthropic/OpenAI → Ollama → OpenRouter → offline)")
    summ = incident.summarize()
    print(f"   severity={summ['severity']}  situation={summ['situation']}  "
          f"action={summ['action']}  provider={summ['provider']}  "
          f"latency={summ['latency_ms']}ms")
    print(f"   summary : {summ['summary']}")
    print("   suggested next steps (from docs/runbook.md):")
    for i, step in enumerate(summ["suggested_steps"], 1):
        print(f"     {i}. {step}")

    print("\n-- mitigation: fault cleared, fresh window (periodic rollup task) --")
    service.reset()
    tasks.process_batch.delay(n=400)
    tasks.Worker().run(max_jobs=20, block_ms=1000)
    tasks.rollup.delay()
    tasks.Worker().run(max_jobs=20, block_ms=1000)
    _line("after recovery")

    print("\nPrometheus exposition (/metrics) — burnrate_* samples:")
    for ln in registry_lines():
        print("  " + ln)


def registry_lines() -> list[str]:
    from burnrate.metrics import registry
    out = []
    for ln in registry.prometheus().decode().splitlines():
        if ln and not ln.startswith("#") and ln.startswith("burnrate_"):
            out.append(ln)
    return out[:12]


if __name__ == "__main__":
    main()
