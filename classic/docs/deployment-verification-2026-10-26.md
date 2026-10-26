# The Classic deployment, verified on 2026-10-26

Ethereum mainnet (chain id 1), block 26,278,752, read through https://ethereum-rpc.publicnode.com and https://eth.drpc.org by `classic/scripts/verify-deployment.mjs --write` (spec v3.0 §7.2; V7 Stage 5). Every contract's runtime code was compared with its Sourcify record (`classic/contracts/verified/`) and rebuilt with the pinned compiler (`classic/scripts/compilers.mjs`), modulo the record's transformations: the linked `Hasher` library, the metadata hash, the router's immutables. The pins live in `classic/src/config/deployment.json`; `node scripts/verify-deployment.mjs` (and the live suite under `verify-all --live`) reads the chain again and fails on any drift.

## The checks

| Check | Result | Detail |
|---|---|---|
| chain | ✅ | chain id 1 at block 26278752 |
| eth-0.1: runtime code | ✅ | 6615 B, sha256 3bbc2652c41f0a13…; Sourcify match (0.5.11+commit.c082d0b4); recompiled matches modulo the transformations; rebuilt here with 0.5.11+commit.c082d0b4: matches; libraries {"TornadoCash_Eth_01.sol:Hasher":"0x83584f83f26af4edda9cbe8c730bc87c364b28fe"} |
| eth-1: runtime code | ✅ | 5191 B, sha256 57632dbb86b78ae0…; Sourcify match (0.5.11+commit.c082d0b4); recompiled matches modulo the transformations; rebuilt here with 0.5.11+commit.c082d0b4: matches; libraries {"TornadoCash_eth.sol:Hasher":"0x83584f83f26af4edda9cbe8c730bc87c364b28fe"} |
| eth-10: runtime code | ✅ | 5191 B, sha256 57632dbb86b78ae0…; Sourcify match (0.5.11+commit.c082d0b4); recompiled matches modulo the transformations; rebuilt here with 0.5.11+commit.c082d0b4: matches; libraries {"TornadoCash_eth.sol:Hasher":"0x83584f83f26af4edda9cbe8c730bc87c364b28fe"} |
| eth-100: runtime code | ✅ | 5191 B, sha256 57632dbb86b78ae0…; Sourcify match (0.5.11+commit.c082d0b4); recompiled matches modulo the transformations; rebuilt here with 0.5.11+commit.c082d0b4: matches; libraries {"TornadoCash_eth.sol:Hasher":"0x83584f83f26af4edda9cbe8c730bc87c364b28fe"} |
| verifier: runtime code | ✅ | 3781 B, sha256 ff815c35f6f160a3…; Sourcify match (0.5.17+commit.d19bba13); recompiled matches modulo the transformations; rebuilt here with 0.5.17+commit.d19bba13: matches |
| router: runtime code | ✅ | 5725 B, sha256 789e8e68ed03fea4…; Sourcify exact_match (0.6.12+commit.27d51765); recompiled matches modulo the transformations; rebuilt here with 0.6.12+commit.27d51765: matches |
| instanceRegistry: runtime code | ✅ | 1450 B, sha256 3a3419f6edf4d1ea…; Sourcify exact_match (0.6.12+commit.27d51765); recompiled matches modulo the transformations; rebuilt here with 0.6.12+commit.27d51765: matches |
| relayerRegistry: runtime code | ✅ | 1450 B, sha256 3a3419f6edf4d1ea…; Sourcify exact_match (0.6.12+commit.27d51765); recompiled matches modulo the transformations; rebuilt here with 0.6.12+commit.27d51765: matches |
| eth-0.1: verifier | ✅ | verifier() = 0xce172ce1f20ec0b3728c9965470eaf994a03557a |
| eth-0.1: levels | ✅ | levels() = 20 |
| eth-0.1: denomination | ✅ | denomination() = 100000000000000000 wei (0.1 ETH) |
| eth-0.1: operator | ✅ | operator() = 0x0000000000000000000000000000000000000000 (renounced: immutable) |
| eth-0.1: ROOT_HISTORY_SIZE | ✅ | ROOT_HISTORY_SIZE() = 100 |
| eth-0.1: deposits | ✅ | nextIndex() = 75197, last root 0x19a9bdf9701f9bd6… |
| eth-1: verifier | ✅ | verifier() = 0xce172ce1f20ec0b3728c9965470eaf994a03557a |
| eth-1: levels | ✅ | levels() = 20 |
| eth-1: denomination | ✅ | denomination() = 1000000000000000000 wei (1 ETH) |
| eth-1: operator | ✅ | operator() = 0x0000000000000000000000000000000000000000 (renounced: immutable) |
| eth-1: ROOT_HISTORY_SIZE | ✅ | ROOT_HISTORY_SIZE() = 100 |
| eth-1: deposits | ✅ | nextIndex() = 96466, last root 0x18614cdefd82ef49… |
| eth-10: verifier | ✅ | verifier() = 0xce172ce1f20ec0b3728c9965470eaf994a03557a |
| eth-10: levels | ✅ | levels() = 20 |
| eth-10: denomination | ✅ | denomination() = 10000000000000000000 wei (10 ETH) |
| eth-10: operator | ✅ | operator() = 0x0000000000000000000000000000000000000000 (renounced: immutable) |
| eth-10: ROOT_HISTORY_SIZE | ✅ | ROOT_HISTORY_SIZE() = 100 |
| eth-10: deposits | ✅ | nextIndex() = 78822, last root 0x25b250cdb12dce89… |
| eth-100: verifier | ✅ | verifier() = 0xce172ce1f20ec0b3728c9965470eaf994a03557a |
| eth-100: levels | ✅ | levels() = 20 |
| eth-100: denomination | ✅ | denomination() = 100000000000000000000 wei (100 ETH) |
| eth-100: operator | ✅ | operator() = 0x0000000000000000000000000000000000000000 (renounced: immutable) |
| eth-100: ROOT_HISTORY_SIZE | ✅ | ROOT_HISTORY_SIZE() = 100 |
| eth-100: deposits | ✅ | nextIndex() = 49627, last root 0x2401674a92196d5d… |
| router: registries | ✅ | governance 0x5efda50f22d34f262c29268506c5fa42cb56a1ce; instanceRegistry 0xb20c66c4de72433f3ce747b58b86830c459ca911; relayerRegistry 0x58e8dcc13be9780fc42e8723d8ead4cf46943df2 |
| instanceRegistry: proxy | ✅ | implementation 0x2573bac39ebe2901b4389cd468f2872cf7767faf (5935 B, sha256 9aa6800371c73df5…), admin 0x5efda50f22d34f262c29268506c5fa42cb56a1ce = governance |
| relayerRegistry: proxy | ✅ | implementation 0x84b0c75c1f6211450fec7289c32d717adadd702a (17426 B, sha256 fa899d231b5819c7…), admin 0x5efda50f22d34f262c29268506c5fa42cb56a1ce = governance |
| eth-0.1: instance | ✅ | ENABLED, ETH, protocol fee 0 (×0.01 %) |
| eth-1: instance | ✅ | ENABLED, ETH, protocol fee 30 (×0.01 %) |
| eth-10: instance | ✅ | ENABLED, ETH, protocol fee 30 (×0.01 %) |
| eth-100: instance | ✅ | ENABLED, ETH, protocol fee 30 (×0.01 %) |
| verifier: key | ✅ | 6 public inputs, 7 IC points from Verifier.sol |

## The pools

| Pool | Address | Runtime code (sha256, bytes) | Source | Deployed | Verifier | levels | denomination (wei) | operator | ROOT_HISTORY_SIZE | Deposits | Hasher |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.1 ETH | `0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc` | `3bbc2652c41f0a13289cac4d503b27595c017b8d3c780424610c6feec6eb7dfe`, 6615 | TornadoCash_Eth_01 (solc 0.5.11+commit.c082d0b4; Sourcify match) | 9,116,966 | `0xce172ce1f20ec0b3728c9965470eaf994a03557a` | 20 | 100000000000000000 | `0x0000000000000000000000000000000000000000` | 100 | 75,197 | `0x83584f83f26af4edda9cbe8c730bc87c364b28fe` |
| 1 ETH | `0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936` | `57632dbb86b78ae0bd84ff480d359a2422945e6df83c3b04511a0ed22e9456dd`, 5191 | TornadoCash_eth (solc 0.5.11+commit.c082d0b4; Sourcify match) | 9,117,609 | `0xce172ce1f20ec0b3728c9965470eaf994a03557a` | 20 | 1000000000000000000 | `0x0000000000000000000000000000000000000000` | 100 | 96,466 | `0x83584f83f26af4edda9cbe8c730bc87c364b28fe` |
| 10 ETH | `0x910cbd523d972eb0a6f4cae4618ad62622b39dbf` | `57632dbb86b78ae0bd84ff480d359a2422945e6df83c3b04511a0ed22e9456dd`, 5191 | TornadoCash_eth (solc 0.5.11+commit.c082d0b4; Sourcify match) | 9,117,720 | `0xce172ce1f20ec0b3728c9965470eaf994a03557a` | 20 | 10000000000000000000 | `0x0000000000000000000000000000000000000000` | 100 | 78,822 | `0x83584f83f26af4edda9cbe8c730bc87c364b28fe` |
| 100 ETH | `0xa160cdab225685da1d56aa342ad8841c3b53f291` | `57632dbb86b78ae0bd84ff480d359a2422945e6df83c3b04511a0ed22e9456dd`, 5191 | TornadoCash_eth (solc 0.5.11+commit.c082d0b4; Sourcify match) | 9,161,895 | `0xce172ce1f20ec0b3728c9965470eaf994a03557a` | 20 | 100000000000000000000 | `0x0000000000000000000000000000000000000000` | 100 | 49,627 | `0x83584f83f26af4edda9cbe8c730bc87c364b28fe` |

## The verifier, the router and the registries

- The shared verifier `0xce172ce1f20ec0b3728c9965470eaf994a03557a`: Verifier, solc 0.5.17+commit.d19bba13, runtime sha256 `ff815c35f6f160a3e86d72a13a922c732b1be9306a53c200c37ce64b2e80811f` (3781 B), deployed at block 10,050,743 — after the pools, which point at it: the pools' verifier was updated to this one while the operator still existed, and the operator was then renounced. Its key has 6 public inputs (root, nullifierHash, recipient, relayer, fee, refund); the constants are in the pins (`verifier.vk`).
- The router `0xd90e2f925da726b50c4ed8d0fb90ad053324f31b`: TornadoRouter, solc 0.6.12+commit.27d51765 (Sourcify exact_match), deployed at block 14,173,127; governance `0x5efda50f22d34f262c29268506c5fa42cb56a1ce`; instanceRegistry `0xb20c66c4de72433f3ce747b58b86830c459ca911`; relayerRegistry `0x58e8dcc13be9780fc42e8723d8ead4cf46943df2`.
- The instance registry `0xb20c66c4de72433f3ce747b58b86830c459ca911`: an AdminUpgradeableProxy (solc 0.6.12+commit.27d51765) whose implementation is `0x2573bac39ebe2901b4389cd468f2872cf7767faf` (5935 B, sha256 `9aa6800371c73df597f4d8274ccf286214a8a6909c2a4c8fc8cb273755321dc4`) and whose admin is `0x5efda50f22d34f262c29268506c5fa42cb56a1ce` (governance): upgradeable, unlike the pools — the availability model reports it apart (spec §7.7).
- The relayer registry `0x58e8dcc13be9780fc42e8723d8ead4cf46943df2`: an AdminUpgradeableProxy (solc 0.6.12+commit.27d51765) whose implementation is `0x84b0c75c1f6211450fec7289c32d717adadd702a` (17426 B, sha256 `fa899d231b5819c75454f156538429bac53761d72f3da01191fffdf1bfaf7e63`) and whose admin is `0x5efda50f22d34f262c29268506c5fa42cb56a1ce` (governance): upgradeable, unlike the pools — the availability model reports it apart (spec §7.7).

| Pool | Instance state | ERC-20 | Protocol fee (×0.01 %) |
|---|---|---|---|
| 0.1 ETH | ENABLED | no | 0 |
| 1 ETH | ENABLED | no | 30 |
| 10 ETH | ENABLED | no | 30 |
| 100 ETH | ENABLED | no | 30 |

## The compilers

| solc | Build | sha256 |
|---|---|---|
| 0.5.11+commit.c082d0b4 | soljson-v0.5.11+commit.c082d0b4.js | `b6012fb777a7f842a6e7efe8c50cb2eba3b3997c72b761810823e796d4390d44` |
| 0.5.17+commit.d19bba13 | soljson-v0.5.17+commit.d19bba13.js | `dac1bc7560247d3e69bce9891f7eb2218a6a8d0106d9cdb4de8e03ede4546153` |
| 0.6.12+commit.27d51765 | soljson-v0.6.12+commit.27d51765.js | `3e1956c550ca48e289044c7c0bd892403081b4b5e17e77ce707c815ce6c4228f` |

The builds are downloaded from binaries.soliditylang.org into `classic/contracts/verified/compilers/` (git-ignored) and refused unless they hash to these pins.
