"""Poseidon2 over the BN254 scalar field, t = 4, with the Noir/barretenberg sponge (spec §2).

Written from the specification (not ported from the TypeScript) so that it is an independent
differential implementation; only the round constants are shared (poseidon2_constants.py, generated).
Pure Python, no dependencies. Checked against the nargo vectors in test_vectors.py.
"""

from poseidon2_constants import D, RC

P = 21888242871839275222246405745257275088548364400416034343698204186575808495617
T = 4
RATE = 3
R_F = 8  # full rounds, 4 before and 4 after the partial rounds
R_P = 56  # partial rounds


def _pow5(x: int) -> int:
    return pow(x, 5, P)


def _external(s: list[int]) -> None:
    """Circulant M4 external matrix, as barretenberg's matmul_external computes it."""
    t0 = (s[0] + s[1]) % P
    t1 = (s[2] + s[3]) % P
    t2 = (2 * s[1] + t1) % P
    t3 = (2 * s[3] + t0) % P
    t4 = (4 * t1 + t3) % P
    t5 = (4 * t0 + t2) % P
    s[0] = (t3 + t5) % P
    s[1] = t5
    s[2] = (t2 + t4) % P
    s[3] = t4


def _internal(s: list[int]) -> None:
    """s[i] = D_i * s[i] + sum(s)  (D holds diagonal - 1), barretenberg's matmul_internal."""
    total = sum(s) % P
    for i in range(T):
        s[i] = (D[i] * s[i] + total) % P


def permute(state: list[int]) -> list[int]:
    if len(state) != T:
        raise ValueError("state width must be 4")
    s = [x % P for x in state]
    _external(s)
    for r in range(0, 4):
        for i in range(T):
            s[i] = _pow5((s[i] + RC[r * T + i]) % P)
        _external(s)
    for r in range(4, 4 + R_P):
        s[0] = _pow5((s[0] + RC[r * T]) % P)
        _internal(s)
    for r in range(4 + R_P, 8 + R_P):
        for i in range(T):
            s[i] = _pow5((s[i] + RC[r * T + i]) % P)
        _external(s)
    return s


def hash(inputs: list[int]) -> int:
    """Noir sponge: state = [0,0,0, n * 2^64]; absorb in chunks of RATE, permuting when a chunk is
    full and another element arrives; squeeze = add the remaining cache, permute, return state[0]."""
    n = len(inputs)
    if n == 0:
        raise ValueError("empty input")
    state = [0, 0, 0, (n << 64) % P]
    cache: list[int] = []
    for x in inputs:
        if len(cache) == RATE:
            for j in range(RATE):
                state[j] = (state[j] + cache[j]) % P
            state = permute(state)
            cache = []
        cache.append(x % P)
    for j, c in enumerate(cache):
        state[j] = (state[j] + c) % P
    state = permute(state)
    return state[0]
