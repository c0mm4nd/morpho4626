import { parseAbi } from 'viem'

export const morpho7702DelegatorAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'plan',
        type: 'tuple',
        components: [
          {
            name: 'marketParams',
            type: 'tuple',
            components: [
              { name: 'loanToken', type: 'address' },
              { name: 'collateralToken', type: 'address' },
              { name: 'oracle', type: 'address' },
              { name: 'irm', type: 'address' },
              { name: 'lltv', type: 'uint256' },
            ],
          },
          { name: 'flashAssets', type: 'uint256' },
          { name: 'repayAssets', type: 'uint256' },
          { name: 'withdrawCollateralAssets', type: 'uint256' },
          { name: 'minLoanTokenProfit', type: 'uint256' },
          { name: 'repayMode', type: 'uint8' },
          { name: 'exitMode', type: 'uint8' },
          { name: 'exitTarget', type: 'address' },
          {
            name: 'postCalls',
            type: 'tuple[]',
            components: [
              { name: 'target', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
            ],
          },
          {
            name: 'afterCalls',
            type: 'tuple[]',
            components: [
              { name: 'target', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'marketId',
    stateMutability: 'pure',
    inputs: [
      {
        name: 'marketParams',
        type: 'tuple',
        components: [
          { name: 'loanToken', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'irm', type: 'address' },
          { name: 'lltv', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const erc4626Abi = parseAbi([
  'function redeem(uint256 shares,address receiver,address owner) returns (uint256 assets)',
])

export const erc20Abi = parseAbi([
  'function transfer(address to,uint256 amount) returns (bool)',
])
