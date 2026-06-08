# Tanglement.ai Technical Specification - Section 2: System Architecture Overview

[← Previous: System Overview](../01-system-overview/README.md) | [Next: Distributed Routing Engine Specification →](../03-routing/README.md)

---

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

---

## 2. System Architecture Overview

This section provides the comprehensive system architecture for the Tanglement.ai platform, detailing how distributed components work together to create a fully peer-to-peer LLM access network without centralized infrastructure dependencies.

### 2.1 High-Level Architecture

The Tanglement.ai architecture emphasizes client-side intelligence and distributed coordination. Unlike traditional client-server models, all routing decisions occur locally on client devices using shared network state stored on decentralized infrastructure.

The Tanglement.ai system consists of four primary architectural layers operating on client devices:

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
│           Client-Side User Interfaces                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Web UI    │  │  Mobile App │  │  CLI Tools  │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                   Client Intelligence Layer                 │
│           Local Processing & Decision Making                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  Routing    │  │  Request    │  │  Credential │        │
│  │  Engine     │  │  Optimizer  │  │  Manager    │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                    P2P Network Layer                        │
│         Distributed Coordination & State Sharing            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ DHT Peer    │  │ Gossip      │  │ Consensus   │        │
│  │ Discovery   │  │ Protocol    │  │ Protocol    │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                  Infrastructure Layer                       │
│        Encrypted Connectivity & Cryptographic Primitives    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ WireGuard   │  │ Signal      │  │ Blockchain  │        │
│  │ Mesh VPN    │  │ Protocol    │  │ / IPFS      │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

**External Shared Infrastructure** (Decentralized, Not Company-Owned):
- **Routing Table Storage**: Blockchain / IPFS / GitHub Gists / S3 (read-only)
- **Bootstrap Seed Nodes**: 3-5 lightweight directory servers (~$50-65/month total)

### 2.2 Core Components

This section details the primary architectural components that operate on client devices to enable distributed LLM routing and coordination.

#### 2.2.1 Distributed Routing Engine (Client-Side)

The routing engine runs entirely on client devices, making intelligent routing decisions based on locally cached network state. This eliminates dependency on centralized routing services and enables zero-trust operation.

**Primary Function**: Intelligent request routing based on multi-objective optimization performed locally on client devices

**Key Technologies**:
- Client-side route calculation using cached routing table
- DHT-based peer discovery (Chord Protocol)
- Gossip protocol for receiving state updates
- Multi-objective optimization (cost/speed/reliability based on user tier)

**Performance Targets**:
- Routing table download & decrypt: <100ms (cached locally)
- Local routing decision time: <50ms
- DHT peer discovery: <65ms (O(log N) for 10k nodes)
- Total routing overhead: <215ms (target: <500ms total)

**Key Algorithms**:
- Pareto optimization for route selection
- Predictive latency modeling using historical data
- Client-side load balancing
- Local cache with intelligent prefetching

**Deployment Model**: Embedded in client software (Go library, JavaScript SDK, mobile SDK)

#### 2.2.2 Security Subsystem (Client-Side)

All cryptographic operations occur client-side to ensure zero-trust architecture. The company never has access to plaintext user requests or LLM provider credentials.

**Primary Function**: End-to-end encryption, client-side credential management, privacy protection

**Key Technologies**:
- Signal Protocol (forward secrecy, double ratchet)
- AES-256-GCM encryption for routing table decryption
- Curve25519 key exchange for peer connections
- Client-side key storage (OS keychain integration)

**Security Model**:
- Zero-trust architecture (no server sees plaintext)
- Mandatory encrypted P2P connections (WireGuard)
- Zero-knowledge telemetry (differential privacy)
- Client-side credential storage (no company escrow)

**Privacy Features**:
- Differential privacy for metrics reporting
- Onion routing for request anonymization (optional)
- Privacy-by-design architecture
- GDPR compliance through technical controls

**Credential Management**:
- Users store LLM provider API keys locally (encrypted via OS keychain)
- OR use token-based ephemeral credentials derived from token balance
- No company access to credentials (eliminates liability)

#### 2.2.3 Economic Engine (Hybrid: Client-Side + Blockchain)

Token management and contribution tracking operate through cryptographic proofs verified by peer consensus, eliminating centralized accounting infrastructure.

**Primary Function**: Token-based incentive system and contribution tracking

**Key Technologies**:
- Blockchain integration for token ledger (immutable, public)
- Cryptographic proof-of-contribution (Merkle trees, attestations)
- Client-side contribution measurement
- Peer validation through gossip protocol

**Economic Model**:
- Single utility token for LLM access (NOT a cryptocurrency)
- CPU/bandwidth/storage contribution rewards *(economics under development)*
- Cross-subsidization: Premium tiers (1.2x rate) subsidize Economy tier
- Fair usage enforcement through cryptographic proofs

**Sustainability Mechanisms**:
- Three-tier pricing (users choose ONE: reliability, performance, or price)
- Premium services revenue (0.5-2% transaction fee, under development)
- Provider partnerships for volume discounts
- Community-driven resource contribution

#### 2.2.4 Network Infrastructure (P2P Mesh)

The P2P mesh network enables direct peer-to-peer communication without centralized relay servers. Network topology self-organizes through distributed algorithms.

**Primary Function**: High-performance P2P networking and communication

**Key Technologies**:
- WireGuard mesh networking (kernel-level encryption)
- libp2p DHT implementation (Chord protocol)
- Direct peer-to-peer connections (NAT traversal via STUN/TURN)
- HTTP/2 for LLM provider API calls

**Performance Characteristics**:
- Latency: <5ms per hop (WireGuard)
- Throughput: 1k RPS sustained, 10k peak per node
- Reliability: Byzantine fault tolerance through redundancy
- Scalability: Organic growth to millions of nodes

**Network Features**:
- Automatic failover to alternate paths
- Partition tolerance (eventual consistency via gossip)
- Self-healing topology (DHT finger table maintenance)
- Geographic optimization (route through nearby peers)

### 2.3 Infrastructure Ownership Models

This section presents alternative approaches to infrastructure ownership, balancing decentralization goals against practical operational requirements. Each model involves different cost structures, control trade-offs, and scalability characteristics.

Tanglement.ai can be deployed using various infrastructure ownership models. The choice impacts cost, control, decentralization, and regulatory exposure.

#### Model 1: Fully Distributed (Zero Company Infrastructure)

Pure P2P operation with zero company-owned servers. All network state stored on public decentralized infrastructure.

**Architecture**:
- **Routing Table Storage**: Public blockchain (e.g., Ethereum, Arweave) OR IPFS
- **Bootstrap Discovery**: Public GitHub Gists (read-only) OR hardcoded peer list in client
- **Token Ledger**: Public blockchain (Ethereum, Polygon, etc.)
- **Company Infrastructure**: NONE (not even bootstrap servers)

**Pros**:
- ✅ Maximum decentralization and censorship resistance
- ✅ Zero operational costs for company (~$0/month)
- ✅ No regulatory liability for hosted infrastructure
- ✅ Community-owned and governed network
- ✅ Truly unstoppable service

**Cons**:
- ❌ Slower initial peer discovery (no dedicated bootstrap)
- ❌ Depends on external blockchain costs (transaction fees)
- ❌ Harder to debug and monitor network health
- ❌ Challenging initial bootstrap for first-time users
- ❌ May complicate enterprise adoption (no SLA guarantees)

**Estimated Cost**: $0-500/month (blockchain transaction fees only)

#### Model 2: Minimal Bootstrap (Hybrid Model) ⭐ RECOMMENDED

Lightweight company-operated bootstrap nodes provide initial peer discovery, but all routing happens P2P. Strikes balance between usability and decentralization.

**Architecture**:
- **Routing Table Storage**: Blockchain/IPFS (primary) + S3 backup (read-only)
- **Bootstrap Discovery**: 3-5 lightweight seed servers (provide initial DHT peer list)
- **Token Ledger**: Public blockchain
- **Company Infrastructure**: Only bootstrap nodes (~$50-65/month)

**Bootstrap Node Function**:
- Provide initial list of active DHT peers for new clients
- Serve as "always-on" DHT participants for network stability
- Host read-only backup of routing table (fallback if blockchain slow)
- No request routing (clients do all routing themselves)

**Pros**:
- ✅ Fast initial peer discovery for new users
- ✅ Minimal operational costs (~$50-65/month)
- ✅ 99%+ of network operation fully P2P
- ✅ Easier enterprise onboarding (predictable bootstrap)
- ✅ Company can monitor network health via bootstrap nodes
- ✅ Maintains high decentralization (bootstrap optional after initial)

**Cons**:
- ⚠️ Requires minimal company infrastructure (legal/regulatory surface)
- ⚠️ Bootstrap nodes are single point of failure (mitigated: clients cache peers)
- ⚠️ Small ongoing operational cost

**Estimated Cost**: $50-65/month (3-5 t3.micro instances + S3 bandwidth)

**Recommended Use Case**: Best balance for MVP launch and enterprise adoption

#### Model 3: Federated Community Nodes

Community volunteers run bootstrap infrastructure, company provides coordination and reputation system. Distributes operational responsibility across trusted community members.

**Architecture**:
- **Routing Table Storage**: Blockchain/IPFS
- **Bootstrap Discovery**: Community-operated seed servers (verified via reputation)
- **Token Ledger**: Public blockchain
- **Company Infrastructure**: Reputation/verification service only

**Federated Bootstrap Program**:
- Community members apply to run verified bootstrap nodes
- Company provides cryptographic verification (signed node list)
- Incentivized with token rewards for uptime/reliability
- Geographic diversity requirements (min 1 per continent)

**Pros**:
- ✅ Decentralized infrastructure operation
- ✅ Low company operational costs (~$100/month for verification service)
- ✅ Community ownership and participation
- ✅ Geographic diversity through distributed operators
- ✅ Resistant to single-entity shutdown

**Cons**:
- ❌ Requires community trust and reputation management
- ❌ Harder to guarantee bootstrap reliability
- ❌ Complex governance for verifying operators
- ❌ Slower initial deployment (need community volunteers)

**Estimated Cost**: $100/month (verification service) + token rewards

**Recommended Use Case**: Long-term decentralization after network maturity

#### Model 4: Tiered Infrastructure

Hybrid approach with minimal centralized services for premium tiers, pure P2P for economy tier. Provides SLA guarantees for enterprise customers while maintaining P2P operation for community users.

**Architecture**:
- **Economy Tier**: Pure P2P (Model 1 or 2)
- **Premium Tiers**: Access to company-operated relay nodes for guaranteed SLAs
- **Routing Table Storage**: Blockchain/IPFS + premium CDN mirrors
- **Company Infrastructure**: Optional relay nodes for premium SLA enforcement

**Premium Infrastructure**:
- Dedicated relay nodes for failover (premium tiers only)
- Geographic load balancers for performance optimization
- Monitoring and SLA enforcement infrastructure
- Priority support and dedicated account management

**Pros**:
- ✅ Enables enterprise SLAs (99.9% uptime guarantees)
- ✅ Revenue-generating infrastructure (premium subscriptions)
- ✅ Economy tier remains fully P2P
- ✅ Flexible scaling based on premium adoption

**Cons**:
- ❌ Significant infrastructure costs ($10k-100k/month at scale)
- ❌ Creates two-tier system (may alienate community)
- ❌ Regulatory exposure for premium infrastructure
- ❌ Moves away from pure P2P vision

**Estimated Cost**: $10k-100k/month (scales with premium user adoption)

**Recommended Use Case**: Enterprise-focused deployment with strong SLA requirements

#### Model Comparison Summary

| Factor | Model 1: Fully Distributed | Model 2: Minimal Bootstrap ⭐ | Model 3: Federated | Model 4: Tiered |
|--------|---------------------------|------------------------------|-------------------|-----------------|
| **Company Infra Cost** | $0-500/mo | $50-65/mo | $100/mo | $10k-100k/mo |
| **Decentralization** | Maximum | Very High | High | Medium |
| **Bootstrap Speed** | Slow | Fast | Medium | Fast |
| **Enterprise SLAs** | ❌ Difficult | ⚠️ Limited | ⚠️ Limited | ✅ Strong |
| **Regulatory Exposure** | Minimal | Minimal | Medium | High |
| **Operational Complexity** | Low | Low | Medium | High |
| **Recommended Phase** | Phase 8+ | Phase 1-7 ⭐ | Phase 5+ | Alternative |

**Recommendation**: Start with **Model 2 (Minimal Bootstrap)** for MVP, transition to **Model 3 (Federated)** for long-term decentralization. Model 4 is optional for enterprise-heavy strategy.

### 2.4 Data Flow Architecture

This section illustrates how requests flow through the distributed system from user initiation through LLM provider response, emphasizing the client-side processing and P2P routing mechanisms.

#### 2.4.1 Request Processing Flow (P2P Architecture)

```
User Application
    ↓
Client Routing Engine (Local)
    ├── Download & Decrypt Routing Table (from Blockchain/IPFS)
    ├── Local Route Optimization (Cost/Speed/Reliability)
    └── Select Optimal LLM Provider + Network Path
    ↓
Credential Injection (Client-Side)
    ├── Retrieve API Key from OS Keychain
    └── OR Generate Ephemeral Credential from Token Balance
    ↓
Encryption Layer (Signal Protocol)
    ├── Encrypt Request Payload
    └── Establish Session with Destination Peer
    ↓
P2P Network Routing (WireGuard Mesh)
    ├── DHT Peer Discovery (Chord)
    ├── Establish Encrypted Tunnel to Next Hop
    └── Forward to LLM Provider Node
    ↓
LLM Provider Node (Peer)
    ├── Decrypt Request
    ├── Call LLM Provider API (OpenAI, Anthropic, etc.)
    └── Encrypt Response
    ↓
Response Path (Reverse Route)
    ├── Return via WireGuard Tunnel
    └── Decrypt on Client
    ↓
Local Cache (Client-Side)
    ├── Store Response for Semantic Caching
    └── Update Performance Metrics
    ↓
Metrics Publication (Gossip Protocol)
    ├── Publish Anonymized Performance Data
    └── Contribute to Routing Table Update
    ↓
User Application (Response Delivered)
```

**Note**: No centralized company infrastructure in request path. All routing decisions occur client-side using cached routing table.

#### 2.4.2 Contribution Tracking Flow (Cryptographic Proofs)

```
Node Activity Monitoring (Client-Side)
    ↓
Metrics Collection (Local)
    ├── CPU Time Contributed (measured locally)
    ├── Bandwidth Relayed (bytes forwarded)
    ├── Storage Contributed (routing table hosting)
    └── Uptime (time online and reachable)
    ↓
Proof Generation (Cryptographic)
    ├── Merkle Tree of Activity Logs
    ├── Signed Attestations (private key)
    └── Zero-Knowledge Proofs (privacy-preserving)
    ↓
Peer Validation (Gossip Protocol)
    ├── Broadcast Proofs to Random Peers
    ├── Peers Verify Signatures & Merkle Roots
    └── Consensus on Contribution Validity
    ↓
Reward Calculation (Client-Side + Blockchain)
    ├── Calculate Token Reward (local)
    ├── Submit to Blockchain (smart contract)
    └── Quality Multipliers (reliability, uptime)
    ↓
Token Distribution (Blockchain Transaction)
    ├── Smart Contract Validates Proofs
    ├── Mint Tokens to Contributor Wallet
    └── Emit Event for Client Notification
    ↓
Balance Update (Client Wallet)
```

**Note**: Contribution mining economics under development. Multiple models being evaluated (see Section 5.6).

### 2.5 Client Software Architecture

This section describes the software components that run on client devices, including programming language choices, platform support, and SDK architecture for third-party integration.

The client software embeds all routing intelligence, cryptographic operations, and P2P coordination logic. It is designed for cross-platform deployment and easy integration.

#### 2.5.1 Client Application Components

**Core Library** (Go):
- Routing engine implementation
- DHT peer discovery (libp2p)
- WireGuard mesh networking
- Signal Protocol encryption
- Token wallet integration

**Platform-Specific Bindings**:
- **Desktop**: Go native binary (Windows, macOS, Linux)
- **Web**: WebAssembly (WASM) compilation
- **Mobile**: gomobile for iOS/Android bindings
- **Embedded**: Stripped-down library for IoT devices

**User Interfaces**:
- **CLI Tool**: Full-featured command-line interface
- **Web UI**: React-based dashboard (connects to local client via localhost API)
- **Mobile Apps**: Native iOS/Android with embedded Go library
- **IDE Plugins**: VSCode, JetBrains (for developer workflows)

#### 2.5.2 Technology Stack (Client-Side Focus)

This outlines the technologies used in client software development, emphasizing cross-platform compatibility and performance.

**Client Software**:
- **Language**: Go 1.21+ (core), TypeScript (UI), Swift/Kotlin (mobile)
- **Framework**: Wails (desktop), React (web), React Native (mobile)
- **P2P Library**: libp2p (DHT, gossip, routing)
- **Encryption**: golang.org/x/crypto, Signal Protocol Go implementation
- **Networking**: WireGuard-go, QUIC for low-latency

**Blockchain Integration**:
- **Wallet**: MetaMask SDK, WalletConnect
- **Token Standard**: ERC-20 (Ethereum/Polygon)
- **Smart Contracts**: Solidity (contribution verification, token minting)
- **Decentralized Storage**: IPFS (go-ipfs), Arweave SDK

**Developer SDKs**:
- **Go SDK**: Native library with full feature set
- **JavaScript/TypeScript SDK**: WebAssembly wrapper
- **Python SDK**: CGo bindings (for data science workflows)
- **REST API**: Local HTTP server for language-agnostic integration

**Monitoring & Observability** (Client-Side):
- **Metrics**: Prometheus client libraries
- **Logging**: Structured logging (zap, zerolog)
- **Tracing**: OpenTelemetry (optional, user opt-in)
- **Privacy**: Differential privacy for telemetry (no PII collection)

**Security**:
- **Key Storage**: OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- **Certificate Pinning**: Hardcoded public keys for bootstrap nodes
- **Code Signing**: Apple Developer, Microsoft Authenticode, Linux GPG
- **Anti-Tampering**: Binary obfuscation (UPX, Themida)

### 2.6 Scalability Characteristics

This section defines how the P2P network scales organically as node count increases, including performance characteristics per node and network-wide throughput projections.

Unlike centralized systems that require vertical and horizontal scaling of servers, P2P networks scale organically through node addition. Each new node adds both demand and capacity.

#### 2.6.1 Per-Node Capacity

Individual node performance determines network-wide throughput. These targets assume commodity hardware (4-core CPU, 8GB RAM, 100Mbps internet).

- **Routing Decisions**: 100-1000 routes/second (client-side calculation)
- **Request Throughput**: 1k RPS sustained, 10k RPS peak (including routing overhead)
- **DHT Queries**: 65ms average (O(log N) lookup in 10k node network)
- **WireGuard Tunnels**: 100+ concurrent connections
- **Memory Footprint**: <200MB per client instance
- **CPU Overhead**: 1-5% average (excluding LLM inference)

#### 2.6.2 Network-Wide Scaling

Network throughput scales linearly with node count, with overhead from DHT coordination growing logarithmically.

**Phase 1 (10k nodes)**:
- **Sustained Throughput**: 10M RPS (1k RPS per node average)
- **Peak Throughput**: 100M RPS (10k RPS per node)
- **Monthly Requests**: 26 billion requests
- **DHT Lookup Time**: 65ms (log₂(10000) ≈ 13 hops × 5ms)
- **Effective Compute**: 80 vCPU cores (80% participation × 1% CPU contribution)

**Phase 2 (100k nodes)**:
- **Sustained Throughput**: 100M RPS
- **Peak Throughput**: 1B RPS
- **Monthly Requests**: 260 billion requests
- **DHT Lookup Time**: 85ms (log₂(100000) ≈ 17 hops × 5ms)
- **Effective Compute**: 800 vCPU cores

**Phase 3 (1M+ nodes)**:
- **Sustained Throughput**: 1B RPS
- **Peak Throughput**: 10B RPS
- **Monthly Requests**: 2.6 trillion requests
- **DHT Lookup Time**: 100ms (log₂(1000000) ≈ 20 hops × 5ms)
- **Effective Compute**: 8000+ vCPU cores

**Theoretical Limit**: 2^160 nodes (DHT key space) — practically unlimited

#### 2.6.3 Organic Scaling Mechanisms

P2P networks self-scale through participant incentives and distributed coordination algorithms.

**Automatic Capacity Scaling**:
- Each new user adds both demand (requests) AND capacity (contribution)
- No manual provisioning or auto-scaling configuration required
- Geographic diversity naturally improves through global user adoption
- Load balancing happens through client-side route selection

**Scaling Triggers** (Client-Side):
- **Increase Contribution**: CPU >80% → reduce local contribution percentage
- **Request More Peers**: DHT peer list <50 → discover more peers via gossip
- **Adjust Routing**: Latency >1s → prefer different network paths

### 2.7 Bootstrap Infrastructure Specifications

This section provides specific implementation details for the minimal company-operated bootstrap infrastructure (Model 2), including server specifications, costs, and operational procedures.

For Model 2 (Minimal Bootstrap), company operates 3-5 lightweight seed servers to accelerate initial peer discovery. These nodes do NOT route user requests.

#### 2.7.1 Bootstrap Node Requirements

**Server Specifications** (per node):
- **Instance Type**: AWS t3.micro, Google Cloud e2-micro, or equivalent
- **vCPUs**: 2
- **Memory**: 1GB RAM
- **Storage**: 8GB SSD (routing table cache)
- **Bandwidth**: 1TB/month (peer list serving)
- **Regions**: US-West-2, US-East-1, EU-West-1, AP-Southeast-1, AP-Northeast-1 (5 total)

**Software**:
- Minimal Go binary (DHT participant + HTTP server)
- Serves read-only routing table (backup from S3/blockchain)
- Provides list of 50-100 active DHT peers
- No request routing or proxying

**Estimated Cost**:
- $3.5/month per t3.micro instance × 5 regions = $17.50/month
- S3 storage + bandwidth: ~$30/month
- Domain + SSL certificates: ~$2/month
- **Total: ~$50-65/month**

#### 2.7.2 Operational Procedures

**High Availability**:
- Clients hardcode 5 bootstrap endpoints (multi-region)
- Clients try each endpoint until successful (failover)
- Bootstrap nodes are stateless (easy to replace)
- Health checks every 60s (automatic replacement if down)

**Monitoring**:
- Uptime monitoring (UptimeRobot, Pingdom)
- Request count and latency metrics
- Peer list freshness (update every 5 minutes from DHT)

**Security**:
- Bootstrap nodes cannot decrypt routing table (read-only)
- Rate limiting: 10 requests/second per IP
- DDoS protection via CloudFlare
- No persistent storage of user data

### 2.8 Migration Path from Centralized to Decentralized

This section outlines how the platform can transition from initial centralized deployments (if any) to the target fully distributed P2P architecture over time.

For teams that initially deploy centralized infrastructure, this section provides a roadmap for migrating to pure P2P operation.

#### Phase 1 → Phase 2 Migration: Centralized to Hybrid

**Initial State** (if starting centralized):
- Company operates routing servers, databases, load balancers
- Clients send requests to company API gateway

**Migration Steps**:
1. Deploy client-side routing engine (embedded in client update)
2. Clients download routing table from centralized database
3. Clients make routing decisions locally (still send via company proxy)
4. Gradually reduce company routing server capacity
5. Deprecate centralized routing API

**Outcome**: Hybrid model (clients route, company infrastructure still exists)

#### Phase 2 → Phase 3 Migration: Hybrid to P2P

**Initial State**:
- Clients route locally but still use company infrastructure for fallback
- Routing table stored on centralized database

**Migration Steps**:
1. Deploy routing table to blockchain/IPFS (parallel to database)
2. Clients pull from blockchain/IPFS (with centralized fallback)
3. Monitor adoption (% of requests via P2P vs centralized)
4. Once 95%+ requests via P2P, deprecate centralized infrastructure
5. Decommission databases, load balancers (keep only bootstrap nodes)

**Outcome**: Model 2 (Minimal Bootstrap) achieved

#### Phase 3 → Phase 4 Migration: Minimal Bootstrap to Fully Distributed

**Initial State**:
- Company operates 3-5 bootstrap nodes
- Clients cache peers after initial discovery

**Migration Steps**:
1. Implement federated community bootstrap program
2. Clients accept signed community bootstrap nodes (verified by company)
3. Monitor community bootstrap reliability
4. Deprecate company bootstrap nodes once community sufficient
5. Transition company to pure verification/signing service

**Outcome**: Model 3 (Federated Community Nodes) achieved

---

[← Previous: System Overview](../01-system-overview/README.md) | [Next: Distributed Routing Engine Specification →](../03-routing/README.md)

---
