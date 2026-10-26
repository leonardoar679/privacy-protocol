# The original interface — the parity reference (Workstream D's baseline)

V7 Stage 1 (2026-10-26). The owner's document asks that the original Tornado Classic interface be preserved and compared
before anything is rebuilt (doc §4.1, §4.3 D). The reference used here is the original's **built output**, the
`tornadocash/ui-minified` repository at commit `7aeae4a53f2e3f1b13f21e5ed06f42c2ac94e80a` (2022-08-05), cloned read-only
beside this repository at `../reference/ui-minified` (92 MB with its event and tree caches and the two artifact zips).
Its footer reads `Tornado.cash version: a83fae0`, which is the archived source commit this matrix pins
(`compatibility-matrix.md` §1). Building the Nuxt source itself (Node 14, yarn 1, webpack 4) is not needed for the
reference and was not done.

## How the reference was captured

`classic/docs/reference/capture.cjs` serves the clone from a local static server (port 5190, every path falling back to
`index.html` as the original's IPFS hosting did) and drives installed Chrome through `playwright-core` at the two
canvases of this repository's harness, **390 × 844** (phone, touch) and **1440 × 900** (desktop), screenshotting the
full page and writing each state's visible text (`<state>.txt`) and its visible controls into `inventory.json`. Run it
from the repository root with `node classic/docs/reference/capture.cjs` (it needs the clone and Chrome; nothing is
written outside `reference/`).

The original's network calls fail by design here — the subgraph host and the Infura project key baked into the bundle
are gone — so the Statistics panel shows its loading skeletons and the withdraw tab reports a pasted note as "There is
no related deposit." after "Getting the note data…". Those are the original's own error states, not a defect of the
capture; the structure, the words and the layout are what the reference is for.

## The states (both canvases)

| State | File | What it shows |
|---|---|---|
| Deposit tab, first load | `390x844-deposit.png`, `1440x900-deposit.png` | the two notices (the public-gateway warning and "Tornado.cash was audited. However, it is still an experimental software. Please use at your own risk."), the **Deposit \| Withdraw** tabs, Token (ETH), Amount as a four-stop slider **0.1 ETH · 1 ETH · 10 ETH · 100 ETH**, the **Connect** button, the **Statistics** panel ("Anonymity set", "Latest deposits") beside (desktop) or below (phone) the tabs, the footer (donations address, the version, the social links, the language flag); on the desktop the header bar: Voting, Compliance, Docs, the network selector (Ethereum), the wallet button (Not connected / Connect), the Note Account button, Settings |
| Deposit → Connect | `*-deposit-after-click.png` | the wallet chooser modal "Your Wallet — Please select your Web3 compatible wallet: Install Metamask / WalletConnect" (the note modal comes after a connected wallet; it is described in the matrix §6 from the source) |
| Withdraw tab | `*-withdraw.png` | **Note** (the input), **Recipient Address** ("Please paste address here") with the **Donate** link, the **Withdraw** button; the Statistics panel |
| Withdraw with a note | `*-withdraw-note.png` | the pasted note in the field, the inline error "Error There is no related deposit. The note is invalid.", the Withdraw button busy |

The inventory lists, per state, every visible button, link, input and tab with its text, which is what
`parity.md` (Stage 3) checks the Classic app's screens against, element by element.

## What the reference establishes for the Classic app

- One page, two tabs, the denomination control as a stepped selector, the statistics beside the form, the history
  below — the Classic app keeps that structure (spec §7.9) and adds the tab URLs the owner's document names.
- The original's words for the deposit and withdraw flows are the Classic app's (the matrix §6), under the Classic
  word policy.
- The original is desktop-first and disables zoom; the Classic app is mobile-first at the same canvases and allows
  zoom (the repository's accessibility rule).
- The behaviours the Classic app must not reproduce are listed in the matrix §7 (the note in `localStorage`, the
  console logging, unchecked artifact downloads, the baked-in third-party keys, the note account, the compliance PDF).
