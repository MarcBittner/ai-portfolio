"""Offline demo: drive healthy traffic, inject an incident that burns the error
budget, then recover — printing the SLO snapshot at each step.

Run: python -m slo_kit.demo   (no network required)
"""

from slo_kit import incident, llm, service
from slo_kit.metrics import registry
from slo_kit.slo import compute


def _line(label: str) -> None:
    s = compute(registry.snapshot())
    a, lt = s["availability"], s["latency"]
    print(f"  {label:<22} overall={s['overall_status']:<8} "
          f"avail={a['sli']*100:6.2f}% budget_left={a['budget_remaining']*100:5.1f}% "
          f"burn={a['burn_rate']:>4}x  p95={lt['p95_ms']:>5} ms ({lt['status']})")


def main() -> None:
    print("Outreach-API SLOs (availability 99.5% · latency 95% under 250ms):\n")
    service.reset()
    service.loadtest(400)
    _line("steady traffic")

    print("\n-- incident: upstream starts failing 6% + adds 450ms latency --")
    service.set_fault(error_rate=0.06, latency_ms=450)
    service.loadtest(400)
    _line("during incident")

    print("\n-- on-call: compress the telemetry into an incident summary (LLM) --")
    s = llm.status()
    active = next((p for p, ok in s["providers"].items() if ok), "offline")
    print(f"   routing mode={s['mode']}  active={active}  "
          f"(chain: Anthropic/OpenAI → Ollama → OpenRouter → offline)")
    summ = incident.summarize()
    print(f"   severity={summ['severity']}  situation={summ['situation']}  "
          f"provider={summ['provider']}  latency={summ['latency_ms']}ms")
    print(f"   summary : {summ['summary']}")
    print("   suggested next steps (from docs/runbook.md):")
    for i, step in enumerate(summ["suggested_steps"], 1):
        print(f"     {i}. {step}")

    print("\n-- mitigation: fault cleared, fresh window --")
    service.reset()
    service.loadtest(400)
    _line("after recovery")

    print("\nPrometheus exposition (/metrics):")
    for ln in registry.prometheus().splitlines():
        if ln and not ln.startswith("#"):
            print("  " + ln)


if __name__ == "__main__":
    main()
