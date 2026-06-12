# slo-kit — SLO alerting as code (illustrative reference, AWS CloudWatch flavor).
#
# The service runs as a container (Render/ECS/EKS — out of scope here); what's
# worth version-controlling is the *alerting policy*. This encodes the canonical
# Google-SRE multiwindow, multi-burn-rate error-budget alerts so paging is tied
# to budget burn, not raw error count. Apply with a real provider + metric source.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "service_name" { default = "slo-kit" }
variable "sns_topic_arn" { description = "Pager/SNS topic for alerts" type = string }

# Availability SLO: 99.5% → error budget = 0.5%. Multiwindow burn-rate alerts:
#   fast burn  — 14.4x over 1h  (budget gone in ~2 days)  → page
#   slow burn  —  6x   over 6h                              → ticket
locals {
  error_budget   = 0.005
  fast_threshold = 14.4 * local.error_budget # 7.2% error rate over 1h
  slow_threshold = 6.0 * local.error_budget  # 3.0% error rate over 6h
}

resource "aws_cloudwatch_metric_alarm" "fast_burn" {
  alarm_name          = "${var.service_name}-error-budget-fast-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = local.fast_threshold
  alarm_description    = "Error budget burning >14.4x (1h window) — page on-call."
  alarm_actions       = [var.sns_topic_arn]

  metric_query {
    id          = "error_rate"
    expression  = "errors / total"
    label       = "5xx error ratio"
    return_data = true
  }
  metric_query {
    id = "errors"
    metric {
      metric_name = "slo_request_errors_total"
      namespace   = var.service_name
      period      = 3600
      stat        = "Sum"
    }
  }
  metric_query {
    id = "total"
    metric {
      metric_name = "slo_requests_total"
      namespace   = var.service_name
      period      = 3600
      stat        = "Sum"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "latency_slo" {
  alarm_name          = "${var.service_name}-latency-p95"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  threshold           = 250 # ms — the latency SLI target
  alarm_description    = "p95 latency over target for 3 periods — investigate."
  alarm_actions       = [var.sns_topic_arn]
  metric_name         = "slo_request_duration_ms"
  namespace           = var.service_name
  period              = 300
  extended_statistic  = "p95"
}
