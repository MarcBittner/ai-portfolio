# Tanglement.ai Technical Specification - Section 3: Distributed Routing Engine Specification

[← Previous: System Architecture](../02-architecture/README.md) | [Next: Security Architecture →](../04-security/README.md)

---

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

---

## 3. Distributed Routing Engine Specification

This section provides comprehensive details on the client-side routing engine that enables intelligent, decentralized LLM request routing without centralized infrastructure. The routing engine runs entirely on client devices, making all routing decisions locally using cached network state.

### 3.1 Architecture Overview

The Distributed Routing Engine (DRE) embeds directly into client applications as a Go library, JavaScript SDK, or mobile framework. Unlike traditional API gateways with centralized routing servers, the DRE empowers each client to make independent routing decisions using shared network intelligence.

The Distributed Routing Engine serves as the core intelligence layer embedded in every client device. It downloads encrypted network state from decentralized storage, performs multi-objective optimization locally, and routes requests directly through the P2P mesh without company intermediaries.

**Key Design Principles**:
- **Client-Side Execution**: All routing logic runs on user devices (no company routing servers)
- **Decentralized State**: Routing table stored on blockchain/IPFS/gists (not company databases)
- **Local Optimization**: Multi-objective algorithms execute locally (cost/speed/reliability trade-offs)
- **Tier-Based Routing**: Optimization priorities determined by user's chosen tier
- **Privacy-Preserving**: Zero-knowledge telemetry (company cannot see routing decisions)

**Core Responsibilities**:
1. Download and decrypt routing table from decentralized storage
2. Cache routing table locally with periodic updates
3. Perform local route optimization based on user tier
4. Execute requests through P2P mesh (WireGuard tunnels)
5. Publish anonymized performance metrics via gossip protocol
6. Update local cache with observed performance data

**Performance Targets** (Client-Side):
- Routing table download & decrypt: <100ms (cached locally for 5-15 minutes)
- Local routing decision: <50ms (in-memory computation)
- DHT peer discovery: <65ms (O(log N) for 10k nodes)
- Total routing overhead: <215ms (target: <500ms including network)

### 3.2 Routing Table Architecture

The routing table is the core network intelligence, containing node availability, LLM provider pricing, performance metrics, and geographic distribution. Storing this table on decentralized infrastructure is critical to eliminating company control while enabling censorship-resistant operation.

This section describes how routing information is structured, stored, and accessed by clients without centralized control.

#### 3.2.1 Routing Table Structure

The routing table contains all network intelligence required for making optimal routing decisions without real-time queries to centralized servers.

```go
type RoutingTable struct {
    Version          uint64
    Timestamp        time.Time
    Signature        []byte // Signed by network participants
    NetworkHash      [32]byte

    Providers        map[ProviderID]*ProviderInfo
    Nodes            map[NodeID]*NodeInfo
    PerformanceData  map[NodeID]*PerformanceMetrics
    GeographicZones  map[string]*ZoneInfo
    PriceHistory     *PriceHistogram
}

type ProviderInfo struct {
    ProviderID       string
    Models           []ModelID
    BasePricing      map[ModelID]decimal.Decimal
    SurgePricing     *SurgeMultipliers
    Availability     float64 // 0.0-1.0
    AverageLatency   time.Duration
    GeographicZones  []string
    APIEndpoints     []string
    Capabilities     ProviderCapabilities
}

type NodeInfo struct {
    NodeID           [20]byte
    PublicKey        ed25519.PublicKey
    Endpoint         string
    Capabilities     NodeCapabilities
    ReliabilityScore float64
    GeographicZone   string
    LastSeen         time.Time
    DHTPeerList      [][20]byte // Finger table for Chord DHT
}

type PerformanceMetrics struct {
    NodeID           [20]byte
    Timestamp        time.Time
    ProviderMetrics  map[ProviderID]*ProviderPerformance
    NetworkLatency   map[NodeID]time.Duration
    SuccessRate      float64
    QueueDepth       uint32
}

type ProviderPerformance struct {
    AverageLatency    time.Duration
    P50Latency        time.Duration
    P95Latency        time.Duration
    P99Latency        time.Duration
    SuccessRate       float64
    CostPerToken      decimal.Decimal
    ModelAvailability map[ModelID]bool
}
```

**Routing Table Size Estimation**:
- 10k nodes × 500 bytes/node = 5MB
- 100 providers × 2KB/provider = 200KB
- Performance metrics (compressed) = 2MB
- **Total: ~7-10MB per routing table**

**Update Frequency**: Every 5-15 minutes (configurable based on network volatility)

#### 3.2.2 Routing Table Storage Models

Multiple storage strategies are being evaluated. The choice impacts decentralization, cost, and accessibility trade-offs.

This subsection presents alternative approaches for storing and distributing the routing table, each with distinct trade-offs for cost, performance, and decentralization.

##### Option 1: Public Blockchain Storage

Store routing table as on-chain data or IPFS hash pointer stored on-chain.

**Architecture**:
- Routing table encrypted with network public key
- IPFS hash (CIDv1) stored on Ethereum/Polygon smart contract
- Clients query smart contract for latest IPFS hash, download from IPFS
- Alternatively, store small routing tables (<100KB) directly on-chain

**Pros**:
- ✅ Maximum censorship resistance (immutable, unstoppable)
- ✅ Global availability (thousands of IPFS nodes, blockchain nodes)
- ✅ Cryptographic verification (blockchain consensus)
- ✅ No company infrastructure required
- ✅ Automatic versioning and history

**Cons**:
- ❌ Higher latency (~500ms-2s for blockchain queries)
- ❌ Gas costs for updates ($1-50 per update depending on chain)
- ❌ IPFS pinning may require incentivization
- ❌ Larger bandwidth costs for clients (download full table)

**Estimated Cost**: $10-100/day for routing table updates (depending on update frequency and blockchain)

**Recommended Use Case**: Production deployment with strong decentralization requirements

##### Option 2: GitHub Gists (Read-Only)

Store routing table as encrypted public GitHub Gist, clients download via HTTP.

**Architecture**:
- Encrypted routing table uploaded to public GitHub Gist
- Well-known Gist URL hardcoded in client software
- Clients poll Gist URL every 5-15 minutes for updates
- Fallback to IPFS if GitHub unavailable

**Pros**:
- ✅ Free (no storage/bandwidth costs)
- ✅ Fast downloads (~100-300ms globally via GitHub CDN)
- ✅ Familiar developer tooling (git, GitHub API)
- ✅ Easy manual inspection and debugging
- ✅ No blockchain transaction costs

**Cons**:
- ❌ Centralized (GitHub can censor/block)
- ❌ Rate limiting (5000 API calls/hour for authenticated, 60 for unauthenticated)
- ❌ Requires GitHub account for updates
- ❌ Single point of failure (mitigated with fallbacks)

**Estimated Cost**: $0/month

**Recommended Use Case**: MVP development and testing, fallback for production

##### Option 3: S3-Compatible Storage (Read-Only)

Store routing table on S3, CloudFlare R2, or Backblaze B2 as public read-only object.

**Architecture**:
- Encrypted routing table uploaded to public S3 bucket
- CloudFlare CDN in front for global distribution
- Clients download from CDN edge locations
- Multiple cloud providers for redundancy

**Pros**:
- ✅ Very low cost (~$0.50-5/month for storage + bandwidth)
- ✅ Fast global distribution via CDN (~50-200ms)
- ✅ High reliability (99.99% SLA from cloud providers)
- ✅ Easy to scale (supports millions of downloads)
- ✅ Version control via object versioning

**Cons**:
- ❌ Requires minimal company infrastructure (S3 account, CloudFlare)
- ❌ Centralized (cloud provider can block access)
- ❌ Regulatory exposure (company operates infrastructure)
- ❌ Ongoing operational costs (small but non-zero)

**Estimated Cost**: $1-10/month (depends on request volume)

**Recommended Use Case**: Hybrid model with blockchain/IPFS as primary, S3 as fast fallback

##### Option 4: Hybrid Multi-Source ⭐ RECOMMENDED

Combine blockchain/IPFS (primary) with GitHub Gists and S3 (fallbacks) for maximum resilience.

**Architecture**:
- **Primary**: IPFS hash stored on Polygon (low gas costs)
- **Fallback 1**: GitHub Gist (free, fast)
- **Fallback 2**: S3 + CloudFlare CDN (reliable, fast)
- **Fallback 3**: Hardcoded bootstrap nodes serve cached copy

**Client Download Logic**:
```go
func (client *Client) DownloadRoutingTable() (*RoutingTable, error) {
    sources := []RoutingTableSource{
        client.ipfsSource,      // Try IPFS first (decentralized)
        client.gistSource,      // Try GitHub Gist second (fast)
        client.s3Source,        // Try S3/CDN third (reliable)
        client.bootstrapSource, // Try bootstrap nodes last resort
    }

    for _, source := range sources {
        table, err := source.Download()
        if err == nil && client.verifySignature(table) {
            return table, nil
        }
    }

    return nil, ErrNoRoutingTableAvailable
}
```

**Pros**:
- ✅ Maximum availability (multiple fallbacks)
- ✅ Balance of decentralization and performance
- ✅ Fast for most clients (CDN fallback)
- ✅ Resilient to single source failures
- ✅ Gradual migration path (start with S3, move to IPFS)

**Cons**:
- ⚠️ More complex client logic
- ⚠️ Small ongoing costs for S3/CloudFlare (~$5-10/month)
- ⚠️ IPFS may still require pinning incentives

**Estimated Cost**: $10-50/month (blockchain updates + S3 bandwidth)

**Recommended Use Case**: Production deployment balancing decentralization and user experience

#### 3.2.3 Routing Table Encryption

The routing table must be encrypted to prevent unauthorized access while allowing all legitimate clients to decrypt and use the data. PKI key management decisions are pending legal review.

**Encryption Scheme**:
- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Derivation**: PBKDF2 or Argon2id (from master secret)
- **Integrity**: HMAC-SHA256 signature from network validators

**PKI Key Management Options** *(Pending Legal Review)*:

**Option A: Static Company Public Key**
- Company holds master decryption key
- Routing table encrypted with company public key
- All clients receive decryption key (embedded in software)
- **Pros**: Simple, company can monitor network health
- **Cons**: Company can read all routing data, regulatory exposure

**Option B: Individual Client Keys**
- Each client generates own keypair
- Clients cannot read each other's encrypted routing data
- Requires separate routing table encryption per client OR public routing table
- **Pros**: Maximum privacy, no company access to routing decisions
- **Cons**: Complex key distribution, larger bandwidth requirements

**Option C: Hybrid Bootstrap**
- Public routing table readable by all (encrypted for integrity only)
- Individual performance metrics encrypted per-client
- **Pros**: Balance of transparency and privacy
- **Cons**: Routing table visible to anyone (may reveal network topology)

**Pending Legal Decision**: Consult legal counsel on liability implications of each approach.

### 3.3 DHT-Based Peer Discovery

The Distributed Hash Table (DHT) enables clients to discover other network participants without central directories. This section describes the Chord protocol implementation that provides O(log N) lookup complexity and self-organizing topology.

This section describes how clients discover peers in the P2P network using a structured overlay network that scales logarithmically with network size.

#### 3.3.1 Chord Protocol Implementation

Tanglement.ai uses a modified Chord DHT protocol for scalable peer discovery and decentralized routing table distribution.

**Key Space Design**:
- **160-bit key space** using SHA-1 hash function (same as Git commit hashes)
- **Node identifiers** derived from ed25519 public key fingerprints
- **Consistent hashing** for load distribution across nodes
- **Finger table** optimization for O(log N) lookup complexity

**Finger Table Structure**:
```go
type FingerTable struct {
    NodeID     [20]byte
    Successor  [20]byte // Immediate next node in ring
    Fingers    []FingerEntry // log2(N) entries
}

type FingerEntry struct {
    Start      *big.Int // Start of range: (n + 2^i) mod 2^160
    NodeID     [20]byte // First node >= start
    Endpoint   string
    LastSeen   time.Time
}
```

**DHT Lookup Algorithm**:
```go
func (node *DHTNode) FindNode(targetID [20]byte) (*NodeInfo, error) {
    if node.isInSuccessorRange(targetID) {
        return node.Successor, nil
    }

    // Find closest preceding finger
    closestNode := node.findClosestPrecedingFinger(targetID)

    if closestNode.NodeID == node.NodeID {
        return node.Successor, nil // We are closest
    }

    // Recursively query closest node
    return closestNode.FindNode(targetID)
}
```

**Lookup Complexity**: O(log N) where N = network size
- 10k nodes: ~13 hops (log₂(10000))
- 100k nodes: ~17 hops (log₂(100000))
- 1M nodes: ~20 hops (log₂(1000000))

**Latency Calculation**:
- Average hop latency: ~5ms (WireGuard overhead)
- Total DHT lookup: 13 hops × 5ms = **~65ms for 10k nodes**

#### 3.3.2 Node Join/Leave Protocol

Nodes dynamically join and leave the network, requiring routing table updates and finger table adjustments.

```go
type JoinRequest struct {
    NodeID       [20]byte
    PublicKey    ed25519.PublicKey
    Endpoint     string
    Capabilities NodeCapabilities
    Timestamp    time.Time
    Signature    []byte // Signed by private key
}

type NodeCapabilities struct {
    CPUContribution  float64   // % of CPU willing to contribute
    BandwidthMbps    uint32    // Available bandwidth
    SupportedModels  []ModelID // LLM models client can access
    GeographicZone   string    // Geographic region
    ReliabilityScore float64   // Historical uptime (0.0-1.0)
    ClientVersion    string    // Software version
}
```

**Join Protocol**:
1. New client contacts bootstrap node to get initial peer list
2. Client calculates own NodeID from public key hash
3. Client performs DHT lookup to find successor in ring
4. Client updates successor's finger tables
5. Client broadcasts join announcement via gossip protocol
6. Established nodes update their finger tables if necessary

**Leave Protocol**:
- **Graceful**: Node broadcasts departure, updates successor/predecessor
- **Ungraceful**: Nodes detect timeout (30s no heartbeat), remove from finger tables
- **Stabilization**: Periodic finger table refresh (every 60s) maintains consistency

#### 3.3.3 Gossip Protocol State Synchronization

The gossip protocol enables efficient state propagation without requiring all nodes to communicate with all other nodes. This epidemic-style dissemination ensures eventual consistency across the network.

Gossip protocol propagates routing table updates and performance metrics across the network with eventual consistency guarantees.

**State Propagation Algorithm**:
- Each node randomly selects **fanout peers** (default: 6) every **gossip interval** (default: 10s)
- Node sends digest of local state (hash of routing table + recent metrics)
- Peers respond with missing data or newer versions
- Exponential propagation: 6^n nodes reached in n rounds

**Propagation Time**:
- Network of 10k nodes, fanout=6: log₆(10000) ≈ **5 rounds** ≈ **50 seconds** for 99% coverage

**Message Structure**:
```go
type GossipMessage struct {
    SenderID        [20]byte
    Timestamp       time.Time
    RoutingTableHash [32]byte
    Version         uint64
    PerformanceData *PerformanceMetrics
    Signature       []byte
}

type GossipDigest struct {
    NodeStates map[NodeID]*NodeStateDigest
}

type NodeStateDigest struct {
    NodeID    [20]byte
    Version   uint64
    StateHash [32]byte
}
```

**Anti-Entropy Mechanisms**:
- **Pull gossip**: Nodes request missing data from peers
- **Push gossip**: Nodes proactively send updates to peers
- **Delta compression**: Only send changed fields (reduce bandwidth)
- **Bounded message sizes**: Max 100KB per gossip message

**Bandwidth Estimation**:
- Gossip interval: 10s
- Fanout: 6 peers
- Message size: 10KB (compressed)
- **Per-node bandwidth**: 6 × 10KB × 6 exchanges/min = ~360KB/min = **~6KB/s**

### 3.4 Multi-Objective Optimization Algorithm

The routing engine must balance competing objectives based on the user's chosen tier. Premium Reliability users prioritize uptime, Premium Performance users prioritize speed, and Economy users prioritize cost.

This section details how the routing engine selects optimal routes by balancing cost, performance, and reliability according to user tier preferences.

#### 3.4.1 Tier-Based Objective Weighting

Users select ONE optimization tier, which determines routing priorities:

| Tier | Cost Weight | Performance Weight | Reliability Weight |
|------|-------------|-------------------|-------------------|
| **Premium Reliability** | 0.1 | 0.2 | 0.7 |
| **Premium Performance** | 0.2 | 0.7 | 0.1 |
| **Economy Pricing** | 0.7 | 0.2 | 0.1 |

**Tier Configuration**:
```go
type TierConfig struct {
    TierType          TierType
    CostWeight        float64 // 0.0-1.0, sum to 1.0
    PerformanceWeight float64
    ReliabilityWeight float64
    SLATarget         *SLARequirements
}

type TierType int

const (
    TierEconomy TierType = iota
    TierPerformance
    TierReliability
)

type SLARequirements struct {
    MinUptime      float64       // 0.999 for Premium Reliability
    MaxP95Latency  time.Duration // 1s for Premium Performance
    MaxCostPerToken decimal.Decimal // Varies for Economy
}
```

#### 3.4.2 Objective Functions

The routing engine optimizes across three dimensions simultaneously:

**Cost Optimization (C)**:
```
C(route) = Σ(provider_cost + network_cost + processing_overhead)

where:
- provider_cost = base_rate * tokens * surge_multiplier
- network_cost = bandwidth_cost * data_size (amortized P2P costs)
- processing_overhead = cpu_time * node_reward_rate (token economics)
```

**Performance Optimization (P)**:
```
P(route) = total_latency + queue_time + processing_time

where:
- total_latency = network_latency + provider_latency
- network_latency = DHT_lookup + WireGuard_hops + provider_API_call
- queue_time = estimated_wait_based_on_current_load
- processing_time = model_complexity * input_size
```

**Reliability Optimization (R)**:
```
R(route) = (1 - failure_probability) * availability_score

where:
- failure_probability = historical_failure_rate * current_load_factor
- availability_score = uptime_percentage * redundancy_factor
- redundancy_factor = 1.0 (single path) or 1.5 (multi-path failover)
```

#### 3.4.3 Pareto Optimization Implementation

The client generates multiple candidate routes and scores each using weighted objective functions.

```go
type RouteCandidate struct {
    Path             []NodeID      // P2P hops to reach provider
    ProviderID       ProviderID
    ModelID          ModelID
    Cost             decimal.Decimal
    EstimatedLatency time.Duration
    ReliabilityScore float64
    TotalScore       float64       // Weighted sum of objectives
}

func (engine *RoutingEngine) SelectOptimalRoute(
    request *LLMRequest,
    tierConfig *TierConfig,
) (*RouteCandidate, error) {
    // Generate candidate routes
    candidates := engine.generateCandidates(request)

    if len(candidates) == 0 {
        return nil, ErrNoViableRoutes
    }

    // Score each candidate using tier-specific weights
    for i := range candidates {
        candidates[i].TotalScore =
            tierConfig.CostWeight * normalizedCost(candidates[i]) +
            tierConfig.PerformanceWeight * normalizedLatency(candidates[i]) +
            tierConfig.ReliabilityWeight * (1.0 - candidates[i].ReliabilityScore)
    }

    // Select route with minimum total score (lower is better)
    optimal := candidates[0]
    for _, candidate := range candidates[1:] {
        if candidate.TotalScore < optimal.TotalScore {
            optimal = candidate
        }
    }

    return optimal, nil
}

func normalizedCost(route *RouteCandidate) float64 {
    // Normalize to 0.0-1.0 range
    return math.Min(1.0, route.Cost.InexactFloat64() / maxExpectedCost)
}

func normalizedLatency(route *RouteCandidate) float64 {
    return math.Min(1.0, route.EstimatedLatency.Seconds() / maxExpectedLatency)
}
```

### 3.5 Request Processing Pipeline

This section traces the complete lifecycle of an LLM request from application code through client-side routing to P2P network execution and response delivery.

Understanding this pipeline is essential for optimizing performance and debugging issues in the distributed system.

#### 3.5.1 Client-Side Request Validation

Before routing decisions, requests must be validated locally to ensure they meet constraints and resource availability.

```go
type LLMRequest struct {
    RequestID        uuid.UUID
    ClientID         string
    Model            ModelSpecification
    Prompt           string
    Parameters       RequestParameters
    Constraints      RequestConstraints
    Priority         RequestPriority
    TierConfig       *TierConfig // User's chosen tier
    Metadata         map[string]interface{}
}

type RequestConstraints struct {
    MaxCost          decimal.Decimal
    MaxLatency       time.Duration
    MinReliability   float64
    GeographicZones  []string // Allowed regions for data residency
    ProviderWhitelist []ProviderID
    ProviderBlacklist []ProviderID
    RequireEncryption bool
}
```

**Validation Pipeline** (Client-Side):
1. **Token Balance Check**: Verify user has sufficient tokens for estimated cost
2. **Rate Limiting**: Apply per-client rate limits (prevent abuse)
3. **Content Filtering** *(Optional)*: Screen for prohibited content if premium service enabled
4. **Resource Estimation**: Predict token usage and cost
5. **Constraint Feasibility**: Ensure MaxCost, MaxLatency are achievable
6. **Provider Availability**: Check routing table for compatible providers

#### 3.5.2 Route Discovery Algorithm

Client-side route discovery identifies all viable paths to LLM providers matching request criteria.

```go
func (engine *RoutingEngine) DiscoverRoutes(
    request *LLMRequest,
) ([]*RouteCandidate, error) {
    // Phase 1: Provider Discovery (from cached routing table)
    availableProviders := engine.filterProviders(
        engine.routingTable.Providers,
        request.Model,
        request.Constraints,
    )

    if len(availableProviders) == 0 {
        return nil, ErrNoCompatibleProviders
    }

    // Phase 2: Network Path Planning (via DHT)
    var candidates []*RouteCandidate
    for _, provider := range availableProviders {
        // Find P2P nodes that can reach this provider
        nodes := engine.findNodesForProvider(provider.ProviderID)

        for _, node := range nodes {
            // Calculate shortest path through P2P mesh
            path := engine.findShortestPath(engine.localNodeID, node.NodeID)

            candidate := &RouteCandidate{
                Path:             path,
                ProviderID:       provider.ProviderID,
                ModelID:          request.Model.ModelID,
                Cost:             engine.calculateCost(path, provider, request),
                EstimatedLatency: engine.calculateLatency(path, provider),
                ReliabilityScore: engine.calculateReliability(node, provider),
            }

            candidates = append(candidates, candidate)
        }
    }

    // Phase 3: Constraint Filtering
    filtered := engine.filterByConstraints(candidates, request.Constraints)

    return filtered, nil
}
```

**Path Planning Strategies**:
- **Shortest Path**: Minimize WireGuard hops (lowest latency)
- **Least Cost Path**: Minimize network costs (Economy tier)
- **Most Reliable Path**: Select nodes with highest uptime (Reliability tier)

### 3.6 Load Balancing and Failover

Client-side load balancing distributes requests across multiple providers and nodes to prevent overload and maximize reliability.

This section describes how clients adaptively balance load and handle failures without centralized coordination.

#### 3.6.1 Client-Side Load Balancing

Clients use weighted random selection based on real-time performance metrics from the routing table.

```go
type LoadBalancer struct {
    routingTable    *RoutingTable
    circuitBreakers map[ProviderID]*CircuitBreaker
    localMetrics    *LocalPerformanceTracker
}

func (lb *LoadBalancer) SelectRoute(
    candidates []*RouteCandidate,
    tierConfig *TierConfig,
) *RouteCandidate {
    // Filter out failed routes (circuit breaker open)
    available := lb.filterByCircuitState(candidates)

    if len(available) == 0 {
        // All circuit breakers open, try fallback logic
        return lb.fallbackSelection(candidates)
    }

    // Calculate selection weights based on current load
    weights := make([]float64, len(available))
    for i, candidate := range available {
        weights[i] = lb.calculateWeight(candidate, tierConfig)
    }

    // Weighted random selection (prevents thundering herd)
    selectedIndex := weightedRandom(weights)
    return available[selectedIndex]
}

func (lb *LoadBalancer) calculateWeight(
    candidate *RouteCandidate,
    tierConfig *TierConfig,
) float64 {
    // Higher weight = more likely to be selected
    // Inverse of total score (lower score = better route)
    baseWeight := 1.0 / (1.0 + candidate.TotalScore)

    // Adjust for current load (prefer under-utilized nodes)
    nodeLoad := lb.routingTable.GetNodeLoad(candidate.Path[len(candidate.Path)-1])
    loadFactor := 1.0 / (1.0 + nodeLoad)

    return baseWeight * loadFactor
}
```

#### 3.6.2 Circuit Breaker Implementation

Circuit breakers prevent repeated requests to failing providers, enabling fast-fail and automatic recovery.

```go
type CircuitBreaker struct {
    providerID       ProviderID
    failureThreshold uint32        // Open after N failures
    timeout          time.Duration // Try again after timeout
    maxRequests      uint32        // Max requests in half-open state

    state            CircuitState
    failureCount     uint32
    successCount     uint32
    lastFailureTime  time.Time
    lastStateChange  time.Time
}

type CircuitState int

const (
    StateClosed   CircuitState = iota // Normal operation
    StateOpen                          // Failing, reject all requests
    StateHalfOpen                      // Testing recovery
)

func (cb *CircuitBreaker) AllowRequest() bool {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        return true

    case StateOpen:
        // Check if timeout elapsed, transition to half-open
        if time.Since(cb.lastFailureTime) > cb.timeout {
            cb.setState(StateHalfOpen)
            return true
        }
        return false

    case StateHalfOpen:
        // Allow limited requests to test recovery
        return cb.successCount < cb.maxRequests
    }

    return false
}

func (cb *CircuitBreaker) RecordSuccess() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if cb.state == StateHalfOpen {
        cb.successCount++
        if cb.successCount >= cb.maxRequests {
            cb.setState(StateClosed) // Recovered
            cb.failureCount = 0
        }
    }
}

func (cb *CircuitBreaker) RecordFailure() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    cb.failureCount++
    cb.lastFailureTime = time.Now()

    if cb.failureCount >= cb.failureThreshold {
        cb.setState(StateOpen) // Failed
    }
}
```

**Circuit Breaker Parameters**:
- **Failure Threshold**: 5 consecutive failures
- **Timeout**: 30 seconds (try again after 30s)
- **Half-Open Test Requests**: 3 successful requests required for recovery

### 3.7 Caching and Performance Optimization

Client-side caching and intelligent prefetching dramatically reduce latency and costs by serving repeated requests locally without network roundtrips.

This section describes multi-tier caching strategies that operate entirely on client devices and the P2P network.

#### 3.7.1 Client-Side Cache Architecture

```go
type ClientCache struct {
    localCache      *LRUCache    // In-memory cache on client device
    persistentCache *DiskCache   // Optional disk cache for large responses
    peerCache       *P2PCache    // Distributed cache across P2P network

    cachePolicy     *CachePolicy
    hitRate         float64
}

type CachePolicy struct {
    MaxMemoryMB     uint64
    MaxDiskGB       uint64
    TTL             time.Duration
    SemanticCaching bool // Enable similarity-based caching
}

type CacheEntry struct {
    Key             string    // Hash of (model, prompt, parameters)
    Value           []byte    // LLM response
    Timestamp       time.Time
    TTL             time.Duration
    AccessCount     uint64
    LastAccessed    time.Time
    SemanticHash    []float64 // Embedding for semantic similarity
}
```

**Cache Lookup Flow**:
```go
func (cache *ClientCache) Get(request *LLMRequest) ([]byte, bool) {
    cacheKey := cache.generateKey(request)

    // L1: Local memory cache (fastest, <1ms)
    if value, found := cache.localCache.Get(cacheKey); found {
        return value, true
    }

    // L2: Local disk cache (fast, ~10ms)
    if cache.persistentCache != nil {
        if value, found := cache.persistentCache.Get(cacheKey); found {
            cache.localCache.Set(cacheKey, value) // Promote to L1
            return value, true
        }
    }

    // L3: Semantic cache (similar prompts, ~20ms)
    if cache.cachePolicy.SemanticCaching {
        if value, similarity := cache.findSimilarCached(request); similarity > 0.95 {
            return value, true
        }
    }

    // L4: P2P peer cache (slower, ~50-200ms)
    if value, found := cache.peerCache.Get(cacheKey); found {
        cache.localCache.Set(cacheKey, value) // Promote to L1
        return value, true
    }

    return nil, false // Cache miss, must query LLM provider
}
```

**Cache Hit Rates** (Expected):
- **L1 (Memory)**: 30-50% hit rate
- **L2 (Disk)**: 10-20% additional hits
- **L3 (Semantic)**: 5-15% additional hits
- **L4 (P2P)**: 5-10% additional hits
- **Overall**: 50-95% cache hit rate (depending on workload repetition)

**Latency Reduction**:
- Cached response: <1ms (L1) vs 500ms+ (network + LLM)
- **Cost savings**: ~90% for cached responses (no LLM provider charges)

#### 3.7.2 Semantic Caching with Embeddings

Semantic caching matches similar prompts even if text differs, using embedding similarity.

```go
type SemanticCache struct {
    embedder        *EmbeddingModel // Local sentence embedding model
    vectorIndex     *FAISSIndex     // Fast similarity search
    threshold       float64          // Minimum similarity (0.95)
}

func (sc *SemanticCache) FindSimilar(
    request *LLMRequest,
) (*CacheEntry, float64) {
    // Generate embedding for current prompt
    embedding := sc.embedder.Encode(request.Prompt)

    // Search vector index for similar cached prompts
    neighbors, distances := sc.vectorIndex.Search(embedding, k=5)

    // Return best match if above threshold
    for i, neighbor := range neighbors {
        if distances[i] > sc.threshold {
            return neighbor, distances[i]
        }
    }

    return nil, 0.0
}
```

**Semantic Cache Example**:
- Original prompt: "What is the capital of France?"
- Cached prompt: "Tell me the capital city of France"
- Similarity: 0.97 → **Cache hit!**

**Trade-offs**:
- **Pros**: Higher cache hit rates, handles paraphrasing
- **Cons**: Requires embedding model (~100MB), ~20ms overhead for similarity search

#### 3.7.3 Intelligent Prefetching

Predictive prefetching anticipates future requests based on user patterns, loading responses proactively.

```go
type PrefetchManager struct {
    accessPatterns  map[ClientID]*AccessPattern
    predictionModel *MarkovChainModel
    prefetchQueue   chan *LLMRequest
    maxPrefetch     int // Max concurrent prefetches
}

type AccessPattern struct {
    SequentialPatterns []SequencePattern // "A → B → C" sequences
    TemporalPatterns   []TemporalPattern // Time-of-day patterns
    FrequencyMap       map[string]uint64 // Most common prompts
}

func (pm *PrefetchManager) AnalyzeAndPrefetch(
    clientID ClientID,
    currentRequest *LLMRequest,
) {
    pattern := pm.accessPatterns[clientID]
    if pattern == nil {
        pattern = pm.createNewPattern(clientID)
    }

    // Update pattern with current request
    pattern.RecordRequest(currentRequest)

    // Predict next likely requests
    predictions := pm.predictionModel.PredictNext(pattern, currentRequest)

    for _, prediction := range predictions {
        if prediction.Confidence > 0.7 {
            // Queue prefetch if high confidence
            select {
            case pm.prefetchQueue <- prediction.Request:
            default:
                // Queue full, skip prefetch
            }
        }
    }
}
```

**Prefetch Strategies**:
- **Sequential**: If user requested A then B, prefetch C
- **Temporal**: Morning = news summary, afternoon = code help
- **Frequency**: Prefetch most common prompts for user

**Effectiveness**:
- **Hit Rate Improvement**: +10-20% for repetitive workflows
- **Perceived Latency**: Near-zero for prefetched responses
- **Cost**: Minimal (only high-confidence predictions)

### 3.8 Performance Metrics and Benchmarks

This section establishes quantitative performance targets for client-side routing operations, providing concrete benchmarks for implementation validation.

**Target Performance** (Client-Side Operations):
- **Routing table download & decrypt**: <100ms (from cache)
- **Routing table update check**: <50ms (query blockchain/IPFS for new version)
- **Local routing decision**: <50ms (in-memory computation)
- **DHT peer discovery**: ~65ms (13 hops × 5ms for 10k nodes)
- **Cache lookup (L1)**: <1ms (in-memory LRU cache)
- **Cache lookup (L2-L4)**: <200ms (disk or P2P cache)
- **Total routing overhead**: <215ms (without cache) to <1ms (cached)

**Memory Footprint**:
- Routing table cache: ~10MB (compressed)
- Local response cache: 100MB-1GB (configurable)
- DHT finger tables: ~1KB per 1000 nodes
- Total client memory: <200MB baseline + cache size

**Bandwidth Usage** (Per Client):
- Routing table updates: ~10MB / 10 minutes = ~17KB/s average
- Gossip protocol: ~6KB/s (periodic state sharing)
- DHT maintenance: ~2KB/s (heartbeats, finger table updates)
- **Total overhead**: ~25KB/s (~200 Mbps for 10k concurrent clients)

**Scalability**:
- **10k nodes**: 80 vCPU cores effective (80% participation × 1% CPU contribution)
- **100k nodes**: 800 vCPU cores effective
- **1M nodes**: 8000 vCPU cores effective
- **Per-node throughput**: 1k RPS sustained, 10k RPS peak
- **Network throughput**: 10M RPS sustained, 100M RPS peak (at 10k nodes)

---

[← Previous: System Architecture](../02-architecture/README.md) | [Next: Security Architecture →](../04-security/README.md)

---
