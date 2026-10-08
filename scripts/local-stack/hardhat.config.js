// The local chain for the end-to-end run: chain id 1 so the wallet's mainnet pins (THORChain router, Chainlink
// feeds) can be placed at their real addresses with hardhat_setCode. Nothing here forks mainnet.
module.exports = {
  solidity: "0.8.24",
  networks: {
    hardhat: {
      chainId: 1,
      allowUnlimitedContractSize: false,
      initialBaseFeePerGas: 1000000000,
      accounts: { count: 10, accountsBalance: "100000000000000000000000" },
      mining: { auto: true, interval: 0 },
    },
  },
};
