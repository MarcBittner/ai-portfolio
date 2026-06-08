# Tanglement.ai Technical Specification - Section 4: Security Architecture and Cryptographic Implementation

[← Previous: Distributed Routing](../03-routing/README.md) | [Next: Economic Mechanism →](../05-economics/README.md)

---

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

---

## 4. Security Architecture and Cryptographic Implementation

This section defines the security model, cryptographic protocols, and threat mitigations for the Tanglement.ai P2P network. Security operates entirely client-side with zero-trust assumptions, ensuring the company never has access to plaintext user data or routing decisions.

### 4.1 Security Model Overview

The Tanglement.ai security architecture implements a zero-trust, client-side security model where all cryptographic operations occur on user devices without company intermediaries. The system assumes adversarial network conditions and potentially compromised peers, designing all mechanisms to maintain security under these threats.

This section establishes the fundamental security assumptions, threat model, and guarantees that govern the entire system. Understanding these principles is essential for evaluating all subsequent security design decisions.

**Core Security Principles**:
- **Zero-Trust Architecture**: No trust in company infrastructure, peers, or network
- **Client-Side Operations**: All encryption/decryption occurs on user devices
- **End-to-End Encryption**: Company cannot decrypt user requests or responses
- **Forward Secrecy**: Compromised keys don't affect past communications
- **Privacy-by-Design**: Minimal data collection, differential privacy for telemetry
- **Defense-in-Depth**: Multiple independent security layers

#### 4.1.1 Threat Model for P2P Networks

The threat model defines adversarial capabilities and attack scenarios the system must resist. P2P networks face unique threats compared to centralized systems, including Sybil attacks, eclipse attacks, and Byzantine nodes.

This subsection catalogues the types of adversaries and attacks the security architecture is designed to withstand.

**Adversarial Capabilities Assumed**:
- **Network Adversaries**: Can monitor, modify, delay, or drop network traffic
- **Compromised Peers**: Attacker controls subset of P2P nodes (up to 20% of network)
- **Insider Threats**: Malicious participants with valid credentials and tokens
- **State-Level Actors**: Advanced persistent threats with significant compute/storage
- **Economic Attacks**: Attempts to manipulate token economics, free-ride, or double-spend
- **Reverse Engineering**: Attempts to extract routing table decryption keys from client software
- **Traffic Analysis**: Attempts to infer user behavior from network traffic patterns

**Attack Scenarios**:
- **Sybil Attack**: Attacker creates many fake identities to subvert network
- **Eclipse Attack**: Attacker isolates victim from honest peers
- **Byzantine Nodes**: Malicious nodes provide incorrect routing information
- **Routing Table Poisoning**: Attacker injects false performance metrics
- **Credential Theft**: Attacker steals LLM provider API keys from client devices
- **Key Exfiltration**: Attacker extracts encryption keys from client software
- **Privacy Violations**: Attacker de-anonymizes users or infers routing decisions

**Security Properties Maintained**:
- **Confidentiality**: All request/response data encrypted end-to-end
- **Integrity**: Cryptographic verification of routing table and performance metrics
- **Availability**: Byzantine fault tolerance with automatic failover (99.9% target)
- **Anonymity**: Zero-knowledge protocols prevent user deanonymization
- **Non-repudiation**: Cryptographic proof of message origin for accountability
- **Forward Secrecy**: Compromised current keys cannot decrypt past communications
- **Post-Compromise Security**: Recovery possible after key compromise

#### 4.1.2 Company Security Posture

The company's security posture emphasizes minimal access to user data and network operations, reducing regulatory liability and enhancing user trust.

**What the Company CAN Access**:
- Public routing table updates (if PKI Option A chosen - pending legal decision)
- Aggregate network statistics (with differential privacy applied)
- Bootstrap node connection logs (IP addresses, connection times)
- Transaction metadata on blockchain (wallet addresses, token transfers)

**What the Company CANNOT Access**:
- User LLM prompts or responses (end-to-end encrypted)
- User LLM provider API keys (stored locally on client devices)
- Individual routing decisions (made client-side)
- User identities linked to requests (zero-knowledge protocols)
- Plaintext performance metrics (aggregated with differential privacy)

**Security Certifications** *(Roadmap)*:
- SOC 2 Type II (Phase 3)
- ISO 27001 (Phase 4)
- GDPR compliance technical controls (Phase 3)
- HIPAA compliance (if healthcare customers, Phase 5)

### 4.2 Routing Table Encryption and PKI

The routing table contains critical network intelligence and must be encrypted to prevent unauthorized access while remaining readable by all legitimate clients. PKI key management strategy has significant legal and operational implications.

This section presents multiple PKI key management approaches with detailed pros/cons analysis. The final decision depends on legal counsel input regarding regulatory liability.

#### 4.2.1 Routing Table Encryption Requirements

Routing table encryption must balance security (prevent unauthorized access) with usability (all clients can decrypt) and anti-reverse-engineering (prevent key extraction from client software).

**Encryption Scheme**:
- **Algorithm**: AES-256-GCM (authenticated encryption with associated data)
- **Key Derivation**: HKDF-SHA256 with context-specific info strings
- **Integrity**: HMAC-SHA256 signatures from network validators
- **Versioning**: Each routing table version has unique encryption metadata

**Encryption Envelope**:
```go
type EncryptedRoutingTable struct {
    Version       uint64
    Timestamp     time.Time
    EncryptionKey []byte      // Encrypted with PKI public key
    Nonce         [12]byte    // GCM nonce
    Ciphertext    []byte      // AES-256-GCM encrypted routing table
    AuthTag       [16]byte    // GCM authentication tag
    Signature     []byte      // Ed25519 signature from validators
    Metadata      EncryptionMetadata
}

type EncryptionMetadata struct {
    Algorithm     string      // "AES-256-GCM"
    KeyDerivation string      // "HKDF-SHA256"
    PKIModel      string      // "StaticCompanyKey" | "IndividualClientKeys" | "Hybrid"
    ValidatorSigs [][]byte    // Multi-signature from network validators
}
```

#### 4.2.2 PKI Key Management Options ⚠️ PENDING LEGAL REVIEW

The choice of PKI model has significant implications for company liability, user privacy, and operational complexity. Legal counsel must evaluate regulatory exposure for each option.

This subsection presents three alternative PKI architectures with detailed analysis of legal, technical, and operational trade-offs.

##### Option A: Static Company Public Key

Single company-controlled master key pair encrypts all routing tables. All clients embed the same decryption key.

**Architecture**:
- Company generates master ed25519 keypair (stored in HSM)
- Routing table encrypted with company public key
- Decryption key embedded in client software (obfuscated)
- All clients can decrypt routing table using embedded key

**Pros**:
- ✅ Simple implementation (single key pair)
- ✅ Fast deployment (no per-client key distribution)
- ✅ Company can monitor network health (can decrypt routing table)
- ✅ Easy key rotation (update client software)
- ✅ Lower bandwidth (single encrypted routing table)

**Cons**:
- ❌ Company can read all routing data (regulatory exposure)
- ❌ Vulnerable to reverse engineering (single key extraction = full compromise)
- ❌ Company becomes custodian of routing data (GDPR/privacy implications)
- ❌ Single point of failure (key compromise = network-wide impact)
- ❌ Potential legal liability (company has access to network topology)

**Anti-Reverse-Engineering Mitigations**:
- Code obfuscation (LLVM-obfuscator, Themida)
- White-box cryptography (embed key in lookup tables)
- Runtime integrity checks (detect debuggers, tampering)
- Server-side key verification (clients prove possession without revealing key)

**Legal Considerations** *(Requires Counsel Review)*:
- Does company access to routing table create regulatory obligations?
- Does GDPR classify routing table as "personal data"?
- What liability does company assume by controlling decryption key?

**Recommended Use Case**: MVP development, testing, rapid iteration

##### Option B: Individual Client Keys

Each client generates unique keypair. Routing table encrypted once per client (or routing table publicly readable).

**Architecture**:
- Each client generates ed25519 keypair on first launch
- Client registers public key with network (via blockchain or DHT)
- **Sub-Option B1**: Routing table encrypted separately for each client (high bandwidth)
- **Sub-Option B2**: Routing table publicly readable, only integrity-protected (no encryption)

**Pros**:
- ✅ Maximum user privacy (company cannot read routing data)
- ✅ No company access to routing decisions (minimal regulatory exposure)
- ✅ Resistance to reverse engineering (each client has unique key)
- ✅ Key compromise only affects single client

**Cons**:
- ❌ Complex key distribution (clients must discover each other's public keys)
- ❌ **Sub-Option B1**: Massive bandwidth overhead (N encrypted copies of routing table)
- ❌ **Sub-Option B2**: Routing table visible to anyone (network topology exposed)
- ❌ Harder for company to debug network issues (no visibility)
- ❌ Complex key rotation (clients must update keys independently)

**Sub-Option B1 Bandwidth Analysis**:
- 10k clients × 10MB routing table = 100GB per update
- Update frequency: 10 minutes
- **Total bandwidth**: 100GB / 10min = ~170MB/s (prohibitively expensive)

**Sub-Option B2 Transparency Trade-offs**:
- **Pros**: No encryption overhead, simple distribution, transparent network
- **Cons**: Anyone can see network topology, node locations, provider pricing

**Legal Considerations** *(Requires Counsel Review)*:
- Does company avoid liability if routing table is public?
- Are there security risks to exposing network topology?

**Recommended Use Case**:
- **B1**: Not recommended (bandwidth prohibitive)
- **B2**: Fully transparent network (research/academic use cases)

##### Option C: Hybrid Threshold Encryption ⭐ RECOMMENDED (PENDING LEGAL)

Routing table encrypted with multi-party threshold key. Company holds 1-of-N key shares; decryption requires t-of-N shares from network validators.

**Architecture**:
- Routing table encrypted with threshold public key (t-of-N scheme)
- Company holds 1 key share (can monitor if combined with validators)
- Network validators hold remaining N-1 shares (decentralized control)
- Decryption requires collaboration of t participants (threshold t < N)
- Clients receive threshold decryption key (not individual shares)

**Example Configuration** (3-of-5 threshold):
- Company: 1 share
- Network Validators: 4 shares (elected by token holders)
- Required for decryption: Any 3 of 5 shares
- Company alone: Cannot decrypt (needs 2 more shares)
- Validators alone: Can decrypt (any 3 of 4 can collaborate)

**Pros**:
- ✅ No single party can decrypt alone (distributed trust)
- ✅ Company has limited access (requires validator cooperation)
- ✅ Network can operate without company (validators sufficient)
- ✅ Key compromise requires colluding t parties
- ✅ Balance of transparency and privacy

**Cons**:
- ⚠️ Complex implementation (threshold cryptography)
- ⚠️ Requires validator election mechanism (governance complexity)
- ⚠️ Higher computational overhead (threshold decryption)
- ⚠️ Legal ambiguity (is company a "data controller"?)

**Threshold Cryptography Implementation**:
```go
type ThresholdKey struct {
    Threshold     int         // t (minimum shares needed)
    Total         int         // N (total shares)
    PublicKey     *ecdsa.PublicKey
    Shares        []*KeyShare // Distributed to participants
}

type KeyShare struct {
    Index         int
    Value         []byte      // Shamir secret share
    Participant   ParticipantID
    CreatedAt     time.Time
}

func (tk *ThresholdKey) Decrypt(
    ciphertext []byte,
    shares []*KeyShare,
) ([]byte, error) {
    if len(shares) < tk.Threshold {
        return nil, ErrInsufficientShares
    }

    // Reconstruct decryption key from t shares
    reconstructedKey := shamirReconstruct(shares, tk.Threshold)

    // Decrypt routing table
    return aesGCMDecrypt(ciphertext, reconstructedKey)
}
```

**Legal Considerations** *(Requires Counsel Review)*:
- Does threshold control change company's regulatory status?
- Can company avoid liability if majority control lies with validators?
- What happens if validators collude to decrypt without company?

**Recommended Use Case**: Production deployment balancing privacy, transparency, and oversight

#### 4.2.3 PKI Model Comparison Summary

| Factor | Option A: Static Company Key | Option B1: Individual Keys | Option B2: Public Routing Table | Option C: Threshold ⭐ |
|--------|----------------------------|---------------------------|--------------------------------|---------------------|
| **Company Access** | ✅ Full | ❌ None | ✅ Full (public) | ⚠️ Limited (needs t-1 validators) |
| **User Privacy** | ⚠️ Low | ✅ High | ❌ None (public) | ✅ High |
| **Bandwidth Cost** | ✅ Low | ❌ Very High | ✅ Low | ✅ Low |
| **Regulatory Exposure** | ❌ High | ✅ Low | ⚠️ Medium | ⚠️ Medium |
| **Implementation Complexity** | ✅ Simple | ⚠️ Medium | ✅ Simple | ❌ Complex |
| **Reverse Engineering Risk** | ❌ High (single key) | ✅ Low | N/A | ⚠️ Medium |
| **Operational Overhead** | ✅ Low | ❌ High | ✅ Low | ⚠️ Medium |
| **Recommended Phase** | Phase 1-2 (MVP) | Not Recommended | Research Only | Phase 3+ (Production) |

**Recommendation**: Start with **Option A** for MVP/testing, transition to **Option C** for production pending legal review of threshold model.

### 4.3 Client-Side Cryptographic Operations

All encryption, decryption, signing, and verification operations occur on client devices using the Signal Protocol for end-to-end encryption and ed25519 for digital signatures.

This section details the cryptographic primitives and protocols that protect user data throughout its lifecycle from client device to LLM provider and back.

#### 4.3.1 Signal Protocol for E2E Encryption

The Signal Protocol provides forward secrecy and post-compromise security through the Double Ratchet Algorithm, ensuring compromised keys cannot decrypt past or future messages.

```go
type SignalSession struct {
    identityKey     *IdentityKey     // Long-term identity
    signedPreKey    *SignedPreKey    // Medium-term signed key
    oneTimePreKeys  []*OneTimePreKey // Single-use ephemeral keys
    rootKey         [32]byte         // Root key for chain derivation
    chainKey        [32]byte         // Current chain key
    sendingChain    *MessageChain    // Sending ratchet state
    receivingChains map[string]*MessageChain // Receiving ratchet states
    sessionState    SessionState
}

type IdentityKey struct {
    publicKey  ed25519.PublicKey
    privateKey ed25519.PrivateKey
    signature  [64]byte              // Self-signed
    timestamp  time.Time
}

func (session *SignalSession) EncryptRequest(request *LLMRequest) (*EncryptedRequest, error) {
    // Serialize request
    plaintext, err := json.Marshal(request)
    if err != nil {
        return nil, err
    }

    // Generate ephemeral key for this message
    ephemeralPriv, ephemeralPub, err := ed25519.GenerateKey(rand.Reader)
    if err != nil {
        return nil, err
    }

    // Perform X25519 key exchange (convert ed25519 to curve25519)
    sharedSecret := session.performKeyExchange(ephemeralPriv, session.remoteIdentityKey)

    // Derive message key using Double Ratchet
    messageKey := session.deriveMessageKey(sharedSecret)

    // Encrypt with AES-256-GCM
    cipher, err := aes.NewCipher(messageKey[:32])
    if err != nil {
        return nil, err
    }

    gcm, err := cipher.NewGCM()
    if err != nil {
        return nil, err
    }

    nonce := make([]byte, gcm.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }

    ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

    return &EncryptedRequest{
        EphemeralKey: ephemeralPub,
        Nonce:        nonce,
        Ciphertext:   ciphertext,
        MessageNum:   session.sendingChain.MessageNum,
        PrevChainLen: session.sendingChain.PrevLength,
    }, nil
}
```

**Forward Secrecy**: Each message uses ephemeral key, compromised session key doesn't affect past messages

**Post-Compromise Security**: Ratchet mechanism recovers security after key compromise

#### 4.3.2 Client-Side Key Management

All cryptographic keys are generated and stored locally on client devices using OS-provided secure storage (Keychain, Credential Manager, Secret Service).

```go
type ClientKeyManager struct {
    identityKey    *IdentityKey
    sessionKeys    map[PeerID]*SessionKey
    preKeyStore    *PreKeyStore
    keychain       OSKeychain        // Platform-specific secure storage
    backupStrategy BackupStrategy
}

func (km *ClientKeyManager) GenerateIdentityKey() (*IdentityKey, error) {
    // Generate ed25519 keypair
    pub, priv, err := ed25519.GenerateKey(rand.Reader)
    if err != nil {
        return nil, err
    }

    // Self-sign public key
    signature := ed25519.Sign(priv, pub)

    identity := &IdentityKey{
        publicKey:  pub,
        privateKey: priv,
        signature:  signature,
        timestamp:  time.Now(),
    }

    // Store in OS keychain (encrypted, access-controlled)
    if err := km.keychain.StoreKey("identity", identity.privateKey); err != nil {
        return nil, err
    }

    return identity, nil
}

// OS Keychain Abstraction
type OSKeychain interface {
    StoreKey(label string, key []byte) error
    RetrieveKey(label string) ([]byte, error)
    DeleteKey(label string) error
}

// Platform-specific implementations:
// - macOS: Keychain Services API
// - Windows: Credential Manager API / DPAPI
// - Linux: Secret Service API (libsecret)
// - iOS: Keychain Services + Secure Enclave
// - Android: Keystore + Hardware-Backed Keys
```

**Key Storage Security**:
- Keys never leave client device
- Encrypted at rest using OS-provided protection
- Access-controlled by OS (biometric, password)
- Hardware-backed where available (Secure Enclave, TPM, TEE)

### 4.4 Credential Security and Management

Users store LLM provider API keys locally on their devices. The company never has access to these credentials, eliminating custodial liability and enhancing security.

This section describes how credentials are securely stored, accessed, and protected on client devices without company escrow.

#### 4.4.1 Local Credential Storage

Credentials are encrypted and stored in OS-provided secure storage, never transmitted to company servers.

```go
type CredentialManager struct {
    keychain       OSKeychain
    encryptionKey  [32]byte        // Derived from user password or device key
    credentials    map[ProviderID]*ProviderCredential
}

type ProviderCredential struct {
    ProviderID    ProviderID
    APIKey        string          // Encrypted at rest
    APISecret     string          // Encrypted at rest
    ExpiresAt     time.Time
    Scopes        []string
    Metadata      map[string]string
}

func (cm *CredentialManager) StoreCredential(
    providerID ProviderID,
    apiKey string,
    apiSecret string,
) error {
    // Encrypt credential
    cred := &ProviderCredential{
        ProviderID: providerID,
        APIKey:     apiKey,
        APISecret:  apiSecret,
        ExpiresAt:  time.Now().Add(90 * 24 * time.Hour), // 90 days
    }

    encryptedCred, err := cm.encryptCredential(cred)
    if err != nil {
        return err
    }

    // Store in OS keychain
    label := fmt.Sprintf("tanglement.cred.%s", providerID)
    return cm.keychain.StoreKey(label, encryptedCred)
}

func (cm *CredentialManager) RetrieveCredential(providerID ProviderID) (*ProviderCredential, error) {
    label := fmt.Sprintf("tanglement.cred.%s", providerID)

    // Retrieve from OS keychain
    encryptedCred, err := cm.keychain.RetrieveKey(label)
    if err != nil {
        return nil, err
    }

    // Decrypt credential
    return cm.decryptCredential(encryptedCred)
}
```

**Security Properties**:
- ❌ Company CANNOT access user credentials (stored locally only)
- ✅ Credentials encrypted at rest (AES-256-GCM)
- ✅ OS-level access control (biometric, password)
- ✅ No custodial liability for company

#### 4.4.2 Alternative: Token-Based Ephemeral Credentials

For users without their own LLM provider accounts, the network can generate ephemeral credentials derived from token balance.

```go
type EphemeralCredentialManager struct {
    tokenBalance   TokenBalance
    credGenerator  *CredentialGenerator
    providers      map[ProviderID]*ProviderPool
}

func (ecm *EphemeralCredentialManager) GenerateEphemeralCredential(
    providerID ProviderID,
    estimatedCost decimal.Decimal,
) (*EphemeralCredential, error) {
    // Check token balance
    if ecm.tokenBalance.Available < estimatedCost {
        return nil, ErrInsufficientTokens
    }

    // Reserve tokens
    ecm.tokenBalance.Reserve(estimatedCost)

    // Generate time-limited credential
    cred := &EphemeralCredential{
        ProviderID: providerID,
        APIKey:     ecm.credGenerator.Generate(),
        ExpiresAt:  time.Now().Add(5 * time.Minute), // Short-lived
        MaxCost:    estimatedCost,
    }

    return cred, nil
}
```

**Use Case**: Users who don't have their own OpenAI/Anthropic accounts

**Security**: Credentials expire quickly, limited to specific cost cap

### 4.5 Anti-Reverse-Engineering Countermeasures

Client software contains decryption keys for routing table access. Anti-reverse-engineering techniques make key extraction difficult, though not impossible.

This section describes layered defenses against attackers attempting to extract decryption keys from client software through static or dynamic analysis.

#### 4.5.1 Code Obfuscation Strategies

Multiple obfuscation layers increase difficulty and time required for reverse engineering.

**Obfuscation Techniques**:

**1. LLVM-Based Obfuscation**:
- Control flow flattening (remove if/else structure)
- Bogus control flow (add fake branches)
- Instruction substitution (replace simple ops with complex equivalents)
- String encryption (encrypt all string literals)

**2. Binary Packing/Encryption**:
- UPX packing (compress executable)
- Runtime unpacking (decrypt sections during execution)
- Anti-debugging (detect debuggers, exit if found)

**3. White-Box Cryptography**:
- Embed decryption key in lookup tables (not explicit bytes)
- Mix key material with code (indistinguishable from instructions)
- Use obfuscated S-boxes (AES operations as large tables)

**Example: Key Obfuscation**:
```go
// Instead of:
var decryptionKey = []byte{0x12, 0x34, 0x56, ...} // Easily extracted

// Use:
func getDKey() []byte {
    // Key split across multiple sources
    part1 := computeFromBuildID()
    part2 := deriveFromCPUID()
    part3 := extractFromLookupTable(part1, part2)

    return combineKeyParts(part1, part2, part3)
}

// Lookup table obfuscation (mix key with noise)
var lookupTable = [256][256]byte{
    // 65KB table embedding key fragments
    // Indistinguishable from AES S-boxes
}
```

**4. Runtime Integrity Checks**:
```go
func init() {
    // Check for debuggers
    if isDebuggerAttached() {
        os.Exit(1)
    }

    // Verify binary integrity (anti-tampering)
    if !verifyCodeSignature() {
        os.Exit(1)
    }

    // Environment checks
    if isRunningInVM() || isRunningInSandbox() {
        os.Exit(1)
    }
}
```

#### 4.5.2 Server-Side Key Verification (Optional)

Clients prove they possess decryption key without revealing it through zero-knowledge proofs.

```go
type KeyProofChallenge struct {
    Nonce      [32]byte
    Timestamp  time.Time
    Difficulty uint32
}

func (client *Client) ProveKeyPossession(challenge *KeyProofChallenge) (*KeyProof, error) {
    // Decrypt challenge using embedded key (without revealing key)
    decrypted := client.decryptWithKey(challenge.Nonce)

    // Hash result with proof-of-work
    proof := client.computeProofOfWork(decrypted, challenge.Difficulty)

    return &KeyProof{
        Response:  proof,
        Timestamp: time.Now(),
    }, nil
}
```

**Limitations**: Reverse engineering is a cat-and-mouse game. Determined attackers with sufficient resources will eventually extract keys. Obfuscation raises the bar but cannot provide absolute protection.

**Mitigation Strategy**: Combine obfuscation with **Option C (Threshold Encryption)** so extracted key alone is insufficient for decryption.

### 4.6 P2P Network Security

WireGuard mesh networking provides encrypted tunnels between all peers, ensuring confidentiality and authenticity of P2P communications.

This section describes network-layer security mechanisms protecting traffic between nodes in the P2P mesh.

#### 4.6.1 WireGuard Mesh Configuration

WireGuard provides state-of-the-art VPN functionality with minimal overhead, using Curve25519 for key exchange and ChaCha20Poly1305 for encryption.

```go
type WireGuardNode struct {
    privateKey   wgtypes.Key       // Node's WireGuard private key
    publicKey    wgtypes.Key       // Node's WireGuard public key
    listenPort   int               // UDP port for incoming connections
    peers        map[NodeID]*WireGuardPeer
    device       *device.Device
    allowedIPs   []net.IPNet
}

type WireGuardPeer struct {
    nodeID       NodeID
    publicKey    wgtypes.Key
    endpoint     *net.UDPAddr
    allowedIPs   []net.IPNet
    lastHandshake time.Time
    rxBytes      uint64
    txBytes      uint64
}

func (node *WireGuardNode) EstablishTunnel(
    peerID NodeID,
    peerKey wgtypes.Key,
    endpoint *net.UDPAddr,
) error {
    peerConfig := wgtypes.PeerConfig{
        PublicKey:  peerKey,
        Endpoint:   endpoint,
        AllowedIPs: []net.IPNet{
            {IP: net.ParseIP("10.0.0.0"), Mask: net.CIDRMask(8, 32)},
        },
        PersistentKeepaliveInterval: &[]time.Duration{25 * time.Second}[0],
    }

    config := wgtypes.Config{
        Peers: []wgtypes.PeerConfig{peerConfig},
    }

    if err := node.device.Device.Configure(config); err != nil {
        return fmt.Errorf("failed to configure WireGuard peer: %w", err)
    }

    node.peers[peerID] = &WireGuardPeer{
        nodeID:    peerID,
        publicKey: peerKey,
        endpoint:  endpoint,
    }

    return nil
}
```

**Security Properties**:
- All inter-node traffic encrypted (ChaCha20Poly1305)
- Perfect forward secrecy (ephemeral Curve25519 keys)
- Mutual authentication (both peers verify public keys)
- Replay protection (message counters)
- Low overhead (~5ms per hop)

#### 4.6.2 Traffic Analysis Protection

Even with encryption, traffic patterns can leak information. Padding and timing obfuscation prevent adversaries from inferring user behavior.

```go
type TrafficObfuscator struct {
    paddingStrategy PaddingStrategy
    timingStrategy  TimingStrategy
    coverTraffic    *CoverTrafficGenerator
}

func (obf *TrafficObfuscator) ObfuscatePacket(packet []byte, targetSize int) []byte {
    // Pad to standard size (hide message length)
    if len(packet) < targetSize {
        padding := make([]byte, targetSize-len(packet))
        rand.Read(padding)
        packet = append(packet, padding...)
    }

    return packet
}

func (obf *TrafficObfuscator) AddTimingDelay(baseDelay time.Duration) time.Duration {
    // Random delay to prevent timing attacks
    jitter := time.Duration(rand.Int63n(int64(baseDelay / 2)))
    return baseDelay + jitter
}
```

**Padding Strategy**: Round packet sizes to nearest 1KB (prevents size-based fingerprinting)

**Timing Strategy**: Add random jitter (prevents timing correlation attacks)

### 4.7 Zero-Knowledge Telemetry

The network collects aggregate performance metrics without revealing individual user data through differential privacy and secure multiparty computation.

This section describes cryptographic and statistical techniques that enable network optimization while preserving user privacy.

#### 4.7.1 Differential Privacy for Metrics

Differential privacy adds calibrated noise to queries, providing mathematical guarantees that individual records cannot be distinguished.

```go
type DifferentialPrivacyEngine struct {
    epsilon        float64 // Privacy parameter (smaller = more private)
    delta          float64 // Failure probability
    sensitivity    float64 // Global sensitivity of queries
    noiseGenerator *LaplaceNoiseGenerator
    privacyBudget  *PrivacyBudgetTracker
}

func (dp *DifferentialPrivacyEngine) PublishMetric(
    metricName string,
    value float64,
) float64 {
    // Calculate query sensitivity
    sensitivity := dp.getQuerySensitivity(metricName)

    // Calculate noise scale (Laplace mechanism)
    scale := sensitivity / dp.epsilon

    // Generate Laplace noise
    noise := dp.noiseGenerator.Sample(0, scale)

    // Track privacy budget consumption
    dp.privacyBudget.Consume(dp.epsilon, metricName)

    // Add noise to true value
    noisyValue := value + noise

    return noisyValue
}

type LaplaceNoiseGenerator struct {
    rng *rand.Rand
}

func (lng *LaplaceNoiseGenerator) Sample(mu, b float64) float64 {
    u := lng.rng.Float64() - 0.5
    return mu - b*math.Copysign(math.Log(1-2*math.Abs(u)), u)
}
```

**Privacy Guarantee**: With probability (1-δ), attacker cannot distinguish whether any individual's data was included in aggregate

**Example**: Publishing average latency with ε=0.1 privacy
- True average: 235ms
- Added noise: ±20ms
- Published value: 247ms *(noise protects individual contributions)*

#### 4.7.2 Secure Multiparty Computation

Secure aggregation allows nodes to compute network-wide statistics without revealing individual contributions.

```go
type SecureAggregator struct {
    participants map[NodeID]*Participant
    threshold    int                  // Minimum participants for reconstruction
    polynomial   *ShamirPolynomial
    commitments  map[NodeID]*Commitment
}

func (sa *SecureAggregator) AggregatePerformanceMetrics(
    localMetrics *PerformanceMetrics,
) (*AggregatedMetrics, error) {
    // Phase 1: Secret sharing of local metrics
    shares, err := sa.polynomial.ShareSecret(localMetrics.Serialize(), sa.threshold)
    if err != nil {
        return nil, err
    }

    // Phase 2: Distribute shares to peers via gossip
    for peerID, share := range shares {
        if err := sa.sendShareToPeer(peerID, share); err != nil {
            return nil, err
        }
    }

    // Phase 3: Collect shares from peers
    collectedShares := sa.collectSharesFromPeers()

    // Phase 4: Reconstruct aggregate (Lagrange interpolation)
    if len(collectedShares) < sa.threshold {
        return nil, ErrInsufficientShares
    }

    aggregateBytes := sa.polynomial.Reconstruct(collectedShares)

    return DeserializeAggregatedMetrics(aggregateBytes)
}
```

**Security Property**: No single node learns individual contributions, only final aggregate

### 4.8 Security Performance Targets

This section establishes quantitative performance benchmarks for cryptographic operations to ensure security mechanisms don't create unacceptable latency.

**Client-Side Cryptographic Performance**:
- **Identity key generation**: <10ms (ed25519)
- **Session key derivation**: <5ms (HKDF-SHA256)
- **Message encryption**: <1ms per request (up to 100KB, AES-256-GCM)
- **Message decryption**: <1ms per response (up to 1MB)
- **Signature generation**: <5ms (ed25519)
- **Signature verification**: <2ms (ed25519)
- **Routing table decryption**: <100ms (10MB table, cached)

**WireGuard Network Performance**:
- **Handshake time**: <100ms
- **Per-hop latency**: ~5ms
- **Throughput**: >1Gbps per connection
- **CPU overhead**: 1-2% per connection

**Memory Footprint**:
- **Keychain storage**: <1MB (all keys)
- **Signal sessions**: <10KB per active session
- **WireGuard state**: <1KB per peer

---

[← Previous: Distributed Routing](../03-routing/README.md) | [Next: Economic Mechanism →](../05-economics/README.md)

---
