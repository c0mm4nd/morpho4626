import { ChainId, getChainAddresses, type Address } from '@morpho-org/blue-sdk'
import { getAuthorizationTypedData } from '@morpho-org/blue-sdk-viem'
import {
  BundlerAction,
  MAX_ABSOLUTE_SHARE_PRICE,
  type Action,
  type Authorization,
} from '@morpho-org/bundler-sdk-viem'
import {
  encodeAbiParameters,
  keccak256,
  maxUint256,
  numberToHex,
  type Hex,
} from 'viem'

export type MarketParams = {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

export type RepayMode = 'full-shares' | 'exact-assets'

export type MorphoAuthorizationPair = {
  authorize: Authorization
  authorizeTypedData: ReturnType<typeof getAuthorizationTypedData>
  revoke?: Authorization
  revokeTypedData?: ReturnType<typeof getAuthorizationTypedData>
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
  authorizeSignature?: Hex | null
  revokeSignature?: Hex | null
}

export type MorphoBundlerRedeemPlan = {
  authorization: MorphoAuthorizationPair
  actions: Action[]
  bundlerAddress: Address
  generalAdapter1: Address
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

export function buildMorphoAuthorizationPair(parameters: {
  chainId: number
  account: Address
  nonce: bigint
  deadline: bigint
  autoRevoke?: boolean
}): MorphoAuthorizationPair {
  const normalizedChainId = parameters.chainId as ChainId
  const { bundler3 } = getChainAddresses(normalizedChainId)

  const authorize: Authorization = {
    authorizer: parameters.account,
    authorized: bundler3.generalAdapter1,
    isAuthorized: true,
    nonce: parameters.nonce,
    deadline: parameters.deadline,
  }

  const result: MorphoAuthorizationPair = {
    authorize,
    authorizeTypedData: getAuthorizationTypedData(authorize, normalizedChainId),
  }

  if (!parameters.autoRevoke) return result

  const revoke: Authorization = {
    ...authorize,
    isAuthorized: false,
    nonce: parameters.nonce + 1n,
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
  })

  const repayAction: Action =
    parameters.repayMode === 'full-shares'
      ? {
          type: 'morphoRepay',
          args: [
            parameters.marketParams,
            0n,
            maxUint256,
            MAX_ABSOLUTE_SHARE_PRICE,
            parameters.account,
            [],
            false,
          ],
        }
      : {
          type: 'morphoRepay',
          args: [
            parameters.marketParams,
            parameters.repayAssets ?? 0n,
            0n,
            MAX_ABSOLUTE_SHARE_PRICE,
            parameters.account,
            [],
            false,
          ],
        }

  const callbackActions: Action[] = [
    repayAction,
    {
      type: 'morphoWithdrawCollateral',
      args: [
        parameters.marketParams,
        parameters.withdrawCollateralAssets,
        bundler3.generalAdapter1,
        false,
      ],
    },
    {
      type: 'erc4626Redeem',
      args: [
        parameters.vault,
        parameters.withdrawCollateralAssets,
        parameters.minVaultSharePriceE27,
        bundler3.generalAdapter1,
        bundler3.bundler3,
        false,
      ],
    },
  ]

  const actions: Action[] = []

  if (!parameters.skipInitialAuthorization) {
    actions.push({
      type: 'morphoSetAuthorizationWithSig',
      args: [
        authorization.authorize,
        parameters.authorizeSignature ?? null,
        false,
      ],
    })
  }

  actions.push({
    type: 'morphoFlashLoan',
    args: [
      parameters.marketParams.loanToken,
      parameters.flashAssets,
      callbackActions,
      false,
    ],
  })


  if (parameters.autoRevoke) {
    actions.push({
      type: 'morphoSetAuthorizationWithSig',
      args: [
        authorization.revoke!,
        parameters.revokeSignature ?? null,
        false,
      ],
    })
  }

  return {
    authorization,
    actions,
    bundlerAddress: bundler3.bundler3,
    generalAdapter1: bundler3.generalAdapter1,
  }
}

export function buildMorphoBundlerRedeemTransactionRequest(
  parameters: MorphoBundlerRedeemParameters & {
    from: Address
    authorizeSignature?: Hex
    revokeSignature?: Hex
  },
) {
  const plan = buildMorphoBundlerRedeemPlan(parameters)

  if (plan.actions.some((action) => action.type === 'morphoSetAuthorizationWithSig' && action.args[1] == null)) {
    throw new Error('Authorization signatures are required before encoding the bundler transaction.')
  }

  const transaction = BundlerAction.encodeBundle(parameters.chainId as ChainId, plan.actions)

  return {
    plan,
    transaction,
    request: {
      from: parameters.from,
      to: transaction.to,
      data: transaction.data,
      value: numberToHex(transaction.value),
    },
  }
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
  if (parameters.repayMode === 'exact-assets' && (!parameters.repayAssets || parameters.repayAssets <= 0n)) {
    throw new Error('repayAssets must be greater than zero in exact-assets mode.')
  }
}
