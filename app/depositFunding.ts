import { getChainAddresses, type Address } from '@morpho-org/blue-sdk'
import { BundlerAction, bundler3Abi, type Action, type BundlerCall } from '@morpho-org/bundler-sdk-viem'
import { encodeFunctionData, maxUint256, numberToHex, parseAbi, zeroHash, type Hex } from 'viem'

import {
  computeMinSharePriceE27,
  type MarketParams,
  type MorphoAuthorizationPair,
  type MorphoBundlerDepositAssetRoute,
  type MorphoBundlerDepositLoopIteration,
} from '../sdk/morphoBundlerOfficial.js'

const erc20ApproveAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)'])
const litePsmWrapperAbi = parseAbi([
  'function sellGem(address usr,uint256 gemAmt) returns (uint256 usdsAmt)',
  'function buyGem(address usr,uint256 gemAmt) returns (uint256 usdsAmt)',
  'function tin() view returns (uint256)',
  'function tout() view returns (uint256)',
  'function to18ConversionFactor() view returns (uint256)',
])

const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const DAI_MAINNET = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address
const USDS_MAINNET = '0xdC035D45d973E3EC169d2276DDab16f1e407384F' as Address
const LITE_PSM_USDC_DAI_MAINNET = '0xf6e72Db5454dd049d0788e411b06CfAF16853042' as Address
const LITE_PSM_WRAPPER_USDC_USDS_MAINNET = '0xA188EEC8F81263234dA3622A406892F3D630f98c' as Address

export type RawBundlerAction = {
  type: 'rawCall'
  args: [Address, Hex, bigint, boolean, string?]
}

export type BundlerExecutionAction = Action | RawBundlerAction

export type BundlerExecutionPlan<T extends { actions: Action[] }> = Omit<T, 'actions'> & {
  actions: BundlerExecutionAction[]
}

export type SupportedLitePsmRouteConfig = {
  chainId: number
  loanToken: Address
  vaultAsset: Address
  wrapper: Address
}

export const SUPPORTED_LITE_PSM_ROUTES: SupportedLitePsmRouteConfig[] = [
  {
    chainId: 1,
    loanToken: USDC_MAINNET,
    vaultAsset: USDS_MAINNET,
    wrapper: LITE_PSM_WRAPPER_USDC_USDS_MAINNET,
  },
  {
    chainId: 1,
    loanToken: USDC_MAINNET,
    vaultAsset: DAI_MAINNET,
    wrapper: LITE_PSM_USDC_DAI_MAINNET,
  },
]

export function findSupportedLitePsmRouteConfig(parameters: {
  chainId: number
  loanToken: Address
  vaultAsset: Address
  customRoutes?: SupportedLitePsmRouteConfig[]
}) {
  const lookupRoutes = [...(parameters.customRoutes ?? []), ...SUPPORTED_LITE_PSM_ROUTES]
  return (
    lookupRoutes.find(
      (route) =>
        route.chainId === parameters.chainId &&
        route.loanToken.toLowerCase() === parameters.loanToken.toLowerCase() &&
        route.vaultAsset.toLowerCase() === parameters.vaultAsset.toLowerCase(),
    ) ?? null
  )
}

export function resolveDepositAssetRoute(parameters: {
  chainId: number
  loanToken: Address
  vaultAsset: Address
  customRoutes?: SupportedLitePsmRouteConfig[]
  sellGemFeeWad?: bigint
  buyGemFeeWad?: bigint
  to18ConversionFactor?: bigint
}): MorphoBundlerDepositAssetRoute | null {
  if (parameters.loanToken.toLowerCase() === parameters.vaultAsset.toLowerCase()) {
    return {
      kind: 'direct',
      loanToken: parameters.loanToken,
      vaultAsset: parameters.vaultAsset,
    }
  }

  const matchedRoute = findSupportedLitePsmRouteConfig({
    chainId: parameters.chainId,
    loanToken: parameters.loanToken,
    vaultAsset: parameters.vaultAsset,
    customRoutes: parameters.customRoutes,
  })
  if (!matchedRoute) return null
  if (parameters.sellGemFeeWad == null || parameters.buyGemFeeWad == null || parameters.to18ConversionFactor == null) {
    return null
  }

  return {
    kind: 'psm',
    loanToken: matchedRoute.loanToken,
    vaultAsset: matchedRoute.vaultAsset,
    psmWrapper: matchedRoute.wrapper,
    sellGemFeeWad: parameters.sellGemFeeWad,
    buyGemFeeWad: parameters.buyGemFeeWad,
    to18ConversionFactor: parameters.to18ConversionFactor,
  }
}

export function isRawBundlerAction(action: BundlerExecutionAction): action is RawBundlerAction {
  return action.type === 'rawCall'
}

export function isMorphoAuthorizationAction(
  action: BundlerExecutionAction,
): action is Extract<Action, { type: 'morphoSetAuthorizationWithSig' }> {
  return action.type === 'morphoSetAuthorizationWithSig'
}

function isPsmDepositAssetRoute(
  route: MorphoBundlerDepositAssetRoute,
): route is Extract<MorphoBundlerDepositAssetRoute, { kind: 'psm' }> {
  return route.kind === 'psm'
}

export function encodeBundlerExecutionRequest(parameters: {
  chainId: number
  from: Address
  actions: BundlerExecutionAction[]
}) {
  if (
    parameters.actions.some(
      (action) => !isRawBundlerAction(action) && action.type === 'morphoSetAuthorizationWithSig' && action.args[1] == null,
    )
  ) {
    throw new Error('Authorization signatures are required before encoding the bundler transaction.')
  }

  const {
    bundler3: { bundler3, generalAdapter1 },
  } = getChainAddresses(parameters.chainId)

  let value = 0n
  for (const action of parameters.actions) {
    if (isRawBundlerAction(action) || action.type !== 'nativeTransfer') continue
    const [owner, recipient, amount] = action.args
    if (
      owner !== bundler3 &&
      owner !== generalAdapter1 &&
      (recipient === bundler3 || recipient === generalAdapter1)
    ) {
      value += amount
    }
  }

  const encodedActions = parameters.actions.flatMap((action) => encodeExecutionAction(parameters.chainId, action))
  const transaction = {
    to: bundler3,
    value,
    data: encodeFunctionData({
      abi: bundler3Abi,
      functionName: 'multicall',
      args: [encodedActions],
    }),
  }

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

function encodeExecutionAction(chainId: number, action: BundlerExecutionAction): BundlerCall[] {
  if (isRawBundlerAction(action)) {
    return [
      {
        to: action.args[0],
        data: action.args[1],
        value: action.args[2],
        skipRevert: action.args[3],
        callbackHash: zeroHash,
      },
    ]
  }

  if (action.type === 'morphoFlashLoan') {
    const [token, assets, callbackActions, skipRevert] = action.args
    return BundlerAction.morphoFlashLoan(
      chainId,
      token,
      assets,
      callbackActions.flatMap((callbackAction) => encodeExecutionAction(chainId, callbackAction as BundlerExecutionAction)),
      skipRevert,
    )
  }

  return BundlerAction.encode(chainId, action)
}

export function buildPsmAwareDepositActions(parameters: {
  chainId: number
  account: Address
  authorization: MorphoAuthorizationPair
  marketParams: MarketParams
  vault: Address
  walletAssets: bigint
  flashAssets: bigint
  maxVaultSharePriceE27: bigint
  borrowSlippageBps: bigint
  route: MorphoBundlerDepositAssetRoute
  iterations: MorphoBundlerDepositLoopIteration[]
  bundleHasFlashCallback: boolean
  autoRevoke?: boolean
}): BundlerExecutionAction[] {
  const { bundler3 } = getChainAddresses(parameters.chainId)
  const adapter = bundler3.generalAdapter1
  const psmRoute = isPsmDepositAssetRoute(parameters.route) ? parameters.route : null
  const needsCallbackRoute = psmRoute != null && parameters.bundleHasFlashCallback
  const needsWalletPrefundRoute = psmRoute != null && !parameters.bundleHasFlashCallback && parameters.walletAssets > 0n

  if (
    psmRoute &&
    !parameters.bundleHasFlashCallback &&
    parameters.iterations.slice(1).some((iteration) => iteration.depositAssets > 0n)
  ) {
    throw new Error(
      'PSM-routed deposit loops that redeposit borrowed loan tokens require positive flash assets so the PSM route executes inside the Morpho flash-loan callback.',
    )
  }

  const actions: BundlerExecutionAction[] = []
  if (parameters.authorization.authorize) {
    actions.push({
      type: 'morphoSetAuthorizationWithSig',
      args: [parameters.authorization.authorize, null, false],
    })
  }

  if (needsWalletPrefundRoute) {
    actions.push({
      type: 'erc20TransferFrom',
      args: [parameters.marketParams.loanToken, parameters.walletAssets, bundler3.bundler3, false],
    })
    actions.push(buildApproveRawCall(parameters.marketParams.loanToken, psmRoute!.psmWrapper, parameters.walletAssets))
    actions.push(buildSellGemRawCall(psmRoute!.psmWrapper, adapter, parameters.walletAssets))
    actions.push(buildApproveRawCall(parameters.marketParams.loanToken, psmRoute!.psmWrapper, 0n))
  } else if (parameters.walletAssets > 0n) {
    actions.push({
      type: 'erc20TransferFrom',
      args: [parameters.marketParams.loanToken, parameters.walletAssets, adapter, false],
    })
  }

  const callbackActions = buildDepositCallbackActions(parameters)
  if (parameters.flashAssets > 0n) {
    actions.push({
      type: 'morphoFlashLoan',
      args: [parameters.marketParams.loanToken, parameters.flashAssets, callbackActions as Action[], false],
    })
  } else {
    actions.push(...callbackActions)
  }

  actions.push(
    {
      type: 'erc20Transfer',
      args: [parameters.marketParams.loanToken, parameters.account, maxUint256, adapter, false],
    },
    {
      type: 'erc20Transfer',
      args: [parameters.vault, parameters.account, maxUint256, adapter, false],
    },
  )

  if (parameters.route.kind === 'psm') {
    actions.push({
      type: 'erc20Transfer',
      args: [parameters.route.vaultAsset, parameters.account, maxUint256, adapter, false],
    })
  }

  if (parameters.authorization.revoke) {
    actions.push({
      type: 'morphoSetAuthorizationWithSig',
      args: [parameters.authorization.revoke, null, false],
    })
  }

  return actions
}

function buildDepositCallbackActions(parameters: {
  chainId: number
  account: Address
  marketParams: MarketParams
  vault: Address
  maxVaultSharePriceE27: bigint
  borrowSlippageBps: bigint
  route: MorphoBundlerDepositAssetRoute
  iterations: MorphoBundlerDepositLoopIteration[]
  bundleHasFlashCallback: boolean
}) {
  const adapter = getChainAddresses(parameters.chainId).bundler3.generalAdapter1
  const callbackActions: BundlerExecutionAction[] = []
  const psmRoute = isPsmDepositAssetRoute(parameters.route) ? parameters.route : null
  const needsPsmApproval = psmRoute != null && parameters.bundleHasFlashCallback

  if (needsPsmApproval) {
    callbackActions.push(buildApproveRawCall(parameters.marketParams.loanToken, psmRoute!.psmWrapper, maxUint256))
  }

  for (const iteration of parameters.iterations) {
    if (iteration.depositAssets > 0n) {
      if (psmRoute) {
        if (iteration.loanTokenSpentForDeposit <= 0n) {
          throw new Error('PSM-routed deposit iteration requires positive loan-token input.')
        }
        callbackActions.push(buildSellGemRawCall(psmRoute.psmWrapper, adapter, iteration.loanTokenSpentForDeposit))
      }

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
        args: [parameters.marketParams, iteration.borrowAssets, 0n, minBorrowSharePriceE27, adapter, false],
      })
    }
  }

  if (needsPsmApproval) {
    callbackActions.push(buildApproveRawCall(parameters.marketParams.loanToken, psmRoute!.psmWrapper, 0n))
  }

  return callbackActions
}

function buildApproveRawCall(token: Address, spender: Address, amount: bigint): RawBundlerAction {
  return {
    type: 'rawCall',
    args: [
      token,
      encodeFunctionData({
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [spender, amount],
      }),
      0n,
      false,
    ],
  }
}

function buildSellGemRawCall(psmWrapper: Address, receiver: Address, loanTokenAmount: bigint): RawBundlerAction {
  return {
    type: 'rawCall',
    args: [
      psmWrapper,
      encodeFunctionData({
        abi: litePsmWrapperAbi,
        functionName: 'sellGem',
        args: [receiver, loanTokenAmount],
      }),
      0n,
      false,
    ],
  }
}

export const litePsmWrapperViewAbi = litePsmWrapperAbi
