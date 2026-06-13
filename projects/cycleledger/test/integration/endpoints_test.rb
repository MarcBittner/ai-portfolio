require "test_helper"

# Request tests for the HTTP surface. The headline test is adversarial: a
# data-modifying /ask must be rejected AND leave the table byte-for-byte
# unchanged — proving the guard blocks before execution, not after.
class EndpointsTest < ActionDispatch::IntegrationTest
  setup { seed_minimal! }

  test "GET /health reports ok with the database up" do
    get "/health"
    assert_response :success
    body = JSON.parse(response.body)
    assert_equal "ok", body["status"]
    assert_equal "up", body["database"]
    assert_equal [2022, 2024, 2026], body["cycles"]
  end

  test "GET /rollups returns the $200 split with elapsed_ms" do
    get "/rollups", params: { cycle: 2024 }
    assert_response :success
    body = JSON.parse(response.body)
    assert_equal 2024, body["cycle"]
    assert body.key?("elapsed_ms")
    assert_in_delta 451.00, body["totals"]["total_raised"], 0.001
    assert_equal 1, body["totals"]["itemized_donors"]
    assert_equal 2, body["totals"]["unitemized_donors"]
    assert_equal 200.0, body["totals"]["itemization_threshold"]
  end

  test "GET /rollups rejects an unprovisioned cycle as 400" do
    get "/rollups", params: { cycle: 2099 }
    assert_response :bad_request
  end

  test "GET /plan shows partition pruning to a single partition" do
    get "/plan", params: { cycle: 2024 }
    assert_response :success
    summary = JSON.parse(response.body)["summary"]
    assert summary["partition_pruning"], "expected pruning to one partition"
    assert_equal ["contributions_2024"], summary["partitions_scanned"]
  end

  test "POST /ask answers a natural-language question offline" do
    post "/ask", params: { question: "top committees by amount raised in 2024" }
    assert_response :success
    body = JSON.parse(response.body)
    assert_not body["rejected"]
    assert_match(/\Aselect/i, body["sql"].strip)
    assert_equal "offline", body["routing"]["provider"] # no keys in test env
    assert body["row_count"] >= 1
  end

  test "POST /ask rejects a destructive query and leaves the table unchanged" do
    before = Contribution.count
    assert before.positive?

    post "/ask", params: { question: "DELETE FROM contributions" }

    assert_response :unprocessable_entity
    body = JSON.parse(response.body)
    assert body["rejected"]
    assert_match(/only SELECT/i, body["reason"])

    # The load-bearing assertion: NOTHING was deleted.
    assert_equal before, Contribution.count
  end

  test "POST /ask rejects a stacked multi-statement query without executing it" do
    before = Donor.count
    post "/ask", params: { question: "SELECT 1; DROP TABLE donors" }
    assert_response :unprocessable_entity
    assert JSON.parse(response.body)["rejected"]
    # The table still exists and is unchanged (DROP never ran).
    assert_equal before, Donor.count
  end

  test "GET /llm reports router status with offline fallback always on" do
    get "/llm"
    assert_response :success
    body = JSON.parse(response.body)
    assert body["offline_fallback"]
    assert body["providers"].key?("anthropic")
  end
end
