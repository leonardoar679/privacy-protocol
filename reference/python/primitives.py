"""Protocol primitives from the specification (§3–§5, §9, §11–§12), on top of poseidon2.py."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha3_256  # NOT keccak; see keccak256 below

from poseidon2 import P, hash as H

# --- keccak-256 (Ethereum's pre-standard Keccak, NOT SHA3-256) ---------------------------------
try:  # pycryptodome, if present
    from Crypto.Hash import keccak as _keccak  # type: ignore

    def keccak256(b: bytes) -> bytes:
        return _keccak.new(digest_bits=256, data=b).digest()

except ImportError:  # minimal pure-Python Keccak-f[1600] sponge, pad 0x01 (Ethereum keccak)

    _RC = [
        0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
        0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
        0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
        0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
        0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
        0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    ]
    _ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
    _M = (1 << 64) - 1

    def _f1600(a: list[list[int]]) -> None:
        for rc in _RC:
            c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
            d = [c[(x - 1) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & _M) for x in range(5)]
            for x in range(5):
                for y in range(5):
                    a[x][y] ^= d[x]
            b = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    r = _ROT[x][y]
                    b[y][(2 * x + 3 * y) % 5] = ((a[x][y] << r) | (a[x][y] >> (64 - r))) & _M if r else a[x][y]
            for x in range(5):
                for y in range(5):
                    a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
            a[0][0] ^= rc

    def keccak256(b: bytes) -> bytes:
        rate = 136
        msg = bytearray(b) + b"\x01"
        msg += b"\x00" * ((-len(msg)) % rate)
        msg[-1] |= 0x80
        a = [[0] * 5 for _ in range(5)]
        for off in range(0, len(msg), rate):
            for i in range(rate // 8):
                lane = int.from_bytes(msg[off + 8 * i : off + 8 * i + 8], "little")
                a[i % 5][i // 5] ^= lane
            _f1600(a)
        out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
        return out


def _dom(tag: str) -> int:
    return int.from_bytes(keccak256(f"privacy-protocol/v1/domain/{tag}".encode()), "big") % P


NOTE_BODY = _dom("NOTE_BODY")
NOTE_COMMITMENT = _dom("NOTE_COMMITMENT")
OWNER_COMMITMENT = _dom("OWNER_COMMITMENT")
NULLIFIER = _dom("NULLIFIER")
PHANTOM_NULLIFIER = _dom("PHANTOM_NULLIFIER")
OUTPUT_BINDING_TAG = b"privacy-protocol/v1/domain/OUTPUT_BINDING"
TX_DOMAIN_TAG = keccak256(b"privacy-protocol/v1/domain/TX_DOMAIN")
PROTOCOL_ID = keccak256(b"privacy-protocol/v1.0")
CIRCUIT_ID = keccak256(b"privacy-protocol/v1/circuit/transaction-2in3out-depth32-poseidon2")
ZERO_LEAF = int.from_bytes(keccak256(b"privacy-protocol/v1/empty-leaf"), "big") % P
NOTE_DATA_BYTES = 169
GROUP_SIZE = 4


# --- keys (§4) -------------------------------------------------------------------------------------
def derive_keys(seed: bytes) -> dict[str, int]:
    f = lambda label: int.from_bytes(keccak256(seed + label.encode()), "big") % P
    return {"spendKey": f("/spend"), "viewKey": f("/view"), "noteKey": f("/note")}


def derive_note_secret(note_key: int, counter: int) -> int:
    return int.from_bytes(keccak256(note_key.to_bytes(32, "big") + counter.to_bytes(8, "big")), "big") % P


def owner_commitment(spend_key: int) -> int:
    return H([OWNER_COMMITMENT, spend_key])


# --- notes (§5) ------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Note:
    vault_id: int
    amount: int
    owner_commitment: int
    note_secret: int


def note_body(n: Note) -> int:
    return H([NOTE_BODY, n.vault_id, n.amount, n.owner_commitment, n.note_secret])


def note_commitment(body: int, leaf_index: int) -> int:
    return H([NOTE_COMMITMENT, body, leaf_index])


def nullifier(commitment: int, spend_key: int) -> int:
    return H([NULLIFIER, commitment, spend_key])


def phantom_nullifier(nullifier0: int, input_index: int, spend_key0: int) -> int:
    return H([PHANTOM_NULLIFIER, nullifier0, input_index, spend_key0])


# --- payload binding and chain binding (§11–§12) ------------------------------------------------------
def note_data_hash(note_data: bytes) -> int:
    if len(note_data) != NOTE_DATA_BYTES:
        raise ValueError("noteData must be 169 bytes")
    return int.from_bytes(keccak256(OUTPUT_BINDING_TAG + note_data), "big") % P


def tx_domain(chain_id: int, core: int) -> int:
    words = [int.from_bytes(TX_DOMAIN_TAG, "big"), int.from_bytes(PROTOCOL_ID, "big"), chain_id, core, int.from_bytes(CIRCUIT_ID, "big")]
    pre = b"".join(w.to_bytes(32, "big") for w in words)
    return int.from_bytes(keccak256(pre), "big") % P


# --- Merkle accumulator with 4-aligned groups (§9) ---------------------------------------------------
def zero_hashes(levels: int) -> list[int]:
    z = [ZERO_LEAF]
    for i in range(levels):
        z.append(H([z[i], z[i]]))
    return z


class MerkleTree:
    def __init__(self, levels: int):
        self.levels = levels
        self.zeros = zero_hashes(levels)
        self.filled = self.zeros[:levels]
        self.next_index = 0
        self.root = self.zeros[levels]
        self.leaves: list[int] = []

    def insert_leaf(self, leaf: int) -> int:
        return self.insert_group([leaf, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF])

    def insert_group(self, group: list[int]) -> int:
        assert len(group) == GROUP_SIZE
        first = self.next_index
        if first + GROUP_SIZE >= 2**self.levels:
            raise ValueError("tree full")
        h = H([H([group[0], group[1]]), H([group[2], group[3]])])
        cur = first // GROUP_SIZE
        for i in range(2, self.levels):
            if cur % 2 == 0:
                self.filled[i] = h
                h = H([h, self.zeros[i]])
            else:
                h = H([self.filled[i], h])
            cur //= 2
        self.root = h
        self.leaves.extend(group)
        self.next_index = first + GROUP_SIZE
        return first
