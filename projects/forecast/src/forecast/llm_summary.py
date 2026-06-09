"""Optional natural-language summary of a forecast.

Turns the numeric result into a plain-English sentence via the router (Ollama by
default). Always returns a summary: when the provider is the mock / unreachable
or the response is empty, it uses a deterministic template, so the field is
never blank and stays offline-capable.
"""

from forecast import llm

_SYSTEM = (
    "You are a forecasting analyst. In ONE or TWO plain sentences, summarize the "
    "forecast for a non-technical reader: the trend, the next values, and the "
    "method's backtest error. No preamble, no bullet points."
)


def _template(method: str, last: float, forecast: list[float],
              backtest: dict | None) -> str:
    nxt = forecast[0] if forecast else last
    trend = "rising" if nxt > last else "falling" if nxt < last else "flat"
    head = (f"The {method} model projects a {trend} trend; "
            f"next values are {', '.join(str(v) for v in forecast[:4])}"
            f"{'…' if len(forecast) > 4 else ''}.")
    if backtest:
        head += f" Backtest error (MAE) is {backtest.get('mae')}."
    return head


def summarize(method: str, series: list[float], forecast: list[float],
              backtest: dict | None, provider: str | None = "auto",
              model: str | None = None) -> tuple[str, llm.LLMResult | None]:
    last = series[-1] if series else 0.0
    fallback = _template(method, last, forecast, backtest)
    prompt = (f"METHOD: {method}\nRECENT: {series[-8:]}\nFORECAST: {forecast}\n"
              f"BACKTEST: {backtest}")
    result = llm.complete(prompt, _SYSTEM, provider, model)
    if result.provider == "mock" or not result.text.strip():
        return fallback, result
    return result.text.strip(), result
