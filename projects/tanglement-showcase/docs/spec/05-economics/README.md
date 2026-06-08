# Tanglement.ai Technical Specification - Section 5: Economic Mechanism Design

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

[← Previous: Security Architecture](../04-security/README.md) | [Next: Performance Engineering →](../06-performance/README.md)

---

## 5. Economic Mechanism Design

This section defines the economic mechanisms that incentivize P2P participation, ensure fair resource allocation, and create a sustainable network economy without relying on centralized infrastructure revenue. The design balances three competing objectives: user cost savings, contributor rewards, and long-term platform sustainability.

**Economic Philosophy**: Tanglement.ai uses a **single utility token model** combined with a **three-tier choice system** where users select ONE optimization focus (reliability, performance, OR price). Premium tier revenues cross-subsidize economy tier pricing, creating a sustainable circular economy powered by peer contributions.

**Critical Note**: Several economic mechanisms described in this section are **UNDER ACTIVE DEVELOPMENT**. Contribution mining rates, transaction fee percentages, and subsidization formulas represent preliminary models subject to change based on market testing and regulatory guidance.

### 5.1 Token Economics Architecture

The token architecture establishes the foundational value exchange mechanisms of the network. A single utility token simplifies user experience, avoids cryptocurrency speculation, and maintains regulatory clarity while supporting all network economic functions.

#### 5.1.1 Single Utility Token Model

**Why Single Token**: Dual-token models (utility + contribution) create complexity, confusion, and exchange rate volatility. A unified token serves all purposes: purchasing LLM access, rewarding contributors, and enabling governance participation.

**Tanglement.ai Utility Token (TAI)**:
- **Primary Function**: Credits for LLM API access via the network
- **NOT a cryptocurrency**: No trading, speculation, or external exchange listing
- **NOT a governance token**: Governance is separate from token holdings
- **Purely utility**: Tokens are spent to access LLM services through the P2P network

**Token Supply Model** *(Under Development)*:
- **Total Supply**: 1 billion tokens (fixed maximum)
- **Initial Distribution**:
  - 40% - Contribution mining rewards (released over 10 years)
  - 30% - Ecosystem development (grants, partnerships, community)
  - 20% - Team and advisors (4-year vesting, 1-year cliff)
  - 10% - Initial liquidity (early user acquisition, promotions)

**Token Acquisition Methods**:
1. **Purchase with fiat currency** (USD, EUR, etc.) via platform payment processor
2. **Earn through contribution mining** (see Section 5.2)
3. **Ecosystem grants** for developers building premium services
4. **Promotional rewards** during network growth phases

**Token Value Stability**: Tokens are pegged to LLM access costs, not market speculation. 1 TAI ≈ $X USD worth of LLM tokens, with exchange rate adjusted quarterly based on weighted average provider costs.

#### 5.1.2 Three-Tier Pricing Model

**Why Tiered Pricing**: Users have diverse needs. Production systems require reliability, real-time apps need speed, research workloads prioritize cost. Forcing users to choose ONE focus creates natural market segmentation and enables cross-subsidization.

**User Selection Requirement**: Upon network registration, users **MUST select exactly ONE tier**. This choice determines routing optimization, pricing, and SLA guarantees.

##### **Tier 1: Premium Reliability** (1.2x base token rate)

**What You Get**:
- 99.9% uptime SLA with automatic failover
- Multi-provider redundancy (requests routed to 2-3 providers simultaneously)
- Byzantine fault tolerance (consensus across multiple responses)
- Priority support with 1-hour response time

**What You Pay**:
- 1.2x base token rate (e.g., if base = 100 TAI, Premium Reliability = 120 TAI)

**Use Case**: Production systems, mission-critical applications, regulated industries

**Routing Optimization**: Client-side routing prioritizes providers with highest historical uptime, even if costs are higher

##### **Tier 2: Premium Performance** (1.2x base token rate)

**What You Get**:
- P95 latency < 1 second for routing overhead
- Geographic routing optimization (closest provider selected)
- Advanced semantic caching with 40%+ hit rate
- Priority queue processing

**What You Pay**:
- 1.2x base token rate (e.g., if base = 100 TAI, Premium Performance = 120 TAI)

**Use Case**: Real-time chat applications, customer-facing services, interactive experiences

**Routing Optimization**: Client-side routing prioritizes providers with lowest latency, aggressive caching, prefetching

##### **Tier 3: Economy Pricing** (0.6-0.8x base token rate, subsidized)

**What You Get**:
- 20-40% cost savings below direct provider access
- Access to same provider network as premium tiers
- Best-effort reliability (95%+ uptime, no SLA)
- Community support

**What You Pay**:
- 0.6-0.8x base token rate (subsidized by premium tier revenues)

**Use Case**: Research, development, batch processing, high-volume workloads with flexible timing

**Routing Optimization**: Client-side routing prioritizes cheapest providers, tolerates higher latency/failure rates

#### 5.1.3 Token Flow Mechanics

Token flow describes how TAI tokens move through the system as users consume services, contributors earn rewards, and the platform captures transaction fees to fund premium services.

```go
type TokenEconomics struct {
    totalSupply          decimal.Decimal // Fixed: 1 billion TAI
    circulatingSupply    decimal.Decimal // Tokens released to date
    contributionPool     decimal.Decimal // Reserved for mining rewards
    subsidyPool          decimal.Decimal // Premium tier → Economy tier subsidy
    transactionFeeRate   decimal.Decimal // 0.5-2% (under development)
    tierPricing          map[TierType]decimal.Decimal
}

type TierType int
const (
    TierPremiumReliability TierType = iota
    TierPremiumPerformance
    TierEconomyPricing
)

func (te *TokenEconomics) CalculateRequestCost(
    baseProviderCost decimal.Decimal,
    tier TierType,
) *RequestCost {
    // Base cost from LLM provider (e.g., OpenAI, Anthropic pricing)
    baseCost := baseProviderCost

    // Apply tier multiplier
    tierMultiplier := te.getTierMultiplier(tier)
    tierAdjustedCost := baseCost.Mul(tierMultiplier)

    // Apply transaction fee (0.5-2%, under development)
    transactionFee := tierAdjustedCost.Mul(te.transactionFeeRate)

    // Calculate subsidy (if Economy tier)
    subsidy := decimal.Zero
    if tier == TierEconomyPricing {
        subsidy = te.calculateSubsidy(baseCost)
    }

    finalCost := tierAdjustedCost.Add(transactionFee).Sub(subsidy)

    return &RequestCost{
        BaseCost:        baseCost,
        TierMultiplier:  tierMultiplier,
        TierAdjustedCost: tierAdjustedCost,
        TransactionFee:  transactionFee,
        Subsidy:         subsidy,
        FinalCost:       finalCost,
        TokensRequired:  te.convertUSDToTokens(finalCost),
    }
}

func (te *TokenEconomics) getTierMultiplier(tier TierType) decimal.Decimal {
    switch tier {
    case TierPremiumReliability:
        return decimal.NewFromFloat(1.2) // 20% premium
    case TierPremiumPerformance:
        return decimal.NewFromFloat(1.2) // 20% premium
    case TierEconomyPricing:
        return decimal.NewFromFloat(1.0) // Base rate (subsidy applied separately)
    default:
        return decimal.NewFromFloat(1.0)
    }
}
```

### 5.2 Contribution Mining Economics

**Why Contribution Mining**: Pure P2P networks require participants to contribute resources (CPU, bandwidth, storage, uptime). Token rewards incentivize contributions, creating a circular economy where users offset their LLM access costs by hosting network infrastructure.

**IMPORTANT**: The contribution mining economics are **UNDER ACTIVE DEVELOPMENT**. Reward rates, measurement methodologies, and proof-of-contribution protocols described below represent preliminary models subject to change based on network performance data and regulatory guidance.

#### 5.2.1 Contribution Mining Overview

**Four Contribution Types**:
1. **CPU Contribution**: Processing power for routing calculations, encryption, caching
2. **Bandwidth Contribution**: Network throughput for relaying requests/responses
3. **Storage Contribution**: Disk space for routing tables, semantic cache, DHT data
4. **Uptime Contribution**: Availability and reachability for P2P mesh operations

**Contribution Measurement Challenge**: Measuring contributions in a trustless P2P network is non-trivial. How do we verify a node actually contributed resources without centralized monitoring?

**Three Measurement Models Under Evaluation**:

##### **Model A: Peer Attestation (Recommended for MVP)** ⭐

**How It Works**:
- Nodes collect signed attestations from peers they served
- Minimum 5 peer attestations required per contribution claim
- Attestations include resource type, amount, timestamp, quality metrics
- Rewards calculated based on verified attestations

**Pros**:
- ✅ Fully distributed (no company verification)
- ✅ Byzantine fault tolerant (requires collusion of 5+ peers)
- ✅ Scales with network size
- ✅ Implementable in Phase 1

**Cons**:
- ⚠️ Vulnerable to Sybil attacks (one entity creating multiple fake peers)
- ⚠️ Requires anti-collusion mechanisms
- ⚠️ Attestation storage overhead (~1KB per attestation, 5 attestations/claim)

**Cost**: Minimal infrastructure ($0/month company cost)

##### **Model B: Zero-Knowledge Proofs**

**How It Works**:
- Nodes generate cryptographic proofs of computation/bandwidth/storage
- zk-SNARKs prove "I processed X CPU hours" without revealing details
- Proofs verified by smart contract on blockchain
- Rewards distributed automatically via smart contract

**Pros**:
- ✅ Cryptographically verifiable
- ✅ Maximum privacy (zero-knowledge)
- ✅ Trustless verification
- ✅ Eliminates peer collusion risk

**Cons**:
- ❌ High computational overhead for proof generation (~1-5 seconds per proof)
- ❌ Requires blockchain integration (Ethereum gas fees: $0.50-$5 per proof)
- ❌ Complex implementation (6-12 month development time)
- ❌ Not viable for MVP

**Cost**: $10k-$50k/month in blockchain gas fees at 10k nodes

##### **Model C: Hybrid (Attestation + Random Sampling)**

**How It Works**:
- Peer attestations for most contributions (90%)
- Random sampling with company verification (10%)
- Randomly selected nodes undergo detailed verification
- Statistical sampling detects systemic gaming

**Pros**:
- ✅ Reduces Sybil attack success rate
- ✅ Company verification limited to 10% (reduces centralization)
- ✅ Scalable and cost-effective
- ✅ Implementable in Phase 2-3

**Cons**:
- ⚠️ Requires minimal company infrastructure (verification service)
- ⚠️ 10% of rewards depend on company availability
- ⚠️ Partial centralization (10% verification)

**Cost**: $500-$2,000/month (verification API service)

**Recommendation**: Start with **Model A (Peer Attestation)** for MVP, transition to **Model C (Hybrid)** in Phase 3-4 as network matures.

#### 5.2.2 CPU Contribution Model *(Under Development)*

**What Counts as CPU Contribution**:
- Client-side routing calculations (multi-objective optimization)
- Encryption/decryption overhead (Signal Protocol, AES-256-GCM)
- Semantic cache embedding generation (vector search)
- DHT finger table maintenance (Chord protocol operations)
- Gossip protocol message processing

**Measurement Methodology** (Preliminary):
- Track CPU time spent on network operations (separate from user's LLM usage)
- Baseline CPU spec: 2.0 GHz single-core equivalent
- Contribution tracked in "CPU-hours normalized to baseline"

**Reward Calculation** *(Example - Subject to Change)*:
```go
type CPUContribution struct {
    NodeID              NodeID
    TimeWindow          TimeRange // e.g., 24 hours
    CPUHoursNormalized  decimal.Decimal // CPU hours at baseline spec
    QualityMultiplier   decimal.Decimal // Uptime, latency performance bonus
    PeerAttestations    []*PeerAttestation
    TotalReward         decimal.Decimal // TAI tokens earned
}

func (te *TokenEconomics) CalculateCPUReward(contribution *CPUContribution) decimal.Decimal {
    // Preliminary rate: 10 TAI per CPU-hour (SUBJECT TO CHANGE)
    baseRate := decimal.NewFromFloat(10.0)
    baseReward := contribution.CPUHoursNormalized.Mul(baseRate)

    // Apply quality multiplier (1.0-1.5x based on uptime, performance)
    qualityMultiplier := te.calculateQualityMultiplier(contribution)
    adjustedReward := baseReward.Mul(qualityMultiplier)

    // Apply network effects bonus (early adopter boost: 1.0-2.0x in Year 1)
    networkBonus := te.calculateNetworkBonus(contribution.NodeID)
    finalReward := adjustedReward.Mul(networkBonus)

    return finalReward
}
```

**Anti-Gaming Measures**:
- Maximum CPU contribution cap: 100 CPU-hours/day per node (prevents fake workload generation)
- Peer attestation requirement: Minimum 5 unique peers must verify contribution
- Statistical anomaly detection: Contributions >3 standard deviations flagged for review

#### 5.2.3 Bandwidth Contribution Model *(Under Development)*

**What Counts as Bandwidth Contribution**:
- Relaying LLM requests from peers to providers
- Relaying responses back to requesting clients
- Distributing encrypted routing table updates
- DHT lookup responses
- Gossip protocol message propagation

**Measurement Methodology** (Preliminary):
- Track bytes transferred for network operations (separate from user's own requests)
- Only count verified bandwidth (peer attestations required)
- Measured in GB transferred per time window

**Reward Calculation** *(Example - Subject to Change)*:
```go
type BandwidthContribution struct {
    NodeID              NodeID
    TimeWindow          TimeRange
    BytesTransferred    uint64 // Total bytes relayed for network
    PeerAttestations    []*PeerAttestation
    TotalReward         decimal.Decimal
}

func (te *TokenEconomics) CalculateBandwidthReward(contribution *BandwidthContribution) decimal.Decimal {
    // Preliminary rate: 1 TAI per GB transferred (SUBJECT TO CHANGE)
    baseRate := decimal.NewFromFloat(1.0)
    gbTransferred := decimal.NewFromFloat(float64(contribution.BytesTransferred) / 1e9)
    baseReward := gbTransferred.Mul(baseRate)

    // Geographic diversity bonus (underserved regions: +20%)
    geoBonus := te.calculateGeographicBonus(contribution.NodeID)
    finalReward := baseReward.Mul(geoBonus)

    return finalReward
}
```

**Anti-Gaming Measures**:
- Maximum bandwidth cap: 500 GB/day per node
- Peer attestation requirement: Both sender and receiver must attest
- Bandwidth verification: Random sampling checks actual transferred data size

#### 5.2.4 Storage Contribution Model *(Under Development)*

**What Counts as Storage Contribution**:
- Hosting encrypted routing table (blockchain/IPFS replication)
- Maintaining semantic cache entries for popular prompts
- DHT data storage (peer routing information)
- Backup storage for network redundancy

**Measurement Methodology** (Preliminary):
- Track GB-hours of storage provided (GB × hours available)
- Storage must be accessible with <500ms latency
- Random verification checks ensure data integrity

**Reward Calculation** *(Example - Subject to Change)*:
```go
type StorageContribution struct {
    NodeID              NodeID
    TimeWindow          TimeRange
    GBHoursProvided     decimal.Decimal // GB × hours
    DataIntegrityScore  decimal.Decimal // 0.0-1.0 based on verification checks
    TotalReward         decimal.Decimal
}

func (te *TokenEconomics) CalculateStorageReward(contribution *StorageContribution) decimal.Decimal {
    // Preliminary rate: 0.1 TAI per GB-hour (SUBJECT TO CHANGE)
    baseRate := decimal.NewFromFloat(0.1)
    baseReward := contribution.GBHoursProvided.Mul(baseRate)

    // Data integrity multiplier (reduce rewards if failed verification checks)
    integrityMultiplier := contribution.DataIntegrityScore
    finalReward := baseReward.Mul(integrityMultiplier)

    return finalReward
}
```

**Anti-Gaming Measures**:
- Random data integrity checks (request random cached items, verify correctness)
- Latency requirements (<500ms response time for cache hits)
- Minimum uptime (95%+ availability required for storage rewards)

#### 5.2.5 Uptime Contribution Model *(Under Development)*

**What Counts as Uptime Contribution**:
- Being online and reachable via WireGuard mesh
- Responding to DHT lookups
- Participating in gossip protocol synchronization
- Maintaining <100ms ping response to peers

**Measurement Methodology** (Preliminary):
- Periodic peer health checks (every 5 minutes)
- Uptime calculated as percentage of successful health checks
- Minimum 95% uptime required for rewards

**Reward Calculation** *(Example - Subject to Change)*:
```go
type UptimeContribution struct {
    NodeID              NodeID
    TimeWindow          TimeRange // e.g., 24 hours
    TotalChecks         uint64
    SuccessfulChecks    uint64
    UptimePercentage    decimal.Decimal
    TotalReward         decimal.Decimal
}

func (te *TokenEconomics) CalculateUptimeReward(contribution *UptimeContribution) decimal.Decimal {
    // Preliminary rate: 5 TAI per day at 99% uptime (SUBJECT TO CHANGE)
    baseRate := decimal.NewFromFloat(5.0)

    // Uptime must exceed 95% threshold
    if contribution.UptimePercentage.LessThan(decimal.NewFromFloat(0.95)) {
        return decimal.Zero
    }

    // Bonus for high uptime (99%+ earns full reward, 95-99% scaled linearly)
    uptimeMultiplier := contribution.UptimePercentage.Sub(decimal.NewFromFloat(0.95)).
        Div(decimal.NewFromFloat(0.04)) // (uptime - 0.95) / 0.04
    finalReward := baseRate.Mul(uptimeMultiplier)

    return finalReward
}
```

**Anti-Gaming Measures**:
- Health checks from multiple random peers (not just friends)
- Requires actual DHT participation (must respond to lookups)
- Bandwidth + CPU contribution correlated with uptime (pure online time without work = no reward)

#### 5.2.6 Proof-of-Contribution Protocol

**Why Proof Required**: Without verifiable proof, nodes could claim arbitrary contributions. Cryptographic proofs enable trustless verification in a fully distributed network.

**Proof Components**:
1. **Contribution Data**: CPU hours, bandwidth GB, storage GB-hours, uptime percentage
2. **Peer Attestations**: Signed statements from peers verifying contribution
3. **Merkle Proof**: Cryptographic proof linking contribution to blockchain/DHT record
4. **Node Signature**: ed25519 signature proving authenticity

```go
type ContributionProof struct {
    NodeID              NodeID
    TimeWindow          TimeRange

    // Contribution metrics
    CPUContribution     *CPUContribution
    BandwidthContribution *BandwidthContribution
    StorageContribution *StorageContribution
    UptimeContribution  *UptimeContribution

    // Verification data
    PeerAttestations    []*PeerAttestation // Minimum 5 unique peers
    MerkleProof         []byte              // Proof inclusion in blockchain/DHT
    NodeSignature       [64]byte            // ed25519 signature

    // Calculated reward
    TotalReward         decimal.Decimal     // TAI tokens earned
}

type PeerAttestation struct {
    AttestingNodeID     NodeID
    ContributionType    ContributionType
    Amount              decimal.Decimal
    QualityScore        decimal.Decimal // 0.0-1.0
    Timestamp           time.Time
    Signature           [64]byte // Attesting node's signature
}

func (node *NetworkNode) GenerateContributionProof(timeWindow TimeRange) (*ContributionProof, error) {
    // Collect local metrics
    cpuContribution := node.measureCPUContribution(timeWindow)
    bandwidthContribution := node.measureBandwidthContribution(timeWindow)
    storageContribution := node.measureStorageContribution(timeWindow)
    uptimeContribution := node.measureUptimeContribution(timeWindow)

    // Collect peer attestations (minimum 5 required)
    attestations := node.collectPeerAttestations(timeWindow)
    if len(attestations) < 5 {
        return nil, ErrInsufficientAttestations
    }

    // Generate Merkle proof (prove contribution recorded in DHT/blockchain)
    contributionData := node.serializeContributionData(
        cpuContribution,
        bandwidthContribution,
        storageContribution,
        uptimeContribution,
    )
    merkleProof, err := node.generateMerkleProof(contributionData)
    if err != nil {
        return nil, err
    }

    // Calculate total reward
    economics := node.getTokenEconomics()
    totalReward := decimal.Zero
    totalReward = totalReward.Add(economics.CalculateCPUReward(cpuContribution))
    totalReward = totalReward.Add(economics.CalculateBandwidthReward(bandwidthContribution))
    totalReward = totalReward.Add(economics.CalculateStorageReward(storageContribution))
    totalReward = totalReward.Add(economics.CalculateUptimeReward(uptimeContribution))

    proof := &ContributionProof{
        NodeID:                node.ID,
        TimeWindow:            timeWindow,
        CPUContribution:       cpuContribution,
        BandwidthContribution: bandwidthContribution,
        StorageContribution:   storageContribution,
        UptimeContribution:    uptimeContribution,
        PeerAttestations:      attestations,
        MerkleProof:           merkleProof,
        TotalReward:           totalReward,
    }

    // Sign the proof
    signature, err := node.signContributionProof(proof)
    if err != nil {
        return nil, err
    }
    proof.NodeSignature = signature

    return proof, nil
}

func (node *NetworkNode) VerifyContributionProof(proof *ContributionProof) error {
    // Verify node signature
    if !node.verifySignature(proof.NodeID, proof.serializeForSigning(), proof.NodeSignature) {
        return ErrInvalidSignature
    }

    // Verify peer attestations (minimum 5 unique peers required)
    if len(proof.PeerAttestations) < 5 {
        return ErrInsufficientAttestations
    }

    uniquePeers := make(map[NodeID]bool)
    for _, attestation := range proof.PeerAttestations {
        // Verify attestation signature
        if !node.verifyAttestationSignature(attestation) {
            return ErrInvalidAttestationSignature
        }
        uniquePeers[attestation.AttestingNodeID] = true
    }

    if len(uniquePeers) < 5 {
        return ErrInsufficientUniquePeers
    }

    // Verify Merkle proof (contribution exists in blockchain/DHT)
    if !node.verifyMerkleProof(proof.MerkleProof, proof.serializeContributionData()) {
        return ErrInvalidMerkleProof
    }

    // Verify reward calculation matches
    economics := node.getTokenEconomics()
    expectedReward := decimal.Zero
    expectedReward = expectedReward.Add(economics.CalculateCPUReward(proof.CPUContribution))
    expectedReward = expectedReward.Add(economics.CalculateBandwidthReward(proof.BandwidthContribution))
    expectedReward = expectedReward.Add(economics.CalculateStorageReward(proof.StorageContribution))
    expectedReward = expectedReward.Add(economics.CalculateUptimeReward(proof.UptimeContribution))

    if !proof.TotalReward.Equal(expectedReward) {
        return ErrInvalidRewardCalculation
    }

    return nil
}
```

### 5.3 Cross-Subsidization Mechanics

**Why Cross-Subsidization**: Economy tier users (20-40% cost savings) cannot be served profitably at discounted rates without external funding. Premium tier users pay 1.2x rates, generating surplus revenue that subsidizes economy tier pricing.

**Economic Sustainability**: The model requires approximately 30-40% of users to select premium tiers to subsidize 60-70% economy tier users. Market research suggests enterprise customers (production systems) represent 35-45% of LLM API usage, making this ratio achievable.

#### 5.3.1 Premium-to-Economy Revenue Flow

**How Subsidization Works**:
1. **Premium tier users** pay 1.2x base rate (20% premium)
2. **20% premium revenue** flows into subsidy pool
3. **Subsidy pool** distributed to economy tier users as discounts
4. **Economy tier users** pay 0.6-0.8x base rate (20-40% discount)

**Example Calculation** *(Stated Assumptions)*:
- **Assumptions**:
  - 10,000 total users
  - 3,000 Premium Reliability users (30%)
  - 1,000 Premium Performance users (10%)
  - 6,000 Economy Pricing users (60%)
  - Average request cost: $0.10 (base provider rate)
  - Average requests per user per month: 1,000

**Revenue Calculation**:
```
Premium Reliability Revenue:
  3,000 users × 1,000 requests/month × $0.10 × 1.2 = $360,000/month

Premium Performance Revenue:
  1,000 users × 1,000 requests/month × $0.10 × 1.2 = $120,000/month

Total Premium Revenue: $480,000/month
Premium Surplus (20% over base): $80,000/month

Economy Tier Base Cost:
  6,000 users × 1,000 requests/month × $0.10 = $600,000/month

Subsidy Available: $80,000/month
Subsidy Per Economy User: $80,000 / 6,000 = $13.33/user/month
Effective Discount: $13.33 / $100 = 13.3%

Economy Tier Effective Rate: $100 - $13.33 = $86.67/user/month (13.3% discount)
```

**Subsidy Rate Adjustments** *(Under Development)*:
- If economy tier grows >70% of users, reduce subsidy percentage (e.g., 10% discount instead of 20%)
- If premium tiers exceed 50%, increase subsidy percentage (e.g., 30% discount)
- Dynamic adjustment algorithm balances user acquisition with economic sustainability

```go
type CrossSubsidizationEngine struct {
    subsidyPool         decimal.Decimal
    tierDistribution    map[TierType]int // User counts per tier
    subsidyRateTarget   decimal.Decimal  // Target discount (0.2 = 20%)
    adjustmentInterval  time.Duration    // Recalculate subsidy monthly
}

func (cse *CrossSubsidizationEngine) CalculateSubsidyAllocation() *SubsidyAllocation {
    totalUsers := cse.getTotalUserCount()
    economyUsers := cse.tierDistribution[TierEconomyPricing]
    premiumUsers := cse.tierDistribution[TierPremiumReliability] +
                   cse.tierDistribution[TierPremiumPerformance]

    // Calculate premium-to-economy ratio
    premiumRatio := decimal.NewFromInt(int64(premiumUsers)).
        Div(decimal.NewFromInt(int64(totalUsers)))

    // Adjust subsidy rate based on tier distribution
    subsidyRate := cse.calculateDynamicSubsidyRate(premiumRatio)

    // Calculate total subsidy available
    totalSubsidy := cse.subsidyPool

    // Allocate evenly across economy users
    perUserSubsidy := decimal.Zero
    if economyUsers > 0 {
        perUserSubsidy = totalSubsidy.Div(decimal.NewFromInt(int64(economyUsers)))
    }

    return &SubsidyAllocation{
        TotalSubsidyPool:     totalSubsidy,
        EconomyUserCount:     economyUsers,
        SubsidyPerUser:       perUserSubsidy,
        EffectiveDiscountPct: subsidyRate,
    }
}

func (cse *CrossSubsidizationEngine) calculateDynamicSubsidyRate(premiumRatio decimal.Decimal) decimal.Decimal {
    // Target: 40% premium users → 20% discount for economy
    targetRatio := decimal.NewFromFloat(0.40)
    targetSubsidy := decimal.NewFromFloat(0.20)

    // If premium ratio exceeds target, increase subsidy
    if premiumRatio.GreaterThan(targetRatio) {
        bonus := premiumRatio.Sub(targetRatio).Mul(decimal.NewFromFloat(0.5))
        return targetSubsidy.Add(bonus)
    }

    // If premium ratio below target, reduce subsidy
    penalty := targetRatio.Sub(premiumRatio).Mul(decimal.NewFromFloat(0.5))
    subsidyRate := targetSubsidy.Sub(penalty)

    // Minimum subsidy: 10%
    minSubsidy := decimal.NewFromFloat(0.10)
    if subsidyRate.LessThan(minSubsidy) {
        return minSubsidy
    }

    return subsidyRate
}
```

#### 5.3.2 Transaction Fee Model *(Under Development)*

**Why Transaction Fees**: Premium services (PII redaction, prompt injection prevention, content moderation) require company-operated infrastructure. Transaction fees fund these services without compromising core P2P operation.

**Preliminary Fee Structure** *(SUBJECT TO CHANGE)*:
- **Base transaction fee**: 0.5-2% of request cost
- **Fee applied**: To all tiers (Premium Reliability, Premium Performance, Economy)
- **Fee collection**: Deducted from user token balance at request time
- **Fee allocation**:
  - 60% - Premium service infrastructure (PII detection, content moderation APIs)
  - 20% - Platform development (client software, protocol improvements)
  - 20% - Subsidy pool contribution (additional economy tier support)

**Fee Calculation Example**:
```
Request base cost: $0.10
Premium Reliability tier multiplier: 1.2x
Tier-adjusted cost: $0.12
Transaction fee (1%): $0.0012
Final user cost: $0.1212

Fee distribution:
  Premium services: $0.00072 (60%)
  Platform development: $0.00024 (20%)
  Subsidy pool: $0.00024 (20%)
```

**Fee Transparency**: All transaction fees disclosed in client UI before request submission. Users can opt out of premium services to avoid fees (falls back to base P2P routing).

### 5.4 Anti-Gaming and Fair Allocation

Economic systems attract gaming attempts. Multi-layered detection protects reward integrity while fair allocation prevents resource monopolization by large users.

#### 5.4.1 Anti-Gaming Mechanisms

**Common Gaming Attacks**:
1. **Sybil Attacks**: One entity creating multiple fake nodes to claim excess rewards
2. **Contribution Inflation**: Reporting false CPU/bandwidth/storage metrics
3. **Attestation Collusion**: Coordinating with friends to provide fake peer attestations
4. **Metric Manipulation**: Artificially inflating uptime, latency, or quality scores

**Detection Strategies**:

```go
type AntiGamingSystem struct {
    behaviorAnalyzer  *BehaviorAnalyzer
    anomalyDetector   *AnomalyDetector
    attestationValidator *AttestationValidator
    penaltyCalculator *PenaltyCalculator
}

func (ags *AntiGamingSystem) DetectGamingAttempts(proof *ContributionProof) *GamingAssessment {
    assessment := &GamingAssessment{
        NodeID:      proof.NodeID,
        RiskScore:   0.0,
        Indicators:  make([]GamingIndicator, 0),
    }

    // Check 1: Contribution spikes (sudden 10x increase = suspicious)
    if ags.detectContributionSpikes(proof) {
        assessment.RiskScore += 0.3
        assessment.Indicators = append(assessment.Indicators, GamingIndicator{
            Type:     "CONTRIBUTION_SPIKE",
            Severity: "HIGH",
            Description: "CPU contribution increased 10x in 24 hours",
        })
    }

    // Check 2: Coordinated attestations (same 5 peers always attest together)
    if ags.detectAttestationCollusion(proof) {
        assessment.RiskScore += 0.4
        assessment.Indicators = append(assessment.Indicators, GamingIndicator{
            Type:     "ATTESTATION_COLLUSION",
            Severity: "CRITICAL",
            Description: "Attestations from same peer group across multiple time windows",
        })
    }

    // Check 3: Impossible metrics (100% uptime + 0ms latency = fake)
    if ags.detectImpossibleMetrics(proof) {
        assessment.RiskScore += 0.5
        assessment.Indicators = append(assessment.Indicators, GamingIndicator{
            Type:     "IMPOSSIBLE_METRICS",
            Severity: "CRITICAL",
            Description: "Metrics exceed physical/network constraints",
        })
    }

    // Check 4: New node with high contributions (no history = suspicious)
    if ags.detectNewNodeAnomalies(proof) {
        assessment.RiskScore += 0.2
        assessment.Indicators = append(assessment.Indicators, GamingIndicator{
            Type:     "NEW_NODE_ANOMALY",
            Severity: "MEDIUM",
            Description: "High contributions from node with <7 days history",
        })
    }

    // Apply penalties if risk score exceeds thresholds
    if assessment.RiskScore >= 0.7 {
        assessment.RecommendedAction = "REJECT_CLAIM"
    } else if assessment.RiskScore >= 0.4 {
        assessment.RecommendedAction = "REDUCE_REWARD_50%"
    }

    return assessment
}

func (ags *AntiGamingSystem) detectAttestationCollusion(proof *ContributionProof) bool {
    // Get historical attestations for this node
    historicalAttestations := ags.getHistoricalAttestations(proof.NodeID, 30) // Last 30 days

    // Extract peer IDs from current proof
    currentPeers := make(map[NodeID]bool)
    for _, attestation := range proof.PeerAttestations {
        currentPeers[attestation.AttestingNodeID] = true
    }

    // Check overlap with historical attestations
    overlapCounts := make(map[string]int)
    for _, historical := range historicalAttestations {
        peerSet := ags.serializePeerSet(historical.AttesterIDs)
        overlapCounts[peerSet]++
    }

    // If same peer group appears >5 times, flag as collusion
    currentPeerSet := ags.serializePeerSet(currentPeers)
    if overlapCounts[currentPeerSet] > 5 {
        return true
    }

    return false
}
```

**Penalty Mechanisms**:
- **Warning** (risk score 0.3-0.4): Flag for manual review, no immediate penalty
- **Reward Reduction** (risk score 0.4-0.7): Reduce claimed reward by 50%
- **Claim Rejection** (risk score 0.7+): Reject contribution claim entirely, no tokens awarded
- **Node Suspension** (3+ rejections in 30 days): Temporarily ban node from earning rewards for 7 days

#### 5.4.2 Fair Resource Allocation

**Why Fair Queuing**: Without allocation controls, large users (e.g., enterprises making 10M requests/month) could monopolize network capacity, degrading service for smaller users.

**Weighted Fair Queuing**: Allocate processing capacity proportionally across user tiers and request priorities.

```go
type FairQueueManager struct {
    queues           map[QueueClass]*WeightedQueue
    scheduler        *WeightedFairScheduler
    rateLimiters     map[NodeID]*TokenBucket
}

type QueueClass int
const (
    QueueClassPremiumReliability QueueClass = iota // Weight: 0.5
    QueueClassPremiumPerformance                   // Weight: 0.3
    QueueClassEconomy                              // Weight: 0.2
)

func (fqm *FairQueueManager) EnqueueRequest(request *LLMRequest) error {
    // Classify request based on user tier
    queueClass := fqm.classifyRequest(request)
    queue := fqm.queues[queueClass]

    // Check rate limits (per-user token bucket)
    rateLimiter := fqm.rateLimiters[request.ClientID]
    if !rateLimiter.ConsumeTokens(1) {
        return ErrRateLimitExceeded
    }

    // Calculate virtual finish time (weighted fair scheduling)
    estimatedTokens := fqm.estimateTokenUsage(request)
    serviceTime := decimal.NewFromInt(int64(estimatedTokens)).Div(queue.weight)
    virtualFinishTime := queue.virtualTime.Add(serviceTime)

    queuedReq := QueuedRequest{
        Request:           request,
        ArrivalTime:       time.Now(),
        Priority:          fqm.calculatePriority(request, queueClass),
        EstimatedTokens:   estimatedTokens,
        VirtualFinishTime: virtualFinishTime,
    }

    // Insert into queue (sorted by virtual finish time)
    fqm.insertInOrder(queue, queuedReq)
    return nil
}

func (fqm *FairQueueManager) calculatePriority(request *LLMRequest, class QueueClass) int {
    basePriority := 0

    switch class {
    case QueueClassPremiumReliability:
        basePriority = 100 // Highest priority
    case QueueClassPremiumPerformance:
        basePriority = 80
    case QueueClassEconomy:
        basePriority = 50 // Lower priority
    }

    // Adjust for request age (prevent starvation)
    ageBonus := int(time.Since(request.Timestamp).Seconds() / 10) // +1 per 10 seconds waiting
    return basePriority + ageBonus
}
```

**Rate Limiting** (Per-User Token Buckets):
- **Premium Reliability**: 1,000 requests/minute (burst: 2,000)
- **Premium Performance**: 800 requests/minute (burst: 1,500)
- **Economy**: 500 requests/minute (burst: 1,000)

### 5.6 Economic Governance

**Why Governance**: Economic parameters (tier pricing, contribution reward rates, transaction fees) may require adjustment as market conditions change. Decentralized governance enables community participation in economic policy decisions.

**Important**: Governance mechanisms are **UNDER DEVELOPMENT**. The framework below represents a preliminary design subject to change based on regulatory guidance and community feedback.

#### 5.6.1 Token Governance Model *(Under Development)*

**Governance Scope**:
- Adjusting tier pricing multipliers (currently 1.2x for premium tiers)
- Setting contribution reward rates (CPU, bandwidth, storage, uptime)
- Modifying transaction fee percentage (currently 0.5-2%)
- Allocating ecosystem development funds
- Approving premium service partnerships

**Voting Mechanism**:
- **Who Can Vote**: All token holders (1 TAI = 1 vote)
- **Proposal Threshold**: Minimum 1% of circulating supply to submit proposal
- **Quorum Requirement**: 10% of circulating supply must vote
- **Passage Threshold**: 60% approval required
- **Voting Period**: 7 days

```go
type GovernanceSystem struct {
    proposals        map[ProposalID]*Proposal
    votes           map[ProposalID]map[NodeID]*Vote
    votingPeriod    time.Duration // 7 days
    quorumThreshold decimal.Decimal // 10%
    passThreshold   decimal.Decimal // 60%
}

type Proposal struct {
    ProposalID          ProposalID
    ProposerNodeID      NodeID
    ProposalType        ProposalType // ECONOMIC_PARAMETER, ECOSYSTEM_ALLOCATION, etc.
    Title               string
    Description         string
    ProposedChanges     map[string]interface{} // Parameter: NewValue
    SubmissionTime      time.Time
    VotingDeadline      time.Time
    Status              ProposalStatus
}

func (gs *GovernanceSystem) SubmitProposal(proposal *Proposal) error {
    // Verify proposer holds minimum 1% of supply
    proposerBalance := gs.getTokenBalance(proposal.ProposerNodeID)
    minimumBalance := gs.circulatingSupply.Mul(decimal.NewFromFloat(0.01))

    if proposerBalance.LessThan(minimumBalance) {
        return ErrInsufficientTokensToPropose
    }

    proposal.SubmissionTime = time.Now()
    proposal.VotingDeadline = time.Now().Add(gs.votingPeriod)
    proposal.Status = ProposalStatusActive

    gs.proposals[proposal.ProposalID] = proposal
    return nil
}

func (gs *GovernanceSystem) TallyVotes(proposalID ProposalID) *VotingResult {
    votes := gs.votes[proposalID]

    result := &VotingResult{
        ProposalID:       proposalID,
        TotalVotingPower: decimal.Zero,
        ForVotes:         decimal.Zero,
        AgainstVotes:     decimal.Zero,
        QuorumMet:        false,
        Passed:           false,
    }

    // Tally votes (weighted by token balance)
    for nodeID, vote := range votes {
        votingPower := gs.getTokenBalance(nodeID)
        result.TotalVotingPower = result.TotalVotingPower.Add(votingPower)

        switch vote.Choice {
        case VoteChoiceFor:
            result.ForVotes = result.ForVotes.Add(votingPower)
        case VoteChoiceAgainst:
            result.AgainstVotes = result.AgainstVotes.Add(votingPower)
        }
    }

    // Check quorum (10% of supply must vote)
    quorumRequirement := gs.circulatingSupply.Mul(gs.quorumThreshold)
    result.QuorumMet = result.TotalVotingPower.GreaterThanOrEqual(quorumRequirement)

    // Check if passes (60% approval required)
    if result.QuorumMet {
        votesForOrAgainst := result.ForVotes.Add(result.AgainstVotes)
        if votesForOrAgainst.IsPositive() {
            supportRatio := result.ForVotes.Div(votesForOrAgainst)
            result.Passed = supportRatio.GreaterThanOrEqual(gs.passThreshold)
        }
    }

    return result
}
```

### 5.7 Economic Performance Targets

This section establishes quantitative benchmarks for economic health. These metrics guide economic policy adjustments and measure ecosystem sustainability.

**Token Velocity**: 10+ transactions per token per month
- **Definition**: Number of times each token changes hands monthly
- **Target**: High velocity indicates active usage, not hoarding
- **Measurement**: Total monthly transaction volume / circulating supply

**Network Revenue** *(Goal - Subject to Change)*:
- **Year 1**: $1M ARR (target: 10k users, $100/user/year)
- **Year 2**: $10M ARR (target: 100k users, $100/user/year)
- **Revenue Sources**: Token sales (80%), transaction fees (15%), premium services (5%)

**Cost Savings for Users**:
- **Average across all tiers**: 25% reduction vs. direct provider access
- **Economy tier**: 40% cost savings
- **Premium tiers**: 10-15% savings (paying for reliability/performance, not just price)

**Contribution Rate**: 80% of nodes actively contributing resources
- **Definition**: Percentage of registered nodes earning tokens through CPU/bandwidth/storage/uptime contribution
- **Target**: High contribution rate ensures network sustainability without external funding
- **Measurement**: Nodes with contribution claims in last 30 days / total registered nodes

**Cross-Subsidization Balance**:
- **Target ratio**: 40% premium tiers, 60% economy tier
- **Subsidy coverage**: Premium revenues should cover 100% of economy tier discounts
- **Monitoring**: Monthly financial reports track subsidy pool health

---

[← Previous: Security Architecture](../04-security/README.md) | [Next: Performance Engineering →](../06-performance/README.md)

---
