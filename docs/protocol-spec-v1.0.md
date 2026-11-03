# Protocol Specification V1.0 — Exact Contract & Cryptographic Specification

Normative. Everything an implementer or auditor needs to build or check V1 without making a design
decision. Design rationale lives in the Core Protocol Specification Plan (§1–§95) and `../research`.
Status words: **MUST / MUST NOT / SHOULD** are RFC-2119. Values marked *pinned* are frozen for V1.

Conformance of this repository to this document is executed, not asserted: every formula below has a
known-answer test in all four implementations (circom, Solidity, TypeScript, Python), see §17.

---

## 1. Field, encodings, identifiers

**Field.** All circuit values are elements of the BN254 scalar field
`p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.

**Canonical encoding (§46 of the plan).** Every value that enters the verifier or a hash MUST satisfy:

| Value | Bound | Enforced by |
|---|---|---|
| any field element | `x < p` | `FieldLib.requireField` (core), hasher, circuit (implicit: witness is in F_p) |
| `address` as field | `x < 2^160` | `FieldLib.requireAddress` |
| `amount` | `x < 2^248` | `FieldLib.requireAmount` + circuit `Num2Bits(248)` |
| `leafIndex` | `x < 2^32` | `FieldLib.requireLeafIndex` (contract assigns it; always true) |

A value `>= p` is **rejected**, never reduced (aliasing: `x` and `x + p` would hash identically).

**Protocol identifiers (§82).** *pinned*, exposed as `bytes32 public constant` on `PrivacyCore`:

```
PROTOCOL_VERSION_STRING = "privacy-protocol/v1.0"
PROTOCOL_ID   = keccak256("privacy-protocol/v1.0")
CIRCUIT_ID    = keccak256("privacy-protocol/v1/circuit/transaction-2in3out-depth32-poseidon2")
HASH_ID       = keccak256("poseidon2-bn254-t4-rf8-rp56/noir-sponge/v1")
VAULT_VERSION = 1
```

A client MUST refuse to combine artifacts whose identifiers differ (V1 core + V2 circuit, etc.).

---

## 2. Hash function — Poseidon2 (*pinned*)

Exactly one hash is used everywhere: **Poseidon2 over the BN254 scalar field, state width t = 4,
S-box x⁵, R_F = 8 full rounds (4 + 4), R_P = 56 partial rounds**, with the HorizenLabs reference round
constants and matrices — the instance implemented by barretenberg's `Poseidon2Bn254ScalarFieldParams`
and executed by Noir's `std::hash::poseidon2_permutation`.

**Permutation.** `P : F_p^4 → F_p^4` as specified above.

**Hash of n field elements (sponge, Noir/barretenberg mode).** `H(x_1, …, x_n)`, n ≥ 1:

```
rate = 3, capacity = 1
state = [0, 0, 0, IV]            where IV = n · 2^64   (as a field element, in state[3])
cache = []
for each x_i:
    if |cache| == rate:            # a 4th element arrives: absorb the full cache first
        state[j] += cache[j]  for j in 0..2
        state = P(state)
        cache = []
    cache.append(x_i)
# squeeze
state[j] += cache[j]  for j in 0..|cache|-1
state = P(state)
return state[0]
```

Consequences: n ∈ {1,2,3} costs one permutation; n ∈ {4,5,6} costs two. The length is bound through IV,
so `H(a,b)` and `H(a,b,0)` differ.

**Known answers (generated with nargo / barretenberg v5.2.0; hex, big-endian field elements):**

```
P([0,0,0,0])[0]       = 0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e
P([1,2,3,4])[0]       = 0x224785a48a72c75e2cbb698143e71d5d41bd89a2b9a7185871e39a54ce5785b1
P([1,2,3,4])[3]       = 0x16c877b5b9c04d873218804ccbf65d0eeb12db447f66c9ca26fec380055df7e9
H(0)                  = 0x2710144414c3a5f2354f4c08d52ed655b9fe253b4bf12cb9ad3de693d9b1db11
H(1)                  = 0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373
H(0,0)                = 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1
H(1,2)                = 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383
H(0,0,0)              = 0x2a5de47ed300af27b706aaa14762fc468f5cfc16cd8116eb6b09b0f2643ca2b9
H(1,2,3)              = 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8
H(1,2,3,4)            = 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9
```

Every implementation (circom `Poseidon2Hash`, Solidity `Poseidon2Hasher`, TypeScript `poseidon2.ts`,
Python `poseidon2.py`) MUST reproduce all ten. Implementations are vendored verbatim with their sha256
recorded (`contracts/src/hasher/poseidon2/VENDORED.md`).

---

## 3. Domain separators (*pinned*)

`DOM(tag) = uint256(keccak256("privacy-protocol/v1/domain/" ‖ tag)) mod p`, for tags

```
NOTE_BODY, NOTE_COMMITMENT, OWNER_COMMITMENT, NULLIFIER, PHANTOM_NULLIFIER, OUTPUT_BINDING, TX_DOMAIN
```

Decimal values are in `circuits/vectors/primitives.json → domains` and MUST be identical in
`DomainSeparators.sol`, `packages/protocol/src/domains.ts`, `circuits/lib/domains.circom`,
`reference/python/primitives.py`. `OUTPUT_BINDING` and `TX_DOMAIN` are used with keccak (see §5, §9), the
others as the first Poseidon2 input of their object. No two semantic objects share a domain.

---

## 4. Keys and owner commitment

Derived locally from a wallet master seed; never leaves the device; never written to dapp-origin storage.

```
spendKey = uint256(keccak256(seed ‖ "/spend")) mod p      # authorizes spends (nullifier key)
viewKey  = uint256(keccak256(seed ‖ "/view"))  mod p      # decrypts incoming note payloads
noteKey  = uint256(keccak256(seed ‖ "/note"))  mod p      # derives per-note secrets (§5)
ownerCommitment = H(DOM(OWNER_COMMITMENT), spendKey)      # the receiving address (1 permutation)
```

The seed → key map above is the reference derivation; a production wallet MAY use a different KDF as
long as `ownerCommitment` is computed exactly as shown. **There is no on-chain key registry (§55).**
`ownerCommitment` is a public-ish receiving address; a wallet SHOULD use a fresh deposit-only owner key
(child derivation) for public shields, because a deposit reveals its owner commitment (§6).

The reference wallet does so for every note whose owner commitment becomes public (the audit round of 2026-10-16,
c18): a protect's deposit, a swap order's refund note (the escrow's `refundOwnerCommitment`) and a same-chain receipt's
note are each made out to their own,

```
ownerKey(note)  = uint256(keccak256(be32(spendKey) ‖ "/owner-key/" ‖ be32(noteSecret))) mod p
ownerCommitment = H(DOM(OWNER_COMMITMENT), ownerKey(note))
```

pinned by `packages/protocol/test/vectors/owner-keys.json`. The input that spends such a note takes `ownerKey(note)` as
its owner key; the circuit takes one per input (§5.3), so it is unchanged. The privacy address's `ownerCommitment`
names only the notes received and the wallet's own private outputs, which no deposit publishes.

---

## 5. Notes: format, commitment, nullifier, phantom

### 5.1 Note (wallet record), exact byte encoding (121 bytes)
```
offset  size  field
0       1     version          = 0x01
1       20    vaultId          canonical vault address (§7)
21      32    amount           uint256 big-endian, < 2^248
53      32    ownerCommitment  field element, big-endian
85      32    noteSecret       field element, big-endian, uniformly random (or noteKey-derived, §5.5)
117     4     leafIndex        uint32 big-endian (assigned by the contract)
```
As circuit inputs, `vaultId` is `uint256(uint160(address))`.

### 5.2 Note body and commitment (two layers, §13)
```
body       = H(DOM(NOTE_BODY), vaultId, amount, ownerCommitment, noteSecret)     # 5 inputs → 2 perms
commitment = H(DOM(NOTE_COMMITMENT), body, leafIndex)                            # 3 inputs → 1 perm
```
The contract assigns `leafIndex` at insertion and computes `commitment` itself (deposit: from public
inputs; transact: from the proof's public `outputBody_k`). Two identical bodies at different positions
yield different commitments (structural uniqueness).

### 5.3 Nullifier (1:1, §14)
```
nullifier = H(DOM(NULLIFIER), commitment, spendKey)                               # 3 inputs → 1 perm
```
One funded note has exactly one nullifier, because in the spending circuit `ownerCommitment` is
**derived** from `spendKey` (§10, constraint C4) — never a free witness (finding PP-C01).

### 5.4 Phantom input nullifier (§15–16)
Every transaction has 2 inputs. Input 0 is always real. If input slot 1 is unused, its nullifier is
```
nullifier_1 = H(DOM(PHANTOM_NULLIFIER), nullifier_0, 1, spendKey_0)               # 4 inputs → 2 perms
```
derived in-circuit (C8). Properties: unique per transaction (`nullifier_0` is unique), domain-separated
from real nullifiers, and **not recomputable by an observer** (it includes the private `spendKey_0`), so a
1-input transaction is indistinguishable from a 2-input one (finding PP-P02). The contract stores it
like any nullifier.

### 5.5 Dummy outputs (§17–18)
A transaction always has 3 outputs. A wallet fills an unused slot with a dummy note:
`amount = 0`, `ownerCommitment` = uniformly random field element (no key is known → unspendable by
construction), `noteSecret` = random. Its body is therefore unique and indistinguishable from a real one.
`noteSecret` for real notes SHOULD be `uint256(keccak256(noteKey ‖ uint64(counter))) mod p` so a wallet
can be restored from the seed plus the on-chain payloads; it MUST be unique per note.

---

## 6. Deposit (public shield)

Only a canonical vault may register a note. Sequence (ETH vault shown; ERC-20 identical after §8.2):

```
NativeAssetVault.deposit{value: amount}(ownerCommitment, noteSecret, noteData)
  require amount > 0
  accountedDeposits += amount
  leafIndex = PrivacyCore.commitDeposit(ownerCommitment, noteSecret, amount, noteData)
  emit Deposited(ownerCommitment, amount, leafIndex)

PrivacyCore.commitDeposit(ownerCommitment, noteSecret, amount, noteData)   # caller MUST be canonical
  require factory.isCanonical(msg.sender)                                   else CallerNotCanonicalVault
  requireField(ownerCommitment); requireField(noteSecret); requireAmount(amount)
  require noteData.length == NOTE_DATA_BYTES                               else MalformedNoteData(0)
  vaultId    = uint256(uint160(msg.sender))
  body       = H(DOM(NOTE_BODY), vaultId, amount, ownerCommitment, noteSecret)
  leafIndex  = nextLeafIndex
  commitment = H(DOM(NOTE_COMMITMENT), body, leafIndex)
  _insertGroup([commitment, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF])                # §9
  emit NoteInserted(leafIndex, commitment, noteData)
```
A deposit is public: `ownerCommitment`, `noteSecret`, `amount`, `vaultId` are calldata. This is by design
(§27–29, §53); privacy comes from the subsequent private transaction. `noteData` is the depositor's own
encrypted backup of the note (§12) and MUST have the fixed size.

---

## 7. Asset vaults and factory

### 7.1 Identity (§11)
`vaultId = uint256(uint160(vaultAddress))`. Symbols are never used cryptographically.

### 7.2 Factory, CREATE2 (§9–10), *pinned*
```
assetType: 0 = NATIVE, 1 = ERC20
salt      = keccak256(abi.encode(block.chainid, uint8(assetType), tokenAddress))   # token = 0 for native
initCode  = creationCode(NativeAssetVault) ‖ abi.encode(core)
          | creationCode(ERC20AssetVault)  ‖ abi.encode(core, token)
vault     = address(keccak256(0xff ‖ factory ‖ salt ‖ keccak256(initCode))[12:])
```
State: `vaultOf[asset] → vault`, `isCanonical[vault] → bool`. One vault per asset, permissionless
`getOrCreate*`, no setter of any kind. The factory is deployed by `PrivacyCore`'s constructor, so
`factory.CORE` and `core.VAULT_FACTORY` are both immutable without an admin.

### 7.3 Vault storage and invariants (§31–32)
```
CORE (immutable)      TOKEN (immutable, ERC-20 only)
accountedDeposits     shielded liabilities (sum of deposits − sum of releases)
totalClaimable        failed payouts owed to named recipients
claimable[recipient]
```
Solvency invariant: `actualBalance ≥ accountedDeposits + totalClaimable`. Donations only increase the
left side; they never become spendable liabilities.

### 7.4 Two-sided authorization (§28–29)
Core → vault: `factory.isCanonical(vault)` before `release`. Vault → core: `msg.sender == CORE`.

---

## 8. Vault algorithms

### 8.1 Native deposit — §6.
### 8.2 ERC-20 deposit (strict balance delta, §24–25)
```
balBefore = token.balanceOf(vault)
transferFrom(msg.sender, vault, amount)      # revert on revert, on `false`, or on malformed return
balAfter  = token.balanceOf(vault)
require balAfter − balBefore == amount        else UnsupportedTokenBehavior   (fee-on-transfer, rebasing)
accountedDeposits += amount; commitDeposit(...)
```
Supported ERC-20 behaviour: standard `transfer`/`transferFrom` returning `true` or nothing. Anything
else is rejected at deposit, so it can never be inside a vault.

### 8.3 Release and the claim state machine (§51–52)
```
release(recipient, amount)   onlyCore, nonReentrant
  require amount > 0 and accountedDeposits ≥ amount     else Undercollateralized
  accountedDeposits −= amount                            # EFFECT first
  ok = softTransfer(recipient, amount)                   # never reverts: ETH call with 100,000 gas at most / ERC-20 call, false on failure
                                                         # an ERC-20 32-byte answer is read as a word: non-zero = paid (the fifth review round, 2026-11-03)
  if ok:  emit Released(recipient, amount)
  else:   claimable[recipient] += amount; totalClaimable += amount; emit WithdrawalClaimCreated(recipient, amount)

claim(recipient)             anyone, nonReentrant
  amt = claimable[recipient]; require amt > 0            else NothingToClaim
  claimable[recipient] = 0; totalClaimable −= amt        # EFFECT first
  require softTransfer(recipient, amt)                   else ClaimTransferFailed   (revert restores the claim)
  emit Claimed(recipient, amt)
```
States per `(vault, recipient)`: `NONE —release fails→ CLAIMABLE(x) —release fails again→ CLAIMABLE(x+y)
—claim ok→ NONE`. A failed `claim` leaves the state unchanged. The cryptographic state transition in the
core is never rolled back by a payout failure; a blacklisted or reverting recipient only yields a claim.
No double claim (zeroed before the transfer, `nonReentrant`); no double spend (nullifiers consumed in
the core before `release` is called).

---

## 9. Merkle accumulator (*pinned*)

```
DEPTH               = 32                          (2^32 leaves)
ZERO_LEAF           = uint256(keccak256("privacy-protocol/v1/empty-leaf")) mod p
zeros[0]            = ZERO_LEAF;  zeros[i+1] = H(zeros[i], zeros[i])           (2 inputs → 1 perm)
node(l, r)          = H(l, r)
ROOT_HISTORY_BLOCKS = 4096
```

**Leaf groups.** Leaves are appended in aligned groups of 4; `nextLeafIndex` is always a multiple of 4.
Every operation consumes one group: a deposit = `[c, Z, Z, Z]`, a transaction = `[c0, c1, c2, Z]`
(`Z = ZERO_LEAF`). Padding slots hold `ZERO_LEAF`, which has no known Poseidon2 preimage → unspendable.

```
_insertGroup(l[4]):
  g      = nextLeafIndex / 4                     # group index = position at level 2
  n2     = H(H(l0, l1), H(l2, l3))               # 3 hashes (2 when l2 = l3 = Z: H(l2,l3) = zeros[1])
  cur = g; h = n2
  for level in 2 .. 31:                          # 30 levels
      if cur even: left = h, right = zeros[level], filledSubtrees[level] = h
      else:        left = filledSubtrees[level], right = h
      h = H(left, right); cur /= 2
  root = h; nextLeafIndex += 4
  if root not known: rootKnown[root] = true; rootBlock[root] = block.number; rootHistory.push(root)
```
Costs: deposit 32 hashes, transaction 33 hashes. The membership path in the circuit is the ordinary
32-level path of a single leaf (pathIndices = bits of leafIndex); nothing in the circuit knows about groups.

**Root validity (§37–38).** `isKnownRoot(r)` ⇔ `r == currentRoot` or
(`rootKnown[r]` and `block.number − rootBlock[r] ≤ ROOT_HISTORY_BLOCKS`). Validity is measured in
blocks, never in a count of later insertions. Wallets SHOULD prove against a finalized root (§39) and
MUST track `(blockNumber, blockHash, parentHash, root, leafIndex)` off-chain to detect reorgs (§40).

---

## 10. Transaction circuit — `Transaction(32, 2, 3)` (*pinned*)

### 10.1 Signals
Public (order = §11):
```
root, nullifier[2], outputBody[3], mode, withdrawalVault, withdrawalAmount, withdrawalRecipient,
outDataHash[3], txDomain
```
Private:
```
inAmount[2], inVaultId[2], inOwnerKey[2], inNoteSecret[2], inLeafIndex[2],
inPathElements[2][32], inPathIndices[2][32], inIsReal[2],
outAmount[3], outVaultId[3], outOwnerCommitment[3], outNoteSecret[3]
```

### 10.2 Constraints (every one; `i ∈ {0,1}` inputs, `k ∈ {0,1,2}` outputs)
```
C1  anti-tamper binding of otherwise-unused public signals: withdrawalRecipient², txDomain², outDataHash[k]²
C2  inIsReal[0] == 1 ;  inIsReal[i] ∈ {0,1} ;  mode ∈ {0,1}
C3  inAmount[i] < 2^248 ; outAmount[k] < 2^248 ; withdrawalAmount < 2^248      (Num2Bits(248))
C4  ownerCommitment_i = H(DOM(OWNER_COMMITMENT), inOwnerKey[i])                  (owner binding, PP-C01)
C5  body_i = H(DOM(NOTE_BODY), inVaultId[i], inAmount[i], ownerCommitment_i, inNoteSecret[i])
    cm_i   = H(DOM(NOTE_COMMITMENT), body_i, inLeafIndex[i])
C6  (MerkleRoot(cm_i, inPathElements[i], inPathIndices[i]) − root) · inIsReal[i] == 0   (membership, real only)
    inPathIndices[i][j] ∈ {0,1}
C7  asset = inVaultId[0] ;  (inVaultId[i] − asset) · inIsReal[i] == 0
C8  nullifier[0] == H(DOM(NULLIFIER), cm_0, inOwnerKey[0])
    nullifier[1] == isReal_1 · H(DOM(NULLIFIER), cm_1, inOwnerKey[1])
                  + (1 − isReal_1) · H(DOM(PHANTOM_NULLIFIER), nullifier[0], 1, inOwnerKey[0])
C9  nullifier[0] ≠ nullifier[1]                                     ((n0 − n1) · inv == 1, PP-C03)
C10 outputBody[k] == H(DOM(NOTE_BODY), outVaultId[k], outAmount[k], outOwnerCommitment[k], outNoteSecret[k])
C11 outVaultId[k] == asset                                           (asset conservation, §21)
C12 (1 − mode) · withdrawalAmount == 0 ;  mode · (withdrawalVault − asset) == 0
C13 Σ_i inAmount[i]·inIsReal[i] == Σ_k outAmount[k] + withdrawalAmount    (value conservation, §20)
```
Nothing else is constrained; in particular the circuit does not know `leafIndex` of outputs (the contract
adds it, §5.2) and does not constrain `withdrawalRecipient` beyond binding it.

---

## 11. Verifier and public-input order (*pinned*)

`IProofVerifier.verify(uint256[] publicInputs, bytes proof) → bool`, `publicInputs.length == 14`:

```
 0 root            1 nullifier0        2 nullifier1
 3 outputBody0     4 outputBody1       5 outputBody2
 6 mode            7 withdrawalVault   8 withdrawalAmount   9 withdrawalRecipient
10 noteData0Hash  11 noteData1Hash    12 noteData2Hash
13 txDomain
```
Groth16/BN254 (V1 baseline): `proof = abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c)` as
produced by snarkjs `exportSolidityCallData` (G2 limbs EVM-ordered). The adapter `Groth16Verifier`
wraps an **immutable** snarkjs-generated verifier; it reverts on a wrong input count and returns `false`
on any invalid or malformed proof. The proof system remains pluggable behind the interface (§41–42); a
different system changes only the adapter and the `proof` encoding, never this order.

`txDomain` (§45): `uint256(keccak256(abi.encode(keccak256("privacy-protocol/v1/domain/TX_DOMAIN"),
PROTOCOL_ID, block.chainid, address(core), CIRCUIT_ID))) mod p`, computed once in the core constructor
and required to equal public input 13. A proof is therefore bound to one chain, one core, one circuit.

---

## 12. Output payload — fixed size (§56–57), *pinned*

`NOTE_DATA_BYTES = 169`. Layout (the core checks only the length; wallets MUST produce exactly this):
```
offset  size  field
0       1     version = 0x01
1       32    ephemeral public key (X25519)
33      24    nonce (XChaCha20-Poly1305)
57      96    ciphertext of: amount (32) ‖ noteSecret (32) ‖ vaultId (32, left-padded address)
153     16    Poly1305 tag
```
Encryption to the recipient's `viewKey`-derived X25519 public key is a wallet concern; the core never
parses it (the reference binding and the `pp1…` privacy address are in `crypto-spec.md`, "Output
payload envelope"). Dummy outputs carry 169 uniformly random bytes. Binding (§5 of the plan, "OUTPUT_DOMAIN"):
```
noteDataHash_k = uint256(keccak256("privacy-protocol/v1/domain/OUTPUT_BINDING" ‖ noteData_k)) mod p
```
and the proof commits to `noteDataHash_k`, so a relayer cannot swap payloads after proving.

---

## 13. `PrivacyCore` — storage, functions, state transitions

### 13.1 Storage layout (declaration order; no proxy, so slots are informational)
```
MerkleAccumulator: nextLeafIndex (uint32), currentRoot (bytes32), _filledSubtrees (mapping), _zeros (mapping),
                   rootKnown (mapping), rootBlock (mapping), rootHistory (bytes32[])
ReentrancyGuard:   _status (uint256)
PrivacyCore:       spentNullifier (mapping uint256 → bool)
immutables:        VERIFIER, VAULT_FACTORY, HASHER, LEVELS, TX_DOMAIN, EXECUTION_CHAIN_ID
constants:         PROTOCOL_ID, CIRCUIT_ID, HASH_ID, VAULT_VERSION, NOTE_DATA_BYTES, ROOT_HISTORY_BLOCKS
```
There is **no** owner, pauser, upgrader, rescuer, fee setter, relayer list or any function that moves
assets. The core's ETH and ERC-20 balances are 0 forever (Invariants 1–2).

### 13.2 `transact(proof, PublicInputs pi, noteData0, noteData1, noteData2)` — exact order
```
 1  requireField on root, nullifiers, outputBodies, noteData hashes; mode ∈ {0,1}        InvalidField / InvalidMode
 2  pi.txDomain == TX_DOMAIN                                                               InvalidTxDomain
 3  noteData_k.length == NOTE_DATA_BYTES ; noteDataHash_k == binding(noteData_k)           MalformedNoteData(k) / UnboundNoteData(k)
 4  isKnownRoot(root)                                                                      UnknownRoot
 5  nullifier0 != nullifier1 ; neither spent                                               DuplicateNullifier / SpentNullifier(n)
 6  VERIFIER.verify(encodePublicInputs(pi), proof) == true                                 InvalidProof
 7  mode == WITHDRAW: requireAddress(vault, recipient); requireAmount(amount); amount > 0;
                      recipient ∉ { 0, vault, core }                                       InvalidRecipient (the fifth review round, 2026-11-03)
                      factory.isCanonical(vault)                                           InvalidAddress / ZeroWithdrawal / InvalidVault
    mode == TRANSFER: vault == 0 && amount == 0 && recipient == 0                          TransferMustCarryNoWithdrawal
 8  EFFECTS: spentNullifier[n0] = spentNullifier[n1] = true
             c_k = H(DOM(NOTE_COMMITMENT), outputBody_k, nextLeafIndex + k)  for k = 0..2
             _insertGroup([c0, c1, c2, ZERO_LEAF]);  emit NoteInserted(idx_k, c_k, noteData_k) ×3
             emit ShieldedTransaction(n0, n1, c0, c1, c2)
 9  INTERACTION (WITHDRAW only): IAssetVault(vault).release(recipient, amount)             (never reverts the tx, §8.3)
```
`nonReentrant`. Nothing after step 8 can undo steps 8's writes.

### 13.3 Events (§53–54), minimal
```
NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData)
ShieldedTransaction(uint256 nullifier0, uint256 nullifier1, uint256 commitment0, uint256 commitment1, uint256 commitment2)
Vault: Deposited(bytes32 indexed ownerCommitment, uint256 amount, uint32 leafIndex), Released, WithdrawalClaimCreated, Claimed
Factory: VaultDeployed(address indexed asset, address vault)
```
Never emitted: private amounts, recipients, owners, secrets, relayer identity.

---

## 14. ABI (freeze set, §81)

```solidity
interface IPrivacyCore {
    function commitDeposit(uint256 ownerCommitment, uint256 noteSecret, uint256 amount, bytes calldata noteData) external returns (uint32 leafIndex);
    function transact(bytes calldata proof, PublicInputs calldata pi, bytes calldata noteData0, bytes calldata noteData1, bytes calldata noteData2) external;
    function encodePublicInputs(PublicInputs calldata pi) external pure returns (uint256[] memory);
    function isKnownRoot(bytes32 root) external view returns (bool);
    function isNullifierSpent(uint256 nullifier) external view returns (bool);
    function currentRoot() external view returns (bytes32);
    function nextLeafIndex() external view returns (uint32);
    function VERIFIER() / VAULT_FACTORY() / HASHER() / TX_DOMAIN() / LEVELS() / PROTOCOL_ID() / CIRCUIT_ID() / HASH_ID()
}
struct PublicInputs { uint256 root; uint256 nullifier0; uint256 nullifier1; uint256 outputBody0; uint256 outputBody1; uint256 outputBody2;
                      uint256 mode; uint256 withdrawalVault; uint256 withdrawalAmount; uint256 withdrawalRecipient;
                      uint256 noteData0Hash; uint256 noteData1Hash; uint256 noteData2Hash; uint256 txDomain; }

interface IAssetVault {
    function asset() external view returns (address);          // address(0) for ETH
    function core() external view returns (address);
    function vaultId() external view returns (uint256);
    function accountedDeposits() / totalClaimable() / claimable(address) / actualAssetBalance() / isSolvent()
    function release(address recipient, uint256 amount) external;   // onlyCore
    function claim(address recipient) external;
}
NativeAssetVault.deposit(uint256 ownerCommitment, uint256 noteSecret, bytes noteData) payable returns (uint32)
ERC20AssetVault.deposit(uint256 amount, uint256 ownerCommitment, uint256 noteSecret, bytes noteData) returns (uint32)

interface IAssetVaultFactory {
    function CORE() external view returns (address);
    function vaultOf(address asset) external view returns (address);
    function isCanonical(address vault) external view returns (bool);
    function getOrCreateNativeVault() external returns (address);
    function getOrCreateERC20Vault(address token) external returns (address);
    function predictNativeVault() / predictERC20Vault(address token) external view returns (address);
}
interface IProofVerifier { function verify(uint256[] calldata publicInputs, bytes calldata proof) external view returns (bool); }
interface IHasher        { function poseidon2(uint256[] memory input) external pure returns (uint256); }
```

**Errors (§86), custom, deterministic meaning:**
```
Core:    InvalidField(), InvalidAddress(), InvalidAmount(), InvalidMode(), InvalidTxDomain(), MalformedNoteData(uint8),
         UnboundNoteData(uint8), UnknownRoot(), DuplicateNullifier(), SpentNullifier(uint256), InvalidProof(),
         InvalidVault(), ZeroWithdrawal(), InvalidRecipient(), TransferMustCarryNoWithdrawal(), CallerNotCanonicalVault(), VerifierNotContract()
Tree:    LevelsOutOfRange(), TreeFull(), ValueOutOfField()
Vault:   CallerNotCore(), ZeroAmount(), ZeroCore(), ZeroToken(), Undercollateralized(), NothingToClaim(),
         ClaimTransferFailed(), TokenTransferFailed(), UnsupportedTokenBehavior()
Factory: VaultExists(), ZeroToken(), ZeroCore()
Hasher:  InputNotInField(), UnsupportedArity()
Verifier adapter: BadPublicInputCount(), InnerNotContract()
```
After audit, any change to this section is a new protocol version, never an in-place update.

---

## 15. Protocol state machine (§85) and failure states (§86)

```
Note:  EMPTY ─deposit/transact output→ UNSPENT ─transact (nullifier consumed)→ SPENT
Value: SHIELDED (accountedDeposits) ─release ok→ SETTLED
                                    ─release fails→ CLAIMABLE ─claim ok→ SETTLED   (claim fails → CLAIMABLE)
```
Invalid transitions (all fail closed, never fall back): spending a note twice (`SpentNullifier`); proving
against a root outside the window (`UnknownRoot`); any proof failure (`InvalidProof`); an exit through a
non-canonical or foreign-asset vault (`InvalidVault`, and asset conservation in-circuit); creating value
(`C13`); a payload swap (`UnboundNoteData`); a replay on another chain/core (`InvalidTxDomain`).

---

## 16. Security invariants (Foundry, §70–71) — see `security-invariants.md` for the test map
```
Inv 1  core ETH balance == 0            Inv 2  core ERC-20 balance == 0 (every token)
Inv 3  one note → one nullifier         Inv 4  spent nullifier cannot be reused
Inv 5  invalid proof cannot change state Inv 6  invalid root cannot change state
Inv 7  vault A cannot release asset B   Inv 8  non-canonical vault cannot be used
Inv 9  unsupported token behaviour cannot corrupt accounting
Inv 10 no privileged state transition exists (no DELEGATECALL/CALLCODE/SELFDESTRUCT/CREATE in runtime code; no admin selector)
Issuer isolation: Blacklist(vault_X) changes no state of any other vault, the tree, or the nullifier set;
                  a failed vault_X transfer creates no deficit in any other vault.
Vault solvency:   actualBalance ≥ accountedDeposits + totalClaimable, for every vault, always.
```

---

## 17. Test matrix (§83–84 and plan §70–78)
| Area | Where |
|---|---|
| Poseidon2 known answers (10) in circom / Solidity ×2 / TS / Python | `circuits/test/kat.mjs`, `contracts/test/hasher`, `reference/*/test` |
| Protocol vectors (owner commitment, body, commitment, nullifier, phantom, roots) in all layers | `circuits/vectors/primitives.json` |
| Circuit soundness (honest sat; each attack unsat at its constraint) | `circuits/test/witness.mjs` |
| Proof binding of all 14 inputs, no replay, malformed | `circuits/test/prove.mjs`, `contracts/test/verifier` |
| End to end, nothing mocked (shield → private withdraw; relayer fee note spent) | `contracts/test/e2e` |
| Deposit zoo: standard / fee / rebase / blacklist / pause / reentrant / false-return / no-return / malformed / burn | `contracts/test/vault`, `adversarial` |
| Issuer isolation across ETH + two ERC-20 vaults | `contracts/test/issuer-risk` |
| Reentrancy (release→token→release; recipient→claim) | `contracts/test/adversarial` |
| Reorg / root window; root stress 10…10⁴ (forge), 10⁵ + reorg (TS) | `contracts/test/reorg`, `packages/protocol/test` |
| No privileged path (bytecode + ABI scan) | `contracts/test/invariants/NoPrivilege.t.sol` |
| Stateful fuzz invariants (core holds nothing; solvency) | `contracts/test/invariants` |

---

## 18. Deployment (§88) and reproducibility (§80)

Build settings (*pinned* in `contracts/foundry.toml`): solc 0.8.24, optimizer on, 200 runs, EVM `paris`,
`via_ir = false`, `bytecode_hash = "none"`, `cbor_metadata = false`. The deployed runtime code MUST be
reproducible byte-for-byte from the published source + these settings.

```
Deployment 1 (ETH first, §23):  Groth16 inner verifier (from the ceremony) → Groth16Verifier adapter
                                → Poseidon2Hasher → PrivacyCore(verifier, hasher, 32)  [deploys the factory]
                                → factory.getOrCreateNativeVault()
Deployment 2 (V1.1):            factory.getOrCreateERC20Vault(USDC), (USDT)
```
Publish: source, compiler config, ABI, addresses, `DEPTH`/`ROOT_HISTORY_BLOCKS`/`ZERO_LEAF`, `HASH_ID`,
`CIRCUIT_ID`, circuit hash (`sha256(transaction.r1cs)`), verification key (+ sha256), setup transcript,
build hash of the deployed bytecode. The dev setup in this repo (`circuits/scripts/dev-setup.sh`) is
insecure by design and MUST NOT be deployed.

## 19. Upgrade policy (§89)
None. A bug means V2 is deployed separately; migration is a user action with a new wallet flow.
