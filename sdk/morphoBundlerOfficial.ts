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
export type RedeemFlashAssetKind = 'loan-token' | 'vault-shares'
export type DepositFlashAssetKind = 'loan-token' | 'vault-shares'

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
  flashAssetKind?: RedeemFlashAssetKind
  flashLoanRedeemAssets?: bigint
  flashLoanRepaymentAssets?: bigint
  flashLoanMinSharePriceE27?: bigint
  flashLoanMaxSharePriceE27?: bigint
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

type ResolvedRedeemFlashContext = {
  flashAssetKind: RedeemFlashAssetKind
  flashLoanToken: Address
  flashLoanAmount: bigint
  initialLoanTokenBalance: bigint
  openingActions: Action[]
  closingActions: Action[]
  requiredLoanTokenBalanceAtCallbackEnd: bigint
  insufficientBalanceMessage: string
}

export type MorphoBundlerDepositParameters = {
  chainId: number
  account: Address
  marketParams: MarketParams
  vault: Address
  depositAssetRoute?: MorphoBundlerDepositAssetRoute
  flashAssetKind?: DepositFlashAssetKind
  flashLoanLiquidityAssets: bigint
  flashLoanLiquidityShares?: bigint
  marketBorrowLiquidityAssets: bigint
  walletAssets: bigint
  flashAssets: bigint
  flashLoanCollateralAssets?: bigint
  flashLoanRepaymentAssets?: bigint
  flashLoanMaxSharePriceE27?: bigint
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
  flashAssetKind: DepositFlashAssetKind
  walletAssetsIn: bigint
  flashAssets: bigint
  flashLoanCollateralAssets: bigint
  flashLoanRepaymentAssets: bigint
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

type ResolvedDepositFlashContext = {
  flashAssetKind: DepositFlashAssetKind
  flashLoanToken: Address
  flashLoanAmount: bigint
  initialLoanTokenBalance: bigint
  initialSuppliedCollateralShares: bigint
  initialDepositAssetsEquivalent: bigint
  openingActions: Action[]
  closingActions: Action[]
  requiredLoanTokenBalanceAtCallbackEnd: bigint
  insufficientBalanceMessage: string
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
  const flashContext = resolveRedeemFlashContext(parameters)
  const authorization = buildMorphoAuthorizationPair({
    chainId: parameters.chainId,
    account: parameters.account,
    nonce: parameters.authorizationNonce,
    deadline: parameters.authorizationDeadline,
    autoRevoke: parameters.autoRevoke,
    skipInitialAuthorization: parameters.skipInitialAuthorization,
  })
  const execution = shouldUseLoopExecution(parameters, flashContext.initialLoanTokenBalance)
    ? buildLoopExecution(parameters, flashContext)
    : buildSingleExecution(parameters, flashContext)

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
      flashContext.flashLoanToken,
      flashContext.flashLoanAmount,
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
  const flashContext = resolveDepositFlashContext(parameters)
  const authorization = buildMorphoAuthorizationPair({
    chainId: parameters.chainId,
    account: parameters.account,
    nonce: parameters.authorizationNonce,
    deadline: parameters.authorizationDeadline,
    autoRevoke: parameters.autoRevoke,
    skipInitialAuthorization: parameters.skipInitialAuthorization,
  })
  const execution = buildDepositExecution(parameters, flashContext)
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
        flashContext.flashLoanToken,
        flashContext.flashLoanAmount,
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

function getRedeemFlashAssetKind(parameters: MorphoBundlerRedeemParameters): RedeemFlashAssetKind {
  return parameters.flashAssetKind ?? 'loan-token'
}

function getTargetRepayAssets(parameters: MorphoBundlerRedeemParameters) {
  return parameters.repayMode === 'full-shares'
    ? parameters.accrualPosition.borrowAssets
    : parameters.repayAssets ?? 0n
}

function resolveRedeemFlashContext(parameters: MorphoBundlerRedeemParameters): ResolvedRedeemFlashContext {
  const adapter = getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1
  const flashAssetKind = getRedeemFlashAssetKind(parameters)

  if (flashAssetKind === 'vault-shares') {
    return {
      flashAssetKind,
      flashLoanToken: parameters.vault,
      flashLoanAmount: parameters.flashAssets,
      initialLoanTokenBalance: parameters.flashLoanRedeemAssets ?? 0n,
      openingActions: [
        {
          type: 'erc4626Redeem',
          args: [
            parameters.vault,
            parameters.flashAssets,
            parameters.flashLoanMinSharePriceE27 ?? 0n,
            adapter,
            adapter,
            false,
          ],
        },
      ],
      closingActions: [
        {
          type: 'erc4626Mint',
          args: [
            parameters.vault,
            parameters.flashAssets,
            parameters.flashLoanMaxSharePriceE27 ?? 0n,
            adapter,
            false,
          ],
        },
      ],
      requiredLoanTokenBalanceAtCallbackEnd: parameters.flashLoanRepaymentAssets ?? 0n,
      insufficientBalanceMessage:
        'Redeemed loan-token assets are insufficient to re-wrap the wrapped flash-loan shares. Increase collateral withdrawal or reduce the repay target.',
    }
  }

  return {
    flashAssetKind,
    flashLoanToken: parameters.marketParams.loanToken,
    flashLoanAmount: parameters.flashAssets,
    initialLoanTokenBalance: parameters.flashAssets,
    openingActions: [],
    closingActions: [],
    requiredLoanTokenBalanceAtCallbackEnd: parameters.flashAssets,
    insufficientBalanceMessage:
      'Redeemed loan-token assets are insufficient to repay the flash-loan principal. Increase collateral withdrawal or reduce the repay target.',
  }
}

function finalizeRedeemFlashBalance(context: ResolvedRedeemFlashContext, loanTokenBalance: bigint) {
  if (loanTokenBalance < context.requiredLoanTokenBalanceAtCallbackEnd) {
    return {
      completed: false,
      netLoanTokenOut: 0n,
      message: context.insufficientBalanceMessage,
    }
  }

  return {
    completed: true,
    netLoanTokenOut: loanTokenBalance - context.requiredLoanTokenBalanceAtCallbackEnd,
    message: undefined,
  }
}

function getDepositFlashAssetKind(parameters: MorphoBundlerDepositParameters): DepositFlashAssetKind {
  return parameters.flashAssetKind ?? 'loan-token'
}

function resolveDepositFlashContext(parameters: MorphoBundlerDepositParameters): ResolvedDepositFlashContext {
  const adapter = getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1
  const flashAssetKind = getDepositFlashAssetKind(parameters)

  if (flashAssetKind === 'vault-shares') {
    return {
      flashAssetKind,
      flashLoanToken: parameters.vault,
      flashLoanAmount: parameters.flashAssets,
      initialLoanTokenBalance: 0n,
      initialSuppliedCollateralShares: parameters.flashAssets,
      initialDepositAssetsEquivalent: parameters.flashLoanCollateralAssets ?? 0n,
      openingActions:
        parameters.flashAssets > 0n
          ? [
              {
                type: 'morphoSupplyCollateral',
                args: [parameters.marketParams, maxUint256, parameters.account, [], false],
              },
            ]
          : [],
      closingActions:
        parameters.flashAssets > 0n
          ? [
              {
                type: 'erc4626Mint',
                args: [
                  parameters.vault,
                  parameters.flashAssets,
                  parameters.flashLoanMaxSharePriceE27 ?? 0n,
                  adapter,
                  false,
                ],
              },
            ]
          : [],
      requiredLoanTokenBalanceAtCallbackEnd: parameters.flashLoanRepaymentAssets ?? 0n,
      insufficientBalanceMessage:
        'Borrowed loan tokens are insufficient to mint back the wrapped flash-loan shares. Reduce the share flash helper, increase wallet assets, or raise Target borrow after.',
    }
  }

  return {
    flashAssetKind,
    flashLoanToken: parameters.marketParams.loanToken,
    flashLoanAmount: parameters.flashAssets,
    initialLoanTokenBalance: parameters.flashAssets,
    initialSuppliedCollateralShares: 0n,
    initialDepositAssetsEquivalent: 0n,
    openingActions: [],
    closingActions: [],
    requiredLoanTokenBalanceAtCallbackEnd: parameters.flashAssets,
    insufficientBalanceMessage:
      'Borrowed loan tokens are insufficient to repay the flash-loan principal. Reduce the flash helper or raise Target borrow after.',
  }
}

function finalizeDepositFlashBalance(context: ResolvedDepositFlashContext, loanTokenBalance: bigint) {
  if (loanTokenBalance < context.requiredLoanTokenBalanceAtCallbackEnd) {
    return {
      completed: false,
      netLoanTokenOut: 0n,
      message: context.insufficientBalanceMessage,
    }
  }

  return {
    completed: true,
    netLoanTokenOut: loanTokenBalance - context.requiredLoanTokenBalanceAtCallbackEnd,
    message: undefined,
  }
}

function shouldUseLoopExecution(
  parameters: MorphoBundlerRedeemParameters,
  initialLoanTokenBalance: bigint,
) {
  return initialLoanTokenBalance < getTargetRepayAssets(parameters)
}

function buildDepositExecution(
  parameters: MorphoBundlerDepositParameters,
  flashContext: ResolvedDepositFlashContext,
): {
  callbackActions: Action[]
  summary: MorphoBundlerDepositSummary
} {
  const callbackActions: Action[] = [...flashContext.openingActions]
  const summary = simulateDepositExecution(parameters, flashContext)
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

  if (summary.completed) {
    callbackActions.push(...flashContext.closingActions)
  }

  return { callbackActions, summary }
}

function buildSingleExecution(
  parameters: MorphoBundlerRedeemParameters,
  flashContext: ResolvedRedeemFlashContext,
): {
  callbackActions: Action[]
  summary: MorphoBundlerLoopSummary
} {
  const summary = simulateSingleExecution(parameters, flashContext)
  if (!summary.completed) {
    throw new Error(summary.message || 'The redeem callback cannot repay the flash loan with the requested inputs.')
  }

  const adapter = getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1
  const callbackActions: Action[] = [
    ...flashContext.openingActions,
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
          adapter,
          false,
        ],
      },
      {
        type: 'erc4626Redeem',
        args: [
          parameters.vault,
          parameters.withdrawCollateralAssets,
          parameters.minVaultSharePriceE27,
          adapter,
          adapter,
          false,
        ],
      },
    )
  }

  callbackActions.push(...flashContext.closingActions)
  return { callbackActions, summary }
}

function simulateSingleExecution(
  parameters: MorphoBundlerRedeemParameters,
  flashContext: ResolvedRedeemFlashContext,
): MorphoBundlerLoopSummary {
  let working = cloneAccrualPosition(parameters.accrualPosition)
  let loanTokenBalance = flashContext.initialLoanTokenBalance
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

  const finalization = finalizeRedeemFlashBalance(flashContext, loanTokenBalance)

  return {
    enabled: false,
    completed: finalization.completed,
    iterations,
    iterationCount: iterations.length,
    totalRepayAssets: repayResult.assets,
    totalWithdrawCollateralAssets,
    totalRedeemAssets: totalRedeemedAssets,
    netLoanTokenOut: finalization.netLoanTokenOut,
    finalPosition: working,
    message: finalization.message,
  }
}

function simulateDepositExecution(
  parameters: MorphoBundlerDepositParameters,
  flashContext: ResolvedDepositFlashContext,
): MorphoBundlerDepositSummary {
  const depositAssetRoute = parameters.depositAssetRoute
  const currentBorrowAssets = parameters.accrualPosition.borrowAssets
  const additionalBorrowTarget = parameters.targetBorrowAssets - currentBorrowAssets
  const initialAvailableLoanToken = parameters.walletAssets + flashContext.initialLoanTokenBalance
  let working = cloneAccrualPosition(parameters.accrualPosition)
  let availableLoanToken = initialAvailableLoanToken
  let remainingDepositAssets =
    parameters.targetDepositAssets > flashContext.initialDepositAssetsEquivalent
      ? parameters.targetDepositAssets - flashContext.initialDepositAssetsEquivalent
      : 0n
  let remainingBorrowAssets = additionalBorrowTarget
  let remainingMorphoCallbackBalance =
    parameters.flashLoanLiquidityAssets > flashContext.initialLoanTokenBalance
      ? parameters.flashLoanLiquidityAssets - flashContext.initialLoanTokenBalance
      : 0n
  let remainingMarketBorrowLiquidity = parameters.marketBorrowLiquidityAssets
  let totalDepositAssets = flashContext.initialDepositAssetsEquivalent
  let suppliedCollateralAssets = flashContext.initialSuppliedCollateralShares
  let totalBorrowAssets = 0n
  let totalBorrowShares = 0n
  const iterations: MorphoBundlerDepositLoopIteration[] = []
  const maxIterations = 24
  let maxSafeBorrowAfterInitialDeposit = currentBorrowAssets
  let initialDepositAssets = flashContext.initialDepositAssetsEquivalent

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

  if (flashContext.initialSuppliedCollateralShares > 0n) {
    working = working.supplyCollateral(flashContext.initialSuppliedCollateralShares)
    maxSafeBorrowAfterInitialDeposit =
      working.borrowAssets + findSafeBorrowAssets(working, working.getBorrowCapacityLimit()?.value ?? 0n)
  }

  const callbackBorrowLiquidityAfterFlash = minBigInt(remainingMarketBorrowLiquidity, remainingMorphoCallbackBalance)
  const maxLoanTokenFundableForDeposits =
    parameters.walletAssets + flashContext.initialLoanTokenBalance + additionalBorrowTarget >
    flashContext.requiredLoanTokenBalanceAtCallbackEnd
      ? parameters.walletAssets +
        flashContext.initialLoanTokenBalance +
        additionalBorrowTarget -
        flashContext.requiredLoanTokenBalanceAtCallbackEnd
      : 0n
  const maxFundableDepositAssets =
    flashContext.initialDepositAssetsEquivalent + maxDepositAssetsFromLoanToken(maxLoanTokenFundableForDeposits)

  if (parameters.targetDepositAssets > maxFundableDepositAssets) {
    const remainingBorrowCapacity = working.getBorrowCapacityLimit()?.value ?? 0n
    const safeAdditionalBorrowCapacity = findSafeBorrowAssets(
      working,
      minBigInt(remainingBorrowCapacity, callbackBorrowLiquidityAfterFlash),
    )
    const maxTargetBorrowAssetsAfterConstraints =
      working.borrowAssets + safeAdditionalBorrowCapacity

    return {
      flashAssetKind: flashContext.flashAssetKind,
      walletAssetsIn: parameters.walletAssets,
      flashAssets: parameters.flashAssets,
      flashLoanCollateralAssets: flashContext.initialDepositAssetsEquivalent,
      flashLoanRepaymentAssets: flashContext.requiredLoanTokenBalanceAtCallbackEnd,
      currentBorrowAssets,
      targetDepositAssets: parameters.targetDepositAssets,
      targetBorrowAssets: parameters.targetBorrowAssets,
      initialDepositAssets,
      totalDepositAssets,
      suppliedCollateralAssets,
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
        initialDepositAssets = totalDepositAssets
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
  const finalization = finalizeDepositFlashBalance(flashContext, availableLoanToken)
  const completed = remainingDepositAssets === 0n && remainingBorrowAssets === 0n && finalization.completed
  const initialSingleLegCapacity =
    flashContext.initialDepositAssetsEquivalent + maxDepositAssetsFromLoanToken(initialAvailableLoanToken)
  const usedLoop = iterations.length > 1 || parameters.targetDepositAssets > initialSingleLegCapacity

  let message: string | undefined
  if (!completed) {
    if (remainingDepositAssets === 0n && remainingBorrowAssets === 0n) {
      message = finalization.message
    } else if (remainingBorrowAssets > 0n && remainingCallbackBorrowLiquidity === 0n) {
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
    flashAssetKind: flashContext.flashAssetKind,
    walletAssetsIn: parameters.walletAssets,
    flashAssets: parameters.flashAssets,
    flashLoanCollateralAssets: flashContext.initialDepositAssetsEquivalent,
    flashLoanRepaymentAssets: flashContext.requiredLoanTokenBalanceAtCallbackEnd,
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
    netLoanTokenOut: completed ? finalization.netLoanTokenOut : 0n,
    finalPosition: working,
    loopEnabled: usedLoop,
    iterationCount: iterations.length,
    iterations,
    completed,
    message,
  }
}

function buildLoopExecution(
  parameters: MorphoBundlerRedeemParameters,
  flashContext: ResolvedRedeemFlashContext,
): {
  callbackActions: Action[]
  summary: MorphoBundlerLoopSummary
} {
  const adapter = getChainAddresses(parameters.chainId as ChainId).bundler3.generalAdapter1
  const callbackActions: Action[] = [...flashContext.openingActions]
  const iterations: MorphoBundlerLoopIteration[] = []
  const maxIterations = parameters.maxIterations ?? 12
  let working = cloneAccrualPosition(parameters.accrualPosition)
  let remainingRepayAssets = getTargetRepayAssets(parameters)
  let remainingWithdrawCollateral = parameters.withdrawCollateralAssets
  let availableLoanToken = flashContext.initialLoanTokenBalance
  let totalRepayAssets = 0n
  let totalWithdrawCollateralAssets = 0n
  let totalRedeemAssets = 0n

  for (let index = 0; index < maxIterations; index += 1) {
    if (remainingRepayAssets === 0n && remainingWithdrawCollateral === 0n) break

    let repayMode: RepayMode = 'exact-assets'
    let repayAssets = 0n
    let repayShares = 0n

    if (remainingRepayAssets > 0n && working.borrowShares > 0n) {
      const fullRepayResult = working.repay(0n, working.borrowShares)
      const wantsFullRepay = remainingRepayAssets >= fullRepayResult.assets
      const canFullyRepay = availableLoanToken >= fullRepayResult.assets

      if (wantsFullRepay && canFullyRepay) {
        repayMode = 'full-shares'
        repayAssets = fullRepayResult.assets
        repayShares = fullRepayResult.shares
        working = fullRepayResult.position
        remainingRepayAssets = 0n
      } else {
        const requestedRepayAssets = minBigInt(availableLoanToken, remainingRepayAssets)
        if (requestedRepayAssets > 0n) {
          const partialRepayResult = working.repay(requestedRepayAssets, 0n)
          repayAssets = partialRepayResult.assets
          repayShares = partialRepayResult.shares
          working = partialRepayResult.position
          remainingRepayAssets = remainingRepayAssets > repayAssets ? remainingRepayAssets - repayAssets : 0n
        }
      }

      if (working.borrowShares === 0n) {
        remainingRepayAssets = 0n
      }

      if (repayAssets > 0n) {
        availableLoanToken -= repayAssets
        totalRepayAssets += repayAssets
        callbackActions.push(buildRepayAction(parameters.marketParams, parameters.account, repayMode, repayAssets))
      }
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
            adapter,
            false,
          ],
        },
        {
          type: 'erc4626Redeem',
          args: [
            parameters.vault,
            withdrawCollateralAssets,
            parameters.minVaultSharePriceE27,
            adapter,
            adapter,
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
          netLoanTokenOut: 0n,
          finalPosition: working,
          message:
            remainingRepayAssets > 0n
              ? 'Loop made no progress toward the requested repay. Increase the collateral withdrawal, switch flash asset, or reduce the repay target.'
              : 'Loop made no progress toward the requested collateral withdrawal. Reduce the withdrawal target or raise the repay amount.',
        },
      }
    }
  }

  const finalization = finalizeRedeemFlashBalance(flashContext, availableLoanToken)
  const completed = remainingRepayAssets === 0n && remainingWithdrawCollateral === 0n && finalization.completed
  if (completed) {
    callbackActions.push(...flashContext.closingActions)
  }

  return {
    callbackActions,
    summary: {
      enabled: true,
      completed,
      iterations,
      iterationCount: iterations.length,
      totalRepayAssets,
      totalWithdrawCollateralAssets,
      totalRedeemAssets,
      netLoanTokenOut: completed ? finalization.netLoanTokenOut : 0n,
      finalPosition: working,
      message:
        completed
          ? undefined
          : finalization.message ??
            (remainingRepayAssets > 0n
              ? 'Loop hit the configured iteration limit before the requested repay completed.'
              : 'Loop hit the configured iteration limit before the requested collateral withdrawal completed.'),
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
  if (getRedeemFlashAssetKind(parameters) === 'vault-shares') {
    if (!parameters.flashLoanRedeemAssets || parameters.flashLoanRedeemAssets <= 0n) {
      throw new Error('flashLoanRedeemAssets must be greater than zero when flashAssetKind is vault-shares.')
    }
    if (!parameters.flashLoanRepaymentAssets || parameters.flashLoanRepaymentAssets <= 0n) {
      throw new Error('flashLoanRepaymentAssets must be greater than zero when flashAssetKind is vault-shares.')
    }
    if (!parameters.flashLoanMinSharePriceE27 || parameters.flashLoanMinSharePriceE27 <= 0n) {
      throw new Error('flashLoanMinSharePriceE27 must be greater than zero when flashAssetKind is vault-shares.')
    }
    if (!parameters.flashLoanMaxSharePriceE27 || parameters.flashLoanMaxSharePriceE27 <= 0n) {
      throw new Error('flashLoanMaxSharePriceE27 must be greater than zero when flashAssetKind is vault-shares.')
    }
  }
}

function assertDepositParameters(parameters: MorphoBundlerDepositParameters) {
  const flashAssetKind = getDepositFlashAssetKind(parameters)
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
  if (flashAssetKind === 'vault-shares') {
    if (parameters.walletAssets <= 0n && parameters.flashAssets <= 0n) {
      throw new Error('walletAssets or flashAssets must be greater than zero for the initial leverage leg.')
    }
  } else if (parameters.walletAssets + parameters.flashAssets <= 0n) {
    throw new Error('walletAssets + flashAssets must be greater than zero for the initial deposit leg.')
  }
  if (flashAssetKind === 'vault-shares') {
    if (parameters.depositAssetRoute?.kind === 'psm') {
      throw new Error('flashAssetKind=vault-shares currently supports only direct depositAssetRoute.')
    }
    if (parameters.flashAssets > 0n) {
      if (!parameters.flashLoanLiquidityShares || parameters.flashLoanLiquidityShares <= 0n) {
        throw new Error('flashLoanLiquidityShares must be greater than zero when flashAssetKind is vault-shares.')
      }
      if (parameters.flashAssets > parameters.flashLoanLiquidityShares) {
        throw new Error('flashAssets exceed Morpho current wrapped-share flash-loan liquidity.')
      }
      if (!parameters.flashLoanCollateralAssets || parameters.flashLoanCollateralAssets <= 0n) {
        throw new Error('flashLoanCollateralAssets must be greater than zero when flashAssetKind is vault-shares.')
      }
      if (!parameters.flashLoanRepaymentAssets || parameters.flashLoanRepaymentAssets <= 0n) {
        throw new Error('flashLoanRepaymentAssets must be greater than zero when flashAssetKind is vault-shares.')
      }
      if (!parameters.flashLoanMaxSharePriceE27 || parameters.flashLoanMaxSharePriceE27 <= 0n) {
        throw new Error('flashLoanMaxSharePriceE27 must be greater than zero when flashAssetKind is vault-shares.')
      }
    }
  } else if (parameters.flashAssets > parameters.flashLoanLiquidityAssets) {
    throw new Error('flashAssets exceed Morpho current loan-token liquidity.')
  }
  if (parameters.targetBorrowAssets < parameters.accrualPosition.borrowAssets) {
    throw new Error('targetBorrowAssets cannot be below the current Morpho borrow.')
  }
  if (parameters.flashAssets > 0n) {
    const additionalBorrowTarget = parameters.targetBorrowAssets - parameters.accrualPosition.borrowAssets
    if (
      flashAssetKind === 'loan-token' &&
      additionalBorrowTarget < parameters.flashAssets
    ) {
      throw new Error(
        'When using a flash loan, targetBorrowAssets must be at least currentBorrow + flashAssets so the flash principal can be repaid from the final liquid borrow.',
      )
    }
    if (flashAssetKind === 'vault-shares') {
      const flashLoanCollateralAssets = parameters.flashLoanCollateralAssets ?? 0n
      const flashLoanRepaymentAssets = parameters.flashLoanRepaymentAssets ?? 0n
      const remainingDepositAssets =
        parameters.targetDepositAssets > flashLoanCollateralAssets
          ? parameters.targetDepositAssets - flashLoanCollateralAssets
          : 0n
      const requiredDepositFunding = requiredLoanTokenForDepositAssetOut({
        route: parameters.depositAssetRoute,
        depositAssetAmount: remainingDepositAssets,
      })
      const minimumAdditionalBorrowTarget =
        requiredDepositFunding + flashLoanRepaymentAssets > parameters.walletAssets
          ? requiredDepositFunding + flashLoanRepaymentAssets - parameters.walletAssets
          : 0n
      if (additionalBorrowTarget < minimumAdditionalBorrowTarget) {
        throw new Error(
          'targetBorrowAssets are too low to both fund the requested deposit and mint back the wrapped flash-loan shares.',
        )
      }
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
