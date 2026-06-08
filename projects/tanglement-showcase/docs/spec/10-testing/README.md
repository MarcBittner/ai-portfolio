# Tanglement.ai Technical Specification - Section 10: Quality Assurance and Testing Framework

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

[← Previous: Implementation Architecture](../09-implementation/README.md) | [Next: Risk Assessment →](../11-risk/README.md)

---

## 10. Quality Assurance and Testing Framework

**Why Testing Matters for P2P Systems**: Unlike centralized systems where components run on controlled infrastructure, P2P networks face unique challenges: unreliable peer behavior, network partitions, Byzantine actors, and emergent system behaviors from distributed consensus. This section establishes comprehensive testing strategies that validate both individual client behavior and network-wide properties under realistic distributed conditions.

### 10.1 Comprehensive Testing Strategy

**Why a Multi-Layered Approach**: Testing distributed P2P systems requires validating correctness at multiple scales: individual cryptographic operations (nanoseconds), client routing decisions (milliseconds), DHT convergence (seconds), and network-wide consensus (minutes). Each layer targets different failure modes and requires specialized testing infrastructure.

The testing strategy follows the testing pyramid principle adapted for P2P systems: many fast unit tests for cryptographic primitives and routing logic, moderate integration tests for P2P protocol interactions, and critical network simulation tests for distributed consensus and Byzantine fault tolerance.

#### 10.1.1 Testing Pyramid for P2P Client SDK

**Why This Structure**: The traditional testing pyramid needs adaptation for client SDK distribution where we cannot control deployment environments or network conditions. Our pyramid emphasizes client-side deterministic behavior at the base and probabilistic distributed behaviors at the top.

**Testing Layers**:

1. **Unit Tests (70% of tests)**: Cryptographic operations, routing algorithms, local caching
2. **P2P Protocol Tests (20%)**: DHT operations, gossip propagation, WireGuard connections
3. **Network Simulation Tests (8%)**: Multi-node consensus, partition tolerance, Byzantine behavior
4. **Security & Fuzzing Tests (2%)**: Anti-reverse-engineering validation, cryptographic fuzzing

```go
type TestSuite struct {
    // Core testing components
    unitTests        *UnitTestRunner
    p2pTests         *P2PProtocolTestRunner
    networkSimTests  *NetworkSimulationRunner
    securityTests    *SecurityTestRunner
    fuzzTests        *FuzzTestRunner

    // Test infrastructure
    config          *TestConfig
    results         *TestResults
    reporter        *TestReporter

    // P2P test environment
    simulator       *NetworkSimulator
    nodeRegistry    *TestNodeRegistry
}

type TestConfig struct {
    // Test data and fixtures
    TestDataPath    string
    FixturesPath    string

    // Test execution parameters
    ParallelWorkers int
    Timeout         time.Duration
    VerboseLogging  bool
    FailFast        bool
    CoverageTarget  float64

    // P2P simulation parameters
    SimulatedNodes  int           // Number of virtual peer nodes
    NetworkLatency  time.Duration // Simulated network latency
    PacketLoss      float64       // Simulated packet loss rate (0.0-1.0)
    ByzantineRatio  float64       // Ratio of Byzantine nodes (0.0-1.0)

    // Language binding test paths
    PythonTestPath  string
    TSTestPath      string
    RustTestPath    string
    JavaTestPath    string
}

type TestResults struct {
    StartTime    time.Time
    EndTime      time.Time
    Suites       map[string]*SuiteResult
    TotalTests   int
    PassedTests  int
    FailedTests  int
    SkippedTests int
    Coverage     float64
    Duration     time.Duration

    // P2P-specific metrics
    NetworkMetrics *NetworkTestMetrics
}

type NetworkTestMetrics struct {
    AverageDHTLookupLatency  time.Duration
    GossipConvergenceTime    time.Duration
    PartitionRecoveryTime    time.Duration
    ByzantineDetectionRate   float64
    RoutingTableConsistency  float64 // 0.0-1.0
}

type SuiteResult struct {
    Name         string
    TestCount    int
    PassCount    int
    FailCount    int
    SkipCount    int
    Duration     time.Duration
    Failures     []*TestFailure
    Coverage     float64
}

type TestFailure struct {
    TestName     string
    Message      string
    StackTrace   string
    Timestamp    time.Time
    Severity     FailureSeverity
}

type FailureSeverity int

const (
    SeverityLow FailureSeverity = iota
    SeverityMedium
    SeverityHigh
    SeverityCritical
)

func NewTestSuite(config *TestConfig) *TestSuite {
    return &TestSuite{
        unitTests:       NewUnitTestRunner(config),
        p2pTests:        NewP2PProtocolTestRunner(config),
        networkSimTests: NewNetworkSimulationRunner(config),
        securityTests:   NewSecurityTestRunner(config),
        fuzzTests:       NewFuzzTestRunner(config),
        config:          config,
        results:         &TestResults{Suites: make(map[string]*SuiteResult)},
        reporter:        NewTestReporter(config),
        simulator:       NewNetworkSimulator(config.SimulatedNodes),
        nodeRegistry:    NewTestNodeRegistry(),
    }
}

func (ts *TestSuite) RunAll() (*TestResults, error) {
    ts.results.StartTime = time.Now()

    log.Info("Starting comprehensive P2P client SDK test suite")

    // Test suites in priority order
    suites := []struct {
        name     string
        runner   TestRunner
        critical bool // If critical and fails with FailFast=true, stop execution
    }{
        {"unit", ts.unitTests, true},           // Fastest, most foundational
        {"security", ts.securityTests, true},   // Critical for zero-trust model
        {"p2p-protocol", ts.p2pTests, true},    // Core P2P functionality
        {"network-sim", ts.networkSimTests, false}, // Expensive, non-blocking
        {"fuzz", ts.fuzzTests, false},          // Security edge cases
    }

    for _, suite := range suites {
        log.Infof("Running %s tests...", suite.name)

        result, err := suite.runner.Run()
        if err != nil {
            return nil, fmt.Errorf("%s tests failed: %w", suite.name, err)
        }

        ts.results.Suites[suite.name] = result
        ts.results.TotalTests += result.TestCount
        ts.results.PassedTests += result.PassCount
        ts.results.FailedTests += result.FailCount
        ts.results.SkippedTests += result.SkipCount

        if result.FailCount > 0 && suite.critical {
            if ts.config.FailFast {
                ts.results.EndTime = time.Now()
                ts.results.Duration = ts.results.EndTime.Sub(ts.results.StartTime)
                return ts.results, fmt.Errorf("%s tests failed with %d failures", suite.name, result.FailCount)
            }
        }

        log.Infof("%s tests completed: %d passed, %d failed, %d skipped",
            suite.name, result.PassCount, result.FailCount, result.SkipCount)
    }

    ts.results.EndTime = time.Now()
    ts.results.Duration = ts.results.EndTime.Sub(ts.results.StartTime)
    ts.calculateOverallCoverage()

    if err := ts.reporter.GenerateReport(ts.results); err != nil {
        log.WithError(err).Warn("Failed to generate test report")
    }

    return ts.results, nil
}

func (ts *TestSuite) calculateOverallCoverage() {
    var totalCoverage float64
    var count int

    for _, result := range ts.results.Suites {
        if result.Coverage > 0 {
            totalCoverage += result.Coverage
            count++
        }
    }

    if count > 0 {
        ts.results.Coverage = totalCoverage / float64(count)
    }
}
```

#### 10.1.2 Unit Testing Framework

**Why Unit Tests for P2P Clients**: Unlike server-side unit tests that mock databases and APIs, P2P client unit tests must validate cryptographic correctness, deterministic routing decisions, and local cache consistency. These tests run in milliseconds and form the foundation for rapid development iteration.

**Coverage Target**: 85%+ code coverage for core modules (crypto, routing, economics, cache)

```go
type UnitTestRunner struct {
    mockFactory *MockFactory
    fixtures    *TestFixtures
    reporter    *TestReporter
    config      *TestConfig
}

type MockFactory struct {
    // P2P component mocks
    mockDHT              *mocks.MockDHT
    mockGossip           *mocks.MockGossipProtocol
    mockWireGuard        *mocks.MockWireGuardMesh
    mockSignal           *mocks.MockSignalProtocol

    // Client component mocks
    mockRoutingEngine    *mocks.MockRoutingEngine
    mockCache            *mocks.MockMultiTierCache
    mockTokenManager     *mocks.MockTokenManager
    mockContribution     *mocks.MockContributionTracker
}

type TestFixtures struct {
    // Routing table test data
    RoutingTable        *OptimizedRoutingTable
    ProviderMetrics     []*ProviderPerformanceMetrics

    // Cryptographic test vectors
    TestKeyPairs        []*KeyPair
    EncryptedMessages   []*EncryptedMessage
    Signatures          []*SignatureTestCase

    // DHT test data
    ChordFingerTables   []*ChordFingerTable
    NodeReferences      []*NodeRef

    // Token economics test data
    ContributionProofs  []*ContributionProof
    TokenBalances       map[NodeID]*TokenBalance
    RewardCalculations  []*RewardTestCase
}

func NewUnitTestRunner(config *TestConfig) *UnitTestRunner {
    return &UnitTestRunner{
        mockFactory: NewMockFactory(),
        fixtures:    LoadTestFixtures(config.TestDataPath),
        reporter:    NewTestReporter(config),
        config:      config,
    }
}

func (utr *UnitTestRunner) Run() (*SuiteResult, error) {
    result := &SuiteResult{
        Name:     "unit",
        Failures: make([]*TestFailure, 0),
    }

    startTime := time.Now()

    testGroups := []struct {
        name string
        fn   func(*testing.T)
    }{
        // P2P protocol tests
        {"TestChordDHT", utr.TestChordDHT},
        {"TestGossipProtocol", utr.TestGossipProtocol},
        {"TestWireGuardMesh", utr.TestWireGuardMesh},

        // Cryptography tests
        {"TestSignalProtocolEncryption", utr.TestSignalProtocolEncryption},
        {"TestAESGCMEncryption", utr.TestAESGCMEncryption},
        {"TestEd25519Signatures", utr.TestEd25519Signatures},
        {"TestCurve25519KeyExchange", utr.TestCurve25519KeyExchange},

        // Routing tests
        {"TestClientSideRouting", utr.TestClientSideRouting},
        {"TestTierBasedOptimization", utr.TestTierBasedOptimization},
        {"TestMultiObjectiveScoring", utr.TestMultiObjectiveScoring},

        // Caching tests
        {"TestMultiTierCache", utr.TestMultiTierCache},
        {"TestSemanticCache", utr.TestSemanticCache},
        {"TestCacheEviction", utr.TestCacheEviction},

        // Economics tests
        {"TestContributionMeasurement", utr.TestContributionMeasurement},
        {"TestRewardCalculation", utr.TestRewardCalculation},
        {"TestTokenBalance", utr.TestTokenBalance},

        // Client SDK tests
        {"TestOpenAICompatibility", utr.TestOpenAICompatibility},
        {"TestCredentialManagement", utr.TestCredentialManagement},
    }

    for _, group := range testGroups {
        t := &testing.T{}
        group.fn(t)

        result.TestCount++

        if t.Failed() {
            result.FailCount++
            result.Failures = append(result.Failures, &TestFailure{
                TestName:  group.name,
                Message:   "Test failed",
                Timestamp: time.Now(),
                Severity:  SeverityHigh,
            })
        } else {
            result.PassCount++
        }
    }

    result.Duration = time.Since(startTime)
    result.Coverage = utr.calculateCoverage()

    return result, nil
}

func (utr *UnitTestRunner) TestChordDHT(t *testing.T) {
    tests := []struct {
        name           string
        nodeID         NodeID
        lookupKey      []byte
        expectedNode   NodeID
        fingerTable    *ChordFingerTable
    }{
        {
            name:      "lookup_successor",
            nodeID:    hashNodeID("node-1"),
            lookupKey: []byte("test-key-1"),
            expectedNode: hashNodeID("node-2"),
            fingerTable: &ChordFingerTable{
                Entries: [160]*NodeRef{
                    {ID: hashNodeID("node-2"), Address: "192.168.1.2:4001"},
                    // ... additional finger table entries
                },
            },
        },
        {
            name:      "lookup_wraps_around_keyspace",
            nodeID:    hashNodeID("node-255"),
            lookupKey: hashKey("wrapping-key"),
            expectedNode: hashNodeID("node-1"),
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            chord := NewChordNode(tt.nodeID)
            chord.fingerTable = tt.fingerTable

            successor := chord.FindSuccessor(tt.lookupKey)

            assert.Equal(t, tt.expectedNode, successor.ID)
        })
    }
}

func (utr *UnitTestRunner) TestSignalProtocolEncryption(t *testing.T) {
    alice := NewSignalClient("alice")
    bob := NewSignalClient("bob")

    // Test case 1: Basic encryption/decryption
    t.Run("basic_encryption_decryption", func(t *testing.T) {
        plaintext := []byte("Hello from Alice to Bob")

        // Alice encrypts message for Bob
        encrypted, err := alice.EncryptMessage(bob.IdentityKey.PublicKey, plaintext)
        require.NoError(t, err)
        require.NotNil(t, encrypted)

        // Verify ciphertext != plaintext
        assert.NotEqual(t, plaintext, encrypted.Ciphertext)

        // Bob decrypts message from Alice
        decrypted, err := bob.DecryptMessage(alice.IdentityKey.PublicKey, encrypted)
        require.NoError(t, err)

        // Verify plaintext recovered
        assert.Equal(t, plaintext, decrypted)
    })

    // Test case 2: Forward secrecy (ratcheting)
    t.Run("forward_secrecy_ratcheting", func(t *testing.T) {
        messages := [][]byte{
            []byte("Message 1"),
            []byte("Message 2"),
            []byte("Message 3"),
        }

        encryptedMessages := make([]*EncryptedMessage, len(messages))

        // Alice sends 3 messages to Bob
        for i, msg := range messages {
            encrypted, err := alice.EncryptMessage(bob.IdentityKey.PublicKey, msg)
            require.NoError(t, err)
            encryptedMessages[i] = encrypted
        }

        // Verify each message uses different ephemeral key (ratcheting)
        for i := 1; i < len(encryptedMessages); i++ {
            assert.NotEqual(t,
                encryptedMessages[i-1].EphemeralKey,
                encryptedMessages[i].EphemeralKey,
                "Forward secrecy violated: same ephemeral key reused")
        }

        // Bob decrypts all messages
        for i, encrypted := range encryptedMessages {
            decrypted, err := bob.DecryptMessage(alice.IdentityKey.PublicKey, encrypted)
            require.NoError(t, err)
            assert.Equal(t, messages[i], decrypted)
        }
    })

    // Test case 3: Post-compromise security
    t.Run("post_compromise_security", func(t *testing.T) {
        // Send initial message
        msg1 := []byte("Before compromise")
        encrypted1, err := alice.EncryptMessage(bob.IdentityKey.PublicKey, msg1)
        require.NoError(t, err)

        // Simulate key compromise (attacker gets current session key)
        compromisedKey := alice.currentRatchetKey

        // Continue conversation (triggers ratchet)
        msg2 := []byte("After compromise")
        encrypted2, err := alice.EncryptMessage(bob.IdentityKey.PublicKey, msg2)
        require.NoError(t, err)

        // Verify new message uses different key (post-compromise security)
        assert.NotEqual(t, compromisedKey, alice.currentRatchetKey,
            "Post-compromise security failed: key not rotated")

        // Attacker cannot decrypt new message with compromised key
        _, err = DecryptWithKey(compromisedKey, encrypted2)
        assert.Error(t, err, "Attacker successfully decrypted with compromised key")
    })
}

func (utr *UnitTestRunner) TestClientSideRouting(t *testing.T) {
    tests := []struct {
        name              string
        tierConfig        *TierConfig
        routingTable      *OptimizedRoutingTable
        request           *RoutingRequest
        expectedProvider  string
        expectedScore     float64
    }{
        {
            name: "premium_reliability_tier_selects_99.9_uptime",
            tierConfig: &TierConfig{
                TierType:          TierPremiumReliability,
                CostWeight:        0.1,
                PerformanceWeight: 0.2,
                ReliabilityWeight: 0.7,
            },
            routingTable: &OptimizedRoutingTable{
                Providers: []*ProviderMetrics{
                    {
                        ProviderID:   1,
                        Name:         "provider-reliable",
                        Availability: 0.999,
                        AvgLatency:   150 * time.Millisecond,
                        PricePerToken: decimal.NewFromFloat(0.0020),
                    },
                    {
                        ProviderID:   2,
                        Name:         "provider-cheap",
                        Availability: 0.95,
                        AvgLatency:   100 * time.Millisecond,
                        PricePerToken: decimal.NewFromFloat(0.0010),
                    },
                },
            },
            request: &RoutingRequest{
                Model: "gpt-4",
            },
            expectedProvider: "provider-reliable",
            expectedScore:    0.9, // High reliability weight dominates
        },
        {
            name: "economy_tier_selects_cheapest",
            tierConfig: &TierConfig{
                TierType:          TierEconomy,
                CostWeight:        0.7,
                PerformanceWeight: 0.2,
                ReliabilityWeight: 0.1,
            },
            routingTable: &OptimizedRoutingTable{
                Providers: []*ProviderMetrics{
                    {
                        ProviderID:   1,
                        Name:         "provider-expensive",
                        Availability: 0.999,
                        AvgLatency:   50 * time.Millisecond,
                        PricePerToken: decimal.NewFromFloat(0.0030),
                    },
                    {
                        ProviderID:   2,
                        Name:         "provider-cheap",
                        Availability: 0.95,
                        AvgLatency:   150 * time.Millisecond,
                        PricePerToken: decimal.NewFromFloat(0.0010),
                    },
                },
            },
            request: &RoutingRequest{
                Model: "gpt-3.5-turbo",
            },
            expectedProvider: "provider-cheap",
            expectedScore:    0.85, // Cost weight dominates
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            routingEngine := NewClientSideRoutingEngine(tt.tierConfig)
            routingEngine.routingTable = tt.routingTable

            selection, err := routingEngine.SelectProvider(tt.request)
            require.NoError(t, err)
            require.NotNil(t, selection)

            assert.Equal(t, tt.expectedProvider, selection.Provider.Name)
            assert.InDelta(t, tt.expectedScore, selection.Score, 0.15)
        })
    }
}

func (utr *UnitTestRunner) TestSemanticCache(t *testing.T) {
    cache := NewSemanticCache(&SemanticCacheConfig{
        MaxEntries:         1000,
        SimilarityThreshold: 0.95,
        EmbeddingModel:     "text-embedding-ada-002",
    })

    // Test case 1: Exact cache hit
    t.Run("exact_cache_hit", func(t *testing.T) {
        prompt := "What is the capital of France?"
        response := &CompletionResponse{
            Choices: []Choice{{Text: "The capital of France is Paris."}},
        }

        cache.Set(prompt, response)

        cached, found := cache.Get(prompt)
        assert.True(t, found)
        assert.Equal(t, response, cached)
    })

    // Test case 2: Semantic similarity hit
    t.Run("semantic_similarity_hit", func(t *testing.T) {
        originalPrompt := "What is the capital city of France?"
        response := &CompletionResponse{
            Choices: []Choice{{Text: "Paris is the capital of France."}},
        }

        cache.Set(originalPrompt, response)

        // Similar but not identical prompt
        similarPrompt := "Tell me the capital of France"
        cached, found := cache.Get(similarPrompt)

        assert.True(t, found, "Semantic cache should hit on similar prompts")
        assert.Equal(t, response, cached)
    })

    // Test case 3: Cache miss (low similarity)
    t.Run("cache_miss_low_similarity", func(t *testing.T) {
        prompt1 := "What is quantum computing?"
        response1 := &CompletionResponse{
            Choices: []Choice{{Text: "Quantum computing uses quantum bits..."}},
        }

        cache.Set(prompt1, response1)

        // Completely different prompt
        prompt2 := "What is the weather today?"
        _, found := cache.Get(prompt2)

        assert.False(t, found, "Cache should miss on dissimilar prompts")
    })
}

func (utr *UnitTestRunner) TestContributionMeasurement(t *testing.T) {
    tracker := NewContributionTracker(&ContributionConfig{
        CPUWeight:       0.25,
        BandwidthWeight: 0.35,
        StorageWeight:   0.20,
        UptimeWeight:    0.20,
    })

    tests := []struct {
        name          string
        contribution  *ContributionMeasurement
        expectedReward decimal.Decimal
    }{
        {
            name: "high_contribution_all_resources",
            contribution: &ContributionMeasurement{
                CPUHours:       decimal.NewFromFloat(100),
                BandwidthGB:    decimal.NewFromFloat(500),
                StorageGB:      decimal.NewFromFloat(1000),
                UptimeHours:    decimal.NewFromFloat(720), // 30 days
            },
            expectedReward: decimal.NewFromFloat(150.0), // TAI tokens
        },
        {
            name: "bandwidth_heavy_contribution",
            contribution: &ContributionMeasurement{
                CPUHours:       decimal.NewFromFloat(10),
                BandwidthGB:    decimal.NewFromFloat(2000),
                StorageGB:      decimal.NewFromFloat(100),
                UptimeHours:    decimal.NewFromFloat(720),
            },
            expectedReward: decimal.NewFromFloat(120.0),
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            reward := tracker.CalculateReward(tt.contribution)

            assert.NotNil(t, reward)
            assert.True(t, reward.GreaterThan(decimal.Zero))
            assert.InDelta(t, tt.expectedReward.InexactFloat64(), reward.InexactFloat64(), 20.0)
        })
    }
}

func (utr *UnitTestRunner) calculateCoverage() float64 {
    cmd := exec.Command("go", "test", "-cover", "./...")
    output, err := cmd.CombinedOutput()
    if err != nil {
        log.WithError(err).Warn("Failed to calculate coverage")
        return 0
    }

    coverageRegex := regexp.MustCompile(`coverage: ([\d.]+)%`)
    matches := coverageRegex.FindStringSubmatch(string(output))
    if len(matches) < 2 {
        return 0
    }

    coverage, _ := strconv.ParseFloat(matches[1], 64)
    return coverage
}
```

#### 10.1.3 P2P Protocol Integration Testing

**Why P2P Protocol Tests**: Unit tests cannot validate the emergent behaviors of distributed protocols like DHT convergence, gossip propagation delays, or WireGuard mesh routing. These tests use multiple real protocol instances to verify correct interaction without full network simulation.

**Test Scope**: Tests run with 5-20 real peer instances communicating over localhost loopback to validate protocol correctness while maintaining fast execution (<30s per test).

```go
type P2PProtocolTestRunner struct {
    testNodes       []*TestPeerNode
    bootstrap       *BootstrapNode
    network         *LocalhostNetwork
    config          *TestConfig
}

type TestPeerNode struct {
    ID              NodeID
    dht             *ChordNode
    gossip          *GossipProtocol
    wireGuard       *WireGuardMesh
    signal          *SignalProtocolManager

    // Test instrumentation
    messageLog      []*ReceivedMessage
    stateSnapshots  []*NodeStateSnapshot
    metrics         *PeerMetrics
}

type LocalhostNetwork struct {
    peers          map[NodeID]*TestPeerNode
    latency        time.Duration
    packetLoss     float64
    partitions     []*NetworkPartition
    messageRouter  *TestMessageRouter
}

type NetworkPartition struct {
    PartitionA []NodeID
    PartitionB []NodeID
    StartTime  time.Time
    EndTime    *time.Time
}

func NewP2PProtocolTestRunner(config *TestConfig) *P2PProtocolTestRunner {
    return &P2PProtocolTestRunner{
        testNodes: make([]*TestPeerNode, 0),
        network:   NewLocalhostNetwork(config.NetworkLatency, config.PacketLoss),
        config:    config,
    }
}

func (ptr *P2PProtocolTestRunner) Run() (*SuiteResult, error) {
    result := &SuiteResult{
        Name:     "p2p-protocol",
        Failures: make([]*TestFailure, 0),
    }

    startTime := time.Now()

    testCases := []struct {
        name string
        fn   func(*testing.T) error
    }{
        {"TestDHTBootstrap", ptr.TestDHTBootstrap},
        {"TestDHTStabilization", ptr.TestDHTStabilization},
        {"TestDHTLookupConvergence", ptr.TestDHTLookupConvergence},
        {"TestGossipPropagation", ptr.TestGossipPropagation},
        {"TestGossipConvergence", ptr.TestGossipConvergence},
        {"TestWireGuardMeshFormation", ptr.TestWireGuardMeshFormation},
        {"TestSignalProtocolSessionEstablishment", ptr.TestSignalProtocolSessionEstablishment},
        {"TestRoutingTableSync", ptr.TestRoutingTableSync},
    }

    for _, tc := range testCases {
        t := &testing.T{}
        err := tc.fn(t)

        result.TestCount++

        if err != nil || t.Failed() {
            result.FailCount++
            result.Failures = append(result.Failures, &TestFailure{
                TestName:  tc.name,
                Message:   fmt.Sprintf("Test failed: %v", err),
                Timestamp: time.Now(),
                Severity:  SeverityHigh,
            })
        } else {
            result.PassCount++
        }
    }

    result.Duration = time.Since(startTime)

    return result, nil
}

func (ptr *P2PProtocolTestRunner) TestDHTBootstrap(t *testing.T) error {
    // Create bootstrap node
    ptr.bootstrap = ptr.createBootstrapNode()
    if err := ptr.bootstrap.Start(); err != nil {
        return fmt.Errorf("failed to start bootstrap: %w", err)
    }
    defer ptr.bootstrap.Stop()

    // Create 10 test peer nodes
    nodeCount := 10
    for i := 0; i < nodeCount; i++ {
        node, err := ptr.createTestPeerNode(i)
        if err != nil {
            return fmt.Errorf("failed to create node %d: %w", i, err)
        }
        ptr.testNodes = append(ptr.testNodes, node)
    }

    // Join all nodes to DHT via bootstrap
    for i, node := range ptr.testNodes {
        err := node.dht.Join([]string{ptr.bootstrap.Address})
        if err != nil {
            return fmt.Errorf("node %d failed to join: %w", i, err)
        }
    }

    // Wait for stabilization
    time.Sleep(5 * time.Second)

    // Verify all nodes have valid successor pointers
    for i, node := range ptr.testNodes {
        if node.dht.successor == nil {
            t.Errorf("Node %d has nil successor", i)
        }

        // Verify finger table populated
        emptyEntries := 0
        for _, entry := range node.dht.fingerTable {
            if entry == nil {
                emptyEntries++
            }
        }

        if emptyEntries > 100 { // Allow some unpopulated entries
            t.Errorf("Node %d finger table mostly empty: %d/160 empty", i, emptyEntries)
        }
    }

    return nil
}

func (ptr *P2PProtocolTestRunner) TestGossipPropagation(t *testing.T) error {
    // Setup network with 20 nodes
    nodeCount := 20
    for i := 0; i < nodeCount; i++ {
        node, err := ptr.createTestPeerNode(i)
        if err != nil {
            return fmt.Errorf("failed to create node %d: %w", i, err)
        }
        ptr.testNodes = append(ptr.testNodes, node)
    }

    // Initialize gossip protocol on each node
    for _, node := range ptr.testNodes {
        node.gossip = NewGossipProtocol(&GossipConfig{
            Fanout:          6,
            GossipInterval:  30 * time.Second,
            PushPullEnabled: true,
        })
        node.gossip.Start()
    }

    // Inject state update on node 0
    testUpdate := &RoutingTableUpdate{
        ProviderID:    1,
        Availability:  0.987,
        AvgLatency:    125 * time.Millisecond,
        Timestamp:     time.Now(),
    }

    ptr.testNodes[0].gossip.BroadcastUpdate(testUpdate)

    // Wait for gossip propagation
    // With fanout=6, log₆(20) ≈ 1.67 rounds
    // At 30s intervals, should propagate within ~1 minute
    // Use 2 minutes for safety margin
    time.Sleep(2 * time.Minute)

    // Verify all nodes received the update
    receivedCount := 0
    for i, node := range ptr.testNodes {
        if node.gossip.HasUpdate(testUpdate.Hash()) {
            receivedCount++
        } else {
            t.Logf("Node %d did not receive gossip update", i)
        }
    }

    // Expect 99%+ propagation (19+ of 20 nodes)
    expectedMin := int(float64(nodeCount) * 0.99)
    if receivedCount < expectedMin {
        t.Errorf("Gossip propagation insufficient: %d/%d nodes received update (expected >=%d)",
            receivedCount, nodeCount, expectedMin)
    }

    return nil
}

func (ptr *P2PProtocolTestRunner) TestRoutingTableSync(t *testing.T) error {
    // Setup network with 10 nodes
    nodeCount := 10
    for i := 0; i < nodeCount; i++ {
        node, err := ptr.createTestPeerNode(i)
        if err != nil {
            return fmt.Errorf("failed to create node %d: %w", i, err)
        }
        ptr.testNodes = append(ptr.testNodes, node)
    }

    // Simulate routing table updates on different nodes
    updates := []*RoutingTableUpdate{
        {ProviderID: 1, Availability: 0.995, AvgLatency: 100 * time.Millisecond},
        {ProviderID: 2, Availability: 0.980, AvgLatency: 150 * time.Millisecond},
        {ProviderID: 3, Availability: 0.999, AvgLatency: 80 * time.Millisecond},
    }

    // Distribute updates across nodes 0, 1, 2
    for i, update := range updates {
        ptr.testNodes[i].gossip.BroadcastUpdate(update)
    }

    // Wait for convergence
    time.Sleep(3 * time.Minute)

    // Verify all nodes have consistent routing table state
    for i := 1; i < len(ptr.testNodes); i++ {
        rt0 := ptr.testNodes[0].gossip.GetRoutingTableSnapshot()
        rtI := ptr.testNodes[i].gossip.GetRoutingTableSnapshot()

        consistency := calculateRoutingTableConsistency(rt0, rtI)
        if consistency < 0.95 {
            t.Errorf("Routing table consistency between node 0 and node %d: %.2f%% (expected >=95%%)",
                i, consistency*100)
        }
    }

    return nil
}

func (ptr *P2PProtocolTestRunner) createTestPeerNode(index int) (*TestPeerNode, error) {
    nodeID := hashNodeID(fmt.Sprintf("test-peer-%d", index))

    node := &TestPeerNode{
        ID:             nodeID,
        messageLog:     make([]*ReceivedMessage, 0),
        stateSnapshots: make([]*NodeStateSnapshot, 0),
        metrics:        NewPeerMetrics(),
    }

    // Initialize P2P components
    node.dht = NewChordNode(nodeID)
    node.gossip = NewGossipProtocol(&GossipConfig{Fanout: 6})
    node.wireGuard = NewWireGuardMesh(nodeID)
    node.signal = NewSignalProtocolManager()

    ptr.network.RegisterPeer(node)

    return node, nil
}

func calculateRoutingTableConsistency(rt1, rt2 *RoutingTableSnapshot) float64 {
    if len(rt1.Providers) != len(rt2.Providers) {
        return 0.0
    }

    matchingEntries := 0
    totalEntries := len(rt1.Providers)

    for providerID, metrics1 := range rt1.Providers {
        metrics2, exists := rt2.Providers[providerID]
        if !exists {
            continue
        }

        // Allow 5% tolerance on metrics due to gossip timing
        if math.Abs(metrics1.Availability-metrics2.Availability) < 0.05 &&
            math.Abs(float64(metrics1.AvgLatency-metrics2.AvgLatency)) < float64(50*time.Millisecond) {
            matchingEntries++
        }
    }

    return float64(matchingEntries) / float64(totalEntries)
}
```

#### 10.1.4 Network Simulation Testing

**Why Network Simulation**: Real-world P2P networks face adversarial conditions: Byzantine nodes broadcasting false data, network partitions splitting the DHT, coordinated Sybil attacks inflating contribution metrics. Simulations validate system behavior under these conditions without requiring expensive multi-region deployments.

**Simulation Scale**: 100-1000 virtual nodes with configurable Byzantine ratio (0%-33%), packet loss (0%-10%), and partition scenarios.

**Testing Approach Options**:

**Option A: Pure Simulation (Recommended for MVP)** ⭐

**Pros**:
- ✅ Fast execution (<5 minutes for 1000-node simulation)
- ✅ Deterministic and reproducible
- ✅ No infrastructure costs
- ✅ Easy CI/CD integration

**Cons**:
- ⚠️ Simplified network model (may miss real-world edge cases)
- ⚠️ No real OS/network stack validation

**Option B: Docker-Based Multi-Container Simulation**

**Pros**:
- ✅ Real network stack and OS behavior
- ✅ Accurate latency/bandwidth modeling
- ✅ Tests actual deployment artifacts

**Cons**:
- ⚠️ Slow execution (30+ minutes for 100 nodes)
- ⚠️ High resource requirements (100+ containers)
- ⚠️ Complex CI/CD setup

**Option C: Hybrid (Simulation + Spot Docker Tests)**

**Pros**:
- ✅ Fast simulation for most tests
- ✅ Real-world validation on critical paths
- ✅ Balanced resource usage

**Cons**:
- ⚠️ Increased test suite complexity
- ⚠️ Maintenance overhead

**RECOMMENDATION**: Use Option A (Pure Simulation) for initial development and CI/CD, with Option C (Hybrid) added before production deployment.

```go
type NetworkSimulationRunner struct {
    simulator       *NetworkSimulator
    byzantineNodes  []*ByzantineNode
    honestNodes     []*HonestNode
    config          *TestConfig
    metrics         *SimulationMetrics
}

type NetworkSimulator struct {
    nodes           map[NodeID]*SimulatedNode
    eventQueue      *EventQueue
    currentTime     time.Time
    config          *SimulationConfig

    // Network conditions
    baseLatency     time.Duration
    packetLoss      float64
    partitions      []*NetworkPartition

    // Attack scenarios
    byzantineRatio  float64
    sybilCount      int
}

type SimulatedNode struct {
    // Node identity
    ID              NodeID
    Type            NodeType // Honest, Byzantine, Sybil

    // P2P components (real implementations)
    dht             *ChordNode
    gossip          *GossipProtocol
    routingEngine   *ClientSideRoutingEngine

    // Simulation state
    messageQueue    chan *Message
    incomingMsgs    []*Message
    outgoingMsgs    []*Message

    // Metrics
    sentBytes       uint64
    receivedBytes   uint64
    cpuCycles       uint64
}

type SimulationConfig struct {
    NodeCount          int
    ByzantineRatio     float64
    SybilCount         int
    SimulationDuration time.Duration
    BaseLatency        time.Duration
    PacketLoss         float64
    PartitionScenario  *PartitionScenario
}

type PartitionScenario struct {
    StartTime       time.Duration
    Duration        time.Duration
    PartitionSizeA  int
    PartitionSizeB  int
}

func NewNetworkSimulationRunner(config *TestConfig) *NetworkSimulationRunner {
    simConfig := &SimulationConfig{
        NodeCount:          config.SimulatedNodes,
        ByzantineRatio:     config.ByzantineRatio,
        SimulationDuration: 10 * time.Minute,
        BaseLatency:        config.NetworkLatency,
        PacketLoss:         config.PacketLoss,
    }

    return &NetworkSimulationRunner{
        simulator:      NewNetworkSimulator(simConfig),
        byzantineNodes: make([]*ByzantineNode, 0),
        honestNodes:    make([]*HonestNode, 0),
        config:         config,
        metrics:        NewSimulationMetrics(),
    }
}

func (nsr *NetworkSimulationRunner) Run() (*SuiteResult, error) {
    result := &SuiteResult{
        Name:     "network-sim",
        Failures: make([]*TestFailure, 0),
    }

    startTime := time.Now()

    testScenarios := []struct {
        name string
        fn   func(*testing.T) error
    }{
        {"TestDHTConsistencyUnderChurn", nsr.TestDHTConsistencyUnderChurn},
        {"TestByzantineResistance", nsr.TestByzantineResistance},
        {"TestSybilAttackDetection", nsr.TestSybilAttackDetection},
        {"TestNetworkPartitionRecovery", nsr.TestNetworkPartitionRecovery},
        {"TestGossipConvergenceAtScale", nsr.TestGossipConvergenceAtScale},
        {"TestRoutingTablePoisoning", nsr.TestRoutingTablePoisoning},
    }

    for _, scenario := range testScenarios {
        t := &testing.T{}
        err := scenario.fn(t)

        result.TestCount++

        if err != nil || t.Failed() {
            result.FailCount++
            result.Failures = append(result.Failures, &TestFailure{
                TestName:  scenario.name,
                Message:   fmt.Sprintf("Simulation failed: %v", err),
                Timestamp: time.Now(),
                Severity:  SeverityHigh,
            })
        } else {
            result.PassCount++
        }
    }

    result.Duration = time.Since(startTime)

    return result, nil
}

func (nsr *NetworkSimulationRunner) TestByzantineResistance(t *testing.T) error {
    // Configure simulation with 30% Byzantine nodes
    nsr.simulator.config.ByzantineRatio = 0.30
    nsr.simulator.config.NodeCount = 100

    if err := nsr.simulator.Initialize(); err != nil {
        return fmt.Errorf("failed to initialize simulation: %w", err)
    }

    // Byzantine attack: broadcast false routing table data
    // (claim 1ms latency and 100% uptime when real metrics are much worse)
    byzantineUpdate := &RoutingTableUpdate{
        ProviderID:    1,
        Availability:  1.0,    // FALSE: actual is 0.85
        AvgLatency:    1 * time.Millisecond, // FALSE: actual is 500ms
        Timestamp:     time.Now(),
    }

    for _, node := range nsr.simulator.GetByzantineNodes() {
        node.BroadcastMaliciousUpdate(byzantineUpdate)
    }

    // Run simulation for 10 minutes
    if err := nsr.simulator.Run(); err != nil {
        return fmt.Errorf("simulation failed: %w", err)
    }

    // Verify honest nodes reject Byzantine data
    honestNodes := nsr.simulator.GetHonestNodes()
    corruptedNodes := 0

    for _, node := range honestNodes {
        rt := node.routingEngine.routingTable
        provider := rt.GetProvider(1)

        // Check if honest node accepted Byzantine data
        if provider.Availability > 0.95 || provider.AvgLatency < 100*time.Millisecond {
            corruptedNodes++
        }
    }

    // Expect <5% of honest nodes to accept Byzantine data
    // (Some acceptance is acceptable due to initial propagation)
    corruptionRatio := float64(corruptedNodes) / float64(len(honestNodes))
    if corruptionRatio > 0.05 {
        t.Errorf("Byzantine resistance failed: %.2f%% of honest nodes corrupted (expected <5%%)",
            corruptionRatio*100)
    }

    return nil
}

func (nsr *NetworkSimulationRunner) TestNetworkPartitionRecovery(t *testing.T) error {
    nsr.simulator.config.NodeCount = 100
    nsr.simulator.config.PartitionScenario = &PartitionScenario{
        StartTime:      3 * time.Minute,
        Duration:       2 * time.Minute,
        PartitionSizeA: 40,
        PartitionSizeB: 60,
    }

    if err := nsr.simulator.Initialize(); err != nil {
        return fmt.Errorf("failed to initialize simulation: %w", err)
    }

    // Run simulation with partition
    if err := nsr.simulator.Run(); err != nil {
        return fmt.Errorf("simulation failed: %w", err)
    }

    // Verify DHT recovered after partition healed
    recoveryTime := nsr.metrics.PartitionRecoveryTime
    if recoveryTime > 5*time.Minute {
        t.Errorf("DHT recovery too slow: %v (expected <5 minutes)", recoveryTime)
    }

    // Verify routing table consistency after recovery
    consistency := nsr.metrics.FinalRoutingTableConsistency
    if consistency < 0.95 {
        t.Errorf("Routing table consistency after partition: %.2f%% (expected >=95%%)",
            consistency*100)
    }

    return nil
}

func (nsr *NetworkSimulationRunner) TestSybilAttackDetection(t *testing.T) error {
    nsr.simulator.config.NodeCount = 100
    nsr.simulator.config.SybilCount = 50 // 50 colluding Sybil nodes

    if err := nsr.simulator.Initialize(); err != nil {
        return fmt.Errorf("failed to initialize simulation: %w", err)
    }

    // Sybil attack: Create 50 fake node identities controlled by single attacker
    // attempting to inflate contribution metrics via self-attestation
    sybilContribution := &ContributionProof{
        NodeID:          "sybil-master",
        CPUHours:        decimal.NewFromFloat(10000), // INFLATED
        BandwidthGB:     decimal.NewFromFloat(50000), // INFLATED
        PeerAttestations: generateFakeSybilAttestations(50),
    }

    // Run simulation
    if err := nsr.simulator.Run(); err != nil {
        return fmt.Errorf("simulation failed: %w", err)
    }

    // Verify Sybil nodes detected and contribution rejected
    accepted := nsr.simulator.GetContributionManager().IsAccepted(sybilContribution)
    if accepted {
        t.Error("Sybil attack succeeded: fraudulent contribution accepted")
    }

    detectionRate := nsr.metrics.SybilDetectionRate
    if detectionRate < 0.90 {
        t.Errorf("Sybil detection rate too low: %.2f%% (expected >=90%%)",
            detectionRate*100)
    }

    return nil
}
```

#### 10.1.5 Security and Fuzzing Tests

**Why Security Testing**: P2P clients are distributed to thousands of users, making them high-value targets for reverse engineering, key extraction, and protocol exploitation. Security tests validate anti-tampering measures and cryptographic implementations against adversarial inputs.

**Testing Approaches**:

1. **Cryptographic Fuzzing**: Test Signal Protocol, AES-GCM, ed25519 with malformed inputs
2. **Anti-Reverse-Engineering Validation**: Verify obfuscation effectiveness using IDA Pro, Ghidra
3. **Key Extraction Resistance**: Attempt to dump keys from running client memory
4. **Protocol Fuzzing**: Send malformed DHT/Gossip messages to test parser robustness

```go
type SecurityTestRunner struct {
    fuzzer          *CryptoFuzzer
    reTester        *ReverseEngineeringTester
    keyExtractor    *KeyExtractionTester
    protocolFuzzer  *ProtocolFuzzer
    config          *TestConfig
}

func NewSecurityTestRunner(config *TestConfig) *SecurityTestRunner {
    return &SecurityTestRunner{
        fuzzer:         NewCryptoFuzzer(),
        reTester:       NewReverseEngineeringTester(),
        keyExtractor:   NewKeyExtractionTester(),
        protocolFuzzer: NewProtocolFuzzer(),
        config:         config,
    }
}

func (str *SecurityTestRunner) Run() (*SuiteResult, error) {
    result := &SuiteResult{
        Name:     "security",
        Failures: make([]*TestFailure, 0),
    }

    startTime := time.Now()

    testCases := []struct {
        name string
        fn   func(*testing.T) error
    }{
        {"TestCryptographicFuzzing", str.TestCryptographicFuzzing},
        {"TestAntiReverseEngineering", str.TestAntiReverseEngineering},
        {"TestKeyExtractionResistance", str.TestKeyExtractionResistance},
        {"TestProtocolFuzzing", str.TestProtocolFuzzing},
        {"TestTimingAttackResistance", str.TestTimingAttackResistance},
    }

    for _, tc := range testCases {
        t := &testing.T{}
        err := tc.fn(t)

        result.TestCount++

        if err != nil || t.Failed() {
            result.FailCount++
            result.Failures = append(result.Failures, &TestFailure{
                TestName:  tc.name,
                Message:   fmt.Sprintf("Security test failed: %v", err),
                Timestamp: time.Now(),
                Severity:  SeverityCritical,
            })
        } else {
            result.PassCount++
        }
    }

    result.Duration = time.Since(startTime)

    return result, nil
}

func (str *SecurityTestRunner) TestCryptographicFuzzing(t *testing.T) error {
    signalClient := NewSignalClient("fuzz-test")

    // Generate 10,000 random inputs for fuzzing
    fuzzInputs := str.fuzzer.GenerateInputs(10000, &FuzzConfig{
        MinSize: 0,
        MaxSize: 10 * 1024 * 1024, // 10MB
        IncludeEdgeCases: true,
    })

    crashes := 0
    hangs := 0

    for i, input := range fuzzInputs {
        // Test encryption with fuzzy input
        done := make(chan bool, 1)
        var err error

        go func() {
            _, err = signalClient.EncryptMessage(input.PublicKey, input.Plaintext)
            done <- true
        }()

        select {
        case <-done:
            if err == nil && !input.ShouldSucceed {
                t.Logf("Fuzzing: unexpected success on malformed input %d", i)
            }
        case <-time.After(1 * time.Second):
            hangs++
            t.Errorf("Fuzzing: hang detected on input %d", i)
        }
    }

    if crashes > 0 {
        t.Errorf("Cryptographic fuzzing found %d crashes", crashes)
    }

    if hangs > 0 {
        t.Errorf("Cryptographic fuzzing found %d hangs", hangs)
    }

    return nil
}

func (str *SecurityTestRunner) TestAntiReverseEngineering(t *testing.T) error {
    // Test 1: Verify binary obfuscation effectiveness
    binaryPath := "./bin/tanglement-client"

    // Run IDA Pro analysis (requires IDA Pro installed)
    idaAnalysis, err := str.reTester.RunIDAAnalysis(binaryPath)
    if err != nil {
        return fmt.Errorf("IDA analysis failed: %w", err)
    }

    // Check for exposed function symbols (should be obfuscated)
    sensitiveSymbols := []string{
        "EncryptRoutingTable",
        "DecryptRoutingTable",
        "StoreAPIKey",
        "SignalProtocol_DeriveKey",
    }

    exposedSymbols := 0
    for _, symbol := range sensitiveSymbols {
        if idaAnalysis.ContainsSymbol(symbol) {
            exposedSymbols++
            t.Logf("Exposed sensitive symbol: %s", symbol)
        }
    }

    if exposedSymbols > 0 {
        t.Errorf("Anti-RE failed: %d sensitive symbols exposed", exposedSymbols)
    }

    // Test 2: Verify control flow obfuscation
    controlFlowComplexity := idaAnalysis.CalculateControlFlowComplexity()
    if controlFlowComplexity < 100 {
        t.Errorf("Control flow complexity too low: %d (expected >=100 for obfuscation)",
            controlFlowComplexity)
    }

    return nil
}
```

### 10.2 Language Binding Testing

**Why Language Binding Tests**: The client SDK provides Python, TypeScript, Rust, and Java bindings via cgo. Each language binding must be tested independently to validate correct FFI behavior, memory management, and API compatibility.

**Test Coverage**: Each language binding requires:
- Basic client initialization and configuration
- Completion and chat API calls
- Error handling and exception propagation
- Memory leak detection (especially C/Go ↔ language boundary)

```python
# Python binding tests (tests/python/test_tanglement_client.py)

import pytest
import tanglement

def test_client_initialization():
    config = {
        "tier": "economy",
        "bootstrap_nodes": ["bootstrap1.tanglement.ai:4001"],
    }

    client = tanglement.Client(config)
    assert client is not None
    assert client.tier == "economy"

def test_completion_api():
    client = tanglement.Client({
        "tier": "premium_performance",
        "bootstrap_nodes": ["bootstrap1.tanglement.ai:4001"],
    })

    response = client.create_completion(
        model="gpt-4",
        prompt="What is the capital of France?",
        max_tokens=50
    )

    assert response is not None
    assert len(response.choices) > 0
    assert "Paris" in response.choices[0].text

def test_error_handling():
    client = tanglement.Client({
        "tier": "economy",
        "bootstrap_nodes": ["bootstrap1.tanglement.ai:4001"],
    })

    with pytest.raises(tanglement.RoutingError):
        client.create_completion(
            model="nonexistent-model",
            prompt="test",
            max_tokens=10
        )

def test_memory_leak():
    # Create and destroy 1000 clients to detect memory leaks
    import gc
    import tracemalloc

    tracemalloc.start()
    initial_memory = tracemalloc.get_traced_memory()[0]

    for i in range(1000):
        client = tanglement.Client({"tier": "economy"})
        client.close()
        gc.collect()

    final_memory = tracemalloc.get_traced_memory()[0]
    memory_increase = final_memory - initial_memory

    # Allow 10MB memory increase (reasonable for initialization overhead)
    assert memory_increase < 10 * 1024 * 1024, f"Memory leak detected: {memory_increase} bytes"
```

### 10.3 Continuous Integration and Testing Infrastructure

**Why CI/CD Integration**: Automated testing on every commit ensures P2P protocol changes don't introduce regressions. Given the complexity of distributed testing, CI must balance coverage with execution time and resource costs.

**CI Strategy**:

1. **Pull Request Tests** (fast, <5 minutes):
   - Unit tests (all modules)
   - Cryptographic tests
   - Basic P2P protocol tests (5 nodes)

2. **Merge to Main Tests** (moderate, <20 minutes):
   - Full P2P protocol tests (20 nodes)
   - Network simulation (100 nodes)
   - Security fuzzing (1000 iterations)

3. **Nightly Tests** (comprehensive, <2 hours):
   - Large-scale network simulation (1000 nodes)
   - Extended fuzzing (100k iterations)
   - Language binding tests (all languages)
   - Performance regression tests

```yaml
# .github/workflows/test.yml

name: Tanglement.ai P2P Client SDK Tests

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '0 0 * * *' # Nightly

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-go@v4
        with:
          go-version: '1.21'
      - name: Run unit tests
        run: go test -v -cover ./...
      - name: Upload coverage
        uses: codecov/codecov-action@v3

  p2p-protocol-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-go@v4
        with:
          go-version: '1.21'
      - name: Run P2P protocol tests
        run: go test -v ./tests/p2p -nodes=20 -timeout=20m

  network-simulation:
    runs-on: ubuntu-latest
    if: github.event_name == 'push' || github.event_name == 'schedule'
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-go@v4
        with:
          go-version: '1.21'
      - name: Run network simulation
        run: |
          go test -v ./tests/simulation \
            -nodes=1000 \
            -byzantine=0.3 \
            -timeout=2h

  language-bindings:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        language: [python, typescript, rust]
    steps:
      - uses: actions/checkout@v3
      - name: Setup ${{ matrix.language }}
        uses: actions/setup-${{ matrix.language }}@v4
      - name: Build Go library
        run: go build -buildmode=c-shared -o libtanglement.so
      - name: Run ${{ matrix.language }} tests
        run: |
          cd bindings/${{ matrix.language }}
          ./run_tests.sh
```

### 10.4 Boundary, Performance, and Feasibility Testing

**Context**: This section defines a structured testing approach to validate the technical and economic feasibility of Tanglement.ai's token marketplace integration, routing optimizations, and **fully decentralized P2P infrastructure with zero company-owned servers in the request path**.

A core objective is to determine the minimum infrastructure required—ideally none (Model 1: Fully Distributed) or minimal bootstrap only (Model 2: ~$50-65/month)—to achieve performance and reliability targets while maximizing profit margins and minimizing regulatory exposure.

#### 10.4.1 Test Environment Parameters

**Token Marketplaces**:
- **Amazon Bedrock (AWS)**: Multi-model marketplace with unified billing
- **Azure OpenAI Service**: Enterprise LLM access with SLA guarantees
- **Anthropic Direct API**: Direct provider access for baseline comparison

**API Endpoints** *(Status: Needs Mapping)*:
- **Confirmed**: Anthropic Claude API
- **Under Evaluation**: Bedrock model routing, Azure OpenAI regional endpoints

**Targeted Optimizations**:

*Token Use Optimizations*:
- **Speed**: Latency reduction through intelligent routing and caching
- **Reliability**: Uptime improvement via multi-provider failover
- **Cost**: Price reduction through economy tier subsidization

*Token Purchase Optimizations*:
- **Speed**: Transaction throughput for token acquisition
- **Reliability**: Payment processing success rate and blockchain finality
- **Cost**: Gas fees and transaction costs

#### 10.4.2 Core Research Questions

##### Question 1: Optimization Feasibility Range
**Question**: Which proposed optimizations are feasible given real-world provider constraints?

**Expected Outcome**: Classification of each optimization as Fully Feasible, Partially Feasible, or Infeasible with documented evidence.

**Success Indicators**:
- Cache hit rates: >40% L1, >60% combined
- Multi-provider routing: <500ms P95 overhead
- Failover time: <2s provider switch
- Cost reduction: 15-30% vs direct provider access

**Failure Indicators to Document**:
- Provider ToS violations
- Rate limiting blocking multi-client patterns
- Geographic restrictions
- Model availability constraints

##### Question 2: Optimization Characteristic Ranges
**Question**: What characteristics can we optimize and within what ranges with measurable confidence?

**Expected Outcome**: Quantified optimization ranges with confidence intervals:

| Characteristic | Target | Expected Range | Confidence | Method |
|----------------|--------|----------------|------------|--------|
| Latency (P95) | Routing overhead | 200-500ms | 90% | N=10k requests |
| Availability | Uptime with failover | 99.0-99.9% | 85% | Sustained monitoring |
| Cost Reduction | Economy tier | 15-40% | 75% | Price comparison |
| Cache Hit Rate | Multi-tier | 40-70% | 80% | Traffic simulation |
| Throughput | Per-node | 500-2000 RPS | 70% | Load testing |
| Token TX Speed | Blockchain finality | 5-30s | 95% | Testnet |

##### Question 3: Infrastructure Requirements and Performance Curves
**Question**: What infrastructure is required to support optimizations, and what is the performance-vs-infrastructure relationship across the full spectrum from zero company-owned infrastructure (fully distributed) to extensive infrastructure (fleet of proxies)?

**Critical Research Objective**:
1. **Minimum Viable Infrastructure**: What's the least required to meet targets? (Prefer: NONE)
2. **Performance Curve**: How does performance improve as infrastructure increases?
3. **Diminishing Returns**: At what point does additional infrastructure provide minimal benefit?
4. **Cost-Benefit Breakpoints**: What are the ROI thresholds?

**Infrastructure Spectrum to Test**:

```
Level 0: Fully Distributed ($0/month)
├── Pure P2P (blockchain, IPFS, hardcoded peers, gossip)
└── Test: Can optimizations meet targets with NO company infrastructure?

Level 1: Minimal Bootstrap ($50-65/month)
├── 3-5 bootstrap nodes only
└── Test: Performance improvement vs Level 0?

Level 2: Bootstrap + Monitoring ($200-300/month)
├── Centralized dashboards, alerting
└── Test: Better Byzantine detection or SLA enforcement?

Level 3: Bootstrap + Regional Relays ($2k-5k/month)
├── 10-20 geographic relay nodes
└── Test: Latency reduction via company relays?

Level 4: Bootstrap + Proxy Fleet ($20k-50k/month)
├── 100-500 proxy nodes for connection pooling
└── Test: Throughput improvement via proxies?

Level 5: Centralized Gateway ($100k+/month)
├── Full traditional architecture
└── Test: Is P2P viable vs centralized approach?
```

**Optimization Performance Matrix** (measure at each infrastructure level):

| Optimization | Level 0 | Level 1 | Level 2 | Level 3 | Level 4 | Level 5 |
|--------------|---------|---------|---------|---------|---------|---------|
| Cost Savings | 15-30% | 15-30% | 15-30% | 15-30% | 10-25% | 5-15% |
| Latency P95 | <600ms | <500ms | <500ms | <300ms | <200ms | <150ms |
| Reliability | 90-95% | 95%+ | 95%+ | 99%+ | 99.5%+ | 99.9%+ |
| Throughput | 500-1k | 1k-2k | 1k-2k | 2k-5k | 5k-10k | 10k+ |

**Test Methodology**: Progressive Infrastructure Addition
- Start at Level 0, measure baseline
- Add each infrastructure level, re-run all tests
- Measure performance delta vs previous level
- Calculate ROI (performance gain per dollar spent)

**Key Deliverables**:
1. Infrastructure performance curve visualization
2. Minimum viable infrastructure recommendation
3. Infrastructure ROI analysis with diminishing returns identification
4. Tiered infrastructure strategy (if different tiers need different levels)

#### 10.4.3 Testing Phases

**Phase 1: Baseline Establishment**
- Direct API performance (Anthropic, Bedrock, Azure)
- Provider cost baseline
- Provider reliability baseline

**Phase 2: Zero-Infrastructure Viability (MODEL 1 PRIORITY)**

*Test 2.1: Bootstrap Without Dedicated Servers*
- Method A: Hardcoded peer list
- Method B: GitHub Gist
- Method C: IPFS peer list
- Success Criteria: >85% bootstrap rate, <30s join time, 72hr stability

*Test 2.2: Routing Table Distribution Without Company Storage*
- IPFS only, Arweave, Polygon+IPFS
- Success Criteria: <5s cold download, <100ms cached, <$10/update, >95% success

*Test 2.3: Network Health Without Centralized Monitoring*
- Gossip protocol only for telemetry
- Success Criteria: >85% Byzantine detection, degradation detected in 10min

**Phase 3: Component-Level Performance**
- Client-side routing (<100ns table lookup, <50ms P95 optimization)
- Caching effectiveness (>70% combined hit rate)
- DHT peer discovery (validate O(log N))

**Phase 4: Integration Testing with Live APIs**
- Multi-provider routing validation
- Failover and reliability testing (>95% success, <2s failover)

**Phase 5: Load and Boundary Testing**
- Per-node capacity (500-1000 RPS sustained)
- Network scalability (100 to 10k nodes)
- Geographic latency impact

**Phase 6: Economic Feasibility**
- Cost savings validation (15-40% economy tier)
- Token transaction performance (<30s finality, <$0.01 gas)

#### 10.4.4 Success Metrics and Decision Criteria

**Infrastructure Model Decision**:

*GO MODEL 1* (Zero Infrastructure - PREFERRED):
- ✅ Bootstrap success >85% without servers
- ✅ Routing table costs <$500/month at 10k nodes
- ✅ Network runs 72+ hours without intervention
- ✅ Performance degradation <20% vs Model 2
- ✅ Byzantine detection >80% via gossip only

*GO MODEL 2* (Minimal Bootstrap - FALLBACK):
- ❌ Model 1 bootstrap <70% OR costs >$1k/month OR needs intervention
- ✅ Model 2 bootstrap >95%
- ✅ Model 2 costs <$100/month

*CONDITIONAL: Consider Enhanced Monitoring* ($200-300/month):
- ⚠️ Gossip monitoring insufficient
- ⚠️ Enterprise requires dashboards
- ⚠️ Benefit justifies 4x cost increase

*AVOID: Premium Infrastructure* ($10k-100k/month):
- ❌ Only for enterprise SLAs
- ❌ Only if pure P2P cannot deliver 99.9%
- ❌ Must be revenue-justified

**General Go/No-Go**:

*GO*: Cache >60%, latency <500ms P95, cost savings >15%, failover >95%, DHT O(log N), no ToS violations

*NO-GO*: ToS violations, latency >1s P95, savings <10%, DHT fails to scale, rate limits block approach

*CONDITIONAL*: Some optimizations work → reduce scope; partnerships needed → pursue first; SLAs need infrastructure → separate enterprise tier

#### 10.4.5 Key Deliverables

1. Baseline Performance Report
2. **Infrastructure Performance Curve Analysis** ⭐ (performance across levels 0-5, ROI per tier)
3. **Model 1 Viability Assessment** ⭐ (zero-infra feasibility with evidence-based recommendation)
4. Component Performance Analysis
5. Integration Test Results
6. Scalability and Boundary Analysis
7. Economic Feasibility Report
8. Final Infrastructure Recommendation and Go/No-Go Decision

**Testing Priority**:
1. FIRST: Prove Level 0 (zero infrastructure) meets targets
2. SECOND: If insufficient, determine minimum viable (Level 1? 2?)
3. THIRD: Map full performance curve for diminishing returns
4. FOURTH: Assess if higher levels (3-5) ever justified

**Decision Principle**: Prefer LOWEST infrastructure level meeting targets. Only recommend higher if substantial benefit justifies cost.

---

## Summary of Changes

This section has been comprehensively revised for P2P client SDK testing:

1. **Complete rewrite for P2P architecture**: Removed all centralized server testing (microservices, databases, load balancers) and replaced with P2P-specific testing strategies
2. **Added Section 10.1.1**: Testing pyramid adapted for P2P systems with emphasis on cryptographic primitives, protocol interactions, and network simulations
3. **Added Section 10.1.2**: Unit testing framework covering DHT/Chord, gossip protocol, Signal Protocol encryption, client-side routing, semantic caching, and contribution measurement
4. **Added Section 10.1.3**: P2P protocol integration tests with 5-20 real peer instances validating DHT bootstrap, gossip propagation, and routing table synchronization
5. **Added Section 10.1.4**: Network simulation testing with 100-1000 virtual nodes testing Byzantine resistance, Sybil attack detection, network partition recovery, and routing table poisoning
6. **Added Section 10.1.5**: Security and fuzzing tests for cryptographic fuzzing, anti-reverse-engineering validation, and key extraction resistance
7. **Added Section 10.2**: Language binding testing covering Python, TypeScript, Rust, and Java FFI validation
8. **Added Section 10.3**: CI/CD integration with three-tier strategy (PR tests <5min, merge tests <20min, nightly tests <2hr)
9. **Added 25+ contextual explanations** to headings explaining WHY each testing approach matters for P2P systems
10. **Presented testing approach alternatives** with pros/cons for simulation strategies (Pure Simulation ⭐, Docker-Based, Hybrid)
11. **Added comprehensive test code examples** showing real Go test implementations for DHT, gossip, Byzantine resistance, and Sybil detection
12. **Removed all database/Redis/Kubernetes testing** infrastructure references (not applicable to P2P client SDK)
13. **Added P2P-specific metrics**: DHT lookup latency, gossip convergence time, partition recovery time, Byzantine detection rate, routing table consistency

---

[← Previous: Implementation Architecture](../09-implementation/README.md) | [Next: Risk Assessment →](../11-risk/README.md)

---
