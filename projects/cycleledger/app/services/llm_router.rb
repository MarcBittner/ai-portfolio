# LlmRouter — the portfolio's standard multi-provider routing layer, in Ruby.
#
# Same shape as field-vault's llm.py and the rest of the portfolio: a single
# reviewable chain that self-selects from the environment —
#
#     paid (Anthropic / OpenAI)  ->  local (Ollama)  ->  free (OpenRouter)  ->  offline
#
# A provider is *available* only when its key env is set (or, for Ollama, when a
# probe to {OLLAMA_BASE_URL}/api/tags succeeds), so with zero keys the chain
# collapses straight to `offline`. The offline path is a caller-supplied
# deterministic lambda — it is always terminal, so #complete never raises for
# lack of a provider, and the app always runs at zero cost and zero keys.
#
# stdlib only: Net::HTTP + json, no provider SDKs.
require "net/http"
require "json"
require "uri"

module LlmRouter
  module_function

  # Order within each tier. "auto" is the full standardized chain.
  CHAIN = {
    "auto"    => %w[anthropic openai ollama openrouter],
    "paid"    => %w[anthropic openai],
    "local"   => %w[ollama],
    "free"    => %w[openrouter],
    "offline" => [],
  }.freeze

  # Indicative blended $/Mtok (input, output) for the cost estimate. Free/local = 0.
  PRICE = {
    "anthropic"  => [1.0, 5.0],    # claude-haiku-class
    "openai"     => [0.15, 0.60],  # gpt-4o-mini-class
    "openrouter" => [0.0, 0.0],
    "ollama"     => [0.0, 0.0],
  }.freeze

  # One completion plus the routing telemetry an interviewer will ask about.
  Result = Struct.new(
    :text, :provider, :model, :mode, :latency_ms, :cost_usd, :fallbacks,
    keyword_init: true,
  ) do
    def to_h
      { text: text, provider: provider, model: model, mode: mode,
        latency_ms: latency_ms, cost_usd: cost_usd, fallbacks: fallbacks }
    end
  end

  def ollama_url
    (ENV["OLLAMA_BASE_URL"] || "http://localhost:11434").sub(%r{/+\z}, "")
  end

  def default_model(provider)
    case provider
    when "anthropic"  then ENV.fetch("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
    when "openai"     then ENV.fetch("OPENAI_MODEL", "gpt-4o-mini")
    when "openrouter" then ENV.fetch("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
    when "ollama"     then ENV.fetch("OLLAMA_MODEL", "llama3.1:8b")
    end
  end

  # ----- availability -------------------------------------------------------

  @probe_cache = {}

  def ollama_reachable?
    cached = @probe_cache[:ollama]
    now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    return cached[0] if cached && (now - cached[1]) < 30

    ok = begin
      uri = URI("#{ollama_url}/api/tags")
      res = Net::HTTP.start(uri.host, uri.port, open_timeout: 1.5, read_timeout: 1.5) do |http|
        http.get(uri.request_uri)
      end
      res.is_a?(Net::HTTPSuccess)
    rescue StandardError
      false
    end
    @probe_cache[:ollama] = [ok, now]
    ok
  end

  def available?(provider)
    case provider
    when "anthropic"  then ENV["ANTHROPIC_API_KEY"].present?
    when "openai"     then ENV["OPENAI_API_KEY"].present?
    when "openrouter" then ENV["OPENROUTER_API_KEY"].present?
    when "ollama"     then ollama_reachable?
    else false
    end
  end

  # Which providers are configured/reachable right now — drives GET /llm.
  def status
    {
      mode: resolve_mode(nil),
      providers: %w[anthropic openai ollama openrouter].index_with { |p| available?(p) },
      offline_fallback: true,
      ollama_url: ollama_url,
    }
  end

  def resolve_mode(mode)
    (mode || ENV["LLM_MODE"] || "auto").to_s.downcase
  end

  # ----- router -------------------------------------------------------------

  # Walk the chain for the resolved mode and return the first success. `offline`
  # is the deterministic terminal lambda (system, user) -> text.
  def complete(system:, user:, offline:, mode: nil, json_mode: false, max_tokens: 1024)
    resolved = resolve_mode(mode)
    chain = CHAIN.fetch(resolved, CHAIN["auto"])
    fallbacks = []

    chain.each do |provider|
      next unless available?(provider)

      t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      begin
        text, model, in_tok, out_tok =
          call(provider, system, user, json_mode: json_mode, max_tokens: max_tokens)
      rescue StandardError
        fallbacks << provider
        next
      end
      if text.nil? || text.strip.empty?
        fallbacks << provider
        next
      end

      in_p, out_p = PRICE.fetch(provider, [0.0, 0.0])
      return Result.new(
        text: text, provider: provider, model: model, mode: resolved,
        latency_ms: ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000).round(1),
        cost_usd: ((in_tok * in_p + out_tok * out_p) / 1_000_000.0).round(6),
        fallbacks: fallbacks,
      )
    end

    t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    text = offline.call(system, user)
    Result.new(
      text: text, provider: "offline", model: "deterministic", mode: resolved,
      latency_ms: ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000).round(1),
      cost_usd: 0.0, fallbacks: fallbacks,
    )
  end

  # ----- provider calls (stdlib HTTP) --------------------------------------

  # Returns [text, model, in_tokens, out_tokens] or raises.
  def call(provider, system, user, json_mode:, max_tokens:)
    model = default_model(provider)
    case provider
    when "anthropic"
      out = post(
        "https://api.anthropic.com/v1/messages",
        { model: model, max_tokens: max_tokens, system: system,
          messages: [{ role: "user", content: user }] },
        { "x-api-key" => ENV.fetch("ANTHROPIC_API_KEY"),
          "anthropic-version" => "2023-06-01" },
        60,
      )
      text = Array(out["content"]).map { |b| b["text"].to_s }.join
      u = out["usage"] || {}
      [text, model, u["input_tokens"].to_i, u["output_tokens"].to_i]

    when "openai", "openrouter"
      base = provider == "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1"
      key  = ENV.fetch(provider == "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY")
      body = { model: model, max_tokens: max_tokens,
               messages: [{ role: "system", content: system },
                          { role: "user", content: user }] }
      body[:response_format] = { type: "json_object" } if json_mode
      out = post("#{base}/chat/completions", body, { "authorization" => "Bearer #{key}" }, 60)
      text = out.dig("choices", 0, "message", "content")
      u = out["usage"] || {}
      [text, model, u["prompt_tokens"].to_i, u["completion_tokens"].to_i]

    when "ollama"
      body = { model: model, stream: false,
               messages: [{ role: "system", content: system },
                          { role: "user", content: user }] }
      body[:format] = "json" if json_mode
      out = post("#{ollama_url}/api/chat", body, {}, 120)
      text = out.dig("message", "content")
      [text, model, out["prompt_eval_count"].to_i, out["eval_count"].to_i]

    else
      raise ArgumentError, "unknown provider #{provider}"
    end
  end

  def post(url, payload, headers, timeout)
    uri = URI(url)
    req = Net::HTTP::Post.new(uri.request_uri)
    req["content-type"] = "application/json"
    headers.each { |k, v| req[k] = v }
    req.body = JSON.generate(payload)
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https",
                          open_timeout: timeout, read_timeout: timeout) do |http|
      http.request(req)
    end
    raise "HTTP #{res.code}" unless res.is_a?(Net::HTTPSuccess)

    JSON.parse(res.body)
  end
end
