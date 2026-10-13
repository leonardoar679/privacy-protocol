# Campaign lab — tranches, time, gas and faults (High-Value Protection spec §18)

Measured quotes: `benchmarks/whale/execution.json` (ETH $2568, BTC $83279, SOL $117, USDC $1); the reducer of `packages/protocol/src/wallet/campaign.ts` against a simulated clock; gates per class with the finality margins (BTC 60 min, SOL 1 min, EVM 15 min); the user reassesses a pause after 10 min; a failed step comes back at its refund window (quote TTL 10 min + the 2 h execution window). Gas in USD at the price fetched when this ran: 0.173 gwei, ETH $2558 (never a constant).

## Campaigns

| size | route | provider | mode | sizing | class | gate | tranches | tranche USD | cap | wall time | gas (M) | gas USD | pauses | invariants |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| $1,000,000 | ETH>BTC | thorchain | balanced | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 171.0 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>BTC | thorchain | balanced | varied | R5 | destination-final | 70 | $10,272–$24,171 | $25,000 | 141.2 h | 255 | $113 | 0 | held |
| $1,000,000 | ETH>BTC | thorchain | max-privacy | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 332.8 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>BTC | thorchain | max-safety | varied | R5 | destination-final | 71 | $10,272–$17,976 | $20,000 | 132.9 h | 258 | $115 | 0 | held |
| $2,000,000 | ETH>BTC | thorchain | balanced | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 172.1 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>BTC | thorchain | balanced | varied | R5 | destination-final | 65 | $14,959–$38,520 | $50,000 | 139.0 h | 237 | $105 | 0 | held |
| $2,000,000 | ETH>BTC | thorchain | max-privacy | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 345.0 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>BTC | thorchain | max-safety | varied | R5 | destination-final | 65 | $20,095–$38,520 | $40,000 | 118.5 h | 237 | $105 | 0 | held |
| $5,000,000 | ETH>BTC | thorchain | balanced | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 207.9 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>BTC | thorchain | balanced | varied | R5 | destination-final | 78 | $51,359–$82,337 | $100,000 | 168.7 h | 284 | $126 | 0 | held |
| $5,000,000 | ETH>BTC | thorchain | max-privacy | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 441.1 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>BTC | thorchain | max-safety | varied | R5 | destination-final | 80 | $51,359–$77,039 | $100,000 | 152.2 h | 291 | $129 | 0 | held |
| $10,000,000 | ETH>BTC | thorchain | balanced | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 166.4 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>BTC | thorchain | balanced | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 166.6 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>BTC | thorchain | max-privacy | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 362.9 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>BTC | thorchain | max-safety | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 146.1 h | 284 | $126 | 0 | held |
| $25,000,000 | ETH>BTC | thorchain | balanced | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 206.6 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>BTC | thorchain | balanced | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 206.9 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>BTC | thorchain | max-privacy | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 461.6 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>BTC | thorchain | max-safety | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 185.2 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>BTC | thorchain | balanced | bucket | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 212.0 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>BTC | thorchain | balanced | varied | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 215.1 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>BTC | thorchain | max-privacy | bucket | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 439.1 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>BTC | thorchain | max-safety | varied | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 185.5 h | 353 | $157 | 0 | held |
| $1,000,000 | ETH>BTC | chainflip | balanced | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 157.7 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>BTC | chainflip | balanced | varied | R5 | destination-final | 70 | $10,272–$17,976 | $25,000 | 142.7 h | 255 | $113 | 0 | held |
| $1,000,000 | ETH>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 349.4 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>BTC | chainflip | max-safety | varied | R5 | destination-final | 72 | $10,272–$17,976 | $20,000 | 124.7 h | 262 | $116 | 0 | held |
| $2,000,000 | ETH>BTC | chainflip | balanced | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 158.5 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>BTC | chainflip | balanced | varied | R5 | destination-final | 63 | $25,680–$38,520 | $50,000 | 128.8 h | 229 | $102 | 0 | held |
| $2,000,000 | ETH>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 340.3 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>BTC | chainflip | max-safety | varied | R5 | destination-final | 66 | $14,959–$38,520 | $40,000 | 114.6 h | 240 | $107 | 0 | held |
| $5,000,000 | ETH>BTC | chainflip | balanced | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 191.0 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>BTC | chainflip | balanced | varied | R5 | destination-final | 80 | $51,359–$87,473 | $100,000 | 156.4 h | 291 | $129 | 0 | held |
| $5,000,000 | ETH>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 424.6 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>BTC | chainflip | max-safety | varied | R5 | destination-final | 80 | $51,359–$92,609 | $100,000 | 141.0 h | 291 | $129 | 0 | held |
| $10,000,000 | ETH>BTC | chainflip | balanced | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 160.4 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>BTC | chainflip | balanced | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 156.3 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 333.5 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>BTC | chainflip | max-safety | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 136.7 h | 284 | $126 | 0 | held |
| $25,000,000 | ETH>BTC | chainflip | balanced | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 197.2 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>BTC | chainflip | balanced | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 189.8 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 436.9 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>BTC | chainflip | max-safety | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 173.6 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>BTC | chainflip | balanced | bucket | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 195.6 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>BTC | chainflip | balanced | varied | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 206.7 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 393.8 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>BTC | chainflip | max-safety | varied | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 176.5 h | 353 | $157 | 0 | held |
| $1,000,000 | ETH>SOL | mayan | balanced | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 74.9 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>SOL | mayan | balanced | varied | R5 | destination-final | 71 | $10,272–$19,035 | $25,000 | 66.1 h | 258 | $115 | 0 | held |
| $1,000,000 | ETH>SOL | mayan | max-privacy | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 255.3 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>SOL | mayan | max-safety | varied | R5 | destination-final | 72 | $10,272–$17,976 | $20,000 | 46.1 h | 262 | $116 | 0 | held |
| $2,000,000 | ETH>SOL | mayan | balanced | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 68.4 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>SOL | mayan | balanced | varied | R5 | destination-final | 65 | $25,680–$38,520 | $50,000 | 54.3 h | 237 | $105 | 0 | held |
| $2,000,000 | ETH>SOL | mayan | max-privacy | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 269.8 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>SOL | mayan | max-safety | varied | R5 | destination-final | 65 | $25,680–$38,520 | $40,000 | 39.8 h | 237 | $105 | 0 | held |
| $5,000,000 | ETH>SOL | mayan | balanced | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 81.6 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>SOL | mayan | balanced | varied | R5 | destination-final | 80 | $51,359–$87,473 | $100,000 | 72.8 h | 291 | $129 | 0 | held |
| $5,000,000 | ETH>SOL | mayan | max-privacy | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 292.7 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>SOL | mayan | max-safety | varied | R5 | destination-final | 82 | $48,954–$77,039 | $100,000 | 50.9 h | 298 | $132 | 0 | held |
| $10,000,000 | ETH>SOL | mayan | balanced | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 68.7 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>SOL | mayan | balanced | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 70.5 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>SOL | mayan | max-privacy | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 244.4 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>SOL | mayan | max-safety | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 52.1 h | 284 | $126 | 0 | held |
| $25,000,000 | ETH>SOL | mayan | balanced | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 89.7 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>SOL | mayan | balanced | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 86.1 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>SOL | mayan | max-privacy | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 340.7 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>SOL | mayan | max-safety | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 62.4 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>SOL | mayan | balanced | bucket | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 93.0 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>SOL | mayan | balanced | varied | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 81.9 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>SOL | mayan | max-privacy | bucket | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 311.2 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>SOL | mayan | max-safety | varied | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 60.0 h | 353 | $157 | 0 | held |
| $1,000,000 | ETH>ETH(Base) | uniswap-across | balanced | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 88.0 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>ETH(Base) | uniswap-across | balanced | varied | R5 | destination-final | 72 | $10,272–$17,976 | $25,000 | 78.1 h | 262 | $116 | 0 | held |
| $1,000,000 | ETH>ETH(Base) | uniswap-across | max-privacy | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 293.1 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>ETH(Base) | uniswap-across | max-safety | varied | R5 | destination-final | 72 | $10,272–$17,976 | $20,000 | 64.0 h | 262 | $116 | 0 | held |
| $2,000,000 | ETH>ETH(Base) | uniswap-across | balanced | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 90.6 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>ETH(Base) | uniswap-across | balanced | varied | R5 | destination-final | 65 | $14,959–$38,520 | $50,000 | 70.7 h | 237 | $105 | 0 | held |
| $2,000,000 | ETH>ETH(Base) | uniswap-across | max-privacy | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 290.1 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>ETH(Base) | uniswap-across | max-safety | varied | R5 | destination-final | 66 | $2,119–$38,520 | $40,000 | 55.2 h | 240 | $107 | 0 | held |
| $5,000,000 | ETH>ETH(Base) | uniswap-across | balanced | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 112.1 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>ETH(Base) | uniswap-across | balanced | varied | R5 | destination-final | 80 | $48,954–$77,039 | $100,000 | 91.4 h | 291 | $129 | 0 | held |
| $5,000,000 | ETH>ETH(Base) | uniswap-across | max-privacy | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 362.0 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>ETH(Base) | uniswap-across | max-safety | varied | R5 | destination-final | 78 | $51,359–$77,202 | $100,000 | 68.7 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>ETH(Base) | uniswap-across | balanced | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 92.6 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>ETH(Base) | uniswap-across | balanced | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 95.2 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>ETH(Base) | uniswap-across | max-privacy | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 259.0 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>ETH(Base) | uniswap-across | max-safety | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 71.7 h | 284 | $126 | 0 | held |
| $25,000,000 | ETH>ETH(Base) | uniswap-across | balanced | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 117.4 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>ETH(Base) | uniswap-across | balanced | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 113.0 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>ETH(Base) | uniswap-across | max-privacy | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 336.8 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>ETH(Base) | uniswap-across | max-safety | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 90.8 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>ETH(Base) | uniswap-across | balanced | bucket | R5 | destination-final | 194 | $256,797–$438,179 | $1,000,000 | 223.3 h | 706 | $313 | 0 | held |
| $50,000,000 | ETH>ETH(Base) | uniswap-across | balanced | varied | R5 | destination-final | 194 | $256,797–$438,179 | $1,000,000 | 220.3 h | 706 | $313 | 0 | held |
| $50,000,000 | ETH>ETH(Base) | uniswap-across | max-privacy | bucket | R5 | destination-final | 194 | $256,797–$438,179 | $1,000,000 | 669.9 h | 706 | $313 | 0 | held |
| $50,000,000 | ETH>ETH(Base) | uniswap-across | max-safety | varied | R5 | destination-final | 194 | $256,797–$438,179 | $1,000,000 | 185.0 h | 706 | $313 | 0 | held |
| $1,000,000 | ETH>USDC(Base) | mayan | balanced | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 85.9 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>USDC(Base) | mayan | balanced | varied | R5 | destination-final | 71 | $10,048–$17,976 | $25,000 | 78.3 h | 258 | $115 | 0 | held |
| $1,000,000 | ETH>USDC(Base) | mayan | max-privacy | bucket | R5 | destination-final | 78 | $11,332–$12,840 | $25,000 | 255.7 h | 284 | $126 | 0 | held |
| $1,000,000 | ETH>USDC(Base) | mayan | max-safety | varied | R5 | destination-final | 72 | $10,272–$17,976 | $20,000 | 62.7 h | 262 | $116 | 0 | held |
| $2,000,000 | ETH>USDC(Base) | mayan | balanced | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 84.9 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>USDC(Base) | mayan | balanced | varied | R5 | destination-final | 64 | $25,680–$45,775 | $50,000 | 71.8 h | 233 | $103 | 0 | held |
| $2,000,000 | ETH>USDC(Base) | mayan | max-privacy | bucket | R5 | destination-final | 78 | $22,663–$25,680 | $50,000 | 283.5 h | 284 | $126 | 0 | held |
| $2,000,000 | ETH>USDC(Base) | mayan | max-safety | varied | R5 | destination-final | 64 | $14,959–$38,520 | $40,000 | 55.5 h | 233 | $103 | 0 | held |
| $5,000,000 | ETH>USDC(Base) | mayan | balanced | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 106.4 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>USDC(Base) | mayan | balanced | varied | R5 | destination-final | 80 | $51,359–$97,745 | $100,000 | 81.4 h | 291 | $129 | 0 | held |
| $5,000,000 | ETH>USDC(Base) | mayan | max-privacy | bucket | R5 | destination-final | 97 | $51,359–$69,498 | $100,000 | 348.7 h | 353 | $157 | 0 | held |
| $5,000,000 | ETH>USDC(Base) | mayan | max-safety | varied | R5 | destination-final | 80 | $51,359–$79,769 | $100,000 | 71.5 h | 291 | $129 | 0 | held |
| $10,000,000 | ETH>USDC(Base) | mayan | balanced | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 87.5 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>USDC(Base) | mayan | balanced | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 90.8 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>USDC(Base) | mayan | max-privacy | bucket | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 278.9 h | 284 | $126 | 0 | held |
| $10,000,000 | ETH>USDC(Base) | mayan | max-safety | varied | R5 | destination-final | 78 | $113,315–$128,398 | $200,000 | 68.4 h | 284 | $126 | 0 | held |
| $25,000,000 | ETH>USDC(Base) | mayan | balanced | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 110.1 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>USDC(Base) | mayan | balanced | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 108.6 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>USDC(Base) | mayan | max-privacy | bucket | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 328.5 h | 353 | $157 | 0 | held |
| $25,000,000 | ETH>USDC(Base) | mayan | max-safety | varied | R5 | destination-final | 97 | $256,797–$347,488 | $500,000 | 81.3 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>USDC(Base) | mayan | balanced | bucket | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 109.2 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>USDC(Base) | mayan | balanced | varied | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 110.1 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>USDC(Base) | mayan | max-privacy | bucket | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 356.4 h | 353 | $157 | 0 | held |
| $50,000,000 | ETH>USDC(Base) | mayan | max-safety | varied | R5 | destination-final | 97 | $513,594–$694,976 | $1,000,000 | 82.5 h | 353 | $157 | 0 | held |
| $1,000,000 | BTC>ETH | thorchain | balanced | bucket | R5 | destination-final | 40 | $25,000–$25,000 | $25,000 | 59.8 h | 146 | $65 | 0 | held |
| $1,000,000 | BTC>ETH | thorchain | balanced | varied | R5 | destination-final | 40 | $25,000–$25,000 | $25,000 | 61.7 h | 146 | $65 | 0 | held |
| $1,000,000 | BTC>ETH | thorchain | max-privacy | bucket | R5 | destination-final | 40 | $25,000–$25,000 | $25,000 | 142.3 h | 146 | $65 | 0 | held |
| $1,000,000 | BTC>ETH | thorchain | max-safety | varied | R5 | destination-final | 50 | $20,000–$20,000 | $20,000 | 63.0 h | 182 | $81 | 0 | held |
| $2,000,000 | BTC>ETH | thorchain | balanced | bucket | R5 | destination-final | 40 | $50,000–$50,000 | $50,000 | 60.3 h | 146 | $65 | 0 | held |
| $2,000,000 | BTC>ETH | thorchain | balanced | varied | R5 | destination-final | 40 | $50,000–$50,000 | $50,000 | 62.9 h | 146 | $65 | 0 | held |
| $2,000,000 | BTC>ETH | thorchain | max-privacy | bucket | R5 | destination-final | 40 | $50,000–$50,000 | $50,000 | 158.2 h | 146 | $65 | 0 | held |
| $2,000,000 | BTC>ETH | thorchain | max-safety | varied | R5 | destination-final | 50 | $40,000–$40,000 | $40,000 | 60.4 h | 182 | $81 | 0 | held |
| $5,000,000 | BTC>ETH | thorchain | balanced | bucket | R5 | destination-final | 60 | $83,279–$86,543 | $100,000 | 90.8 h | 218 | $97 | 0 | held |
| $5,000,000 | BTC>ETH | thorchain | balanced | varied | R5 | destination-final | 60 | $83,279–$86,543 | $100,000 | 86.5 h | 218 | $97 | 0 | held |
| $5,000,000 | BTC>ETH | thorchain | max-privacy | bucket | R5 | destination-final | 60 | $83,279–$86,543 | $100,000 | 220.9 h | 218 | $97 | 0 | held |
| $5,000,000 | BTC>ETH | thorchain | max-safety | varied | R5 | destination-final | 60 | $83,279–$86,543 | $100,000 | 76.5 h | 218 | $97 | 0 | held |
| $10,000,000 | BTC>ETH | thorchain | balanced | bucket | R5 | destination-final | 60 | $166,558–$173,085 | $200,000 | 92.9 h | 218 | $97 | 0 | held |
| $10,000,000 | BTC>ETH | thorchain | balanced | varied | R5 | destination-final | 60 | $166,558–$173,085 | $200,000 | 93.2 h | 218 | $97 | 0 | held |
| $10,000,000 | BTC>ETH | thorchain | max-privacy | bucket | R5 | destination-final | 60 | $166,558–$173,085 | $200,000 | 237.2 h | 218 | $97 | 0 | held |
| $10,000,000 | BTC>ETH | thorchain | max-safety | varied | R5 | destination-final | 60 | $166,558–$173,085 | $200,000 | 73.5 h | 218 | $97 | 0 | held |
| $25,000,000 | BTC>ETH | thorchain | balanced | bucket | R5 | destination-final | 60 | $416,395–$432,713 | $500,000 | 91.8 h | 218 | $97 | 0 | held |
| $25,000,000 | BTC>ETH | thorchain | balanced | varied | R5 | destination-final | 60 | $416,395–$432,713 | $500,000 | 91.3 h | 218 | $97 | 0 | held |
| $25,000,000 | BTC>ETH | thorchain | max-privacy | bucket | R5 | destination-final | 60 | $416,395–$432,713 | $500,000 | 240.8 h | 218 | $97 | 0 | held |
| $25,000,000 | BTC>ETH | thorchain | max-safety | varied | R5 | destination-final | 60 | $416,395–$432,713 | $500,000 | 81.7 h | 218 | $97 | 0 | held |
| $50,000,000 | BTC>ETH | thorchain | balanced | bucket | R5 | destination-final | 60 | $832,789–$865,425 | $1,000,000 | 103.9 h | 218 | $97 | 0 | held |
| $50,000,000 | BTC>ETH | thorchain | balanced | varied | R5 | destination-final | 60 | $832,789–$865,425 | $1,000,000 | 106.6 h | 218 | $97 | 0 | held |
| $50,000,000 | BTC>ETH | thorchain | max-privacy | bucket | R5 | destination-final | 60 | $832,789–$865,425 | $1,000,000 | 275.6 h | 218 | $97 | 0 | held |
| $50,000,000 | BTC>ETH | thorchain | max-safety | varied | R5 | destination-final | 60 | $832,789–$865,425 | $1,000,000 | 88.4 h | 218 | $97 | 0 | held |
| $1,000,000 | USDC>BTC | chainflip | balanced | bucket | R5 | destination-final | 50 | $19,996–$20,217 | $25,000 | 100.4 h | 182 | $81 | 0 | held |
| $1,000,000 | USDC>BTC | chainflip | balanced | varied | R5 | destination-final | 55 | $10,998–$24,994 | $25,000 | 107.3 h | 200 | $89 | 0 | held |
| $1,000,000 | USDC>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 50 | $19,996–$20,217 | $25,000 | 224.4 h | 182 | $81 | 0 | held |
| $1,000,000 | USDC>BTC | chainflip | max-safety | varied | R5 | destination-final | 66 | $10,998–$19,996 | $20,000 | 116.3 h | 240 | $107 | 0 | held |
| $2,000,000 | USDC>BTC | chainflip | balanced | bucket | R5 | destination-final | 41 | $443–$49,989 | $50,000 | 82.0 h | 149 | $66 | 0 | held |
| $2,000,000 | USDC>BTC | chainflip | balanced | varied | R5 | destination-final | 60 | $21,995–$49,989 | $50,000 | 118.3 h | 218 | $97 | 0 | held |
| $2,000,000 | USDC>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 41 | $443–$49,989 | $50,000 | 167.6 h | 149 | $66 | 0 | held |
| $2,000,000 | USDC>BTC | chainflip | max-safety | varied | R5 | destination-final | 69 | $21,995–$39,991 | $40,000 | 123.6 h | 251 | $111 | 0 | held |
| $5,000,000 | USDC>BTC | chainflip | balanced | bucket | R5 | destination-final | 51 | $1,107–$99,978 | $100,000 | 103.0 h | 186 | $82 | 0 | held |
| $5,000,000 | USDC>BTC | chainflip | balanced | varied | R5 | destination-final | 68 | $54,988–$99,978 | $100,000 | 134.9 h | 248 | $110 | 0 | held |
| $5,000,000 | USDC>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 51 | $1,107–$99,978 | $100,000 | 218.6 h | 186 | $82 | 0 | held |
| $5,000,000 | USDC>BTC | chainflip | max-safety | varied | R5 | destination-final | 71 | $41,099–$99,978 | $100,000 | 125.3 h | 258 | $115 | 0 | held |
| $10,000,000 | USDC>BTC | chainflip | balanced | bucket | R5 | destination-final | 51 | $2,215–$199,956 | $200,000 | 109.2 h | 186 | $82 | 0 | held |
| $10,000,000 | USDC>BTC | chainflip | balanced | varied | R5 | destination-final | 51 | $2,215–$199,956 | $200,000 | 102.9 h | 186 | $82 | 0 | held |
| $10,000,000 | USDC>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 51 | $2,215–$199,956 | $200,000 | 242.5 h | 186 | $82 | 0 | held |
| $10,000,000 | USDC>BTC | chainflip | max-safety | varied | R5 | destination-final | 51 | $2,215–$199,956 | $200,000 | 93.1 h | 186 | $82 | 0 | held |
| $25,000,000 | USDC>BTC | chainflip | balanced | bucket | R5 | destination-final | 51 | $5,537–$499,889 | $500,000 | 105.3 h | 186 | $82 | 0 | held |
| $25,000,000 | USDC>BTC | chainflip | balanced | varied | R5 | destination-final | 51 | $5,537–$499,889 | $500,000 | 107.4 h | 186 | $82 | 0 | held |
| $25,000,000 | USDC>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 51 | $5,537–$499,889 | $500,000 | 209.0 h | 186 | $82 | 0 | held |
| $25,000,000 | USDC>BTC | chainflip | max-safety | varied | R5 | destination-final | 51 | $5,537–$499,889 | $500,000 | 94.5 h | 186 | $82 | 0 | held |
| $50,000,000 | USDC>BTC | chainflip | balanced | bucket | R5 | destination-final | 100 | $499,889–$510,964 | $1,000,000 | 204.5 h | 364 | $162 | 0 | held |
| $50,000,000 | USDC>BTC | chainflip | balanced | varied | R5 | destination-final | 100 | $499,889–$510,964 | $1,000,000 | 203.4 h | 364 | $162 | 0 | held |
| $50,000,000 | USDC>BTC | chainflip | max-privacy | bucket | R5 | destination-final | 100 | $499,889–$510,964 | $1,000,000 | 433.1 h | 364 | $162 | 0 | held |
| $50,000,000 | USDC>BTC | chainflip | max-safety | varied | R5 | destination-final | 100 | $499,889–$510,964 | $1,000,000 | 180.0 h | 364 | $162 | 0 | held |
| $1,000,000 | SOL>ETH (assumed) | mayan | balanced | bucket | R2 | destination-submitted | 86 | $8,410–$11,666 | $25,000 | 36.9 h | 313 | $139 | 0 | held |
| $1,000,000 | SOL>ETH (assumed) | mayan | balanced | varied | R2 | destination-submitted | 86 | $8,410–$11,666 | $25,000 | 34.5 h | 313 | $139 | 0 | held |
| $1,000,000 | SOL>ETH (assumed) | mayan | max-privacy | bucket | R2 | destination-submitted | 86 | $8,410–$11,666 | $25,000 | 140.8 h | 313 | $139 | 0 | held |
| $1,000,000 | SOL>ETH (assumed) | mayan | max-safety | varied | R2 | destination-final | 86 | $8,410–$11,666 | $20,000 | 76.4 h | 313 | $139 | 0 | held |
| $2,000,000 | SOL>ETH (assumed) | mayan | balanced | bucket | R2 | destination-submitted | 86 | $16,820–$23,332 | $50,000 | 34.5 h | 313 | $139 | 0 | held |
| $2,000,000 | SOL>ETH (assumed) | mayan | balanced | varied | R2 | destination-submitted | 86 | $16,820–$23,332 | $50,000 | 41.1 h | 313 | $139 | 0 | held |
| $2,000,000 | SOL>ETH (assumed) | mayan | max-privacy | bucket | R2 | destination-submitted | 86 | $16,820–$23,332 | $50,000 | 121.3 h | 313 | $139 | 0 | held |
| $2,000,000 | SOL>ETH (assumed) | mayan | max-safety | varied | R2 | destination-final | 86 | $16,820–$23,332 | $40,000 | 76.2 h | 313 | $139 | 0 | held |
| $5,000,000 | SOL>ETH (assumed) | mayan | balanced | bucket | R2 | destination-submitted | 214 | $23,332–$30,384 | $100,000 | 93.1 h | 779 | $346 | 0 | held |
| $5,000,000 | SOL>ETH (assumed) | mayan | balanced | varied | R2 | destination-submitted | 214 | $23,332–$30,384 | $100,000 | 97.5 h | 779 | $346 | 0 | held |
| $5,000,000 | SOL>ETH (assumed) | mayan | max-privacy | bucket | R2 | destination-submitted | 214 | $23,332–$30,384 | $100,000 | 348.5 h | 779 | $346 | 0 | held |
| $5,000,000 | SOL>ETH (assumed) | mayan | max-safety | varied | R2 | destination-final | 86 | $42,050–$58,329 | $100,000 | 75.4 h | 313 | $139 | 0 | held |
| $10,000,000 | SOL>ETH (assumed) | mayan | balanced | bucket | R2 | destination-submitted | 86 | $84,100–$116,658 | $200,000 | 72.0 h | 313 | $139 | 0 | held |
| $10,000,000 | SOL>ETH (assumed) | mayan | balanced | varied | R2 | destination-submitted | 86 | $84,100–$116,658 | $200,000 | 66.7 h | 313 | $139 | 0 | held |
| $10,000,000 | SOL>ETH (assumed) | mayan | max-privacy | bucket | R2 | destination-submitted | 86 | $84,100–$116,658 | $200,000 | 273.4 h | 313 | $139 | 0 | held |
| $10,000,000 | SOL>ETH (assumed) | mayan | max-safety | varied | R2 | destination-final | 86 | $84,100–$116,658 | $200,000 | 74.0 h | 313 | $139 | 0 | held |
| $25,000,000 | SOL>ETH (assumed) | mayan | balanced | bucket | R2 | destination-submitted | 107 | $233,315–$268,578 | $500,000 | 92.5 h | 389 | $173 | 0 | held |
| $25,000,000 | SOL>ETH (assumed) | mayan | balanced | varied | R2 | destination-submitted | 107 | $233,315–$268,578 | $500,000 | 96.1 h | 389 | $173 | 0 | held |
| $25,000,000 | SOL>ETH (assumed) | mayan | max-privacy | bucket | R2 | destination-submitted | 107 | $233,315–$268,578 | $500,000 | 347.1 h | 389 | $173 | 0 | held |
| $25,000,000 | SOL>ETH (assumed) | mayan | max-safety | varied | R2 | destination-final | 107 | $233,315–$268,578 | $500,000 | 91.8 h | 389 | $173 | 0 | held |
| $50,000,000 | SOL>ETH (assumed) | mayan | balanced | bucket | R2 | destination-submitted | 86 | $420,498–$583,288 | $1,000,000 | 75.6 h | 313 | $139 | 0 | held |
| $50,000,000 | SOL>ETH (assumed) | mayan | balanced | varied | R2 | destination-submitted | 86 | $420,498–$583,288 | $1,000,000 | 77.5 h | 313 | $139 | 0 | held |
| $50,000,000 | SOL>ETH (assumed) | mayan | max-privacy | bucket | R2 | destination-submitted | 86 | $420,498–$583,288 | $1,000,000 | 270.2 h | 313 | $139 | 0 | held |
| $50,000,000 | SOL>ETH (assumed) | mayan | max-safety | varied | R2 | destination-final | 86 | $420,498–$583,288 | $1,000,000 | 74.9 h | 313 | $139 | 0 | held |

## Faults (plan §152–§153): the $10M ETH → BTC campaign (THORChain streaming, balanced, bucket sizing), one fault at its middle tranche

| fault | exposed at the fault | maximum loss | outcome | extra time | invariants |
|---|---|---|---|---|---|
| provider-outage | $0 | $0 (cap $200,000) | completed after the pause | 0.5 h | held |
| quote-mismatch | $0 | $0 (cap $200,000) | completed after the pause | 1.2 h | held |
| price-spike | $128,398 | $128,398 (cap $200,000) | completed after the pause | 0.0 h | held |
| chain-congestion | $128,398 | $128,398 (cap $200,000) | completed after the pause | 2.6 h | held |
| rpc-failure | $128,398 | $128,398 (cap $200,000) | completed after the pause | 3.9 h | held |
| destination-error | $0 | $0 (cap $200,000) | cancelled: the rest returns to the private balance | 0.0 h | held |
| wrong-chain | $0 | $0 (cap $200,000) | cancelled: the rest returns to the private balance | 0.0 h | held |
| wrong-token | $0 | $0 (cap $200,000) | cancelled: the rest returns to the private balance | 0.0 h | held |
| reorg | $0 | $0 (cap $200,000) | completed; nothing paused (reconciled from the journal and the chain) | 0.3 h | held |
| bridge-timeout | $128,398 | $128,398 (cap $200,000) | completed after the pause | 4.5 h | held |
| solver-failure | $128,398 | $128,398 (cap $200,000) | completed after the pause | 0.0 h | held |
| app-crash | $128,398 | $128,398 (cap $200,000) | completed; nothing paused (reconciled from the journal and the chain) | 0.5 h | held |
| network-disconnect | $128,398 | $128,398 (cap $200,000) | completed after the pause | 6.4 h | held |

The same faults at $1M (tranche ≈ $25K): maximum loss $12,840 at most, every invariant held: yes.

## ELPF (§10): expected loss per failure = P(failure) × exposed, with the class priors (assumed until settlement history exists)

| route | class | prior | per tranche ($10M balanced) | per campaign (the cap) |
|---|---|---|---|---|
| ETH>BTC / thorchain | R5 | 0.02 | $2,568 | $4,000 |
| ETH>BTC / chainflip | R5 | 0.02 | $2,568 | $4,000 |
| ETH>SOL / mayan | R5 | 0.015 | $1,926 | $3,000 |
| ETH>ETH(Base) / uniswap-across | R5 | 0.015 | $1,926 | $3,000 |
| ETH>USDC(Base) / mayan | R5 | 0.015 | $1,926 | $3,000 |
| BTC>ETH / thorchain | R5 | 0.02 | $3,462 | $4,000 |
| USDC>BTC / chainflip | R5 | 0.02 | $3,999 | $4,000 |
| SOL>ETH / mayan | R2 | 0.015 | $1,750 | $3,000 |
