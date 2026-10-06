# Mobile benchmarks (pending — Stage 12/15)

Measure client-side proving on real consumer hardware (Android mid-range/flagship, iPhone-class):
proof-generation time, peak memory, and Merkle-sync time (§115, §51). The protocol is designed
around consumer hardware, not server benchmarks; delegated proving (if added) must be
privacy-preserving (MPC/FHE/TEE), never raw-secret-to-server (§95).
