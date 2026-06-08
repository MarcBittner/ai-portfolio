# Tanglement.ai Technical Specification - Section 9: Client Implementation and Deployment

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

[← Previous: API Specifications](../08-api/README.md) | [Next: Quality Assurance →](../10-testing/README.md)

---

## 9. Client Implementation and Deployment

This section provides concrete implementation guidance for building Tanglement.ai P2P client software. Unlike centralized systems with server-side microservices, Tanglement.ai's implementation focuses on **client-side module architecture**, **P2P node deployment**, and **SDK packaging** for multiple programming languages.

**Implementation Philosophy**: Every client is a full P2P peer. Implementation guidance covers modular client architecture, not server deployment. The only "servers" are minimal bootstrap nodes (~3-5 lightweight instances) for initial DHT peer discovery.

### 9.1 Client Module Architecture

**Why Modular Design**: Client SDK embeds complex P2P functionality (DHT, gossip, crypto, routing). Modular architecture enables testing individual components, swapping implementations, and reusing modules across language bindings.

#### 9.1.1 Core Module Structure

```
tanglement-client/
├── core/                    # Core Go implementation
│   ├── p2p/                # P2P networking modules
│   │   ├── dht/           # Chord DHT implementation
│   │   ├── gossip/        # Gossip protocol
│   │   ├── wireguard/     # WireGuard mesh
│   │   └── discovery/     # Peer discovery
│   ├── crypto/            # Cryptographic operations
│   │   ├── signal/        # Signal Protocol
│   │   ├── encryption/    # AES-256-GCM, ed25519
│   │   └── keys/          # Key management
│   ├── routing/           # Client-side routing engine
│   │   ├── optimizer/     # Multi-objective optimization
│   │   ├── cache/         # Four-tier caching
│   │   └── table/         # Routing table management
│   ├── economics/         # Token and contribution tracking
│   │   ├── tokens/        # Token wallet
│   │   ├── contribution/  # Contribution measurement
│   │   └── proof/         # Proof-of-contribution
│   └── api/               # Public API surface
│       ├── completion/    # LLM completion APIs
│       ├── chat/          # Chat APIs
│       └── network/       # Network management APIs
├── bindings/              # Language bindings
│   ├── python/           # Python SDK (via cgo)
│   ├── typescript/       # TypeScript SDK (via FFI)
│   ├── rust/            # Rust SDK (via FFI)
│   └── java/            # Java SDK (via JNI)
├── cli/                  # Command-line interface
│   └── tanglement/      # CLI tool
├── examples/            # Example applications
│   ├── simple/         # Simple completion
│   ├── chat/           # Chat application
│   └── monitoring/     # Network monitoring
└── tests/              # Test suites
    ├── unit/          # Unit tests
    ├── integration/   # Integration tests
    └── e2e/          # End-to-end tests
```

#### 9.1.2 Module Interfaces and Contracts

**Interface-Driven Design**: Each module exposes clear interfaces enabling testing, mocking, and alternative implementations.

```go
// P2P DHT interface
type DHT interface {
    // Initialize DHT node
    Initialize(config *DHTConfig) error

    // Join DHT network via bootstrap nodes
    Join(bootstrapNodes []string) error

    // Lookup key in DHT (O(log N) hops)
    Lookup(key []byte) (*NodeRef, error)

    // Store value in DHT
    Store(key []byte, value []byte) error

    // Get finger table status
    GetFingerTable() [160]*NodeRef

    // Get successor list for fault tolerance
    GetSuccessors() []*NodeRef

    // Gracefully leave network
    Leave() error
}

// Gossip protocol interface
type GossipProtocol interface {
    // Initialize gossip protocol
    Initialize(config *GossipConfig) error

    // Broadcast message to network
    BroadcastMessage(msg *GossipMessage) error

    // Subscribe to message types
    Subscribe(msgType MessageType, handler MessageHandler) error

    // Get connected peers
    GetPeers() []*PeerInfo

    // Update peer reputation score
    UpdatePeerScore(nodeID NodeID, score float64) error
}

// Routing engine interface
type RoutingEngine interface {
    // Initialize routing engine
    Initialize(config *RoutingConfig) error

    // Select optimal provider for request
    SelectProvider(req *RoutingRequest) (*ProviderSelection, error)

    // Update routing table with performance data
    RecordPerformance(providerID uint16, modelID uint8, latency time.Duration, success bool) error

    // Refresh routing table from network
    RefreshRoutingTable() error

    // Get routing statistics
    GetStats() *RoutingStats
}

// Cache interface
type Cache interface {
    // Get cached value
    Get(key string) (interface{}, bool)

    // Put value in cache
    Put(key string, value interface{}) error

    // Get cache statistics
    GetHitRate() float64

    // Clear cache
    Clear() error
}

// Token manager interface
type TokenManager interface {
    // Get current token balance
    GetBalance() *TokenBalance

    // Spend tokens for request
    SpendTokens(amount decimal.Decimal, reason string) error

    // Credit tokens from contribution
    CreditTokens(amount decimal.Decimal, proof *ContributionProof) error

    // Get transaction history
    GetTransactions(timeRange TimeRange) []*TokenTransaction
}

// Contribution tracker interface
type ContributionTracker interface {
    // Start tracking contributions
    Start() error

    // Stop tracking
    Stop() error

    // Generate proof for time range
    GenerateProof(timeRange TimeRange) (*ContributionProof, error)

    // Verify contribution proof
    VerifyProof(proof *ContributionProof) error

    // Get earnings summary
    GetEarnings(timeRange TimeRange) *ContributionEarnings
}
```

### 9.2 Client SDK Implementation

**Reference Implementation**: Core client SDK is implemented in Go for performance, cross-platform support, and C interoperability (cgo enables language bindings).

#### 9.2.1 Main Client Implementation

```go
// tanglement-client/core/client.go

package tanglement

import (
    "context"
    "fmt"
    "time"

    "tanglement.ai/core/p2p/dht"
    "tanglement.ai/core/p2p/gossip"
    "tanglement.ai/core/p2p/wireguard"
    "tanglement.ai/core/crypto/signal"
    "tanglement.ai/core/routing"
    "tanglement.ai/core/economics/tokens"
    "tanglement.ai/core/economics/contribution"
)

// TanglementClient is the main SDK client
type TanglementClient struct {
    // Configuration
    config *ClientConfig

    // P2P components
    dht       dht.DHT
    gossip    gossip.GossipProtocol
    wireguard *wireguard.Mesh
    signal    *signal.Protocol

    // Routing
    routingEngine routing.RoutingEngine
    cache         routing.Cache

    // Economics
    tokenManager  tokens.TokenManager
    contribution  contribution.Tracker

    // State
    nodeID        NodeID
    startTime     time.Time
    shutdown      chan struct{}
}

// NewClient creates a new Tanglement.ai client
func NewClient(config *ClientConfig) (*TanglementClient, error) {
    if err := validateConfig(config); err != nil {
        return nil, fmt.Errorf("invalid config: %w", err)
    }

    client := &TanglementClient{
        config:    config,
        nodeID:    config.NodeID,
        startTime: time.Now(),
        shutdown:  make(chan struct{}),
    }

    // Initialize P2P networking
    if err := client.initP2P(); err != nil {
        return nil, fmt.Errorf("P2P init failed: %w", err)
    }

    // Initialize routing
    if err := client.initRouting(); err != nil {
        return nil, fmt.Errorf("routing init failed: %w", err)
    }

    // Initialize economics
    if err := client.initEconomics(); err != nil {
        return nil, fmt.Errorf("economics init failed: %w", err)
    }

    // Start background tasks
    go client.backgroundTasks()

    log.Printf("Tanglement client initialized: node=%s, tier=%s",
        client.nodeID, config.Tier)

    return client, nil
}

func (c *TanglementClient) initP2P() error {
    // Initialize DHT
    dhtImpl := dht.NewChordDHT()
    if err := dhtImpl.Initialize(&dht.DHTConfig{
        NodeID:         c.nodeID,
        BootstrapNodes: c.config.BootstrapNodes,
        ListenAddress:  c.config.ListenAddress,
        Port:           c.config.Port,
    }); err != nil {
        return err
    }
    c.dht = dhtImpl

    // Join DHT network
    if err := c.dht.Join(c.config.BootstrapNodes); err != nil {
        return fmt.Errorf("DHT join failed: %w", err)
    }

    // Initialize gossip
    gossipImpl := gossip.NewEpidemicGossip()
    if err := gossipImpl.Initialize(&gossip.GossipConfig{
        NodeID:         c.nodeID,
        Fanout:         6,
        GossipInterval: 30 * time.Second,
    }); err != nil {
        return err
    }
    c.gossip = gossipImpl

    // Initialize WireGuard mesh
    c.wireguard = wireguard.NewMesh()
    if err := c.wireguard.Initialize(); err != nil {
        return err
    }

    // Initialize Signal Protocol
    c.signal = signal.NewProtocol()
    if err := c.signal.Initialize(); err != nil {
        return err
    }

    return nil
}

func (c *TanglementClient) initRouting() error {
    // Download and decrypt routing table
    routingTable, err := downloadRoutingTable()
    if err != nil {
        return err
    }

    decrypted, err := decryptRoutingTable(routingTable, c.config.PrivateKey)
    if err != nil {
        return err
    }

    // Initialize cache
    c.cache = routing.NewMultiTierCache(&routing.CacheConfig{
        L1MemorySize:  50 * 1024 * 1024,   // 50MB
        L2DiskSize:    1024 * 1024 * 1024, // 1GB
        L3SemanticSize: 100 * 1024 * 1024,  // 100MB
    })

    // Initialize routing engine
    engine := routing.NewEngine()
    if err := engine.Initialize(&routing.RoutingConfig{
        RoutingTable: decrypted,
        Cache:        c.cache,
        TierConfig:   getTierConfig(c.config.Tier),
        DHT:          c.dht,
    }); err != nil {
        return err
    }
    c.routingEngine = engine

    return nil
}

func (c *TanglementClient) initEconomics() error {
    // Initialize token manager
    tokenMgr := tokens.NewManager()
    if err := tokenMgr.Initialize(&tokens.Config{
        NodeID:      c.nodeID,
        StoragePath: c.config.DataDir + "/tokens",
    }); err != nil {
        return err
    }
    c.tokenManager = tokenMgr

    // Initialize contribution tracker
    tracker := contribution.NewTracker()
    if err := tracker.Initialize(&contribution.Config{
        NodeID:      c.nodeID,
        StoragePath: c.config.DataDir + "/contributions",
    }); err != nil {
        return err
    }
    c.contribution = tracker

    // Start contribution tracking
    if err := c.contribution.Start(); err != nil {
        return err
    }

    return nil
}

func (c *TanglementClient) backgroundTasks() {
    // Periodic routing table refresh (every 5 minutes)
    refreshTicker := time.NewTicker(5 * time.Minute)
    defer refreshTicker.Stop()

    // Periodic contribution proof submission (every 24 hours)
    proofTicker := time.NewTicker(24 * time.Hour)
    defer proofTicker.Stop()

    for {
        select {
        case <-refreshTicker.C:
            if err := c.routingEngine.RefreshRoutingTable(); err != nil {
                log.Printf("Routing table refresh failed: %v", err)
            }

        case <-proofTicker.C:
            if err := c.submitContributionProof(); err != nil {
                log.Printf("Contribution proof submission failed: %v", err)
            }

        case <-c.shutdown:
            return
        }
    }
}

func (c *TanglementClient) submitContributionProof() error {
    proof, err := c.contribution.GenerateProof(TimeRange{
        Start: time.Now().Add(-24 * time.Hour),
        End:   time.Now(),
    })
    if err != nil {
        return err
    }

    // Verify proof locally
    if err := c.contribution.VerifyProof(proof); err != nil {
        return err
    }

    // Broadcast to network via gossip
    return c.gossip.BroadcastMessage(&GossipMessage{
        Type:    MessageTypeContributionProof,
        Payload: proof,
    })
}

// Shutdown gracefully shuts down the client
func (c *TanglementClient) Shutdown(ctx context.Context) error {
    log.Printf("Shutting down Tanglement client...")

    // Signal background tasks to stop
    close(c.shutdown)

    // Stop contribution tracking
    if err := c.contribution.Stop(); err != nil {
        log.Printf("Failed to stop contribution tracker: %v", err)
    }

    // Leave DHT network
    if err := c.dht.Leave(); err != nil {
        log.Printf("Failed to leave DHT: %v", err)
    }

    log.Printf("Tanglement client shutdown complete")
    return nil
}
```

### 9.3 Language Binding Implementation

**Multi-Language Support**: Core Go library exports C-compatible functions enabling bindings for Python, TypeScript, Rust, Java.

#### 9.3.1 C Export Layer (cgo)

```go
// tanglement-client/bindings/c/export.go

package main

import "C"
import (
    "encoding/json"
    "unsafe"

    "tanglement.ai/core"
)

//export tanglement_client_new
func tanglement_client_new(configJSON *C.char) *C.char {
    var config tanglement.ClientConfig
    if err := json.Unmarshal([]byte(C.GoString(configJSON)), &config); err != nil {
        return C.CString(fmt.Sprintf(`{"error":"%s"}`, err))
    }

    client, err := tanglement.NewClient(&config)
    if err != nil {
        return C.CString(fmt.Sprintf(`{"error":"%s"}`, err))
    }

    // Store client in registry and return handle
    handle := clientRegistry.Register(client)
    return C.CString(fmt.Sprintf(`{"handle":%d}`, handle))
}

//export tanglement_create_completion
func tanglement_create_completion(handle C.int, requestJSON *C.char) *C.char {
    client := clientRegistry.Get(int(handle))
    if client == nil {
        return C.CString(`{"error":"invalid handle"}`)
    }

    var req tanglement.CompletionRequest
    if err := json.Unmarshal([]byte(C.GoString(requestJSON)), &req); err != nil {
        return C.CString(fmt.Sprintf(`{"error":"%s"}`, err))
    }

    resp, err := client.CreateCompletion(context.Background(), req)
    if err != nil {
        return C.CString(fmt.Sprintf(`{"error":"%s"}`, err))
    }

    respJSON, _ := json.Marshal(resp)
    return C.CString(string(respJSON))
}

//export tanglement_get_network_stats
func tanglement_get_network_stats(handle C.int) *C.char {
    client := clientRegistry.Get(int(handle))
    if client == nil {
        return C.CString(`{"error":"invalid handle"}`)
    }

    stats, err := client.GetNetworkStats()
    if err != nil {
        return C.CString(fmt.Sprintf(`{"error":"%s"}`, err))
    }

    statsJSON, _ := json.Marshal(stats)
    return C.CString(string(statsJSON))
}

//export tanglement_client_free
func tanglement_client_free(handle C.int) {
    client := clientRegistry.Remove(int(handle))
    if client != nil {
        client.Shutdown(context.Background())
    }
}

func main() {} // Required for cgo
```

#### 9.3.2 Python Binding

```python
# tanglement-client/bindings/python/tanglement/__init__.py

import ctypes
import json
from typing import Optional, Dict, List
from enum import Enum

# Load shared library
_lib = ctypes.CDLL("libtanglement.so")

# Function signatures
_lib.tanglement_client_new.argtypes = [ctypes.c_char_p]
_lib.tanglement_client_new.restype = ctypes.c_char_p

_lib.tanglement_create_completion.argtypes = [ctypes.c_int, ctypes.c_char_p]
_lib.tanglement_create_completion.restype = ctypes.c_char_p

_lib.tanglement_get_network_stats.argtypes = [ctypes.c_int]
_lib.tanglement_get_network_stats.restype = ctypes.c_char_p

_lib.tanglement_client_free.argtypes = [ctypes.c_int]

class TierType(Enum):
    PREMIUM_RELIABILITY = "premium_reliability"
    PREMIUM_PERFORMANCE = "premium_performance"
    ECONOMY_PRICING = "economy_pricing"

class TanglementClient:
    def __init__(
        self,
        bootstrap_nodes: List[str],
        tier: TierType,
        provider_keys: Dict[str, str],
        listen_address: str = "0.0.0.0",
        port: int = 51820,
        data_dir: str = "~/.tanglement"
    ):
        config = {
            "bootstrap_nodes": bootstrap_nodes,
            "tier": tier.value,
            "provider_keys": provider_keys,
            "listen_address": listen_address,
            "port": port,
            "data_dir": data_dir,
        }

        config_json = json.dumps(config).encode('utf-8')
        result_json = _lib.tanglement_client_new(config_json)
        result = json.loads(result_json.decode('utf-8'))

        if "error" in result:
            raise Exception(f"Failed to create client: {result['error']}")

        self._handle = result["handle"]

    def create_completion(
        self,
        model: str,
        prompt: str,
        max_tokens: int = 100,
        temperature: float = 1.0,
        **kwargs
    ) -> Dict:
        request = {
            "model": model,
            "prompt": prompt,
            "max_tokens": max_tokens,
            "temperature": temperature,
            **kwargs
        }

        request_json = json.dumps(request).encode('utf-8')
        result_json = _lib.tanglement_create_completion(self._handle, request_json)
        result = json.loads(result_json.decode('utf-8'))

        if "error" in result:
            raise Exception(f"Completion failed: {result['error']}")

        return result

    def get_network_stats(self) -> Dict:
        result_json = _lib.tanglement_get_network_stats(self._handle)
        result = json.loads(result_json.decode('utf-8'))

        if "error" in result:
            raise Exception(f"Failed to get stats: {result['error']}")

        return result

    def __del__(self):
        if hasattr(self, '_handle'):
            _lib.tanglement_client_free(self._handle)
```

### 9.4 Deployment Patterns

**Deployment Options**: Unlike centralized systems requiring Kubernetes clusters, Tanglement.ai clients deploy as:
1. **Embedded SDK**: Linked into user applications
2. **Standalone daemon**: Background process for CLI/API access
3. **Docker container**: Isolated environment for cloud deployments

#### 9.4.1 Embedded SDK Deployment

**Most Common**: SDK embedded directly in user application code.

```python
# User application using embedded SDK

from tanglement import TanglementClient, TierType

# Initialize client (runs as part of application process)
client = TanglementClient(
    bootstrap_nodes=["bootstrap.tanglement.ai:51820"],
    tier=TierType.PREMIUM_PERFORMANCE,
    provider_keys={
        "openai": os.getenv("OPENAI_API_KEY"),
        "anthropic": os.getenv("ANTHROPIC_API_KEY"),
    }
)

# Use client for LLM requests
response = client.create_completion(
    model="gpt-4",
    prompt="Explain quantum computing",
    max_tokens=500
)

print(response["choices"][0]["text"])
```

#### 9.4.2 Standalone Daemon Deployment

**For CLI/API Access**: Client runs as background daemon, exposing local REST API.

```yaml
# systemd service: /etc/systemd/system/tanglement.service

[Unit]
Description=Tanglement.ai P2P Client Daemon
After=network.target

[Service]
Type=simple
User=tanglement
ExecStart=/usr/local/bin/tanglement daemon \
    --config /etc/tanglement/config.yaml \
    --data-dir /var/lib/tanglement \
    --api-port 8080
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

```yaml
# config.yaml

node_id: "auto-generate"
tier: "premium_performance"

bootstrap_nodes:
  - "bootstrap1.tanglement.ai:51820"
  - "bootstrap2.tanglement.ai:51820"
  - "bootstrap3.tanglement.ai:51820"

listen_address: "0.0.0.0"
port: 51820

provider_keys:
  openai: "${OPENAI_API_KEY}"
  anthropic: "${ANTHROPIC_API_KEY}"

cache:
  l1_memory: 50MB
  l2_disk: 1GB
  l3_semantic: 100MB

performance:
  max_concurrent: 10
  bandwidth_limit: 100Mbps

data_dir: "/var/lib/tanglement"
log_level: "info"
```

#### 9.4.3 Docker Container Deployment

```dockerfile
# Dockerfile

FROM golang:1.21-alpine AS builder

WORKDIR /build
COPY . .
RUN go build -o tanglement ./cmd/tanglement

FROM alpine:latest

RUN apk add --no-cache wireguard-tools iptables

COPY --from=builder /build/tanglement /usr/local/bin/

VOLUME ["/data"]
EXPOSE 51820/udp 8080/tcp

ENTRYPOINT ["/usr/local/bin/tanglement"]
CMD ["daemon", "--config", "/etc/tanglement/config.yaml"]
```

```bash
# Run Tanglement client in Docker

docker run -d \
  --name tanglement-client \
  --cap-add=NET_ADMIN \
  --device=/dev/net/tun \
  -v tanglement-data:/data \
  -v ./config.yaml:/etc/tanglement/config.yaml \
  -p 51820:51820/udp \
  -p 8080:8080 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  tanglement/client:latest
```

### 9.5 Bootstrap Node Deployment

**Minimal Infrastructure**: Only infrastructure owned/operated by company are 3-5 lightweight bootstrap nodes for initial DHT peer discovery.

```yaml
# Bootstrap node deployment (AWS EC2 t3.micro)

resource "aws_instance" "bootstrap" {
  count         = 3
  ami           = "ami-0c55b159cbfafe1f0" # Ubuntu 22.04 LTS
  instance_type = "t3.micro" # $7.50/month

  user_data = <<-EOF
    #!/bin/bash
    apt-get update
    apt-get install -y wireguard

    # Download bootstrap binary
    wget https://releases.tanglement.ai/bootstrap/latest/tanglement-bootstrap
    chmod +x tanglement-bootstrap

    # Run bootstrap node
    ./tanglement-bootstrap \
      --listen 0.0.0.0:51820 \
      --seed-file /etc/tanglement/seed-peers.txt
  EOF

  tags = {
    Name = "tanglement-bootstrap-${count.index + 1}"
    Role = "bootstrap"
  }
}

# Total cost: 3 × $7.50 = ~$22.50/month
# With S3 storage (~$3/month) and bandwidth (~$25/month): ~$50/month total
```

---

[← Previous: API Specifications](../08-api/README.md) | [Next: Quality Assurance →](../10-testing/README.md)

---
