import type { Address } from 'viem'

import {
  EXIT_MODE_ERC4626_REDEEM,
  REPAY_MODE_EXACT_ASSETS,
  REPAY_MODE_FULL_SHARES,
  WITHDRAW_ALL_COLLATERAL,
  type FlashPlanInput,
  type MarketParams,
} from './morpho7702.js'

export const ETHEREUM_MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address

export const SUSDF_USDF_ETHEREUM_MARKET_ID =
  '0x2e09b73c35e0769bdf589a9556e6ac3c892485ea502ac8c445cec9e79b0378af' as const

export const SUSDF_USDF_ETHEREUM_MARKET_PARAMS: MarketParams = {
  loanToken: '0xFa2B947eEc368f42195f24F36d2aF29f7c24CeC2',
  collateralToken: '0xc8CF6D7991f15525488b2A83Df53468D682Ba4B0',
  oracle: '0x84bf7A62708108fA640292684F04b0f7362C88F9',
  irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
  lltv: 915000000000000000n,
}

export function buildSusdfUsdfRedeemAllPlan(parameters: {
  maxFlashAssets: bigint
  minUsdfProfit?: bigint
}): FlashPlanInput {
  return {
    marketParams: SUSDF_USDF_ETHEREUM_MARKET_PARAMS,
    flashAssets: parameters.maxFlashAssets,
    repayMode: REPAY_MODE_FULL_SHARES,
    withdrawCollateralAssets: WITHDRAW_ALL_COLLATERAL,
    minLoanTokenProfit: parameters.minUsdfProfit ?? 0n,
    exitMode: EXIT_MODE_ERC4626_REDEEM,
    exitTarget: SUSDF_USDF_ETHEREUM_MARKET_PARAMS.collateralToken,
  }
}

export function buildSusdfUsdfRedeemPartialPlan(parameters: {
  repayAssets: bigint
  withdrawSusdfAssets: bigint
  minUsdfProfit?: bigint
}): FlashPlanInput {
  return {
    marketParams: SUSDF_USDF_ETHEREUM_MARKET_PARAMS,
    flashAssets: parameters.repayAssets,
    repayMode: REPAY_MODE_EXACT_ASSETS,
    repayAssets: parameters.repayAssets,
    withdrawCollateralAssets: parameters.withdrawSusdfAssets,
    minLoanTokenProfit: parameters.minUsdfProfit ?? 0n,
    exitMode: EXIT_MODE_ERC4626_REDEEM,
    exitTarget: SUSDF_USDF_ETHEREUM_MARKET_PARAMS.collateralToken,
  }
}
