# Tanglement.ai Technical Specification - Section 8: Client SDK and Integration APIs

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

[← Previous: Network Protocols](../07-protocols/README.md) | [Next: Implementation Architecture →](../09-implementation/README.md)

---

## 8. Client SDK and Integration APIs

This section defines the client-side SDKs and integration APIs enabling applications to interact with the Tanglement.ai P2P network. Unlike centralized API gateways with server-side endpoints, Tanglement.ai provides **client-side SDKs** that embed the full routing intelligence directly into user applications.

**API Philosophy**: In P2P networks, there is no central API server. Each client is a full peer running routing logic, DHT participation, and cryptographic operations locally. The "API" is the client SDK that provides high-level abstractions over P2P network complexity.

### 8.1 Client SDK Architecture

**Why Client SDKs**: P2P networks eliminate the client-server distinction. Every participant runs the same code, but client SDKs provide developer-friendly interfaces that hide P2P complexity (DHT lookups, gossip protocols, WireGuard tunnels) behind familiar LLM API patterns.

The Tanglement.ai client SDK provides:
1. **Familiar LLM API**: Drop-in replacement for OpenAI/Anthropic SDKs
2. **P2P Networking**: Automatic DHT participation, gossip synchronization, mesh networking
3. **Client-Side Routing**: Local routing optimization without external dependencies
4. **Credential Management**: Secure local storage of LLM provider API keys
5. **Token Economics**: Transparent token spending and contribution earning

```go
type TanglementClient struct {
    // P2P networking components
    dht              *ChordNode
    gossip           *GossipProtocol
    wireGuard        *WireGuardMesh
    signal           *SignalProtocolManager

    // Routing intelligence
    routingEngine    *ClientSideRoutingEngine
    routingTable     *OptimizedRoutingTable
    cache            *MultiTierCache

    // Economics
    tokenManager     *TokenManager
    contribution     *ContributionTracker

    // Configuration
    config           *ClientConfig
    tierSelection    TierType
}

type ClientConfig struct {
    // Node identity
    NodeID           NodeID
    PrivateKey       *ecdsa.PrivateKey

    // Network configuration
    BootstrapNodes   []string  // Initial DHT peers
    ListenAddress    string    // WireGuard listen address
    Port             int       // WireGuard port

    // Tier selection (MUST choose ONE)
    Tier             TierType  // PremiumReliability, PremiumPerformance, or Economy

    // Provider credentials (encrypted locally)
    ProviderKeys     map[string]string // provider_name → API key

    // Performance tuning
    MaxConcurrent    int
    CacheSize        uint64
    BandwidthLimit   uint64
}

func NewTanglementClient(config *ClientConfig) (*TanglementClient, error) {
    // Validate configuration
    if err := validateConfig(config); err != nil {
        return nil, fmt.Errorf("invalid configuration: %w", err)
    }

    // Validate tier selection
    if config.Tier != TierPremiumReliability &&
       config.Tier != TierPremiumPerformance &&
       config.Tier != TierEconomyPricing {
        return nil, fmt.Errorf("must select exactly ONE tier")
    }

    client := &TanglementClient{
        config:        config,
        tierSelection: config.Tier,
    }

    // Initialize P2P components
    if err := client.initializeP2P(); err != nil {
        return nil, fmt.Errorf("P2P initialization failed: %w", err)
    }

    // Initialize routing engine
    if err := client.initializeRouting(); err != nil {
        return nil, fmt.Errorf("routing initialization failed: %w", err)
    }

    // Initialize token economics
    if err := client.initializeEconomics(); err != nil {
        return nil, fmt.Errorf("economics initialization failed: %w", err)
    }

    log.Printf("Tanglement client initialized: node=%s, tier=%s", config.NodeID, config.Tier)

    return client, nil
}

func (tc *TanglementClient) initializeP2P() error {
    // Initialize Chord DHT
    tc.dht = &ChordNode{
        ID:      tc.config.NodeID,
        Address: fmt.Sprintf("%s:%d", tc.config.ListenAddress, tc.config.Port),
    }

    // Bootstrap into DHT
    for _, bootstrapNode := range tc.config.BootstrapNodes {
        if err := tc.dht.Join(bootstrapNode); err != nil {
            log.Printf("Failed to join via bootstrap node %s: %v", bootstrapNode, err)
            continue
        }
        log.Printf("Joined DHT via bootstrap node %s", bootstrapNode)
        break
    }

    // Start DHT stabilization
    tc.dht.startStabilization()

    // Initialize gossip protocol
    tc.gossip = &GossipProtocol{
        nodeID:         tc.config.NodeID,
        peers:          NewPeerManager(),
        fanout:         6,
        gossipInterval: 30 * time.Second,
    }

    // Initialize WireGuard mesh
    tc.wireGuard = &WireGuardMesh{
        listenPort: tc.config.Port,
    }
    if err := tc.wireGuard.Initialize(); err != nil {
        return fmt.Errorf("WireGuard initialization failed: %w", err)
    }

    // Initialize Signal Protocol
    tc.signal = &SignalProtocolManager{
        sessions: make(map[NodeID]*SessionState),
    }
    if err := tc.signal.Initialize(); err != nil {
        return fmt.Errorf("Signal Protocol initialization failed: %w", err)
    }

    return nil
}

func (tc *TanglementClient) initializeRouting() error {
    // Download encrypted routing table from blockchain/IPFS
    routingTable, err := downloadRoutingTable()
    if err != nil {
        return fmt.Errorf("failed to download routing table: %w", err)
    }

    // Decrypt routing table
    decryptedTable, err := decryptRoutingTable(routingTable, tc.config.PrivateKey)
    if err != nil {
        return fmt.Errorf("failed to decrypt routing table: %w", err)
    }

    tc.routingTable = decryptedTable

    // Initialize multi-tier cache
    tc.cache = &MultiTierCache{
        l1Memory:   NewLRUCache(50 * 1024 * 1024),  // 50MB
        l2Disk:     NewDiskCache(1024 * 1024 * 1024), // 1GB
        l3Semantic: NewSemanticCache(100 * 1024 * 1024), // 100MB
        l4P2P:      NewP2PCache(tc.dht),
    }

    // Initialize routing engine with tier-specific configuration
    tierConfig := tc.getTierConfig(tc.tierSelection)
    tc.routingEngine = &ClientSideRoutingEngine{
        routingTable: tc.routingTable,
        cache:        tc.cache,
        tierConfig:   tierConfig,
        dht:          tc.dht,
    }

    return nil
}

func (tc *TanglementClient) getTierConfig(tier TierType) *TierConfig {
    switch tier {
    case TierPremiumReliability:
        return &TierConfig{
            TierType:          TierPremiumReliability,
            CostWeight:        0.1,
            PerformanceWeight: 0.2,
            ReliabilityWeight: 0.7,
            SLATarget:         &SLARequirements{Uptime: 0.999},
        }
    case TierPremiumPerformance:
        return &TierConfig{
            TierType:          TierPremiumPerformance,
            CostWeight:        0.2,
            PerformanceWeight: 0.7,
            ReliabilityWeight: 0.1,
            LatencyTarget:     ptr(1 * time.Second), // P95 < 1s
        }
    case TierEconomyPricing:
        return &TierConfig{
            TierType:          TierEconomyPricing,
            CostWeight:        0.7,
            PerformanceWeight: 0.2,
            ReliabilityWeight: 0.1,
        }
    default:
        // Should never reach here due to validation
        panic("invalid tier selection")
    }
}
```

### 8.2 LLM Completion API (OpenAI-Compatible)

**Why OpenAI-Compatible**: Most applications use OpenAI SDK patterns. Providing a compatible interface enables zero-code migration from centralized APIs to P2P networking.

```go
// OpenAI-compatible completion API
func (tc *TanglementClient) CreateCompletion(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
    startTime := time.Now()

    // Validate request
    if err := tc.validateCompletionRequest(&req); err != nil {
        return nil, fmt.Errorf("invalid request: %w", err)
    }

    log.Printf("CreateCompletion: model=%s, maxTokens=%d, tier=%s",
        req.Model, req.MaxTokens, tc.tierSelection)

    // Check L1 cache first
    cacheKey := tc.cache.GenerateCacheKey(&req)
    if cached, found := tc.cache.Get(cacheKey); found {
        log.Printf("Cache hit (L1): %s", cacheKey)
        return cached.(*CompletionResponse), nil
    }

    // Build internal routing request
    routingReq := &RoutingRequest{
        Model:           req.Model,
        EstimatedTokens: req.MaxTokens,
        Constraints:     tc.buildConstraints(&req),
        Tier:            tc.tierSelection,
    }

    // Client-side routing optimization (~50ms)
    providerSelection, err := tc.routingEngine.SelectProvider(routingReq)
    if err != nil {
        return nil, fmt.Errorf("provider selection failed: %w", err)
    }

    log.Printf("Selected provider: %s (score=%.2f, cost=$%.4f, latency=%dms)",
        providerSelection.Provider,
        providerSelection.Score,
        providerSelection.EstimatedCost,
        providerSelection.EstimatedLatency.Milliseconds())

    // Get provider API key from encrypted local storage
    apiKey, err := tc.getProviderAPIKey(providerSelection.Provider)
    if err != nil {
        return nil, fmt.Errorf("provider credentials not found: %w", err)
    }

    // Execute request directly to provider (no Tanglement.ai middleman)
    providerResp, err := tc.callProvider(ctx, providerSelection.Provider, apiKey, &req)
    if err != nil {
        return nil, fmt.Errorf("provider call failed: %w", err)
    }

    // Record performance metrics
    totalLatency := time.Since(startTime)
    tc.recordMetrics(&MetricsRecord{
        Provider:      providerSelection.Provider,
        Model:         req.Model,
        PromptTokens:  providerResp.Usage.PromptTokens,
        CompletionTokens: providerResp.Usage.CompletionTokens,
        Latency:       totalLatency,
        Cost:          providerSelection.EstimatedCost,
        Success:       true,
        Tier:          tc.tierSelection,
    })

    // Update routing table with performance data (gossip will distribute)
    tc.routingTable.RecordPerformance(
        providerSelection.ProviderID,
        req.Model,
        totalLatency,
        true,
    )

    // Cache successful response
    tc.cache.Put(cacheKey, providerResp)

    // Construct response with Tanglement.ai metadata
    response := &CompletionResponse{
        ID:      providerResp.ID,
        Object:  "text.completion",
        Created: time.Now().Unix(),
        Model:   req.Model,
        Choices: providerResp.Choices,
        Usage:   providerResp.Usage,
        TanglementMetadata: &TanglementMetadata{
            RoutingLatency:    providerSelection.OptimizationTime,
            ProviderLatency:   totalLatency - providerSelection.OptimizationTime,
            TotalLatency:      totalLatency,
            Provider:          providerSelection.Provider,
            TierUsed:          tc.tierSelection.String(),
            TokensSpent:       tc.calculateTokensSpent(providerResp.Usage, providerSelection.EstimatedCost),
            CacheHit:          false,
        },
    }

    log.Printf("Completion successful: id=%s, tokens=%d, latency=%v, cost=$%.4f",
        response.ID,
        response.Usage.TotalTokens,
        totalLatency,
        providerSelection.EstimatedCost)

    return response, nil
}

// Streaming completion API
func (tc *TanglementClient) CreateCompletionStream(ctx context.Context, req CompletionRequest) (<-chan CompletionChunk, error) {
    // Validate request
    if err := tc.validateCompletionRequest(&req); err != nil {
        return nil, fmt.Errorf("invalid request: %w", err)
    }

    log.Printf("CreateCompletionStream: model=%s, tier=%s", req.Model, tc.tierSelection)

    // Select provider (same logic as non-streaming)
    routingReq := &RoutingRequest{
        Model:           req.Model,
        EstimatedTokens: req.MaxTokens,
        Constraints:     tc.buildConstraints(&req),
        Tier:            tc.tierSelection,
    }

    providerSelection, err := tc.routingEngine.SelectProvider(routingReq)
    if err != nil {
        return nil, fmt.Errorf("provider selection failed: %w", err)
    }

    // Get provider API key
    apiKey, err := tc.getProviderAPIKey(providerSelection.Provider)
    if err != nil {
        return nil, fmt.Errorf("provider credentials not found: %w", err)
    }

    // Create output channel
    outputChan := make(chan CompletionChunk, 10)

    // Stream from provider in goroutine
    go func() {
        defer close(outputChan)

        providerStream, err := tc.callProviderStream(ctx, providerSelection.Provider, apiKey, &req)
        if err != nil {
            outputChan <- CompletionChunk{
                Error: err.Error(),
            }
            return
        }

        chunkCount := 0
        var totalContent string

        for chunk := range providerStream {
            if chunk.Error != nil {
                outputChan <- CompletionChunk{
                    Error: chunk.Error.Error(),
                }
                return
            }

            totalContent += chunk.Delta

            outputChan <- CompletionChunk{
                ID:           chunk.ID,
                Object:       "text.completion.chunk",
                Created:      time.Now().Unix(),
                Model:        req.Model,
                Content:      totalContent,
                Delta:        chunk.Delta,
                FinishReason: chunk.FinishReason,
            }

            chunkCount++
        }

        log.Printf("Stream completed: %d chunks", chunkCount)
    }()

    return outputChan, nil
}

type CompletionRequest struct {
    Model            string   `json:"model"`
    Prompt           string   `json:"prompt"`
    MaxTokens        int      `json:"max_tokens,omitempty"`
    Temperature      float64  `json:"temperature,omitempty"`
    TopP             float64  `json:"top_p,omitempty"`
    FrequencyPenalty float64  `json:"frequency_penalty,omitempty"`
    PresencePenalty  float64  `json:"presence_penalty,omitempty"`
    Stop             []string `json:"stop,omitempty"`
    Stream           bool     `json:"stream,omitempty"`
}

type CompletionResponse struct {
    ID                  string               `json:"id"`
    Object              string               `json:"object"`
    Created             int64                `json:"created"`
    Model               string               `json:"model"`
    Choices             []Choice             `json:"choices"`
    Usage               Usage                `json:"usage"`
    TanglementMetadata  *TanglementMetadata  `json:"tanglement_metadata,omitempty"`
}

type TanglementMetadata struct {
    RoutingLatency   time.Duration `json:"routing_latency_ms"`
    ProviderLatency  time.Duration `json:"provider_latency_ms"`
    TotalLatency     time.Duration `json:"total_latency_ms"`
    Provider         string        `json:"provider"`
    TierUsed         string        `json:"tier_used"`
    TokensSpent      decimal.Decimal `json:"tokens_spent"`
    CacheHit         bool          `json:"cache_hit"`
}

type Choice struct {
    Text         string  `json:"text"`
    Index        int     `json:"index"`
    FinishReason string  `json:"finish_reason"`
    Logprobs     *Logprobs `json:"logprobs,omitempty"`
}

type Usage struct {
    PromptTokens     int `json:"prompt_tokens"`
    CompletionTokens int `json:"completion_tokens"`
    TotalTokens      int `json:"total_tokens"`
}

type CompletionChunk struct {
    ID           string `json:"id"`
    Object       string `json:"object"`
    Created      int64  `json:"created"`
    Model        string `json:"model"`
    Content      string `json:"content"`
    Delta        string `json:"delta"`
    FinishReason string `json:"finish_reason,omitempty"`
    Error        string `json:"error,omitempty"`
}
```

### 8.3 Chat Completion API (OpenAI-Compatible)

```go
// Chat completion API (OpenAI-compatible)
func (tc *TanglementClient) CreateChatCompletion(ctx context.Context, req ChatCompletionRequest) (*ChatCompletionResponse, error) {
    startTime := time.Now()

    log.Printf("CreateChatCompletion: model=%s, messages=%d, tier=%s",
        req.Model, len(req.Messages), tc.tierSelection)

    // Convert chat messages to completion prompt format
    completionReq := tc.convertChatToCompletion(&req)

    // Use same routing logic as completion
    providerSelection, err := tc.routingEngine.SelectProvider(&RoutingRequest{
        Model:           req.Model,
        EstimatedTokens: tc.estimateChatTokens(&req),
        Tier:            tc.tierSelection,
    })
    if err != nil {
        return nil, fmt.Errorf("provider selection failed: %w", err)
    }

    // Get provider API key
    apiKey, err := tc.getProviderAPIKey(providerSelection.Provider)
    if err != nil {
        return nil, fmt.Errorf("provider credentials not found: %w", err)
    }

    // Call provider chat API directly
    providerResp, err := tc.callProviderChat(ctx, providerSelection.Provider, apiKey, &req)
    if err != nil {
        return nil, fmt.Errorf("provider call failed: %w", err)
    }

    totalLatency := time.Since(startTime)

    // Record metrics and update routing table
    tc.recordMetrics(&MetricsRecord{
        Provider:         providerSelection.Provider,
        Model:            req.Model,
        PromptTokens:     providerResp.Usage.PromptTokens,
        CompletionTokens: providerResp.Usage.CompletionTokens,
        Latency:          totalLatency,
        Cost:             providerSelection.EstimatedCost,
        Success:          true,
        Tier:             tc.tierSelection,
    })

    response := &ChatCompletionResponse{
        ID:      providerResp.ID,
        Object:  "chat.completion",
        Created: time.Now().Unix(),
        Model:   req.Model,
        Choices: providerResp.Choices,
        Usage:   providerResp.Usage,
        TanglementMetadata: &TanglementMetadata{
            RoutingLatency:  providerSelection.OptimizationTime,
            ProviderLatency: totalLatency - providerSelection.OptimizationTime,
            TotalLatency:    totalLatency,
            Provider:        providerSelection.Provider,
            TierUsed:        tc.tierSelection.String(),
            TokensSpent:     tc.calculateTokensSpent(providerResp.Usage, providerSelection.EstimatedCost),
            CacheHit:        false,
        },
    }

    return response, nil
}

type ChatCompletionRequest struct {
    Model       string        `json:"model"`
    Messages    []ChatMessage `json:"messages"`
    MaxTokens   int           `json:"max_tokens,omitempty"`
    Temperature float64       `json:"temperature,omitempty"`
    TopP        float64       `json:"top_p,omitempty"`
    Stream      bool          `json:"stream,omitempty"`
}

type ChatMessage struct {
    Role    string `json:"role"`    // "system", "user", "assistant"
    Content string `json:"content"`
    Name    string `json:"name,omitempty"`
}

type ChatCompletionResponse struct {
    ID                 string              `json:"id"`
    Object             string              `json:"object"`
    Created            int64               `json:"created"`
    Model              string              `json:"model"`
    Choices            []ChatChoice        `json:"choices"`
    Usage              Usage               `json:"usage"`
    TanglementMetadata *TanglementMetadata `json:"tanglement_metadata,omitempty"`
}

type ChatChoice struct {
    Index        int         `json:"index"`
    Message      ChatMessage `json:"message"`
    FinishReason string      `json:"finish_reason"`
}
```

### 8.4 Network Management API

**Why Network Management**: Unlike centralized APIs where network management is hidden, P2P clients need visibility into network health, peer status, and contribution metrics to optimize participation.

```go
// Get network statistics
func (tc *TanglementClient) GetNetworkStats() (*NetworkStats, error) {
    return &NetworkStats{
        NodeID:           tc.config.NodeID,
        Tier:             tc.tierSelection,
        ConnectedPeers:   len(tc.gossip.peers.peers),
        DHTFingerTable:   tc.dht.FingerTable,
        UptimeSeconds:    uint64(time.Since(tc.startTime).Seconds()),
        RequestsProcessed: tc.metrics.RequestsProcessed,
        TokensSpent:      tc.tokenManager.GetBalance(),
        TokensEarned:     tc.contribution.GetTotalEarned(),
        CacheHitRate:     tc.cache.GetHitRate(),
        AverageLatency:   tc.metrics.GetAverageLatency(),
    }, nil
}

// List available models
func (tc *TanglementClient) ListAvailableModels() ([]ModelInfo, error) {
    models := make([]ModelInfo, 0)

    // Query local routing table for available models
    providers := tc.routingTable.GetAllProviders()
    for _, provider := range providers {
        for _, model := range provider.Models {
            models = append(models, ModelInfo{
                ID:           model.ID,
                Name:         model.Name,
                Provider:     provider.Name,
                Available:    model.Available,
                AverageLatency: tc.routingTable.GetAverageLatency(provider.ID, model.ID),
                CostTier:     provider.CostTier,
            })
        }
    }

    return models, nil
}

// Get routing table statistics
func (tc *TanglementClient) GetRoutingTableStats() (*RoutingTableStats, error) {
    return &RoutingTableStats{
        Version:          tc.routingTable.version,
        LastUpdate:       tc.routingTable.lastUpdate,
        ProviderCount:    len(tc.routingTable.providers.providers),
        PerformanceEntries: tc.routingTable.performanceCache.count,
        MemoryUsage:      tc.routingTable.GetMemoryUsage(),
    }, nil
}

// Manual routing table refresh (triggers DHT lookup + gossip)
func (tc *TanglementClient) RefreshRoutingTable(ctx context.Context) error {
    log.Printf("Manually refreshing routing table...")

    // Download latest encrypted routing table
    routingTable, err := downloadRoutingTable()
    if err != nil {
        return fmt.Errorf("failed to download routing table: %w", err)
    }

    // Decrypt and update
    decryptedTable, err := decryptRoutingTable(routingTable, tc.config.PrivateKey)
    if err != nil {
        return fmt.Errorf("failed to decrypt routing table: %w", err)
    }

    tc.routingTable = decryptedTable
    log.Printf("Routing table refreshed: version=%d, providers=%d",
        decryptedTable.version, len(decryptedTable.providers.providers))

    return nil
}

type NetworkStats struct {
    NodeID            NodeID
    Tier              TierType
    ConnectedPeers    int
    DHTFingerTable    [160]*NodeRef
    UptimeSeconds     uint64
    RequestsProcessed uint64
    TokensSpent       decimal.Decimal
    TokensEarned      decimal.Decimal
    CacheHitRate      float64
    AverageLatency    time.Duration
}

type ModelInfo struct {
    ID             string
    Name           string
    Provider       string
    Available      bool
    AverageLatency time.Duration
    CostTier       uint8
}

type RoutingTableStats struct {
    Version            uint64
    LastUpdate         time.Time
    ProviderCount      int
    PerformanceEntries int
    MemoryUsage        uint64
}
```

### 8.5 Token Management API

```go
// Get current token balance
func (tc *TanglementClient) GetTokenBalance() (*TokenBalance, error) {
    return tc.tokenManager.GetBalance(), nil
}

// Get contribution earnings
func (tc *TanglementClient) GetContributionEarnings(timeRange TimeRange) (*ContributionEarnings, error) {
    return tc.contribution.GetEarnings(timeRange), nil
}

// Submit contribution proof to claim tokens
func (tc *TanglementClient) SubmitContributionProof(ctx context.Context) (*ContributionProofResult, error) {
    // Generate proof from local measurements
    proof, err := tc.contribution.GenerateProof(TimeRange{
        Start: time.Now().Add(-24 * time.Hour),
        End:   time.Now(),
    })
    if err != nil {
        return nil, fmt.Errorf("failed to generate proof: %w", err)
    }

    // Verify proof locally
    if err := tc.contribution.VerifyProof(proof); err != nil {
        return nil, fmt.Errorf("proof verification failed: %w", err)
    }

    // Submit proof to network (via gossip)
    if err := tc.gossip.BroadcastContributionProof(proof); err != nil {
        return nil, fmt.Errorf("failed to broadcast proof: %w", err)
    }

    log.Printf("Contribution proof submitted: cpu=%.2f hours, bandwidth=%.2f GB, tokens=%.2f TAI",
        proof.CPUContribution.CPUHoursNormalized,
        float64(proof.BandwidthContribution.BytesTransferred)/1e9,
        proof.TotalReward)

    return &ContributionProofResult{
        ProofID:      proof.NodeID.String(),
        TokensEarned: proof.TotalReward,
        Status:       "pending_verification",
    }, nil
}

type TokenBalance struct {
    Available  decimal.Decimal
    Pending    decimal.Decimal
    Earned     decimal.Decimal
    Spent      decimal.Decimal
}

type ContributionEarnings struct {
    TimeRange         TimeRange
    CPUEarnings       decimal.Decimal
    BandwidthEarnings decimal.Decimal
    StorageEarnings   decimal.Decimal
    UptimeEarnings    decimal.Decimal
    TotalEarnings     decimal.Decimal
}

type ContributionProofResult struct {
    ProofID      string
    TokensEarned decimal.Decimal
    Status       string
}
```

### 8.6 SDK Language Bindings

**Multi-Language Support**: To maximize adoption, Tanglement.ai provides SDKs in major programming languages. All SDKs wrap the core Go implementation via C bindings (cgo/FFI).

#### 8.6.1 Python SDK

```python
from tanglement import TanglementClient, TierType, CompletionRequest

# Initialize client
client = TanglementClient(
    bootstrap_nodes=["bootstrap.tanglement.ai:51820"],
    tier=TierType.PREMIUM_PERFORMANCE,
    provider_keys={
        "openai": "sk-...",
        "anthropic": "sk-ant-...",
    }
)

# Create completion (OpenAI-compatible)
response = client.create_completion(
    model="gpt-4",
    prompt="Explain quantum computing in simple terms",
    max_tokens=500,
    temperature=0.7
)

print(f"Response: {response.choices[0].text}")
print(f"Provider: {response.tanglement_metadata.provider}")
print(f"Latency: {response.tanglement_metadata.total_latency_ms}ms")
print(f"Tokens spent: {response.tanglement_metadata.tokens_spent}")

# Streaming completion
for chunk in client.create_completion_stream(
    model="gpt-4",
    prompt="Write a short story about AI",
    max_tokens=1000
):
    if chunk.error:
        print(f"Error: {chunk.error}")
        break
    print(chunk.delta, end="", flush=True)

# Network stats
stats = client.get_network_stats()
print(f"Connected peers: {stats.connected_peers}")
print(f"Cache hit rate: {stats.cache_hit_rate:.1%}")
print(f"Tokens earned: {stats.tokens_earned}")
```

#### 8.6.2 TypeScript/JavaScript SDK

```typescript
import { TanglementClient, TierType } from '@tanglement/sdk';

// Initialize client
const client = new TanglementClient({
  bootstrapNodes: ['bootstrap.tanglement.ai:51820'],
  tier: TierType.ECONOMY_PRICING,
  providerKeys: {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  },
});

// Create completion
const response = await client.createCompletion({
  model: 'gpt-4',
  prompt: 'Explain quantum computing in simple terms',
  maxTokens: 500,
  temperature: 0.7,
});

console.log('Response:', response.choices[0].text);
console.log('Provider:', response.tanglementMetadata.provider);
console.log('Latency:', response.tanglementMetadata.totalLatencyMs, 'ms');
console.log('Tokens spent:', response.tanglementMetadata.tokensSpent);

// Streaming completion
const stream = await client.createCompletionStream({
  model: 'gpt-4',
  prompt: 'Write a short story about AI',
  maxTokens: 1000,
});

for await (const chunk of stream) {
  if (chunk.error) {
    console.error('Error:', chunk.error);
    break;
  }
  process.stdout.write(chunk.delta);
}

// Network stats
const stats = await client.getNetworkStats();
console.log('Connected peers:', stats.connectedPeers);
console.log('Cache hit rate:', `${(stats.cacheHitRate * 100).toFixed(1)}%`);
console.log('Tokens earned:', stats.tokensEarned);
```

### 8.7 API Summary and Comparison

This table compares Tanglement.ai's client SDK API with traditional centralized API gateways:

| Feature | Tanglement.ai (P2P SDK) | Centralized API Gateway |
|---------|------------------------|------------------------|
| **Deployment** | Client-side library | Server-side REST API |
| **Network Access** | Embedded DHT/Gossip/WireGuard | HTTP/gRPC to central server |
| **Routing Logic** | Local client-side optimization | Server-side routing |
| **Credentials** | Encrypted local storage | Centralized credential escrow |
| **Tier Selection** | Configured in SDK | Account-level setting |
| **Provider Keys** | User-provided (encrypted locally) | Company-managed (escrow) |
| **Request Path** | Client → Provider (direct) | Client → Gateway → Provider |
| **Latency Overhead** | ~200ms (routing only) | ~200ms routing + network hops |
| **Single Point of Failure** | None (fully distributed) | Gateway servers |
| **Offline Capability** | Cache + local routing | None (requires gateway) |
| **Token Management** | Local wallet | Centralized ledger |
| **Contribution Mining** | Automatic (client tracks) | N/A |
| **Language Support** | Go, Python, TypeScript, Rust | HTTP (language-agnostic) |

---

[← Previous: Network Protocols](../07-protocols/README.md) | [Next: Implementation Architecture →](../09-implementation/README.md)

---
