# Tanglement.ai Technical Specification - Section 7: Network Protocol Specifications

## Document Information
- **Version**: 1.0.0
- **Date**: October 28, 2025
- **Status**: Draft
- **Classification**: Technical Specification

[← Previous: Performance Engineering](../06-performance/README.md) | [Next: API Specifications →](../08-api/README.md)

---

## 7. Network Protocol Specifications

This section defines the network protocols enabling P2P communication, routing table synchronization, and secure mesh networking across distributed nodes. Unlike centralized API gateways that rely on client-server protocols (HTTP/REST, gRPC), Tanglement.ai uses **peer-to-peer protocols** designed for decentralized operation without central coordination.

**Protocol Philosophy**: P2P protocols must solve problems that don't exist in centralized systems: peer discovery without DNS, routing table consensus without a central database, and trust establishment without certificate authorities. Each protocol is selected for proven P2P performance and security properties.

### 7.1 Tanglement.ai P2P Protocol Stack

**Why This Stack**: The protocol stack combines battle-tested P2P technologies (DHT, gossip) with modern cryptographic protocols (WireGuard, Signal) to achieve secure, efficient decentralized communication.

The Tanglement.ai network implements a P2P protocol stack optimized for distributed routing intelligence and zero-trust security:

```
┌─────────────────────────────────────────────────────────┐
│                Application Layer                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ Client-Side │  │ Contribution│  │  Economic   │    │
│  │   Routing   │  │   Proofs    │  │ Governance  │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│                Synchronization Layer                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Gossip    │  │     DHT     │  │   Routing   │    │
│  │  Protocol   │  │   (Chord)   │  │Table Sync   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│                Security Layer                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Signal    │  │  AES-256    │  │  ed25519    │    │
│  │  Protocol   │  │     GCM     │  │  Signatures │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│                Transport Layer                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  WireGuard  │  │    QUIC     │  │     TCP     │    │
│  │    Mesh     │  │ (fallback)  │  │ (fallback)  │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│                Network Layer                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │    IPv6     │  │     NAT     │  │    STUN/    │    │
│  │   (native)  │  │  Traversal  │  │    TURN     │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 7.2 DHT Protocol (Chord Implementation)

**Why DHT**: Distributed Hash Tables enable O(log N) lookups in a fully decentralized network. Chord provides proven scalability to millions of nodes with simple finger table maintenance.

#### 7.2.1 Chord Protocol Specification

**Chord Overview**: Chord arranges nodes in a 160-bit identifier circle. Each node maintains a "finger table" pointing to nodes at exponentially increasing distances, enabling O(log N) routing.

```go
type ChordNode struct {
    ID              NodeID         // SHA-1 hash (160 bits)
    Address         string         // IP:Port or WireGuard public key
    FingerTable     [160]*NodeRef  // Exponential distance pointers
    Successor       *NodeRef       // Next node on ring
    Predecessor     *NodeRef       // Previous node on ring
    SuccessorList   []*NodeRef     // R successors for fault tolerance (R=6)

    stabilizeTimer  *time.Ticker   // Periodic stabilization
    fixFingersTimer *time.Ticker   // Periodic finger table maintenance
    checkPredTimer  *time.Ticker   // Periodic predecessor check
}

type NodeRef struct {
    ID      NodeID
    Address string
    LastSeen time.Time
    RTT     time.Duration
    Healthy bool
}

type NodeID [20]byte // SHA-1 hash (160 bits)

// Finger table entry i points to first node >= n + 2^i (mod 2^160)
func (cn *ChordNode) calculateFingerStart(i int) NodeID {
    // finger[i].start = (n + 2^i) mod 2^160
    start := new(big.Int).SetBytes(cn.ID[:])
    offset := new(big.Int).Exp(big.NewInt(2), big.NewInt(int64(i)), nil)
    start.Add(start, offset)

    // Mod 2^160
    modulus := new(big.Int).Exp(big.NewInt(2), big.NewInt(160), nil)
    start.Mod(start, modulus)

    var fingerStart NodeID
    copy(fingerStart[:], start.Bytes())
    return fingerStart
}

// Lookup finds the node responsible for the given key
func (cn *ChordNode) Lookup(key []byte) (*NodeRef, error) {
    keyID := sha1.Sum(key)

    // Check if we're responsible
    if cn.isResponsible(keyID) {
        return &NodeRef{
            ID:      cn.ID,
            Address: cn.Address,
        }, nil
    }

    // Check successor (most common case)
    if cn.Successor != nil && between(keyID, cn.ID, cn.Successor.ID) {
        return cn.Successor, nil
    }

    // Find closest preceding node in finger table
    closestNode := cn.closestPrecedingNode(keyID)

    // Forward query to closest node
    return cn.forwardLookup(closestNode, keyID)
}

func (cn *ChordNode) closestPrecedingNode(id NodeID) *NodeRef {
    // Search finger table from highest to lowest
    for i := 159; i >= 0; i-- {
        finger := cn.FingerTable[i]
        if finger != nil && between(finger.ID, cn.ID, id) {
            return finger
        }
    }

    // No closer node found, return successor
    return cn.Successor
}

func (cn *ChordNode) forwardLookup(node *NodeRef, keyID NodeID) (*NodeRef, error) {
    // Send RPC to remote node
    conn, err := cn.dial(node.Address)
    if err != nil {
        return nil, fmt.Errorf("failed to connect to %s: %w", node.ID, err)
    }
    defer conn.Close()

    req := &ChordLookupRequest{
        KeyID: keyID[:],
        HopCount: 1, // Track hop count for metrics
    }

    resp, err := cn.sendChordRPC(conn, req)
    if err != nil {
        return nil, err
    }

    return &NodeRef{
        ID:      NodeID(resp.NodeID),
        Address: resp.Address,
    }, nil
}

// between checks if id is in (start, end) on the circular identifier space
func between(id, start, end NodeID) bool {
    if bytes.Compare(start[:], end[:]) < 0 {
        // Normal case: start < end
        return bytes.Compare(start[:], id[:]) < 0 && bytes.Compare(id[:], end[:]) < 0
    } else {
        // Wraparound case: end < start
        return bytes.Compare(start[:], id[:]) < 0 || bytes.Compare(id[:], end[:]) < 0
    }
}
```

#### 7.2.2 Stabilization Protocol

**Why Stabilization**: Nodes join/leave continuously in P2P networks. Stabilization ensures finger tables remain accurate despite churn without global coordination.

```go
func (cn *ChordNode) startStabilization() {
    // Run stabilization every 10 seconds
    cn.stabilizeTimer = time.NewTicker(10 * time.Second)
    go func() {
        for range cn.stabilizeTimer.C {
            cn.stabilize()
        }
    }()

    // Fix fingers every 30 seconds
    cn.fixFingersTimer = time.NewTicker(30 * time.Second)
    go func() {
        for range cn.fixFingersTimer.C {
            cn.fixFingers()
        }
    }()

    // Check predecessor every 15 seconds
    cn.checkPredTimer = time.NewTicker(15 * time.Second)
    go func() {
        for range cn.checkPredTimer.C {
            cn.checkPredecessor()
        }
    }()
}

func (cn *ChordNode) stabilize() {
    // Ask successor for its predecessor
    if cn.Successor == nil {
        return
    }

    x := cn.getRemotePredecessor(cn.Successor)
    if x != nil && between(x.ID, cn.ID, cn.Successor.ID) {
        // Found a node between us and our successor
        cn.Successor = x
    }

    // Notify successor that we think we're its predecessor
    cn.notify(cn.Successor)

    // Update successor list for fault tolerance
    cn.updateSuccessorList()
}

func (cn *ChordNode) notify(node *NodeRef) {
    // Tell node that we think we're its predecessor
    conn, err := cn.dial(node.Address)
    if err != nil {
        return
    }
    defer conn.Close()

    req := &ChordNotifyRequest{
        NodeID:  cn.ID[:],
        Address: cn.Address,
    }

    cn.sendChordRPC(conn, req)
}

func (cn *ChordNode) handleNotify(potentialPred *NodeRef) {
    // Update predecessor if:
    // 1. We don't have a predecessor, OR
    // 2. potentialPred is between our predecessor and us
    if cn.Predecessor == nil || between(potentialPred.ID, cn.Predecessor.ID, cn.ID) {
        cn.Predecessor = potentialPred
        log.Printf("Updated predecessor to %s", potentialPred.ID)
    }
}

func (cn *ChordNode) fixFingers() {
    // Randomly pick a finger to fix (spreads maintenance load)
    i := rand.Intn(160)

    fingerStart := cn.calculateFingerStart(i)
    node, err := cn.Lookup(fingerStart[:])
    if err != nil {
        log.Printf("Failed to fix finger %d: %v", i, err)
        return
    }

    cn.FingerTable[i] = node
}

func (cn *ChordNode) checkPredecessor() {
    if cn.Predecessor == nil {
        return
    }

    // Ping predecessor to check if it's alive
    if !cn.ping(cn.Predecessor) {
        log.Printf("Predecessor %s failed health check, removing", cn.Predecessor.ID)
        cn.Predecessor = nil
    }
}

func (cn *ChordNode) updateSuccessorList() {
    // Maintain list of R successors for fault tolerance
    R := 6
    successors := make([]*NodeRef, 0, R)

    current := cn.Successor
    for i := 0; i < R && current != nil; i++ {
        successors = append(successors, current)

        // Get next successor from current node's successor
        current = cn.getRemoteSuccessor(current)
    }

    cn.SuccessorList = successors
}
```

### 7.3 Gossip Protocol

**Why Gossip**: Epidemic-style gossip ensures eventual consistency of routing tables across all nodes without central coordination. Probabilistic guarantees enable scaling to 100k+ nodes.

#### 7.3.1 Gossip Message Format

```protobuf
syntax = "proto3";
package tanglement.protocol.gossip;

message GossipMessage {
    MessageHeader header = 1;
    oneof payload {
        RoutingTableUpdate routing_update = 2;
        NodeAnnouncementannouncement = 3;
        PerformanceMetrics metrics = 4;
        ContributionProof contribution = 5;
    }
    bytes signature = 6; // ed25519 signature
}

message MessageHeader {
    bytes message_id = 1;  // Random 16 bytes
    int64 timestamp = 2;    // Unix epoch milliseconds
    bytes source_node_id = 3; // SHA-1 node ID
    uint32 ttl = 4;         // Time-to-live (hop count)
    uint32 version = 5;     // Protocol version
}

message RoutingTableUpdate {
    uint64 table_version = 1;
    repeated ProviderUpdate providers = 2;
    repeated ModelUpdate models = 3;
    UpdateType update_type = 4; // FULL, DELTA
}

enum UpdateType {
    UPDATE_TYPE_FULL = 0;
    UPDATE_TYPE_DELTA = 1;
}

message ProviderUpdate {
    uint32 provider_id = 1;
    ChangeType change = 2; // ADD, UPDATE, DELETE
    string name = 3;
    string base_url = 4;
    repeated uint32 model_ids = 5;
    uint32 avg_latency_ms = 6;
    uint32 uptime_pct = 7; // 0-100
    uint32 cost_tier = 8;  // 0=cheap, 1=medium, 2=expensive
}

enum ChangeType {
    CHANGE_TYPE_ADD = 0;
    CHANGE_TYPE_UPDATE = 1;
    CHANGE_TYPE_DELETE = 2;
}

message NodeAnnouncement {
    bytes node_id = 1;
    string address = 2; // IP:Port or WireGuard public key
    repeated Capability capabilities = 3;
    GeographicLocation location = 4;
    uint64 uptime_seconds = 5;
}

enum Capability {
    CAPABILITY_DHT_NODE = 0;
    CAPABILITY_ROUTING = 1;
    CAPABILITY_CACHING = 2;
    CAPABILITY_RELAY = 3;
}

message GeographicLocation {
    string region = 1; // us-east, eu-west, etc.
    float latitude = 2;
    float longitude = 3;
}

message PerformanceMetrics {
    bytes node_id = 1;
    int64 timestamp = 2;
    repeated ProviderMetric provider_metrics = 3;
}

message ProviderMetric {
    uint32 provider_id = 1;
    uint32 model_id = 2;
    uint32 latency_ms = 3;
    bool success = 4;
    uint32 tokens_processed = 5;
}
```

#### 7.3.2 Gossip Dissemination Algorithm

**Epidemic Spread**: Each node forwards messages to a random subset of peers (fanout=6). Messages reach all nodes in O(log N) rounds with high probability.

```go
type GossipProtocol struct {
    nodeID           NodeID
    peers            *PeerManager
    seenMessages     *BloomFilter   // Prevent duplicate processing
    messageCache     *LRUCache      // Store recent messages
    fanout           int            // Number of peers to gossip to (6)
    gossipInterval   time.Duration  // 30 seconds
    maxTTL           uint32         // 64 hops
    bandwidthLimiter *TokenBucket
}

type PeerManager struct {
    peers       map[NodeID]*PeerInfo
    peerScores  map[NodeID]float64 // Reputation scoring
    mutex       sync.RWMutex
}

type PeerInfo struct {
    NodeID      NodeID
    Address     string
    LastSeen    time.Time
    RTT         time.Duration
    Healthy     bool
    Score       float64 // 0.0-1.0 based on reliability
}

func (gp *GossipProtocol) BroadcastMessage(msg *GossipMessage) error {
    // Set message metadata
    msg.Header.SourceNodeId = gp.nodeID[:]
    msg.Header.Ttl = gp.maxTTL
    msg.Header.Timestamp = time.Now().UnixMilli()

    // Generate random message ID
    msgID := make([]byte, 16)
    rand.Read(msgID)
    msg.Header.MessageId = msgID

    // Sign message
    signature, err := gp.signMessage(msg)
    if err != nil {
        return fmt.Errorf("failed to sign message: %w", err)
    }
    msg.Signature = signature

    // Mark as seen (prevent re-processing)
    gp.seenMessages.Add(msgID)

    // Store in cache
    gp.messageCache.Put(string(msgID), msg)

    // Select peers for gossip
    peers := gp.selectGossipPeers(gp.fanout)

    // Send to selected peers in parallel
    return gp.sendToP eers(peers, msg)
}

func (gp *GossipProtocol) selectGossipPeers(count int) []*PeerInfo {
    gp.peers.mutex.RLock()
    defer gp.peers.mutex.RUnlock()

    // Get all healthy peers
    healthyPeers := make([]*PeerInfo, 0)
    for _, peer := range gp.peers.peers {
        if peer.Healthy {
            healthyPeers = append(healthyPeers, peer)
        }
    }

    if len(healthyPeers) <= count {
        return healthyPeers
    }

    // Weighted random selection based on peer scores
    selected := make([]*PeerInfo, 0, count)
    weights := make([]float64, len(healthyPeers))

    // Calculate weights (higher score = higher probability)
    for i, peer := range healthyPeers {
        weights[i] = peer.Score
    }

    // Sample without replacement
    for i := 0; i < count; i++ {
        idx := weightedRandom(weights)
        selected = append(selected, healthyPeers[idx])
        weights[idx] = 0 // Don't select again
    }

    return selected
}

func (gp *GossipProtocol) sendToPeers(peers []*PeerInfo, msg *GossipMessage) error {
    // Serialize message
    data, err := proto.Marshal(msg)
    if err != nil {
        return fmt.Errorf("failed to marshal message: %w", err)
    }

    // Check bandwidth budget
    totalBandwidth := uint64(len(data) * len(peers))
    if !gp.bandwidthLimiter.TryConsume(totalBandwidth) {
        return ErrBandwidthExceeded
    }

    // Send to peers in parallel
    var wg sync.WaitGroup
    errors := make(chan error, len(peers))

    for _, peer := range peers {
        wg.Add(1)
        go func(p *PeerInfo) {
            defer wg.Done()

            if err := gp.sendToPeer(p, data); err != nil {
                errors <- fmt.Errorf("failed to gossip to %s: %w", p.NodeID, err)
            }
        }(peer)
    }

    wg.Wait()
    close(errors)

    // Log errors but don't fail (eventual consistency)
    for err := range errors {
        log.Printf("Gossip error: %v", err)
    }

    return nil
}

func (gp *GossipProtocol) HandleIncomingMessage(msg *GossipMessage) error {
    // Check if we've seen this message before
    msgID := msg.Header.MessageId
    if gp.seenMessages.Contains(msgID) {
        return nil // Already processed, ignore
    }

    // Verify signature
    if !gp.verifySignature(msg) {
        return ErrInvalidSignature
    }

    // Mark as seen
    gp.seenMessages.Add(msgID)

    // Process message payload
    if err := gp.processPayload(msg); err != nil {
        return fmt.Errorf("failed to process payload: %w", err)
    }

    // Forward to peers if TTL > 0
    if msg.Header.Ttl > 0 {
        msg.Header.Ttl--
        peers := gp.selectGossipPeers(gp.fanout)
        return gp.sendToPeers(peers, msg)
    }

    return nil
}

// Gossip propagation analysis:
// - Network size: 10,000 nodes
// - Fanout: 6 peers per round
// - Rounds to reach 99% of nodes: log₆(10000) ≈ 5.1 rounds
// - At 30-second intervals: ~2.5 minutes for full propagation
// - With prioritized updates (10s interval): ~51 seconds
```

### 7.4 WireGuard Mesh Protocol

**Why WireGuard**: Modern VPN protocol with ~5ms latency overhead (vs OpenVPN's ~20ms), minimal code complexity (~4k lines), and strong cryptographic guarantees.

#### 7.4.1 WireGuard Configuration

```go
type WireGuardMesh struct {
    privateKey  *wgtypes.Key
    publicKey   *wgtypes.Key
    listenPort  int
    peers       map[NodeID]*WireGuardPeer
    device      *wgctrl.Device
    client      *wgctrl.Client
}

type WireGuardPeer struct {
    NodeID          NodeID
    PublicKey       wgtypes.Key
    Endpoint        *net.UDPAddr
    AllowedIPs      []net.IPNet
    PersistentKeepalive time.Duration
    LastHandshake   time.Time
    RxBytes         uint64
    TxBytes         uint64
}

func (wm *WireGuardMesh) Initialize() error {
    // Generate WireGuard keypair
    privateKey, err := wgtypes.GeneratePrivateKey()
    if err != nil {
        return fmt.Errorf("failed to generate private key: %w", err)
    }

    wm.privateKey = &privateKey
    publicKey := privateKey.PublicKey()
    wm.publicKey = &publicKey

    // Create WireGuard device
    wm.client, err = wgctrl.New()
    if err != nil {
        return fmt.Errorf("failed to create WireGuard client: %w", err)
    }

    // Configure device
    cfg := wgtypes.Config{
        PrivateKey:   &privateKey,
        ListenPort:   &wm.listenPort,
        ReplacePeers: false,
    }

    err = wm.client.ConfigureDevice("wg0", cfg)
    if err != nil {
        return fmt.Errorf("failed to configure device: %w", err)
    }

    log.Printf("WireGuard mesh initialized (public key: %s, port: %d)",
        publicKey.String(), wm.listenPort)

    return nil
}

func (wm *WireGuardMesh) AddPeer(nodeID NodeID, publicKey wgtypes.Key, endpoint *net.UDPAddr) error {
    // Configure allowed IPs for peer (use node-specific subnet)
    allowedIPs := []net.IPNet{
        {
            IP:   net.ParseIP(fmt.Sprintf("10.0.%d.0", nodeID[0])),
            Mask: net.CIDRMask(24, 32),
        },
    }

    peerCfg := wgtypes.PeerConfig{
        PublicKey:    publicKey,
        Endpoint:     endpoint,
        AllowedIPs:   allowedIPs,
        PersistentKeepaliveInterval: ptr(25 * time.Second),
        ReplaceAllowedIPs: false,
    }

    cfg := wgtypes.Config{
        Peers: []wgtypes.PeerConfig{peerCfg},
    }

    err := wm.client.ConfigureDevice("wg0", cfg)
    if err != nil {
        return fmt.Errorf("failed to add peer: %w", err)
    }

    wm.peers[nodeID] = &WireGuardPeer{
        NodeID:              nodeID,
        PublicKey:           publicKey,
        Endpoint:            endpoint,
        AllowedIPs:          allowedIPs,
        PersistentKeepalive: 25 * time.Second,
    }

    log.Printf("Added WireGuard peer: %s (%s)", nodeID, endpoint)

    return nil
}

func (wm *WireGuardMesh) SendPacket(nodeID NodeID, data []byte) error {
    peer, exists := wm.peers[nodeID]
    if !exists {
        return fmt.Errorf("peer not found: %s", nodeID)
    }

    // Send through WireGuard tunnel
    // (actual UDP send handled by WireGuard kernel module)
    peerIP := peer.AllowedIPs[0].IP

    conn, err := net.Dial("udp", fmt.Sprintf("%s:51820", peerIP))
    if err != nil {
        return fmt.Errorf("failed to connect to peer: %w", err)
    }
    defer conn.Close()

    _, err = conn.Write(data)
    if err != nil {
        return fmt.Errorf("failed to send data: %w", err)
    }

    peer.TxBytes += uint64(len(data))

    return nil
}

func (wm *WireGuardMesh) GetPeerStatistics() map[NodeID]*WireGuardPeerStats {
    stats := make(map[NodeID]*WireGuardPeerStats)

    device, err := wm.client.Device("wg0")
    if err != nil {
        return stats
    }

    for _, peer := range device.Peers {
        // Find NodeID for this public key
        var nodeID NodeID
        for id, p := range wm.peers {
            if p.PublicKey == peer.PublicKey {
                nodeID = id
                break
            }
        }

        stats[nodeID] = &WireGuardPeerStats{
            NodeID:             nodeID,
            Endpoint:           peer.Endpoint.String(),
            LastHandshake:      peer.LastHandshakeTime,
            RxBytes:            uint64(peer.ReceiveBytes),
            TxBytes:            uint64(peer.TransmitBytes),
            KeepAliveInterval:  peer.PersistentKeepaliveInterval,
        }
    }

    return stats
}
```

### 7.5 Signal Protocol for End-to-End Encryption

**Why Signal Protocol**: Provides forward secrecy (past messages remain secure even if current keys compromised) and post-compromise security (automatic recovery from key compromise).

#### 7.5.1 Signal Protocol Session Management

```go
type SignalProtocolManager struct {
    identityKey  *identity.KeyPair
    sessions     map[NodeID]*SessionState
    preKeyStore  *PreKeyStore
    signedPreKey *signedprekey.SignedPreKey
    mutex        sync.RWMutex
}

type SessionState struct {
    NodeID           NodeID
    SessionCipher    *session.Cipher
    RootKey          []byte
    ChainKey         []byte
    MessageKeys      map[uint32][]byte
    SendingChain     *Chain
    ReceivingChain   *Chain
    LastUpdated      time.Time
}

type Chain struct {
    ChainKey        []byte
    MessageNumber   uint32
    RatchetKey      *ecc.ECPublicKey
}

func (spm *SignalProtocolManager) Initialize() error {
    // Generate identity keypair
    identityKeyPair, err := identity.GenerateKeyPair()
    if err != nil {
        return fmt.Errorf("failed to generate identity key: %w", err)
    }
    spm.identityKey = identityKeyPair

    // Generate signed pre-key
    signedPreKey, err := signedprekey.Generate(identityKeyPair, 1)
    if err != nil {
        return fmt.Errorf("failed to generate signed pre-key: %w", err)
    }
    spm.signedPreKey = signedPreKey

    // Generate one-time pre-keys (100 keys)
    spm.preKeyStore = NewPreKeyStore()
    for i := 1; i <= 100; i++ {
        preKey, err := prekey.Generate(uint32(i))
        if err != nil {
            return fmt.Errorf("failed to generate pre-key %d: %w", i, err)
        }
        spm.preKeyStore.StorePreKey(uint32(i), preKey)
    }

    log.Printf("Signal Protocol initialized (identity: %x)", identityKeyPair.PublicKey().Serialize())

    return nil
}

func (spm *SignalProtocolManager) EstablishSession(nodeID NodeID, remoteIdentityKey *identity.Key, remotePreKey *prekey.PublicKey) error {
    // Create session builder
    builder := session.NewBuilder(
        spm.identityKey,
        remoteIdentityKey,
        remotePreKey,
    )

    // Build session
    sessionState, err := builder.BuildSession()
    if err != nil {
        return fmt.Errorf("failed to build session: %w", err)
    }

    // Create session cipher
    cipher := session.NewCipher(sessionState)

    spm.mutex.Lock()
    spm.sessions[nodeID] = &SessionState{
        NodeID:        nodeID,
        SessionCipher: cipher,
        RootKey:       sessionState.RootKey,
        LastUpdated:   time.Now(),
    }
    spm.mutex.Unlock()

    log.Printf("Established Signal Protocol session with %s", nodeID)

    return nil
}

func (spm *SignalProtocolManager) EncryptMessage(nodeID NodeID, plaintext []byte) ([]byte, error) {
    spm.mutex.RLock()
    session, exists := spm.sessions[nodeID]
    spm.mutex.RUnlock()

    if !exists {
        return nil, fmt.Errorf("no session established with %s", nodeID)
    }

    // Encrypt with session cipher
    ciphertext, err := session.SessionCipher.Encrypt(plaintext)
    if err != nil {
        return nil, fmt.Errorf("encryption failed: %w", err)
    }

    // Update session state
    spm.mutex.Lock()
    session.LastUpdated = time.Now()
    spm.mutex.Unlock()

    return ciphertext, nil
}

func (spm *SignalProtocolManager) DecryptMessage(nodeID NodeID, ciphertext []byte) ([]byte, error) {
    spm.mutex.RLock()
    session, exists := spm.sessions[nodeID]
    spm.mutex.RUnlock()

    if !exists {
        return nil, fmt.Errorf("no session established with %s", nodeID)
    }

    // Decrypt with session cipher
    plaintext, err := session.SessionCipher.Decrypt(ciphertext)
    if err != nil {
        return nil, fmt.Errorf("decryption failed: %w", err)
    }

    // Update session state
    spm.mutex.Lock()
    session.LastUpdated = time.Now()
    spm.mutex.Unlock()

    return plaintext, nil
}

// Forward secrecy: Each message uses a unique key derived from the chain key
// Past messages remain secure even if current chain key is compromised

// Post-compromise security: Double ratchet algorithm automatically recovers
// from key compromise through DH ratchet on each message exchange
```

### 7.6 Protocol Performance Characteristics

This table summarizes the performance characteristics of each protocol layer:

| Protocol | Operation | Latency | Throughput | Overhead |
|----------|-----------|---------|------------|----------|
| **DHT (Chord)** |
| Lookup | O(log N) hops × 6.5ms | ~65ms @ 10k nodes | - | 16 bytes NodeID |
| Stabilization | Per-node periodic | 10s interval | - | ~500 bytes/10s |
| **Gossip** |
| Message propagation | O(log N) rounds × 30s | ~2.5 min @ 10k nodes | - | ~500 bytes/update |
| Fanout | 6 peers | Instant | - | 6× message size |
| Bandwidth | Per-node | - | ~1.6 Kbps | <0.01% overhead |
| **WireGuard** |
| Handshake | 1-RTT | ~30ms | - | 148 bytes |
| Per-hop latency | Encryption overhead | ~5ms | 10 Gbps+ | 32 bytes header |
| Keepalive | Persistent | 25s interval | - | 32 bytes |
| **Signal Protocol** |
| Session establishment | X3DH handshake | ~50ms | - | ~400 bytes |
| Message encryption | Per-message | ~1ms | 100k msg/sec | ~100 bytes |
| Forward secrecy | Automatic | No overhead | - | Chain key rotation |

---

[← Previous: Performance Engineering](../06-performance/README.md) | [Next: API Specifications →](../08-api/README.md)

---
