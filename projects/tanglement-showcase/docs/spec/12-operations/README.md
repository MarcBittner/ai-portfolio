# Tanglement.ai Technical Specification - Section 12: Deployment and Operations

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

[← Previous: Risk Assessment](../11-risk/README.md) | [Next: Development Plan →](../13-development-plan/README.md)

---

## 12. Deployment and Operations

**Why P2P Operations Differ**: Traditional centralized operations focus on controlling company-owned infrastructure (servers, databases, load balancers). P2P operations cannot directly control distributed client deployments; instead, we monitor network health, provide client updates, and operate minimal bootstrap infrastructure. This section covers P2P-specific operational procedures.

### 12.1 Client SDK Distribution and Updates

**Why Client Distribution is Critical**: Unlike centralized systems where we deploy to our own servers, P2P systems distribute client software to thousands of independent users. We cannot force updates, must maintain backward compatibility, and need graceful version migration strategies.

#### 12.1.1 Client SDK Release Process

**Why Formal Release Process**: Client SDK bugs affect all users simultaneously with no rollback capability once distributed. Formal release processes with multi-stage testing prevent catastrophic network-wide failures.

```go
type ClientReleaseOrchestrator struct {
    buildSystem     *BuildSystem
    testingPipeline *ClientTestingPipeline
    distributionMgr *DistributionManager
    versionTracker  *VersionTracker
    rolloutController *ClientRolloutController
}

type ClientRelease struct {
    Version         string          // e.g., "v1.2.3"
    Platform        Platform        // Windows, macOS, Linux, iOS, Android
    Architecture    Architecture    // amd64, arm64
    BuildDate       time.Time
    BinaryHash      [32]byte        // SHA-256 hash
    Signature       [64]byte        // ed25519 signature
    ReleaseNotes    string
    RequiredVersion bool            // If true, old versions will be deprecated
    DeprecationDate *time.Time      // When old versions stop working
}

type Platform int
const (
    PlatformWindows Platform = iota
    PlatformMacOS
    PlatformLinux
    PlatformIOS
    PlatformAndroid
)

type ClientRolloutPhases = []*RolloutPhase{
    {
        Name:              "Phase 1: Internal Testing",
        Duration:          7 * 24 * time.Hour,
        TargetUsers:       []string{"internal-team"},
        TrafficPercentage: 0.0,  // No production traffic
        ValidationCriteria: &ValidationCriteria{
            MinUptime:        0.999,
            MaxCrashRate:     0.001,
            MaxBugReports:    0,
        },
    },
    {
        Name:              "Phase 2: Alpha Release (1% of users)",
        Duration:          14 * 24 * time.Hour,
        TrafficPercentage: 0.01,
        ValidationCriteria: &ValidationCriteria{
            MinUptime:        0.99,
            MaxCrashRate:     0.01,
            MaxBugReports:    10,
        },
    },
    {
        Name:              "Phase 3: Beta Release (10% of users)",
        Duration:          30 * 24 * time.Hour,
        TrafficPercentage: 0.10,
        ValidationCriteria: &ValidationCriteria{
            MinUptime:        0.995,
            MaxCrashRate:     0.005,
            MaxBugReports:    50,
        },
    },
    {
        Name:              "Phase 4: General Availability (100% of users)",
        Duration:          90 * 24 * time.Hour,
        TrafficPercentage: 1.0,
        ValidationCriteria: &ValidationCriteria{
            MinUptime:        0.999,
            MaxCrashRate:     0.001,
            MaxBugReports:    100,
        },
    },
}

func (cro *ClientReleaseOrchestrator) ReleaseNewVersion(version string) error {
    log.Printf("Starting client SDK release process for version %s", version)

    // Build for all platforms
    builds, err := cro.buildSystem.BuildAllPlatforms(version)
    if err != nil {
        return fmt.Errorf("build failed: %w", err)
    }

    // Run comprehensive testing
    if err := cro.testingPipeline.RunTests(builds); err != nil {
        return fmt.Errorf("testing failed: %w", err)
    }

    // Sign binaries
    signedBuilds := make([]*ClientRelease, 0)
    for _, build := range builds {
        signed, err := cro.signBinary(build)
        if err != nil {
            return fmt.Errorf("signing failed for %s: %w", build.Platform, err)
        }
        signedBuilds = append(signedBuilds, signed)
    }

    // Phased rollout
    for _, phase := range ClientRolloutPhases {
        log.Printf("Starting rollout phase: %s", phase.Name)

        if err := cro.rolloutController.DeployPhase(signedBuilds, phase); err != nil {
            log.Printf("Rollout phase %s failed: %v", phase.Name, err)
            // Cannot rollback client deployments, must release hotfix
            return fmt.Errorf("rollout failed: %w", err)
        }

        if err := cro.monitorPhase(phase); err != nil {
            return fmt.Errorf("phase monitoring failed: %w", err)
        }
    }

    log.Printf("Client SDK release %s completed successfully", version)
    return nil
}
```

#### 12.1.2 Version Compatibility and Deprecation

**Why Version Management is Complex**: We cannot force users to upgrade immediately. Network must support multiple client versions simultaneously while gradually deprecating old versions to reduce maintenance burden.

```go
type VersionCompatibilityManager struct {
    supportedVersions map[string]*VersionInfo
    deprecationPolicy *DeprecationPolicy
}

type VersionInfo struct {
    Version         string
    ReleaseDate     time.Time
    MinSupported    bool            // Must be supported for network operation
    DeprecationDate *time.Time      // When this version will be blocked
    KnownIssues     []string
    SecurityPatches []string
}

type DeprecationPolicy struct {
    MinimumSupportWindow time.Duration  // e.g., 90 days
    WarningPeriod        time.Duration  // e.g., 30 days before deprecation
    EnforcementStrategy  EnforcementStrategy
}

type EnforcementStrategy int
const (
    EnforcementSoft EnforcementStrategy = iota  // Warnings only
    EnforcementModerate                         // Degraded service
    EnforcementStrict                           // Bootstrap nodes reject connection
)

// Version compatibility matrix
var VersionCompatibilityMatrix = map[string]*VersionInfo{
    "v1.2.3": {
        Version:         "v1.2.3",
        ReleaseDate:     time.Date(2025, 10, 15, 0, 0, 0, 0, time.UTC),
        MinSupported:    true,
        DeprecationDate: nil,  // Current version, no deprecation
    },
    "v1.2.2": {
        Version:         "v1.2.2",
        ReleaseDate:     time.Date(2025, 9, 1, 0, 0, 0, 0, time.UTC),
        MinSupported:    true,
        DeprecationDate: nil,  // Still supported
    },
    "v1.2.1": {
        Version:         "v1.2.1",
        ReleaseDate:     time.Date(2025, 7, 15, 0, 0, 0, 0, time.UTC),
        MinSupported:    true,
        DeprecationDate: timePtr(time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)),
        KnownIssues:     []string{"Gossip protocol memory leak"},
    },
    "v1.1.0": {
        Version:         "v1.1.0",
        ReleaseDate:     time.Date(2025, 5, 1, 0, 0, 0, 0, time.UTC),
        MinSupported:    false,
        DeprecationDate: timePtr(time.Date(2025, 11, 1, 0, 0, 0, 0, time.UTC)),
        KnownIssues:     []string{"DHT stabilization bug", "Signal Protocol vulnerability"},
        SecurityPatches: []string{"Critical: Upgrade to v1.2.1+ immediately"},
    },
}

func (vcm *VersionCompatibilityManager) CheckVersionCompatibility(clientVersion string) (*CompatibilityResult, error) {
    versionInfo, exists := vcm.supportedVersions[clientVersion]
    if !exists {
        return &CompatibilityResult{
            Allowed:      false,
            Message:      "Unknown client version",
            Severity:     SeverityBlocking,
            UpgradeRequired: true,
        }, nil
    }

    // Check if version is deprecated
    if versionInfo.DeprecationDate != nil {
        if time.Now().After(*versionInfo.DeprecationDate) {
            return &CompatibilityResult{
                Allowed:      false,
                Message:      fmt.Sprintf("Version %s has been deprecated. Please upgrade to latest version.", clientVersion),
                Severity:     SeverityBlocking,
                UpgradeRequired: true,
            }, nil
        }

        // Within warning period
        daysRemaining := time.Until(*versionInfo.DeprecationDate).Hours() / 24
        if daysRemaining <= vcm.deprecationPolicy.WarningPeriod.Hours()/24 {
            return &CompatibilityResult{
                Allowed:      true,
                Message:      fmt.Sprintf("Version %s will be deprecated in %.0f days. Please upgrade soon.", clientVersion, daysRemaining),
                Severity:     SeverityWarning,
                UpgradeRequired: false,
            }, nil
        }
    }

    // Check for security issues
    if len(versionInfo.SecurityPatches) > 0 {
        return &CompatibilityResult{
            Allowed:      vcm.deprecationPolicy.EnforcementStrategy != EnforcementStrict,
            Message:      strings.Join(versionInfo.SecurityPatches, "; "),
            Severity:     SeverityCritical,
            UpgradeRequired: true,
        }, nil
    }

    return &CompatibilityResult{
        Allowed:      true,
        Message:      "Version compatible",
        Severity:     SeverityNone,
        UpgradeRequired: false,
    }, nil
}
```

### 12.2 Bootstrap Node Operations

**Why Bootstrap Nodes are Critical**: Bootstrap nodes are the only centralized infrastructure in the P2P network. They enable new nodes to discover peers and existing nodes to heal partitions. Their failure prevents network growth and partition recovery.

#### 12.2.1 Bootstrap Node Deployment

**Infrastructure Requirements**: Minimal 3-node deployment across multiple regions for redundancy.

```yaml
# Bootstrap Node Deployment Specification

infrastructure:
  provider: "AWS" #  Or Azure, GCP, etc.
  regions:
    - name: "us-east-1"
      node_count: 1
      instance_type: "t3.micro"
      monthly_cost: "$7.50"
    - name: "eu-west-1"
      node_count: 1
      instance_type: "t3.micro"
      monthly_cost: "$7.50"
    - name: "ap-southeast-1"
      node_count: 1
      instance_type: "t3.micro"
      monthly_cost: "$7.50"

  total_monthly_cost: "$22.50"

node_configuration:
  cpu: "1 vCPU"
  memory: "1 GB RAM"
  storage: "8 GB SSD"
  bandwidth: "100 GB/month (estimated)"

  services:
    - name: "DHT Bootstrap Service"
      port: 4001
      protocol: "TCP/UDP"
      purpose: "Provide initial peer list for DHT join"

    - name: "Health Check Endpoint"
      port: 8080
      protocol: "HTTP"
      purpose: "Monitoring and alerting"

  monitoring:
    metrics:
      - "peer_connections"
      - "join_requests_per_minute"
      - "health_check_latency"
      - "uptime_percentage"

    alerts:
      - condition: "health_check_failed"
        threshold: 3
        window: "5 minutes"
        action: "PagerDuty alert to SRE on-call"

      - condition: "join_request_rate_anomaly"
        threshold: "10x normal"
        window: "10 minutes"
        action: "Slack notification to #infrastructure"

deployment_automation:
  infrastructure_as_code: "Terraform"
  configuration_management: "Ansible"
  container_orchestration: "systemd (lightweight, no Kubernetes needed)"

  deployment_process:
    1: "Terraform apply to provision infrastructure"
    2: "Ansible playbook to configure nodes"
    3: "Deploy bootstrap service binary"
    4: "Configure systemd service with auto-restart"
    5: "Verify health checks across all regions"
    6: "Update DNS records (bootstrap.tanglement.ai)"

high_availability:
  strategy: "Active-active across 3 regions"
  client_behavior: "Try all bootstrap nodes until one succeeds"
  failover: "Automatic (clients handle failover)"
  recovery_time: "< 1 minute (client retries)"
```

#### 12.2.2 Bootstrap Node Monitoring and Alerting

**Why Monitoring is Essential**: Bootstrap node failures prevent network growth. We need real-time monitoring with automatic alerts to SRE on-call for rapid response.

```go
type BootstrapMonitoringSystem struct {
    nodes          []*BootstrapNode
    healthChecker  *HealthChecker
    metricsCollector *MetricsCollector
    alertManager   *AlertManager
    dashboard      *MonitoringDashboard
}

type BootstrapNode struct {
    ID              string
    Region          string
    IPAddress       string
    Port            int
    Status          NodeStatus
    LastHealthCheck time.Time
    Metrics         *NodeMetrics
}

type NodeMetrics struct {
    PeerConnections      int
    JoinRequestsPerMin   int
    HealthCheckLatencyMs int
    UptimePercentage     float64
    CPUUtilization       float64
    MemoryUtilization    float64
    BandwidthUsageMB     float64
}

type AlertRule struct {
    Name        string
    Condition   string
    Threshold   float64
    Window      time.Duration
    Severity    AlertSeverity
    Destination string
}

var BootstrapAlertRules = []*AlertRule{
    {
        Name:        "Bootstrap Node Unavailable",
        Condition:   "health_check_failed >= 3",
        Threshold:   3,
        Window:      5 * time.Minute,
        Severity:    AlertSeverityCritical,
        Destination: "PagerDuty + Slack #incidents",
    },
    {
        Name:        "High Join Request Rate",
        Condition:   "join_requests_per_min > 1000",
        Threshold:   1000,
        Window:      10 * time.Minute,
        Severity:    AlertSeverityWarning,
        Destination: "Slack #infrastructure",
    },
    {
        Name:        "All Bootstrap Nodes Down",
        Condition:   "available_nodes == 0",
        Threshold:   0,
        Window:      1 * time.Minute,
        Severity:    AlertSeverityCritical,
        Destination: "PagerDuty + Slack @channel + SMS to CTO",
    },
}

func (bms *BootstrapMonitoringSystem) MonitorNodes() {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            for _, node := range bms.nodes {
                // Perform health check
                healthy, latency := bms.healthChecker.Check(node)
                node.LastHealthCheck = time.Now()

                if !healthy {
                    node.Status = NodeStatusUnhealthy
                    log.Printf("ALERT: Bootstrap node %s (%s) health check failed", node.ID, node.Region)
                    bms.alertManager.SendAlert(&Alert{
                        Severity: AlertSeverityCritical,
                        Message:  fmt.Sprintf("Bootstrap node %s is unhealthy", node.ID),
                    })
                } else {
                    node.Status = NodeStatusHealthy
                }

                // Collect metrics
                metrics, err := bms.metricsCollector.CollectMetrics(node)
                if err != nil {
                    log.Printf("Failed to collect metrics from %s: %v", node.ID, err)
                    continue
                }

                node.Metrics = metrics

                // Evaluate alert rules
                bms.evaluateAlertRules(node, metrics)
            }

            // Update dashboard
            bms.dashboard.UpdateMetrics(bms.nodes)
        }
    }
}
```

### 12.3 Network Health Monitoring

**Why Network-Level Monitoring**: Unlike centralized systems where we monitor our servers, P2P networks require monitoring the health of the distributed network itself: peer connectivity, DHT consistency, gossip convergence.

#### 12.3.1 P2P Network Health Metrics

**Metrics We Cannot Directly Collect**: We don't control client devices, so we rely on voluntary telemetry reporting and bootstrap node observations.

```go
type NetworkHealthMonitor struct {
    telemetryAggregator *TelemetryAggregator
    dhtAnalyzer         *DHTHealthAnalyzer
    gossipTracker       *GossipConvergenceTracker
    partitionDetector   *NetworkPartitionDetector
    byzantineDetector   *ByzantineNodeDetector
}

type NetworkHealthMetrics struct {
    // Network size and growth
    TotalNodes              int
    NodesJoinedLast24h      int
    NodesLeftLast24h        int
    ChurnRate               float64  // Ratio of joins+leaves to total nodes

    // DHT health
    DHTConsistencyScore     float64  // 0.0-1.0, based on peer agreement
    AvgDHTLookupLatency     time.Duration
    DHTLookupSuccessRate    float64

    // Gossip protocol health
    GossipConvergenceTime   time.Duration  // Time to reach 95% of nodes
    RoutingTableConsistency float64  // 0.0-1.0, based on version agreement

    // Network stability
    PartitionEvents         int
    CurrentPartitions       int
    ByzantineNodeRatio      float64  // Estimated % of malicious nodes

    // Geographic distribution
    NodesByRegion           map[string]int
    GeographicDiversity     float64  // Entropy measure
}

type SLI struct {
    Name        string
    Target      float64
    Current     float64
    Status      SLIStatus
    LastUpdate  time.Time
}

// Service Level Indicators for P2P Network
var NetworkSLIs = []*SLI{
    {
        Name:   "DHT Lookup Success Rate",
        Target: 0.99,  // 99% of lookups succeed
    },
    {
        Name:   "Gossip Convergence Time",
        Target: 300,  // < 5 minutes to reach 95% of nodes
    },
    {
        Name:   "Routing Table Consistency",
        Target: 0.95,  // 95% agreement across peers
    },
    {
        Name:   "Network Partition Events",
        Target: 0,  // Zero partition events per day
    },
    {
        Name:   "Byzantine Node Ratio",
        Target: 0.05,  // < 5% malicious nodes
    },
}

// Service Level Objectives for P2P Network
type SLO struct {
    Name        string
    Description string
    Measurement string
    Target      string
    Alerting    string
}

var NetworkSLOs = []*SLO{
    {
        Name:        "DHT Availability",
        Description: "Percentage of time DHT lookups succeed within 2 seconds",
        Measurement: "dht_lookup_success_rate_2s",
        Target:      "99.9% over 30-day window",
        Alerting:    "Alert if < 99% over 1-hour window",
    },
    {
        Name:        "Gossip Propagation",
        Description: "Time to propagate routing table updates to 95% of network",
        Measurement: "gossip_convergence_time_p95",
        Target:      "< 5 minutes",
        Alerting:    "Alert if > 10 minutes for 3 consecutive updates",
    },
    {
        Name:        "Network Partition Recovery",
        Description: "Time to detect and heal network partitions",
        Measurement: "partition_recovery_time_p95",
        Target:      "< 10 minutes",
        Alerting:    "Alert immediately on partition detection",
    },
    {
        Name:        "Client Crash Rate",
        Description: "Percentage of clients that crash within 24 hours of startup",
        Measurement: "client_crash_rate_24h",
        Target:      "< 0.1%",
        Alerting:    "Alert if > 1% over 1-hour window",
    },
}
```

### 12.4 Incident Response Runbooks

**Why P2P Runbooks Differ**: Traditional runbooks assume we can restart servers, rollback deployments, or route traffic. P2P runbooks focus on network-level interventions: partition healing, Byzantine node isolation, client update encouragement.

#### 12.4.1 Network Partition Response

```yaml
runbook:
  id: "RB-P2P-001"
  title: "Network Partition Detected"
  severity: "Critical"
  owner: "SRE Team"

  symptoms:
    - "DHT lookup success rate drops below 70%"
    - "Gossip convergence time exceeds 10 minutes"
    - "Bootstrap nodes report disjoint peer sets"

  detection:
    automated: true
    alerting: "PagerDuty + Slack #incidents"
    monitoring_query: "partition_detector.current_partitions > 0"

  response_steps:
    1:
      action: "Verify partition existence"
      commands:
        - "Query bootstrap nodes for peer lists"
        - "Check geographic distribution of unreachable nodes"
        - "Analyze DHT finger table consistency across regions"
      expected_duration: "5 minutes"

    2:
      action: "Identify partition bridge nodes"
      commands:
        - "Find nodes connected to both partitions"
        - "Prioritize high-uptime, high-reputation nodes"
      expected_duration: "5 minutes"

    3:
      action: "Bootstrap intervention"
      commands:
        - "Bootstrap nodes broadcast bridge node recommendations to both segments"
        - "Clients receive bridge nodes via gossip or bootstrap query"
      expected_duration: "2 minutes"

    4:
      action: "Monitor partition healing"
      commands:
        - "Watch DHT consistency score increase"
        - "Verify peers from both segments can now discover each other"
        - "Confirm gossip convergence time returns to normal"
      expected_duration: "10 minutes"
      success_criteria:
        - "DHT lookup success rate > 95%"
        - "Routing table consistency > 90%"
        - "Gossip convergence time < 5 minutes"

    5:
      action: "Post-incident analysis"
      commands:
        - "Analyze partition root cause (ISP outage, BGP issue, DDoS)"
        - "Document incident timeline"
        - "Update partition detection algorithms if needed"

  rollback_procedure: "N/A - Cannot rollback network state"

  escalation:
    - level: "L1"
      role: "SRE On-Call"
      timeout: "15 minutes"

    - level: "L2"
      role: "Engineering Manager"
      timeout: "30 minutes"

    - level: "L3"
      role: "CTO"
      timeout: "1 hour"
```

#### 12.4.2 Byzantine Node Attack Response

```yaml
runbook:
  id: "RB-P2P-002"
  title: "Byzantine Node Attack Detected"
  severity: "Critical"
  owner: "Security Team + SRE"

  symptoms:
    - "Byzantine node ratio > 15%"
    - "Routing table conflict rate > 10%"
    - "Peer reputation variance > 0.8"

  detection:
    automated: true
    alerting: "PagerDuty + Slack #security-incidents"

  response_steps:
    1:
      action: "Identify Byzantine nodes"
      commands:
        - "Run Byzantine detection algorithm on routing table updates"
        - "Flag nodes with >20% deviation from peer attestations"
        - "Analyze node registration patterns (IP clustering, timing)"

    2:
      action: "Isolate Byzantine nodes"
      commands:
        - "Bootstrap nodes add Byzantine node IDs to blocklist"
        - "Broadcast blocklist update via gossip protocol"
        - "Clients automatically ignore updates from blocked nodes"

    3:
      action: "Increase stake requirements (if severe)"
      commands:
        - "Temporarily increase minimum stake from 1000 TAI to 5000 TAI"
        - "Existing nodes grandfathered, new nodes must meet new requirement"

    4:
      action: "Enable centralized routing fallback (emergency)"
      commands:
        - "Bootstrap nodes activate authoritative routing table mode"
        - "Clients receive 'use_bootstrap_routing_table' flag"
        - "Reduces P2P operation but prevents Byzantine manipulation"
      conditions: "Only if Byzantine ratio > 20%"

    5:
      action: "Monitor and analyze"
      commands:
        - "Track Byzantine node ratio decrease"
        - "Analyze attack patterns and update detection algorithms"
        - "Prepare security patch if client vulnerability found"
```

### 12.5 Operational Cost Summary

**Why Cost Transparency Matters**: P2P architecture dramatically reduces operational costs compared to centralized alternatives. This section provides ongoing cost estimates for budget planning.

#### 12.5.1 Monthly Operational Costs

```markdown
| Component | Provider | Quantity | Unit Cost | Monthly Cost | Annual Cost |
|-----------|----------|----------|-----------|--------------|-------------|
| **Bootstrap Nodes** | | | | | |
| us-east-1 | AWS EC2 t3.micro | 1 | $7.50 | $7.50 | $90 |
| eu-west-1 | AWS EC2 t3.micro | 1 | $7.50 | $7.50 | $90 |
| ap-southeast-1 | AWS EC2 t3.micro | 1 | $7.50 | $7.50 | $90 |
| **Storage** | | | | | |
| Routing Table Backup | S3 Standard | 1 GB | $0.023/GB | $0.02 | $0.28 |
| Client Binary Distribution | S3 + CloudFront | 100 GB/mo | $0.09/GB | $9.00 | $108 |
| **Monitoring** | | | | | |
| Metrics Storage | CloudWatch | 1000 metrics | $0.30/metric | $300 | $3,600 |
| Alerting | PagerDuty | 1 account | $25/user | $25 | $300 |
| **Domain & SSL** | | | | | |
| Domain Registration | Route53 | 1 domain | $1.00 | $1.00 | $12 |
| SSL Certificates | Let's Encrypt | N/A | Free | $0 | $0 |
| **TOTAL** | | | | **$357.50** | **$4,290** |

**Note**: This is for minimal bootstrap infrastructure only. Actual costs scale primarily with user count (support, bandwidth) rather than infrastructure. Compare to centralized API gateway costs of $100k+/month.
```

---

## Summary of Changes

This section has been comprehensively revised for P2P client SDK operations:

1. **Complete rewrite for P2P operations**: Removed all centralized server deployment procedures (Kubernetes, database operations, load balancer configuration)
2. **Added Section 12.1: Client SDK Distribution and Updates** - Focus on distributing client software rather than deploying to company servers
3. **Client release process** with phased rollout (Internal → Alpha 1% → Beta 10% → GA 100%)
4. **Version compatibility management** - Support multiple client versions simultaneously, gradual deprecation strategy
5. **Added Section 12.2: Bootstrap Node Operations** - The ONLY centralized infrastructure we operate
6. **Bootstrap node deployment spec**: 3× AWS t3.micro across regions (~$22.50/month)
7. **Bootstrap node monitoring**: Health checks, join request rates, uptime monitoring with PagerDuty alerts
8. **Added Section 12.3: Network Health Monitoring** - Monitor distributed network health, not company servers
9. **P2P network health metrics**: DHT consistency, gossip convergence, partition events, Byzantine node ratio
10. **SLI/SLO definitions**: DHT availability (99.9%), gossip propagation (<5min), partition recovery (<10min), client crash rate (<0.1%)
11. **Added Section 12.4: Incident Response Runbooks** - P2P-specific runbooks
12. **Network partition response runbook**: Detect partitions, identify bridge nodes, bootstrap intervention, monitor healing
13. **Byzantine attack response runbook**: Identify malicious nodes, isolate via blocklist, increase stake requirements, enable centralized fallback
14. **Added Section 12.5: Operational Cost Summary** - Full cost breakdown
15. **Monthly operational costs**: $357.50/month (vs. $100k+/month for centralized), dominated by monitoring/support not infrastructure
16. **Removed all centralized infrastructure**: No Kubernetes deployments, database operations, server scaling, load balancer configuration
17. **Added 10+ contextual explanations** explaining WHY P2P operations differ from centralized operations

---

[← Previous: Risk Assessment](../11-risk/README.md) | [Next: Development Plan →](../13-development-plan/README.md)

---
