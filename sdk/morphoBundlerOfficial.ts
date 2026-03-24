import { AccrualPosition, ChainId, getChainAddresses, type Address } from '@morpho-org/blue-sdk'
import { getAuthorizationTypedData } from '@morpho-org/blue-sdk-viem'
import {
  BundlerAction,
  MAX_ABSOLUTE_SHARE_PRICE,
  type Action,
  type Authorization,
} from '@morpho-org/bundler-sdk-viem'
import { encodeAbiParameters, keccak256, maxUint256, numberToHex, type Hex } from 'viem'

const LOOP_WITHDRAW_COLLATERAL_BUFFER_BPS = 25n

export type MarketParams = {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

export type RepayMode = 'full-shares' | 'exact-assets'

export type MorphoAuthorizationPair = {
  authorize?: Authorization
  authorizeTypedData?: ReturnType<typeof getAuthorizationTypedData>
  revoke?: Authorization
  revokeTypedData?: ReturnType<typeof getAuthorizationTypedData>
}

export type MorphoBundlerLoopIteration = {
  index: number
  repayMode: RepayMode
  repayAssets: bigint
  repayShares: bigint
  withdrawCollateralAssets: bigint
  redeemAssets: bigint
  loanTokenBalanceAfter: bigint
  borrowAssetsAfter: bigint
  borrowSharesAfter: bigint
  collateralAfter: bigint
}

export type MorphoBundlerLoopSummary = {
  enabled: boolean
  completed: boolean
  iterations: MorphoBundlerLoopIteration[]
  iterationCount: number
  totalRepayAssets: bigint
  totalWithdrawCollateralAssets: bigint
  totalRedeemAssets: bigint
  netLoanTokenOut: bigint
  finalPosition: AccrualPosition
  message?: string
}

export type MorphoBundlerRedeemParameters = {
  chainId: number
  account: Address
  marketParams: MarketParams
  vault: Address
  flashAssets: bigint
  repayMode: RepayMode
  repayAssets?: bigint
  withdrawCollateralAssets: bigint
  minVaultSharePriceE27: bigint
  authorizationNonce: bigint
  authorizationDeadline: bigint
  autoRevoke?: boolean
  skipInitialAuthorization?: boolean
  accrualPosition: AccrualPosition
  previewRedeemAssets: bigint
  maxIterations?: number
}

export type MorphoBundlerRedeemPlan = {
  authorization: MorphoAuthorizationPair
  actions: Action[]
  bundlerAddress: Address
  generalAdapter1: Address
  loop: MorphoBundlerLoopSummary
}

export type MorphoBundlerDepositParameters = {
  chainId: number
  account: Address
  marketParams: MarketParams
  vault: Address
  depositAssetRoute?: MorphoBundlerDepositAssetRoute
  flashLoanLiquidityAssets: bigint
  marketBorrowLiquidityAssets: bigint
  walletAssets: bigint
  flashAssets: bigint
  targetDepositAssets: bigint
  targetBorrowAssets: bigint
  maxVaultSharePriceE27: bigint
  borrowSlippageBps: bigint
  authorizationNonce: bigint
  authorizationDeadline: bigint
  autoRevoke?: boolean
  skipInitialAuthorization?: boolean
  accrualPosition: AccrualPosition
  previewDepositShares: bigint
}

export type MorphoBundlerDepositAssetRoute =
  | {
      kind: 'direct'
      loanToken: Address
      vaultAsset: Address
    }
  | {
      kind: 'psm'
      loanToken: Address
      vaultAsset: Address
      psmWrapper: Address
      sellGemFeeWad: bigint
      buyGemFeeWad: bigint
      to18ConversionFactor: bigint
    }

export type MorphoBundlerDepositLoopIteration = {
  index: number
  depositAssets: bigint
  loanTokenSpentForDeposit: bigint
  depositShares: bigint
  borrowAssets: bigint
  borrowShares: bigint
  loanTokenBalanceAfter: bigint
  totalDepositAssetsAfter: bigint
  totalBorrowAssetsAfter: bigint
  borrowAssetsAfter: bigint
  borrowSharesAfter: bigint
  collateralAfter: bigint
}

export type MorphoBundlerDepositSummary = {
  walletAssetsIn: bigint
  flashAssets: bigint
  currentBorrowAssets: bigint
  targetDepositAssets: bigint
  targetBorrowAssets: bigint
  initialDepositAssets: bigint
  totalDepositAssets: bigint
  suppliedCollateralAssets: bigint
  additionalBorrowAssets: bigint
  maxSafeBorrowAfterInitialDeposit: bigint
  callbackBorrowLiquidityAfterFlash: bigint
  maxTargetBorrowAssetsAfterConstraints: bigint
  finalBorrowAssets: bigint
  finalBorrowShares: bigint
  netLoanTokenOut: bigint
  finalPosition: AccrualPosition
  loopEnabled: boolean
  iterationCount: number
  iterations: MorphoBundlerDepositLoopIteration[]
  completed: boolean
  message?: string
}

export type MorphoBundlerDepositPlan = {
  authorization: MorphoAuthorizationPair
  actions: Action[]
  bundlerAddress: Address
  generalAdapter1: Address
  summary: MorphoBundlerDepositSummary
}

export function buildMarketId(marketParams: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'loanToken', type: 'address' },
        { name: 'collateralToken', type: 'address' },
        { name: 'oracle', type: 'address' },
        { name: 'irm', type: 'address' },
        { name: 'lltv', type: 'uint256' },
      ],
      [
        marketParams.loanToken,
        marketParams.collateralToken,
        marketParams.oracle,
        marketParams.irm,
        marketParams.lltv,
      ],
    ),
  )
}

export function computeMinSharePriceE27(parameters: {
  shares: bigint
  previewAssets: bigint
  slippageBps: bigint
}): bigint {
  if (parameters.shares <= 0n) throw new Error('shares must be greater than zero.')
  if (parameters.previewAssets <= 0n) throw new Error('previewAssets must be greater than zero.')
  if (parameters.slippageBps < 0n || parameters.slippageBps >= 10_000n) {
    throw new Error('slippageBps must be between 0 and 9999.')
  }

  const ray = 10n ** 27n
  const discountedAssets = (parameters.previewAssets * (10_000n - parameters.slippageBps)) / 10_000n
  return (discountedAssets * ray) / parameters.shares
}

export function computeMaxSharePriceE27(parameters: {
  assets: bigint
  previewShares: bigint
  slippageBps: bigint
}): bigint {
  if (parameters.assets <= 0n) throw new Error('assets must be greater than zero.')
  if (parameters.previewShares <= 0n) throw new Error('previewShares must be greater than zero.')
  if (parameters.slippageBps < 0n || parameters.slippageBps >= 10_000n) {
    throw new Error('slippageBps must be between 0 and 9999.')
  }

  const ray = 10n ** 27n
  const minimumShares = (parameters.previewShares * (10_000n - parameters.slippageBps)) / 10_000n
  if (minimumShares <= 0n) throw new Error('slippage leaves zero minimum shares.')
  return (parameters.assets * ray + minimumShares - 1n) / minimumShares
}

function estimateDepositSharesFromSharePriceE27(assets: bigint, sharePriceE27: bigint) {
  if (assets <= 0n) return 0n
  if (sharePriceE27 <= 0n) throw new Error('sharePriceE27 must be greater than zero.')

  const ray = 10n ** 27n
  return (assets * ray) / sharePriceE27
}

export function quoteDepositAssetOutFromLoanToken(parameters: {
  route?: MorphoBundlerDepositAssetRoute
  loanTokenAmount: bigint
}) {
  if (parameters.loanTokenAmount <= 0n) return 0n
  const route = parameters.route
  if (!route || route.kind === 'direct') return parameters.loanTokenAmount
  return (parameters.loanTokenAmount * route.to18ConversionFactor * (10n ** 18n - route.sellGemFeeWad)) / (10n ** 18n)
}

export function requiredLoanTokenForDepositAssetOut(parameters: {
  route?: MorphoBundlerDepositAssetRoute
  depositAssetAmount: bigint
}) {
  if (parameters.depositAssetAmount <= 0n) return 0n
  const route = parameters.route
  if (!route || route.kind === 'direct') return parameters.depositAssetAmount

  const denominator = route.to18ConversionFactor * (10n ** 18n - route.sellGemFeeWad)
  if (denominator <= 0n) throw new Error('PSM sell-gem route is not currently usable.')
  return (parameters.depositAssetAmount * 10n ** 18n + denominator - 1n) / denominator
}

function cloneAccrualPosition(position: AccrualPosition) {
  return new AccrualPosition(
    {
      user: position.user,
      supplyShares: position.supplyShares,
      borrowShares: position.borrowShares,
      collateral: position.collateral,
    },
    position.market,
  )
}

export function buildMorphoAuthorizationPair(parameters: {
  chainId: number
  account: Address
  nonce: bigint
  deadline: bigint
  autoRevoke?: boolean
  skipInitialAuthorization?: boolean
}): MorphoAuthorizationPair {
  const normalizedChainId = parameters.chainId as ChainId
  const { bundler3 } = getChainAddresses(normalizedChainId)
  const result: MorphoAuthorizationPair = {}
  let nextNonce = parameters.nonce

  if (!parameters.skipInitialAuthorization) {
    const authorize: Authorization = {
      authorizer: parameters.account,
      authorized: bundler3.generalAdapter1,
      isAuthorized: true,
      nonce: nextNonce,
      deadline: parameters.deadline,
    }

    result.authorize = authorize
    result.authorizeTypedData = getAuthorizationTypedData(authorize, normalizedChainId)
    nextNonce += 1n
  }

  if (!parameters.autoRevoke) return result

  const revoke: Authorization = {
    authorizer: parameters.account,
    authorized: bundler3.generalAdapter1,
    isAuthorized: false,
    nonce: nextNonce,
    deadline: parameters.deadline,
  }

  result.revoke = revoke
  result.revokeTypedData = getAuthorizationTypedData(revoke, normalizedChainId)
  return result
}

export function buildMorphoBundlerRedeemPlan(
  parameters: MorphoBundlerRedeemParameters,
): MorphoBundlerRedeemPlan {
  assertRedeemParameters(parameters)

  const normalizedChainId = parameters.chainId as ChainId
  const { bundler3 } = getChainAddresses(normalizedChainId)
  const authorization = buildMorphoAuthorizationPair({
    chainId: parameters.chainId,
    account: parameters.account,
    nonce: parameters.authorizationNonce,
    deadline: parameters.authorizationDeadline,
    autoRevoke: parameters.autoRevoke,
    skipInitialAuthorization: parameters.skipInitialAuthorization,
  })
  const execution = shouldUseLoopExecution(parameters)
    ? buildLoopExecution(parameters)
    : buildSingleExecution(parameters)

  const actions: Action[] = []

  if (authorization.authorize) {
    actions.push({
      type: 'morphoSetAuthorizationWithSig',
      args: [authorization.authorize, null, false],
    })
  }

  actions.push({
    type: 'morphoFlashLoan',
    args: [
      parameters.marketParams.loanToken,
      parameters.flashAssets,
      execution.callbackActions,
      false,
    ],
  })

  // Sweep redeemed loan tokens back to the EOA after the flash-loan callback completes.
  actions.push({
    type: 'erc20Transfer',
    args: [
      parameters.marketParams.loanToken,
      parameters.account,
      maxUint256,
      bundler3.generalAdapter1,
      false,
    ],
  })

  // Sweep any leftover vault shares so nothing stays on the adapter.
  actions.push({
    type: 'erc20Transfer',
    args: [
      parameters.vault,
      parameters.account,
      maxUint256,
      bundler3.generalAdapter1,
      false,
    ],
  })

  if (authorization.revoke) {
    actions.push({
      type: 'morphoSetAuthorizationWithSig',
      args: [authorization.revoke, null, false],
    })
  }

  return {
    authorization,
    actions,
    bundlerAddress: bundler3.bundler3,
    generalAdapter1: bundler3.generalAdapter1,
    loop: execution.summary,
  }
}

export function buildMorphoBundlerDepositPlan(
  parameters: MorphoBundlerDepositParameters,
): MorphoBundlerDepositPlan {
  assertDepositParameters(parameters)

  const normalizedChainId = parameters.chainId as ChainId
  const { bundler3 } = getChainAddresses(normalizedChainId)
  const authorization = buildMorphoAuthorizationPair({
    chainId: parameters.chainId,
    account: parameters.account,
    nonce: parameters.authorizationNonce,
    deadline: parameters.authorizationDeadline,
    autoRevoke: parameters.autoRevoke,
    skipInitialAuthorization: parameters.skipInitialAuthorization,
  })
  const execution = buildDepositExecution(parameters)
  const actions: Action[] = []

  if (authorization.authorize) {
    actions.push({
      type: 'morphoSetAuthorizationWithSig',
      args: [authorization.authorize, null, false],
    })
  }

  if (parameters.walletAssets > 0n) {
    actions.push({
      type: 'erc20TransferFrom',
      args: [
        parameters.marketParams.loanToken,
        parameters.walletAssets,
        bundler3.generalAdapter1,
        false,
      ],
    })
  }

  if (parameters.flashAssets > 0n) {
    actions.push({
      type: 'morphoFlashLoan',
      args: [
        parameters.marketParams.loanToken,
        parameters.flashAssets,
        execution.callbackActions,
        false,
      ],
    })
  } else {
    actions.push(...execution.callbackActions)
  }

  // Sweep any dust back to the EOA. Loan-token dust can come from borrow/share rounding.
  actions.push(
    {
      type: 'erc20Transfer',
      args: [
        parameters.marketParams.loanToken,
        parameters.account,
        maxUint256,
        bundler3.generalAdapter1,
        false,
      ],
    },
    {
      type: 'erc20Transfer',
      args: [
        parameters.vault,
        parameters.account,
        maxUint256,
        bundler3.generalAdapter1,
        false,
      ],
    },
  )

  if (authorization.revoke) {
    actions.push({
      type: 'morphoSetAuthorizationWithSig',
      args: [authorization.revoke, null, false],
    })
  }

  return {
    authorization,
    actions,
    bundlerAddress: bundler3.bundler3,
    generalAdapter1: bundler3.generalAdapter1,
    summary: execution.summary,
  }
}

export function encodeMorphoBundlerRedeemTransactionRequest(parameters: {
  chainId: number
  from: Address
  actions: Action[]
}) {
  if (parameters.actions.some((action) => action.type === 'morphoSetAuthorizationWithSig' && action.args[1] == null)) {
    throw new Error('Authorization signatures are required before encoding the bundler transaction.')
  }

  const transaction = BundlerAction.encodeBundle(parameters.chainId as ChainId, parameters.actions)

  return {
    transaction,
    request: {
      from: parameters.from,
      to: transaction.to,
      data: transaction.data,
      value: numberToHex(transaction.value),
    },
  }
}

export function encodeMorphoBundlerTransactionRequest(parameters: {
  chainId: number
  from: Address
  actions: Action[]
}) {
  return encodeMorphoBundlerRedeemTransactionRequest(parameters)
}

export function buildMorphoBundlerRedeemTransactionRequest(
  parameters: MorphoBundlerRedeemParameters & {
    from: Address
    actions?: Action[]
  },
) {
  const plan = buildMorphoBundlerRedeemPlan(parameters)
  const { transaction, request } = encodeMorphoBundlerRedeemTransactionRequest({
    chainId: parameters.chainId,
    from: parameters.from,
    actions: parameters.actions ?? plan.actions,
  })

  return {
    plan,
    transaction,
    request,
  }
}

export function buildMorphoBundlerDepositTransactionRequest(
  parameters: MorphoBundlerDepositParameters & {
    from: Address
    actions?: Action[]
  },
) {
  const plan = buildMorphoBundlerDepositPlan(parameters)
  const { transaction, request } = encodeMorphoBundlerRedeemTransactionRequest({
    chainId: parameters.chainId,
    from: parameters.from,
    actions: parameters.actions ?? plan.actions,
  })

  return {
    plan,
    transaction,
    request,
  }
}

function shouldUseLoopExecution(parameters: MorphoBundlerRedeemParameters) {
  return (
    parameters.repayMode === 'full-shares' &&
    parameters.withdrawCollateralAssets === parameters.accrualPosition.collateral &&
    parameters.flashAssets < parameters.accrualPosition.borrowAssets
  )
}

function buildDepositExecution(parameters: MorphoBundlerDepositParameters): {
  callbackActions: Action[]
  summary: MorphoBundlerDepositSummary
} {
  const callbackActions: Action[] = []
  const summary = simulateDepositExecution(parameters)
  const adapter = getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1
  for (const iteration of summary.iterations) {
    if (iteration.depositAssets > 0n) {
      callbackActions.push(
        {
          type: 'erc4626Deposit',
          args: [parameters.vault, iteration.depositAssets, parameters.maxVaultSharePriceE27, adapter, false],
        },
        {
          type: 'morphoSupplyCollateral',
          args: [parameters.marketParams, maxUint256, parameters.account, [], false],
        },
      )
    }

    if (iteration.borrowAssets > 0n) {
      const minBorrowSharePriceE27 = computeMinSharePriceE27({
        shares: iteration.borrowShares,
        previewAssets: iteration.borrowAssets,
        slippageBps: parameters.borrowSlippageBps,
      })

      callbackActions.push({
        type: 'morphoBorrow',
        args: [
          parameters.marketParams,
          iteration.borrowAssets,
          0n,
          minBorrowSharePriceE27,
          adapter,
          false,
        ],
      })
    }
  }

  return { callbackActions, summary }
}

function buildSingleExecution(parameters: MorphoBundlerRedeemParameters): {
  callbackActions: Action[]
  summary: MorphoBundlerLoopSummary
} {
  const callbackActions: Action[] = [
    buildRepayAction(
      parameters.marketParams,
      parameters.account,
      parameters.repayMode,
      parameters.repayAssets ?? 0n,
    ),
  ]

  if (parameters.withdrawCollateralAssets > 0n) {
    callbackActions.push(
      {
        type: 'morphoWithdrawCollateral',
        args: [
          parameters.marketParams,
          parameters.withdrawCollateralAssets,
          getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1,
          false,
        ],
      },
      {
        type: 'erc4626Redeem',
        args: [
          parameters.vault,
          parameters.withdrawCollateralAssets,
          parameters.minVaultSharePriceE27,
          getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1,
          getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1,
          false,
        ],
      },
    )
  }

  const summary = simulateSingleExecution(parameters)
  return { callbackActions, summary }
}

function simulateSingleExecution(parameters: MorphoBundlerRedeemParameters): MorphoBundlerLoopSummary {
  let working = cloneAccrualPosition(parameters.accrualPosition)
  let loanTokenBalance = parameters.flashAssets
  let totalRedeemedAssets = 0n
  let totalWithdrawCollateralAssets = 0n
  const iterations: MorphoBundlerLoopIteration[] = []

  const repayResult =
    parameters.repayMode === 'full-shares'
      ? working.repay(0n, working.borrowShares)
      : working.repay(parameters.repayAssets ?? 0n, 0n)

  working = repayResult.position
  loanTokenBalance -= repayResult.assets

  let redeemAssets = 0n
  if (parameters.withdrawCollateralAssets > 0n) {
    const withdrawAssets = findSafeWithdrawCollateral(working, parameters.withdrawCollateralAssets)
    if (withdrawAssets > 0n) {
      working = working.withdrawCollateral(withdrawAssets)
      totalWithdrawCollateralAssets += withdrawAssets
      redeemAssets = previewRedeem(
        withdrawAssets,
        parameters.withdrawCollateralAssets,
        parameters.previewRedeemAssets,
      )
      totalRedeemedAssets += redeemAssets
      loanTokenBalance += redeemAssets
    }
  }

  iterations.push({
    index: 0,
    repayMode: parameters.repayMode,
    repayAssets: repayResult.assets,
    repayShares: repayResult.shares,
    withdrawCollateralAssets: totalWithdrawCollateralAssets,
    redeemAssets,
    loanTokenBalanceAfter: loanTokenBalance,
    borrowAssetsAfter: working.borrowAssets,
    borrowSharesAfter: working.borrowShares,
    collateralAfter: working.collateral,
  })

  return {
    enabled: false,
    completed: true,
    iterations,
    iterationCount: iterations.length,
    totalRepayAssets: repayResult.assets,
    totalWithdrawCollateralAssets,
    totalRedeemAssets: totalRedeemedAssets,
    netLoanTokenOut: loanTokenBalance,
    finalPosition: working,
  }
}

function simulateDepositExecution(parameters: MorphoBundlerDepositParameters): MorphoBundlerDepositSummary {
  const depositAssetRoute = parameters.depositAssetRoute
  const initialAvailableLoanToken = parameters.walletAssets + parameters.flashAssets
  const currentBorrowAssets = parameters.accrualPosition.borrowAssets
  const additionalBorrowTarget = parameters.targetBorrowAssets - currentBorrowAssets
  let working = cloneAccrualPosition(parameters.accrualPosition)
  let availableLoanToken = initialAvailableLoanToken
  let remainingDepositAssets = parameters.targetDepositAssets
  let remainingBorrowAssets = additionalBorrowTarget
  let remainingMorphoCallbackBalance =
    parameters.flashLoanLiquidityAssets > parameters.flashAssets
      ? parameters.flashLoanLiquidityAssets - parameters.flashAssets
      : 0n
  let remainingMarketBorrowLiquidity = parameters.marketBorrowLiquidityAssets
  let totalDepositAssets = 0n
  let suppliedCollateralAssets = 0n
  let totalBorrowAssets = 0n
  let totalBorrowShares = 0n
  const iterations: MorphoBundlerDepositLoopIteration[] = []
  const maxIterations = 24
  let maxSafeBorrowAfterInitialDeposit = currentBorrowAssets
  let initialDepositAssets = 0n

  const supplyDepositedAssets = (assets: bigint) => {
    if (assets <= 0n) return 0n

    const estimatedShares = estimateDepositSharesFromSharePriceE27(assets, parameters.maxVaultSharePriceE27)
    if (estimatedShares <= 0n) {
      throw new Error('Estimated ERC-4626 shares are zero for the requested deposit leg.')
    }

    working = working.supplyCollateral(estimatedShares)
    totalDepositAssets += assets
    suppliedCollateralAssets += estimatedShares
    return estimatedShares
  }
  const maxDepositAssetsFromLoanToken = (loanTokenAmount: bigint) =>
    quoteDepositAssetOutFromLoanToken({
      route: depositAssetRoute,
      loanTokenAmount,
    })
  const loanTokenRequiredForDepositAssets = (depositAssets: bigint) =>
    requiredLoanTokenForDepositAssetOut({
      route: depositAssetRoute,
      depositAssetAmount: depositAssets,
    })
  const findSafeBorrowAssets = (position: AccrualPosition, requestedBorrowAssets: bigint) => {
    if (requestedBorrowAssets <= 0n) return 0n

    try {
      position.borrow(requestedBorrowAssets, 0n)
      return requestedBorrowAssets
    } catch {
      let low = 0n
      let high = requestedBorrowAssets
      let best = 0n

      for (let index = 0; index < 24 && low < high; index += 1) {
        const mid = low + (high - low + 1n) / 2n

        try {
          position.borrow(mid, 0n)
          best = mid
          low = mid
        } catch {
          high = mid - 1n
        }
      }

      return best
    }
  }

  const callbackBorrowLiquidityAfterFlash = minBigInt(remainingMarketBorrowLiquidity, remainingMorphoCallbackBalance)
  const maxFundableDepositAssets = maxDepositAssetsFromLoanToken(parameters.walletAssets + additionalBorrowTarget)

  if (parameters.targetDepositAssets > maxFundableDepositAssets) {
    const remainingBorrowCapacity = working.getBorrowCapacityLimit()?.value ?? 0n
    const safeAdditionalBorrowCapacity = findSafeBorrowAssets(
      working,
      minBigInt(remainingBorrowCapacity, callbackBorrowLiquidityAfterFlash),
    )
    const maxTargetBorrowAssetsAfterConstraints =
      working.borrowAssets + safeAdditionalBorrowCapacity

    return {
      walletAssetsIn: parameters.walletAssets,
      flashAssets: parameters.flashAssets,
      currentBorrowAssets,
      targetDepositAssets: parameters.targetDepositAssets,
      targetBorrowAssets: parameters.targetBorrowAssets,
      initialDepositAssets: 0n,
      totalDepositAssets: 0n,
      suppliedCollateralAssets: 0n,
      additionalBorrowAssets: 0n,
      maxSafeBorrowAfterInitialDeposit,
      callbackBorrowLiquidityAfterFlash,
      maxTargetBorrowAssetsAfterConstraints,
      finalBorrowAssets: working.borrowAssets,
      finalBorrowShares: working.borrowShares,
      netLoanTokenOut: 0n,
      finalPosition: working,
      loopEnabled: parameters.targetDepositAssets > initialAvailableLoanToken,
      iterationCount: 0,
      iterations,
      completed: false,
      message:
        'Requested target deposit exceeds what the wallet loan token plus the requested final additional borrow can fund after the vault-asset route. Increase Wallet assets in or raise Target borrow after.',
    }
  }

  for (let index = 0; index < maxIterations; index += 1) {
    if (remainingDepositAssets === 0n && remainingBorrowAssets === 0n) break

    const maxDepositAssetsThisLeg = maxDepositAssetsFromLoanToken(availableLoanToken)
    const depositAssets = minBigInt(maxDepositAssetsThisLeg, remainingDepositAssets)
    const loanTokenSpentForDeposit = loanTokenRequiredForDepositAssets(depositAssets)
    const depositShares = supplyDepositedAssets(depositAssets)
    if (depositAssets > 0n) {
      availableLoanToken -= loanTokenSpentForDeposit
      remainingDepositAssets -= depositAssets
      if (iterations.length === 0) {
        initialDepositAssets = depositAssets
        maxSafeBorrowAfterInitialDeposit =
          working.borrowAssets + findSafeBorrowAssets(working, working.getBorrowCapacityLimit()?.value ?? 0n)
      }
    }

    const borrowCapacity = working.getBorrowCapacityLimit()?.value ?? 0n
    const remainingCallbackBorrowLiquidity = minBigInt(remainingMarketBorrowLiquidity, remainingMorphoCallbackBalance)
    const requestedBorrowAssets = minBigInt(
      minBigInt(remainingBorrowAssets, borrowCapacity),
      remainingCallbackBorrowLiquidity,
    )
    const borrowAssets = findSafeBorrowAssets(working, requestedBorrowAssets)
    let borrowShares = 0n

    if (borrowAssets > 0n) {
      const borrowResult = working.borrow(borrowAssets, 0n)
      working = borrowResult.position
      borrowShares = borrowResult.shares
      availableLoanToken += borrowResult.assets
      remainingBorrowAssets -= borrowResult.assets
      remainingMorphoCallbackBalance -= borrowResult.assets
      remainingMarketBorrowLiquidity -= borrowResult.assets
      totalBorrowAssets += borrowResult.assets
      totalBorrowShares += borrowResult.shares
    }

    iterations.push({
      index,
      depositAssets,
      loanTokenSpentForDeposit,
      depositShares,
      borrowAssets,
      borrowShares,
      loanTokenBalanceAfter: availableLoanToken,
      totalDepositAssetsAfter: totalDepositAssets,
      totalBorrowAssetsAfter: totalBorrowAssets,
      borrowAssetsAfter: working.borrowAssets,
      borrowSharesAfter: working.borrowShares,
      collateralAfter: working.collateral,
    })

    if (depositAssets === 0n && borrowAssets === 0n) {
      break
    }
  }

  const remainingBorrowCapacity = working.getBorrowCapacityLimit()?.value ?? 0n
  const remainingCallbackBorrowLiquidity = minBigInt(remainingMarketBorrowLiquidity, remainingMorphoCallbackBalance)
  const safeAdditionalBorrowCapacity = findSafeBorrowAssets(
    working,
    minBigInt(remainingBorrowCapacity, remainingCallbackBorrowLiquidity),
  )
  const maxTargetBorrowAssetsAfterConstraints =
    working.borrowAssets + safeAdditionalBorrowCapacity
  const completed = remainingDepositAssets === 0n && remainingBorrowAssets === 0n
  const usedLoop = iterations.length > 1 || parameters.targetDepositAssets > initialAvailableLoanToken

  let message: string | undefined
  if (!completed) {
    if (remainingBorrowAssets > 0n && remainingCallbackBorrowLiquidity === 0n) {
      message =
        'Requested target borrow exceeds callback borrow liquidity after the flash loan even after attempting deposit looping. Reduce Flash assets or lower Target borrow after.'
    } else if (remainingBorrowAssets > 0n && remainingBorrowCapacity === 0n) {
      message =
        'Deposit loop reached the safe borrow limit before the requested target borrow was reached. Increase Wallet assets in, reduce Target deposit, or lower Target borrow after.'
    } else if (remainingDepositAssets > 0n && availableLoanToken === 0n && remainingBorrowAssets === 0n) {
      message =
        'Deposit loop ran out of loan-token balance after applying the vault-asset route before the requested target deposit was reached. Increase Wallet assets in or raise Target borrow after.'
    } else {
      message = 'Deposit loop hit the configured iteration limit before the requested target was completed.'
    }
  }

  return {
    walletAssetsIn: parameters.walletAssets,
    flashAssets: parameters.flashAssets,
    currentBorrowAssets,
    targetDepositAssets: parameters.targetDepositAssets,
    targetBorrowAssets: parameters.targetBorrowAssets,
    initialDepositAssets,
    totalDepositAssets,
    suppliedCollateralAssets,
    additionalBorrowAssets: totalBorrowAssets,
    maxSafeBorrowAfterInitialDeposit,
    callbackBorrowLiquidityAfterFlash,
    maxTargetBorrowAssetsAfterConstraints,
    finalBorrowAssets: working.borrowAssets,
    finalBorrowShares: working.borrowShares,
    netLoanTokenOut: availableLoanToken > parameters.flashAssets ? availableLoanToken - parameters.flashAssets : 0n,
    finalPosition: working,
    loopEnabled: usedLoop,
    iterationCount: iterations.length,
    iterations,
    completed,
    message,
  }
}

function buildLoopExecution(parameters: MorphoBundlerRedeemParameters): {
  callbackActions: Action[]
  summary: MorphoBundlerLoopSummary
} {
  const callbackActions: Action[] = []
  const iterations: MorphoBundlerLoopIteration[] = []
  const maxIterations = parameters.maxIterations ?? 12
  let working = cloneAccrualPosition(parameters.accrualPosition)
  let remainingWithdrawCollateral = parameters.withdrawCollateralAssets
  let availableLoanToken = parameters.flashAssets
  let totalRepayAssets = 0n
  let totalWithdrawCollateralAssets = 0n
  let totalRedeemAssets = 0n

  for (let index = 0; index < maxIterations; index += 1) {
    if (working.borrowShares === 0n && remainingWithdrawCollateral === 0n) break

    let repayMode: RepayMode = 'exact-assets'
    let repayAssets = 0n
    let repayShares = 0n

    if (working.borrowShares > 0n) {
      const fullRepayResult = working.repay(0n, working.borrowShares)
      const canFullyRepay = availableLoanToken >= fullRepayResult.assets

      if (canFullyRepay) {
        repayMode = 'full-shares'
        repayAssets = fullRepayResult.assets
        repayShares = fullRepayResult.shares
        working = fullRepayResult.position
      } else {
        if (availableLoanToken <= 0n) {
          return {
            callbackActions,
            summary: {
              enabled: true,
              completed: false,
              iterations,
              iterationCount: iterations.length,
              totalRepayAssets,
              totalWithdrawCollateralAssets,
              totalRedeemAssets,
              netLoanTokenOut: availableLoanToken,
              finalPosition: working,
              message: 'Loop stopped because no loan-token balance remained for the next repay leg.',
            },
          }
        }

        const partialRepayResult = working.repay(availableLoanToken, 0n)
        repayAssets = partialRepayResult.assets
        repayShares = partialRepayResult.shares
        working = partialRepayResult.position
      }

      availableLoanToken -= repayAssets
      totalRepayAssets += repayAssets
      callbackActions.push(buildRepayAction(parameters.marketParams, parameters.account, repayMode, repayAssets))
    }

    const requestedWithdraw = working.borrowShares === 0n
      ? remainingWithdrawCollateral
      : minBigInt(remainingWithdrawCollateral, working.withdrawableCollateral ?? 0n)
    const safeWithdrawCollateralAssets = findSafeWithdrawCollateral(working, requestedWithdraw)
    const withdrawCollateralAssets =
      working.borrowShares === 0n
        ? safeWithdrawCollateralAssets
        : applyLoopWithdrawCollateralBuffer(safeWithdrawCollateralAssets)
    let redeemAssets = 0n

    if (withdrawCollateralAssets > 0n) {
      working = working.withdrawCollateral(withdrawCollateralAssets)
      remainingWithdrawCollateral -= withdrawCollateralAssets
      totalWithdrawCollateralAssets += withdrawCollateralAssets
      redeemAssets = previewRedeem(
        withdrawCollateralAssets,
        parameters.withdrawCollateralAssets,
        parameters.previewRedeemAssets,
      )
      totalRedeemAssets += redeemAssets
      availableLoanToken += redeemAssets

      callbackActions.push(
        {
          type: 'morphoWithdrawCollateral',
          args: [
            parameters.marketParams,
            withdrawCollateralAssets,
            getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1,
            false,
          ],
        },
        {
          type: 'erc4626Redeem',
          args: [
            parameters.vault,
            withdrawCollateralAssets,
            parameters.minVaultSharePriceE27,
            getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1,
            getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1,
            false,
          ],
        },
      )
    }

    iterations.push({
      index,
      repayMode,
      repayAssets,
      repayShares,
      withdrawCollateralAssets,
      redeemAssets,
      loanTokenBalanceAfter: availableLoanToken,
      borrowAssetsAfter: working.borrowAssets,
      borrowSharesAfter: working.borrowShares,
      collateralAfter: working.collateral,
    })

    if (repayAssets === 0n && withdrawCollateralAssets === 0n) {
      return {
        callbackActions,
        summary: {
          enabled: true,
          completed: false,
          iterations,
          iterationCount: iterations.length,
          totalRepayAssets,
          totalWithdrawCollateralAssets,
          totalRedeemAssets,
          netLoanTokenOut: availableLoanToken,
          finalPosition: working,
          message: 'Loop made no progress. Increase flash assets or reduce the requested exit size.',
        },
      }
    }
  }

  return {
    callbackActions,
    summary: {
      enabled: true,
      completed: working.borrowShares === 0n && remainingWithdrawCollateral === 0n,
      iterations,
      iterationCount: iterations.length,
      totalRepayAssets,
      totalWithdrawCollateralAssets,
      totalRedeemAssets,
      netLoanTokenOut: availableLoanToken,
      finalPosition: working,
      message:
        working.borrowShares === 0n && remainingWithdrawCollateral === 0n
          ? undefined
          : 'Loop hit the configured iteration limit before the full exit completed.',
    },
  }
}

function buildRepayAction(
  marketParams: MarketParams,
  account: Address,
  repayMode: RepayMode,
  repayAssets: bigint,
): Action {
  if (repayMode === 'full-shares') {
    return {
      type: 'morphoRepay',
      args: [
        marketParams,
        0n,
        maxUint256,
        MAX_ABSOLUTE_SHARE_PRICE,
        account,
        [],
        false,
      ],
    }
  }

  return {
    type: 'morphoRepay',
    args: [
      marketParams,
      repayAssets,
      0n,
      MAX_ABSOLUTE_SHARE_PRICE,
      account,
      [],
      false,
    ],
  }
}

function previewRedeem(shares: bigint, totalShares: bigint, totalAssets: bigint) {
  if (shares <= 0n || totalShares <= 0n || totalAssets <= 0n) return 0n
  if (shares === totalShares) return totalAssets
  return (shares * totalAssets) / totalShares
}

function findSafeWithdrawCollateral(position: AccrualPosition, requestedAssets: bigint) {
  if (requestedAssets <= 0n) return 0n

  let low = 0n
  let high = requestedAssets

  while (low < high) {
    const mid = (low + high + 1n) >> 1n
    try {
      position.withdrawCollateral(mid)
      low = mid
    } catch {
      high = mid - 1n
    }
  }

  return low
}

function applyLoopWithdrawCollateralBuffer(assets: bigint) {
  if (assets <= 1n) return assets

  const bufferedAssets = (assets * (10_000n - LOOP_WITHDRAW_COLLATERAL_BUFFER_BPS)) / 10_000n
  if (bufferedAssets <= 0n) return 1n
  if (bufferedAssets >= assets) return assets - 1n
  return bufferedAssets
}

function minBigInt(left: bigint, right: bigint) {
  return left < right ? left : right
}

function assertRedeemParameters(parameters: MorphoBundlerRedeemParameters) {
  if (parameters.flashAssets <= 0n) throw new Error('flashAssets must be greater than zero.')
  if (parameters.withdrawCollateralAssets <= 0n) {
    throw new Error('withdrawCollateralAssets must be greater than zero.')
  }
  if (parameters.minVaultSharePriceE27 < 0n) {
    throw new Error('minVaultSharePriceE27 cannot be negative.')
  }
  if (parameters.authorizationDeadline <= 0n) {
    throw new Error('authorizationDeadline must be greater than zero.')
  }
  if (parameters.previewRedeemAssets < 0n) {
    throw new Error('previewRedeemAssets cannot be negative.')
  }
  if (parameters.repayMode === 'exact-assets' && (!parameters.repayAssets || parameters.repayAssets <= 0n)) {
    throw new Error('repayAssets must be greater than zero in exact-assets mode.')
  }
  if (
    parameters.repayMode === 'full-shares' &&
    parameters.flashAssets < parameters.accrualPosition.borrowAssets &&
    parameters.withdrawCollateralAssets !== parameters.accrualPosition.collateral
  ) {
    throw new Error(
      'Full borrow-shares mode with flash assets below the debt can only be completed when withdrawing all collateral through loop mode.',
    )
  }
}

function assertDepositParameters(parameters: MorphoBundlerDepositParameters) {
  if (parameters.depositAssetRoute?.kind === 'psm') {
    if (parameters.depositAssetRoute.sellGemFeeWad < 0n || parameters.depositAssetRoute.sellGemFeeWad >= 10n ** 18n) {
      throw new Error('depositAssetRoute.sellGemFeeWad must be between 0 and 1e18 - 1.')
    }
    if (parameters.depositAssetRoute.buyGemFeeWad < 0n || parameters.depositAssetRoute.buyGemFeeWad >= 10n ** 18n) {
      throw new Error('depositAssetRoute.buyGemFeeWad must be between 0 and 1e18 - 1.')
    }
    if (parameters.depositAssetRoute.to18ConversionFactor <= 0n) {
      throw new Error('depositAssetRoute.to18ConversionFactor must be greater than zero.')
    }
  }
  if (parameters.flashLoanLiquidityAssets < 0n) throw new Error('flashLoanLiquidityAssets cannot be negative.')
  if (parameters.marketBorrowLiquidityAssets < 0n) throw new Error('marketBorrowLiquidityAssets cannot be negative.')
  if (parameters.walletAssets < 0n) throw new Error('walletAssets cannot be negative.')
  if (parameters.flashAssets < 0n) throw new Error('flashAssets cannot be negative.')
  if (parameters.targetDepositAssets <= 0n) {
    throw new Error('targetDepositAssets must be greater than zero.')
  }
  if (parameters.walletAssets + parameters.flashAssets <= 0n) {
    throw new Error('walletAssets + flashAssets must be greater than zero for the initial deposit leg.')
  }
  if (parameters.flashAssets > parameters.flashLoanLiquidityAssets) {
    throw new Error('flashAssets exceed Morpho current loan-token liquidity.')
  }
  if (parameters.targetBorrowAssets < parameters.accrualPosition.borrowAssets) {
    throw new Error('targetBorrowAssets cannot be below the current Morpho borrow.')
  }
  if (parameters.flashAssets > 0n) {
    const additionalBorrowTarget = parameters.targetBorrowAssets - parameters.accrualPosition.borrowAssets
    if (additionalBorrowTarget < parameters.flashAssets) {
      throw new Error(
        'When using a flash loan, targetBorrowAssets must be at least currentBorrow + flashAssets so the flash principal can be repaid from the final liquid borrow.',
      )
    }
  }
  if (parameters.borrowSlippageBps < 0n || parameters.borrowSlippageBps >= 10_000n) {
    throw new Error('borrowSlippageBps must be between 0 and 9999.')
  }
  if (parameters.maxVaultSharePriceE27 <= 0n) {
    throw new Error('maxVaultSharePriceE27 must be greater than zero.')
  }
  if (parameters.authorizationDeadline <= 0n) {
    throw new Error('authorizationDeadline must be greater than zero.')
  }
  if (parameters.previewDepositShares <= 0n) {
    throw new Error('previewDepositShares must be greater than zero.')
  }
}
