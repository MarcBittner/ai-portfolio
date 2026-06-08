# Chord DHT Architecture Design for Tanglement.ai

This document provides a comprehensive Chord-based DHT architecture design for the Tanglement.ai P2P infrastructure, including finger table structure, maintenance algorithms, stabilization protocols, and failure recovery mechanisms.

---

## Executive Summary

**Architecture Choice**: Modified Chord protocol with enhanced stabilization and redundancy

**Key Design Decisions**:
- **Identifier Space**: 256-bit SHA-256 (see [identifier-space-analysis.md](./identifier-space-analysis.md))
- **Successor List Size**: 5 nodes (balances redundancy vs overhead)
- **Predecessor List Size**: 3 nodes (faster recovery)
- **Finger Table**: Full 256 entries with lazy refresh
- **Stabilization Interval**: 30 seconds (adaptive)
- **Failure Detection**: 3-strike heartbeat with 10s timeout

---

## Table of Contents

1. [Overview](#overview)
2. [Identifier Space](#identifier-space)
3. [Finger Table Structure](#finger-table-structure)
4. [Successor and Predecessor Lists](#successor-and-predecessor-lists)
5. [Stabilization Protocol](#stabilization-protocol)
6. [Failure Detection and Recovery](#failure-detection-and-recovery)
7. [Network Partition Detection and Healing](#network-partition-detection-and-healing)
8. [State Diagrams](#state-diagrams)
9. [Performance Characteristics](#performance-characteristics)
10. [Implementation Guidelines](#implementation-guidelines)

---

## Overview

### Chord Basics

Chord is a distributed hash table protocol that provides efficient key lookup in a peer-to-peer network. Each node and key is assigned a unique identifier in a circular identifier space, and keys are stored at their successor nodes.

### Core Principles

1. **Consistent Hashing**: Keys and nodes mapped to same identifier space
2. **Finger Table Routing**: Exponential distance routing for O(log N) lookups
3. **Successor Lists**: Redundancy for fault tolerance
4. **Stabilization**: Periodic protocol to maintain correct topology
5. **Eventual Consistency**: Network converges to correct state after changes

### Why Chord for Tanglement.ai?

While Kademlia was selected as the primary DHT (see [dht-comparison.md](./dht-comparison.md)), Chord architecture principles inform our design:

- **Mathematical Guarantees**: Provable O(log N) properties
- **Simple Stabilization**: Clean protocol for topology maintenance
- **Research Foundation**: Well-studied failure scenarios
- **Hybrid Approach**: Use Chord principles to enhance Kademlia

**Note**: This document describes Chord architecture for reference and potential hybrid implementation. Production system uses Kademlia via libp2p.

---

## Identifier Space

### Parameters

- **Size**: 256 bits (2^256 possible identifiers)
- **Hash Function**: SHA-256
- **Ring Size**: m = 256 (number of bits)

### Node ID Generation

```go
// Generate node ID from ed25519 public key
func GenerateNodeID(publicKey ed25519.PublicKey) NodeID {
    hash := sha256.Sum256(publicKey)
    return NodeID(hash)
}
```

### Key ID Generation

```go
// Generate key ID for data lookup
func GenerateKeyID(key []byte) NodeID {
    hash := sha256.Sum256(key)
    return NodeID(hash)
}
```

### Distance Metric

Chord uses **clockwise distance** on the identifier circle:

```go
// Clockwise distance from start to end on the ring
func Distance(start, end NodeID) *big.Int {
    // Convert to big integers
    s := new(big.Int).SetBytes(start[:])
    e := new(big.Int).SetBytes(end[:])

    // Calculate (end - start) mod 2^256
    ringSize := new(big.Int).Lsh(big.NewInt(1), 256) // 2^256
    distance := new(big.Int).Sub(e, s)
    distance.Mod(distance, ringSize)

    return distance
}
```

### In-Range Check

```go
// InRange checks if id is in the range (start, end] on the ring
func InRange(id, start, end NodeID, inclusive bool) bool {
    if start.Equal(end) {
        return !inclusive || id.Equal(start)
    }

    if start.Less(end) {
        // Normal case: start < end
        if inclusive {
            return (start.Less(id) || start.Equal(id)) &&
                   (id.Less(end) || id.Equal(end))
        }
        return start.Less(id) && id.Less(end)
    } else {
        // Wrap-around case: start > end
        if inclusive {
            return (start.Less(id) || start.Equal(id)) ||
                   (id.Less(end) || id.Equal(end))
        }
        return start.Less(id) || id.Less(end)
    }
}
```

---

## Finger Table Structure

### Definition

Each node `n` maintains a **finger table** with up to `m` entries (m = 256 for 256-bit identifiers), where the i-th entry contains:

```
finger[i].start = (n + 2^(i-1)) mod 2^m
finger[i].node  = successor(finger[i].start)
```

### Data Structure

```go
// FingerEntry represents a single finger table entry
type FingerEntry struct {
    Start    NodeID      // (n + 2^i) mod 2^m
    Interval [2]NodeID   // [start, start + 2^i)
    Node     *RemoteNode // First node >= start
}

// FingerTable maintains routing information
type FingerTable struct {
    entries [256]FingerEntry
    mutex   sync.RWMutex

    // Optimization: cache frequently accessed fingers
    next    int // Next finger to fix
}
```

### Initialization

```go
func (ft *FingerTable) Initialize(self NodeID) {
    ft.mutex.Lock()
    defer ft.mutex.Unlock()

    for i := 0; i < 256; i++ {
        // Calculate finger[i].start = (n + 2^i) mod 2^256
        offset := new(big.Int).Lsh(big.NewInt(1), uint(i))
        selfBig := new(big.Int).SetBytes(self[:])
        start := new(big.Int).Add(selfBig, offset)

        ringSize := new(big.Int).Lsh(big.NewInt(1), 256)
        start.Mod(start, ringSize)

        var startID NodeID
        copy(startID[:], start.Bytes())

        ft.entries[i].Start = startID
        ft.entries[i].Node = nil // To be populated

        // Calculate interval [start, start + 2^i)
        intervalEnd := new(big.Int).Add(start, offset)
        intervalEnd.Mod(intervalEnd, ringSize)

        var endID NodeID
        copy(endID[:], intervalEnd.Bytes())

        ft.entries[i].Interval = [2]NodeID{startID, endID}
    }

    ft.next = 0
}
```

### Finger Table Lookup

```go
// ClosestPrecedingNode finds closest node preceding id
func (ft *FingerTable) ClosestPrecedingNode(id NodeID, self NodeID) *RemoteNode {
    ft.mutex.RLock()
    defer ft.mutex.RUnlock()

    // Search from largest finger down to smallest
    for i := 255; i >= 0; i-- {
        finger := ft.entries[i].Node
        if finger == nil {
            continue
        }

        // Check if finger.id is in (self, id)
        if InRange(finger.ID, self, id, false) {
            return finger
        }
    }

    return nil // No closer node found
}
```

### Finger Table Maintenance

Finger tables are maintained through the **fix_fingers** protocol:

```go
// FixNextFinger updates the next finger in round-robin fashion
func (node *ChordNode) FixNextFinger(ctx context.Context) error {
    ft := node.fingerTable

    // Get next finger index
    ft.mutex.Lock()
    index := ft.next
    ft.next = (ft.next + 1) % 256
    ft.mutex.Unlock()

    // Look up successor of finger[index].start
    start := ft.entries[index].Start
    successor, err := node.FindSuccessor(ctx, start)
    if err != nil {
        return fmt.Errorf("fix finger %d: %w", index, err)
    }

    // Update finger table
    ft.mutex.Lock()
    ft.entries[index].Node = successor
    ft.mutex.Unlock()

    return nil
}
```

**Scheduling**: Fix one finger every 30 seconds (all 256 fingers refreshed in ~2 hours)

---

## Successor and Predecessor Lists

### Successor List

Each node maintains a **successor list** of size `r` (r = 5 recommended):

```go
// SuccessorList maintains r immediate successors
type SuccessorList struct {
    nodes []* RemoteNode
    size  int
    mutex sync.RWMutex
}

func NewSuccessorList(size int) *SuccessorList {
    return &SuccessorList{
        nodes: make([]*RemoteNode, 0, size),
        size:  size,
    }
}

// GetSuccessor returns the immediate successor (first in list)
func (sl *SuccessorList) GetSuccessor() *RemoteNode {
    sl.mutex.RLock()
    defer sl.mutex.RUnlock()

    if len(sl.nodes) == 0 {
        return nil
    }
    return sl.nodes[0]
}

// GetAll returns all successors
func (sl *SuccessorList) GetAll() []*RemoteNode {
    sl.mutex.RLock()
    defer sl.mutex.RUnlock()

    result := make([]*RemoteNode, len(sl.nodes))
    copy(result, sl.nodes)
    return result
}

// Update replaces the successor list with new nodes
func (sl *SuccessorList) Update(nodes []*RemoteNode) {
    sl.mutex.Lock()
    defer sl.mutex.Unlock()

    // Keep only first r nodes
    if len(nodes) > sl.size {
        nodes = nodes[:sl.size]
    }

    sl.nodes = nodes
}
```

### Predecessor List

Each node maintains a **predecessor list** of size `p` (p = 3 recommended):

```go
// PredecessorList maintains p immediate predecessors
type PredecessorList struct {
    nodes []* RemoteNode
    size  int
    mutex sync.RWMutex
}

func NewPredecessorList(size int) *PredecessorList {
    return &PredecessorList{
        nodes: make([]*RemoteNode, 0, size),
        size:  size,
    }
}

// GetPredecessor returns the immediate predecessor (first in list)
func (pl *PredecessorList) GetPredecessor() *RemoteNode {
    pl.mutex.RLock()
    defer pl.mutex.RUnlock()

    if len(pl.nodes) == 0 {
        return nil
    }
    return pl.nodes[0]
}
```

### Redundancy Analysis

With successor list of size r = 5:
- **Probability of total failure** = p^5 (where p is individual node failure probability)
- If p = 0.1 (10% failure rate): P(total failure) = 0.00001 (0.001%)
- If p = 0.2 (20% failure rate): P(total failure) = 0.00032 (0.032%)

**Conclusion**: r = 5 provides excellent redundancy for typical churn rates.

---

## Stabilization Protocol

### Overview

Stabilization is the periodic process that maintains the Chord ring invariants:
1. Each node's successor pointer is correct
2. Each node's predecessor pointer is correct
3. Finger tables are reasonably up-to-date

### Stabilization Interval

- **Default**: 30 seconds
- **Adaptive**: Adjust based on observed churn rate
- **High churn**: Reduce to 15 seconds
- **Low churn**: Increase to 60 seconds

### Stabilization Algorithm

```go
// Stabilize runs periodically to maintain ring invariants
func (node *ChordNode) Stabilize(ctx context.Context) error {
    // Get current successor
    successor := node.successorList.GetSuccessor()
    if successor == nil {
        // No successor - try to find one via finger table
        return node.findInitialSuccessor(ctx)
    }

    // Ask successor for its predecessor
    x, err := successor.GetPredecessor(ctx)
    if err != nil {
        // Successor failed - try next in successor list
        return node.handleSuccessorFailure(ctx)
    }

    // If x is between us and our successor, x should be our successor
    if x != nil && InRange(x.ID, node.id, successor.ID, false) {
        // Update successor list
        node.successorList.Update([]*RemoteNode{x, successor})
        successor = x
    }

    // Notify our successor of our existence
    if err := successor.Notify(ctx, node.Self()); err != nil {
        return fmt.Errorf("notify successor: %w", err)
    }

    // Update successor list from successor's list
    successorList, err := successor.GetSuccessorList(ctx)
    if err != nil {
        return fmt.Errorf("get successor list: %w", err)
    }

    // Merge: [successor] + successor's list
    merged := append([]*RemoteNode{successor}, successorList...)
    node.successorList.Update(merged)

    return nil
}
```

### Notify Protocol

When node n receives `Notify(n')`:

```go
// Notify is called when a node thinks it might be our predecessor
func (node *ChordNode) Notify(ctx context.Context, nprime *RemoteNode) error {
    currentPred := node.predecessorList.GetPredecessor()

    // If we have no predecessor, accept n'
    if currentPred == nil {
        node.predecessorList.Update([]*RemoteNode{nprime})
        return nil
    }

    // If n' is between our predecessor and us, update predecessor
    if InRange(nprime.ID, currentPred.ID, node.id, false) {
        node.predecessorList.Update([]*RemoteNode{nprime, currentPred})
    }

    return nil
}
```

### Fix Fingers Protocol

```go
// FixFingers runs periodically to update finger table entries
func (node *ChordNode) FixFingers(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := node.FixNextFinger(ctx); err != nil {
                log.Printf("Fix finger error: %v", err)
            }
        }
    }
}
```

### Check Predecessor Protocol

```go
// CheckPredecessor periodically checks if predecessor has failed
func (node *ChordNode) CheckPredecessor(ctx context.Context) error {
    pred := node.predecessorList.GetPredecessor()
    if pred == nil {
        return nil // No predecessor to check
    }

    // Ping predecessor
    if err := pred.Ping(ctx); err != nil {
        // Predecessor failed - remove it
        log.Printf("Predecessor %s failed, removing", pred.ID)
        node.predecessorList.Update(nil)
    }

    return nil
}
```

### Stabilization State Machine

```
┌─────────────┐
│   Initial   │
│  (no ring)  │
└──────┬──────┘
       │ join(bootstrap)
       ▼
┌─────────────┐
│   Joining   │◄───────────┐
│ (acquiring  │            │
│ successor)  │            │ retry
└──────┬──────┘            │
       │ successor found   │
       ▼                   │
┌─────────────┐            │
│   Stable    │───error───►│
│ (normal     │            │
│  operation) │            │
└──────┬──────┘            │
       │ stabilize()       │
       │ fix_fingers()     │
       │ check_pred()      │
       └───────────────────┘
```

---

## Failure Detection and Recovery

### Failure Detection Mechanism

**Heartbeat Protocol** with 3-strike failure detection:

```go
// HealthChecker monitors node health
type HealthChecker struct {
    failures map[NodeID]int
    mutex    sync.Mutex

    maxStrikes    int           // 3 strikes
    checkInterval time.Duration // 10 seconds
    timeout       time.Duration // 5 seconds
}

// CheckNode sends heartbeat and records response
func (hc *HealthChecker) CheckNode(ctx context.Context, node *RemoteNode) error {
    ctx, cancel := context.WithTimeout(ctx, hc.timeout)
    defer cancel()

    err := node.Ping(ctx)

    hc.mutex.Lock()
    defer hc.mutex.Unlock()

    if err != nil {
        // Increment strike count
        hc.failures[node.ID]++

        if hc.failures[node.ID] >= hc.maxStrikes {
            // Node is dead - trigger recovery
            return fmt.Errorf("node %s failed (3 strikes)", node.ID)
        }
    } else {
        // Node responded - reset strikes
        delete(hc.failures, node.ID)
    }

    return nil
}
```

### Successor Failure Recovery

```go
// HandleSuccessorFailure promotes next successor
func (node *ChordNode) handleSuccessorFailure(ctx context.Context) error {
    allSuccessors := node.successorList.GetAll()

    if len(allSuccessors) == 0 {
        return fmt.Errorf("no successors available")
    }

    // Try each successor in order
    for i, succ := range allSuccessors {
        if err := succ.Ping(ctx); err == nil {
            // Found a live successor
            log.Printf("Promoted successor[%d] to primary", i)

            // Update successor list (remove failed nodes)
            node.successorList.Update(allSuccessors[i:])

            // Notify new successor
            if err := succ.Notify(ctx, node.Self()); err != nil {
                log.Printf("Notify new successor failed: %v", err)
            }

            return nil
        }
    }

    // All successors failed - emergency recovery
    return node.emergencyRecovery(ctx)
}
```

### Predecessor Failure Recovery

```go
// Predecessor failure is detected passively during stabilization
// When predecessor fails, it simply stops notifying us
// New predecessor will eventually notify us through stabilization
func (node *ChordNode) handlePredecessorFailure() {
    node.predecessorList.Update(nil)
    log.Printf("Predecessor failed, cleared predecessor list")
    // Will be repopulated by new predecessor's Notify
}
```

### Emergency Recovery

```go
// EmergencyRecovery attempts to rejoin the ring from bootstrap nodes
func (node *ChordNode) emergencyRecovery(ctx context.Context) error {
    log.Printf("EMERGENCY: All successors failed, rejoining network")

    // Clear routing state
    node.successorList.Update(nil)
    node.predecessorList.Update(nil)

    // Attempt to rejoin via bootstrap nodes
    for _, bootstrap := range node.config.BootstrapNodes {
        if err := node.Join(ctx, bootstrap); err == nil {
            log.Printf("Emergency recovery successful via %s", bootstrap)
            return nil
        }
    }

    return fmt.Errorf("emergency recovery failed - no bootstrap nodes available")
}
```

### Recovery Timing

| Event | Detection Time | Recovery Time | Total Downtime |
|-------|----------------|---------------|----------------|
| **Successor failure** | 3 × 10s = 30s | <1s | ~31s |
| **Predecessor failure** | 30s (next stabilize) | 0s (passive) | ~30s |
| **Multiple successor failures** | 30s | 1-5s | ~35s |
| **Complete partition** | 30s | 5-60s | ~90s |

---

## Network Partition Detection and Healing

### Partition Detection

Detecting network partitions in Chord is challenging because the protocol is designed for asynchronous networks. We use heuristic detection:

```go
// PartitionDetector monitors for network partition indicators
type PartitionDetector struct {
    node              *ChordNode
    suspectPartition  bool
    partitionEvidence []string

    // Heuristics
    successorFailures    int
    fingerTableStaleness float64
    ringInconsistencies  int
}

// DetectPartition checks for partition indicators
func (pd *PartitionDetector) DetectPartition(ctx context.Context) bool {
    evidence := []string{}

    // Heuristic 1: Multiple successor failures
    if pd.successorFailures >= 3 {
        evidence = append(evidence, "multiple successor failures")
    }

    // Heuristic 2: High finger table staleness
    staleness := pd.measureFingerTableStaleness(ctx)
    if staleness > 0.5 { // More than 50% stale
        evidence = append(evidence, fmt.Sprintf("finger table %.0f%% stale", staleness*100))
    }

    // Heuristic 3: Ring walk inconsistencies
    if pd.detectRingInconsistencies(ctx) {
        evidence = append(evidence, "ring walk inconsistencies detected")
    }

    // Heuristic 4: Unreachable nodes in different parts of ring
    if pd.detectUnreachableSegments(ctx) {
        evidence = append(evidence, "unreachable ring segments")
    }

    if len(evidence) >= 2 {
        pd.suspectPartition = true
        pd.partitionEvidence = evidence
        log.Printf("PARTITION SUSPECTED: %v", evidence)
        return true
    }

    return false
}
```

### Ring Walk for Consistency Checking

```go
// WalkRing performs a complete ring traversal to check consistency
func (node *ChordNode) WalkRing(ctx context.Context, maxHops int) ([]*RemoteNode, error) {
    visited := make(map[NodeID]bool)
    nodes := []*RemoteNode{}

    current := node.successorList.GetSuccessor()
    if current == nil {
        return nil, fmt.Errorf("no successor")
    }

    for i := 0; i < maxHops && current != nil; i++ {
        // Check for loop
        if visited[current.ID] {
            break // Completed ring walk
        }

        visited[current.ID] = true
        nodes = append(nodes, current)

        // Get current's successor
        next, err := current.GetSuccessor(ctx)
        if err != nil {
            log.Printf("Ring walk broken at %s: %v", current.ID, err)
            return nodes, err
        }

        current = next

        // Check if we've returned to ourselves
        if current.ID.Equal(node.id) {
            break // Completed full ring
        }
    }

    return nodes, nil
}
```

### Partition Healing

When partitions heal, Chord's stabilization protocol naturally merges the rings:

```go
// HealPartition attempts to reconnect isolated segments
func (node *ChordNode) HealPartition(ctx context.Context) error {
    log.Printf("Attempting partition healing")

    // Strategy 1: Contact bootstrap nodes from different segments
    for _, bootstrap := range node.config.BootstrapNodes {
        // Try to get their view of the network
        successor, err := bootstrap.FindSuccessor(ctx, node.id)
        if err != nil {
            continue
        }

        // If bootstrap's view differs from ours, we may have been partitioned
        ourSuccessor := node.successorList.GetSuccessor()
        if ourSuccessor != nil && !successor.ID.Equal(ourSuccessor.ID) {
            log.Printf("Partition healing: bootstrap sees different successor")
            log.Printf("  Our view: %s", ourSuccessor.ID)
            log.Printf("  Bootstrap view: %s", successor.ID)

            // Merge: adopt bootstrap's view and stabilize
            node.successorList.Update([]*RemoteNode{successor})

            // Run aggressive stabilization
            for i := 0; i < 5; i++ {
                if err := node.Stabilize(ctx); err != nil {
                    log.Printf("Stabilization round %d failed: %v", i, err)
                } else {
                    log.Printf("Stabilization round %d succeeded", i)
                }
                time.Sleep(5 * time.Second)
            }

            return nil
        }
    }

    return fmt.Errorf("partition healing failed - no evidence of partition")
}
```

### Partition Healing State Machine

```
┌────────────────┐
│  Partitioned   │
│  (isolated     │
│   segment)     │
└────────┬───────┘
         │
         │ network heals
         │ (reconnection event)
         ▼
┌────────────────┐
│  Discovering   │
│  (contact      │
│   bootstrap)   │
└────────┬───────┘
         │
         │ found different ring
         ▼
┌────────────────┐
│    Merging     │
│  (aggressive   │
│  stabilize)    │
└────────┬───────┘
         │
         │ rings merged
         ▼
┌────────────────┐
│    Stable      │
│  (normal ops)  │
└────────────────┘
```

### Merge Conflicts

When two isolated ring segments merge, conflicts may arise:

```go
// ResolveMergeConflict handles key ownership during partition healing
func (node *ChordNode) ResolveMergeConflict(key NodeID, ourData, theirData []byte) ([]byte, error) {
    // Strategy: Last-write-wins with vector clocks

    ourTimestamp := extractTimestamp(ourData)
    theirTimestamp := extractTimestamp(theirData)

    if theirTimestamp.After(ourTimestamp) {
        log.Printf("Merge conflict for %s: accepting their version (newer)", key)
        return theirData, nil
    } else {
        log.Printf("Merge conflict for %s: keeping our version (newer)", key)
        return ourData, nil
    }
}
```

---

## State Diagrams

### Node Lifecycle States

**Diagram**: [chord-node-lifecycle.drawio](./diagrams/chord-node-lifecycle.drawio)

![Node Lifecycle States](./diagrams/chord-node-lifecycle.drawio.png)

**Note**: The diagram shows a "Periodic Maintenance" box connected to the Active state with a bidirectional dashed arrow. This represents the continuous background operations (Stabilize, FixFingers, CheckPredecessor) that run while the node is in the Active state, rather than showing them as self-loops.

**State Descriptions**:

| State | Description | Transitions From | Transitions To |
|-------|-------------|------------------|----------------|
| **Offline** | Node is not running | - (initial) or Leaving | Booting |
| **Booting** | Node is initializing | Offline | Joining |
| **Joining** | Node is connecting to the ring | Booting | Active, Isolated |
| **Isolated** | Node failed to join, retrying | Joining | Active |
| **Active** | Normal operation, processing requests | Joining, Isolated, Partition Healing | Active (maintenance loops), Partition Healing, Leaving |
| **Partition Healing** | Recovering from network partition | Active | Active, Leaving |
| **Leaving** | Graceful shutdown in progress | Active, Partition Healing | Offline, Crashed |
| **Crashed** | Ungraceful termination | Leaving | - (terminal) |

**ASCII Representation** (for text-only viewing):

```
     ┌─────────┐
     │ Offline │
     └────┬────┘
          │
          │ Start()
          ▼
     ┌─────────┐
     │Booting  │
     └────┬────┘
          │
          │ Initialize()
          ▼
     ┌─────────┐               ┌──────────┐
     │ Joining │──────────────►│ Isolated │
     └────┬────┘   timeout     └─────┬────┘
          │                          │
          │ join success             │ reconnect
          ▼                          │
     ┌─────────┐◄────────────────────┘
     │ Active  │ ◄─┐
     │(stable) │   │ Stabilize()
     └────┬────┘   │ FixFingers()
          │        │ CheckPredecessor()
          │        │ (periodic maintenance
          │        │  self-loops)
          │        │
          ├────────┘
          │
          │ partition detected
          ▼
     ┌─────────┐
     │Partition│
     │ Healing │
     └────┬────┘
          │
          │ healed
          │
          ├──────────────┐
          ▼              │
     ┌─────────┐         │
     │ Active  │         │
     └────┬────┘         │
          │              │
          │ Shutdown()   │ failed
          ▼              │
     ┌─────────┐         │
     │ Leaving │         │
     └────┬────┘         │
          │              │
          │ graceful     │
          │ exit         │
          ▼              ▼
     ┌─────────┐    ┌─────────┐
     │ Offline │    │ Crashed │
     └─────────┘    └─────────┘
```

### Stabilization Protocol State

```
     ┌───────────┐
     │   Idle    │
     └─────┬─────┘
           │
           │ timer (30s)
           ▼
     ┌───────────┐
     │  Running  │
     │ Stabilize │
     └─────┬─────┘
           │
           ├─────────────────────┐
           │                     │
           │ has successor       │ no successor
           ▼                     ▼
     ┌───────────┐         ┌───────────┐
     │   Query   │         │   Find    │
     │ Successor │         │ Bootstrap │
     │  for X    │         └─────┬─────┘
     └─────┬─────┘               │
           │                     │
           │ response            │ found
           ▼                     │
     ┌───────────┐               │
     │  Update   │◄──────────────┘
     │ Successor │
     │   List    │
     └─────┬─────┘
           │
           │ send Notify()
           ▼
     ┌───────────┐
     │  Complete │
     └─────┬─────┘
           │
           └──────► back to Idle
```

### Lookup Protocol State

```
     ┌───────────┐
     │   Start   │
     │ Lookup(k) │
     └─────┬─────┘
           │
           ▼
     ┌───────────┐
     │  Check    │
     │ Local     │──yes──► Return self
     │Ownership  │
     └─────┬─────┘
           │
           no
           ▼
     ┌───────────┐
     │   Find    │
     │  Closest  │
     │Preceding  │
     │   Node    │
     └─────┬─────┘
           │
           ├──────────────────┐
           │                  │
           │ found            │ none (use successor)
           ▼                  │
     ┌───────────┐            │
     │   Forward │◄───────────┘
     │  Request  │
     └─────┬─────┘
           │
           │ response
           │
           ├─────────────────┐
           │                 │
           │ target found    │ forward again
           ▼                 │
     ┌───────────┐           │
     │  Return   │           │
     │  Result   │           └──► back to Forward
     └───────────┘
```

---

## Performance Characteristics

### Lookup Complexity

| Operation | Expected Hops | Worst Case | Probability |
|-----------|---------------|------------|-------------|
| **Lookup** | O(log N) | O(N) | Very low with stabilization |
| **Join** | O(log² N) | O(N log N) | During high churn |
| **Leave** | O(log N) | O(log N) | Graceful departure |
| **Stabilize** | O(1) | O(log N) | Rare (many concurrent joins) |

### Network Size Scaling

| Network Size (N) | Expected Hops | Finger Table Size | Successor List |
|------------------|---------------|-------------------|----------------|
| **100** | 7 | 256 entries | 5 nodes |
| **1,000** | 10 | 256 entries | 5 nodes |
| **10,000** | 13 | 256 entries | 5 nodes |
| **100,000** | 17 | 256 entries | 5 nodes |
| **1,000,000** | 20 | 256 entries | 5 nodes |

### Stabilization Overhead

For a network of N nodes with stabilization interval T:
- **Messages per node per interval**: ~6
  - 1 × GetPredecessor (to successor)
  - 1 × Notify (to successor)
  - 1 × GetSuccessorList (to successor)
  - 1 × Ping (to predecessor)
  - 1 × FindSuccessor (for fix_fingers)
  - ~1 × Notify (from predecessor, on average)

- **Total network messages per interval**: 6N
- **Messages per second**: 6N / T
- **For N=10,000, T=30s**: 2,000 messages/second network-wide (~0.2 msgs/sec/node)

### Memory Usage

Per node memory footprint:

| Component | Size | Notes |
|-----------|------|-------|
| **Node ID** | 32 bytes | SHA-256 hash |
| **Finger Table** | ~16 KB | 256 entries × 64 bytes/entry |
| **Successor List** | ~320 bytes | 5 nodes × 64 bytes/node |
| **Predecessor List** | ~192 bytes | 3 nodes × 64 bytes/node |
| **Health Tracker** | ~1 KB | Failure counters |
| **Total** | **~18 KB** | Per node routing state |

For N=10,000 node network:
- **Total routing state**: 180 MB (distributed)
- **Per node**: 18 KB (minimal)

---

## Implementation Guidelines

### Recommended Architecture

```go
// ChordNode is the main node implementation
type ChordNode struct {
    // Identity
    id         NodeID
    address    string
    publicKey  ed25519.PublicKey
    privateKey ed25519.PrivateKey

    // Routing State
    fingerTable     *FingerTable
    successorList   *SuccessorList
    predecessorList *PredecessorList

    // Protocols
    stabilizer       *Stabilizer
    healthChecker    *HealthChecker
    partitionDetector *PartitionDetector

    // Configuration
    config *Config

    // Lifecycle
    ctx    context.Context
    cancel context.CancelFunc
    wg     sync.WaitGroup
}

// Config holds configuration parameters
type Config struct {
    // Stabilization
    StabilizeInterval    time.Duration // 30s default
    FixFingersInterval   time.Duration // 30s default
    CheckPredInterval    time.Duration // 30s default

    // Failure Detection
    PingTimeout         time.Duration // 5s default
    MaxStrikes          int          // 3 default
    HealthCheckInterval time.Duration // 10s default

    // Redundancy
    SuccessorListSize   int // 5 default
    PredecessorListSize int // 3 default

    // Network
    BootstrapNodes []string
    ListenAddress  string

    // Partition Detection
    EnablePartitionDetection bool
    PartitionCheckInterval   time.Duration // 5min default
}
```

### Initialization

```go
func NewChordNode(config *Config, keys ed25519.PrivateKey) *ChordNode {
    publicKey := keys.Public().(ed25519.PublicKey)
    nodeID := GenerateNodeID(publicKey)

    ctx, cancel := context.WithCancel(context.Background())

    node := &ChordNode{
        id:         nodeID,
        publicKey:  publicKey,
        privateKey: keys,
        config:     config,
        ctx:        ctx,
        cancel:     cancel,

        fingerTable:     NewFingerTable(),
        successorList:   NewSuccessorList(config.SuccessorListSize),
        predecessorList: NewPredecessorList(config.PredecessorListSize),

        stabilizer:       NewStabilizer(config),
        healthChecker:    NewHealthChecker(config),
        partitionDetector: NewPartitionDetector(),
    }

    node.fingerTable.Initialize(nodeID)

    return node
}
```

### Start Node

```go
func (node *ChordNode) Start(ctx context.Context) error {
    // Start background protocols
    node.wg.Add(3)

    // Stabilization protocol
    go func() {
        defer node.wg.Done()
        node.runStabilization(ctx)
    }()

    // Fix fingers protocol
    go func() {
        defer node.wg.Done()
        node.runFixFingers(ctx)
    }()

    // Check predecessor protocol
    go func() {
        defer node.wg.Done()
        node.runCheckPredecessor(ctx)
    }()

    log.Printf("Chord node %s started", node.id)
    return nil
}
```

### Graceful Shutdown

```go
func (node *ChordNode) Shutdown(ctx context.Context) error {
    log.Printf("Shutting down node %s", node.id)

    // Notify successor of our departure
    successor := node.successorList.GetSuccessor()
    if successor != nil {
        // Transfer keys to successor
        if err := node.transferKeys(ctx, successor); err != nil {
            log.Printf("Key transfer failed: %v", err)
        }

        // Update successor's predecessor
        predecessor := node.predecessorList.GetPredecessor()
        if predecessor != nil {
            if err := successor.UpdatePredecessor(ctx, predecessor); err != nil {
                log.Printf("Update successor's predecessor failed: %v", err)
            }
        }
    }

    // Notify predecessor of our departure
    predecessor := node.predecessorList.GetPredecessor()
    if predecessor != nil {
        successorList := node.successorList.GetAll()
        if len(successorList) > 0 {
            if err := predecessor.UpdateSuccessor(ctx, successorList); err != nil {
                log.Printf("Update predecessor's successor failed: %v", err)
            }
        }
    }

    // Stop background protocols
    node.cancel()

    // Wait for goroutines to finish
    done := make(chan struct{})
    go func() {
        node.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        log.Printf("Node %s shutdown complete", node.id)
        return nil
    case <-ctx.Done():
        return fmt.Errorf("shutdown timeout")
    }
}
```

### Testing Recommendations

1. **Unit Tests**
   - Finger table calculations
   - Distance metric
   - In-range checks
   - State transitions

2. **Integration Tests**
   - Join/leave protocols
   - Stabilization
   - Failure recovery
   - Partition healing

3. **Simulation Tests**
   - Large network (10,000+ nodes)
   - High churn scenarios
   - Network partition scenarios
   - Byzantine behavior

4. **Chaos Engineering**
   - Random node failures
   - Network delays
   - Packet loss
   - Partition injection

---

## References

### Academic Papers

1. **Stoica, I., Morris, R., Karger, D., Kaashoek, M. F., & Balakrishnan, H. (2001)**
   "Chord: A Scalable Peer-to-peer Lookup Service for Internet Applications"
   - Original Chord paper with theoretical foundations

2. **Stoica, I., Morris, R., Liben-Nowell, D., Karger, D. R., Kaashoek, M. F., Dabek, F., & Balakrishnan, H. (2003)**
   "Chord: A Scalable Peer-to-peer Lookup Protocol for Internet Applications"
   - Extended version with performance analysis

3. **Li, J., Stribling, J., Morris, R., & Kaashoek, M. F. (2005)**
   "Bandwidth-efficient Management of DHT Routing Tables"
   - Optimizations for finger table maintenance

4. **Zave, P. (2012)**
   "Using Lightweight Modeling to Understand Chord"
   - Formal analysis of Chord protocol correctness

### Implementation References

1. **MIT PDOS Chord**: https://pdos.csail.mit.edu/papers/chord:sigcomm01/
2. **OpenChord**: http://www.openChord.net/
3. **Go-Chord**: https://github.com/arriqaaq/chord

### Related Tanglement.ai Documents

1. [DHT Comparison](./dht-comparison.md) - Why Kademlia was chosen over Chord
2. [Identifier Space Analysis](./identifier-space-analysis.md) - 256-bit vs 160-bit analysis
3. [NAT Traversal Strategy](./nat-traversal-strategy.md) - Network connectivity

---

## Appendix: Hybrid Chord-Kademlia Approach

While Tanglement.ai uses Kademlia as the primary DHT, Chord principles can enhance the design:

### Chord Principles to Apply to Kademlia

1. **Successor Lists** → **Replacement Cache**
   - Kademlia k-buckets already maintain multiple nodes
   - Can organize as ordered successor list within buckets

2. **Stabilization Protocol** → **Bucket Refresh**
   - Adapt Chord's stabilization to refresh k-buckets
   - Periodic verification of bucket contents

3. **Finger Table** → **Routing Table Optimization**
   - Use Chord's exponential distance idea to prioritize bucket refresh
   - Ensure buckets at different distance scales are populated

4. **Graceful Departure** → **Leave Protocol**
   - Implement Chord-style key transfer on shutdown
   - Notify neighbors before leaving

### Hybrid Implementation Sketch

```go
// HybridDHT combines Kademlia routing with Chord-inspired redundancy
type HybridDHT struct {
    // Kademlia routing table
    routingTable *KademliaRoutingTable

    // Chord-inspired successor list (within Kademlia buckets)
    successorList *SuccessorList

    // Stabilization protocol
    stabilizer *ChordStabilizer
}
```

This hybrid approach could provide:
- Kademlia's parallel lookups and churn resistance
- Chord's mathematical guarantees and simpler reasoning
- Best of both worlds for Tanglement.ai's needs

---

## Conclusion

This Chord architecture design provides a complete specification for implementing a Chord-based DHT or enhancing a Kademlia implementation with Chord principles. While Tanglement.ai uses Kademlia via libp2p, understanding Chord's elegant design informs our network architecture and provides valuable insights for optimization and failure handling.

**Key Takeaways**:
- 256-bit identifier space provides future-proof security
- Successor list size of 5 balances redundancy and overhead
- 30-second stabilization interval suitable for typical churn
- 3-strike failure detection prevents false positives
- Partition detection requires heuristics (no perfect solution)
- Graceful shutdown improves network stability

**Next Steps**:
1. Implement basic Chord prototype for testing and comparison
2. Study how libp2p Kademlia handles similar scenarios
3. Consider hybrid approach combining best of both protocols
4. Develop comprehensive test suite for failure scenarios
