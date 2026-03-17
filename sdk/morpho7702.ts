import {
  encodeFunctionData,
  maxUint256,
  numberToHex,
  type Address,
  type Authorization,
  type AuthorizationRequest,
  type Hex,
} from 'viem'

import { erc20Abi, erc4626Abi, morpho7702DelegatorAbi } from './abis.js'

export const REPAY_MODE_EXACT_ASSETS = 0 as const
export const REPAY_MODE_FULL_SHARES = 1 as const
export const EXIT_MODE_NONE = 0 as const
export const EXIT_MODE_ERC4626_REDEEM = 1 as const
export const WITHDRAW_ALL_COLLATERAL = maxUint256

export type RepayMode =
  | typeof REPAY_MODE_EXACT_ASSETS
  | typeof REPAY_MODE_FULL_SHARES
  | 'exact-assets'
  | 'full-shares'

export type ExitMode =
  | typeof EXIT_MODE_NONE
  | typeof EXIT_MODE_ERC4626_REDEEM
  | 'none'
  | 'erc4626-redeem'

export type BuilderCall = {
  target: Address
  value?: bigint
  data: Hex
}

export type MarketParams = {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

export type FlashPlanInput = {
  marketParams: MarketParams
  flashAssets: bigint
  repayMode: RepayMode
  repayAssets?: bigint
  withdrawCollateralAssets?: bigint
  minLoanTokenProfit?: bigint
  exitMode?: ExitMode
  exitTarget?: Address
  postCalls?: readonly BuilderCall[]
  afterCalls?: readonly BuilderCall[]
}

export type EncodedCall = {
  target: Address
  value: bigint
  data: Hex
}

export type EncodedFlashPlan = {
  marketParams: MarketParams
  flashAssets: bigint
  repayAssets: bigint
  withdrawCollateralAssets: bigint
  minLoanTokenProfit: bigint
  repayMode: typeof REPAY_MODE_EXACT_ASSETS | typeof REPAY_MODE_FULL_SHARES
  exitMode: typeof EXIT_MODE_NONE | typeof EXIT_MODE_ERC4626_REDEEM
  exitTarget: Address
  postCalls: EncodedCall[]
  afterCalls: EncodedCall[]
}

export type AuthorizationMode = 'self-sponsored' | 'external-executor'

export type Eip7702ExecutionRequest = {
  chainId: number
  to: Address
  data: Hex
  value: bigint
  type: 'eip7702'
  authorizationList: readonly (AuthorizationRequest<bigint> | Authorization<bigint>)[]
}

export type WalletSendCallsRequest = {
  version: string
  from: Address
  chainId: Hex
  atomicRequired: true
  calls: readonly [
    {
      to: Address
      value: Hex
      data: Hex
    },
  ]
  capabilities?: Record<string, unknown>
}

export type RpcAuthorizationRequest = {
  address: Address
  chainId: Hex
  nonce: Hex
  yParity?: Hex
  r?: Hex
  s?: Hex
}

export type RpcEip7702TransactionRequest = {
  from: Address
  to: Address
  data: Hex
  value: Hex
  chainId: Hex
  type: '0x4'
  authorizationList: readonly RpcAuthorizationRequest[]
}

export function normalizeRepayMode(mode: RepayMode): EncodedFlashPlan['repayMode'] {
  if (mode === REPAY_MODE_EXACT_ASSETS || mode === 'exact-assets') return REPAY_MODE_EXACT_ASSETS
  if (mode === REPAY_MODE_FULL_SHARES || mode === 'full-shares') return REPAY_MODE_FULL_SHARES
  throw new Error(`Unsupported repay mode: ${String(mode)}`)
}

export function normalizeExitMode(mode: ExitMode | undefined): EncodedFlashPlan['exitMode'] {
  if (typeof mode === 'undefined' || mode === EXIT_MODE_NONE || mode === 'none') return EXIT_MODE_NONE
  if (mode === EXIT_MODE_ERC4626_REDEEM || mode === 'erc4626-redeem') return EXIT_MODE_ERC4626_REDEEM
  throw new Error(`Unsupported exit mode: ${String(mode)}`)
}

export function buildFlashPlan(input: FlashPlanInput): EncodedFlashPlan {
  const repayMode = normalizeRepayMode(input.repayMode)
  const exitMode = normalizeExitMode(input.exitMode)
  const repayAssets = input.repayAssets ?? 0n
  const withdrawCollateralAssets = input.withdrawCollateralAssets ?? WITHDRAW_ALL_COLLATERAL

  if (input.flashAssets <= 0n) throw new Error('flashAssets must be > 0')
  if (repayMode === REPAY_MODE_EXACT_ASSETS && repayAssets <= 0n) {
    throw new Error('repayAssets must be > 0 when repayMode is exact-assets')
  }
  if (repayMode === REPAY_MODE_EXACT_ASSETS && repayAssets > input.flashAssets) {
    throw new Error('repayAssets cannot exceed flashAssets in exact-assets mode')
  }
  if (exitMode === EXIT_MODE_ERC4626_REDEEM && !input.exitTarget) {
    throw new Error('exitTarget is required when exitMode is erc4626-redeem')
  }

  return {
    marketParams: input.marketParams,
    flashAssets: input.flashAssets,
    repayAssets,
    withdrawCollateralAssets,
    minLoanTokenProfit: input.minLoanTokenProfit ?? 0n,
    repayMode,
    exitMode,
    exitTarget: input.exitTarget ?? input.marketParams.collateralToken,
    postCalls: normalizeCalls(input.postCalls),
    afterCalls: normalizeCalls(input.afterCalls),
  }
}

export function encodeExecute(plan: FlashPlanInput | EncodedFlashPlan): Hex {
  const normalizedPlan = isEncodedPlan(plan) ? plan : buildFlashPlan(plan)
  return encodeFunctionData({
    abi: morpho7702DelegatorAbi,
    functionName: 'execute',
    args: [normalizedPlan],
  })
}

export function buildUnsignedAuthorization(parameters: {
  delegator: Address
  chainId: number | bigint
  authorityNonce: number | bigint
  mode?: AuthorizationMode
}): AuthorizationRequest<bigint> {
  const { delegator, chainId, authorityNonce } = parameters
  const mode = parameters.mode ?? 'self-sponsored'
  const nonce = BigInt(authorityNonce) + (mode === 'self-sponsored' ? 1n : 0n)

  return {
    address: delegator,
    chainId: BigInt(chainId),
    nonce,
  }
}

export function buildEip7702ExecutionRequest(parameters: {
  authority: Address
  chainId: number
  delegator: Address
  authorityNonce: number | bigint
  plan: FlashPlanInput | EncodedFlashPlan
  authorizationMode?: AuthorizationMode
  authorization?: Authorization<bigint>
  value?: bigint
}): Eip7702ExecutionRequest {
  const authorization =
    parameters.authorization ??
    buildUnsignedAuthorization({
      delegator: parameters.delegator,
      chainId: parameters.chainId,
      authorityNonce: parameters.authorityNonce,
      mode: parameters.authorizationMode,
    })

  return {
    type: 'eip7702',
    chainId: parameters.chainId,
    to: parameters.authority,
    data: encodeExecute(parameters.plan),
    value: parameters.value ?? 0n,
    authorizationList: [authorization],
  }
}

export function buildEip7702CallRequest(parameters: {
  authority: Address
  chainId: number
  delegator: Address
  authorityNonce: number | bigint
  data: Hex
  authorizationMode?: AuthorizationMode
  authorization?: Authorization<bigint>
  value?: bigint
}): Eip7702ExecutionRequest {
  const authorization =
    parameters.authorization ??
    buildUnsignedAuthorization({
      delegator: parameters.delegator,
      chainId: parameters.chainId,
      authorityNonce: parameters.authorityNonce,
      mode: parameters.authorizationMode,
    })

  return {
    type: 'eip7702',
    chainId: parameters.chainId,
    to: parameters.authority,
    data: parameters.data,
    value: parameters.value ?? 0n,
    authorizationList: [authorization],
  }
}

// This helper only wraps the self-call. It does not invent a proprietary 7702 capability.
// Use it when the wallet already delegated the account or when the wallet exposes its own 7702 capability field.
export function buildWalletSendCallsRequest(parameters: {
  authority: Address
  chainId: number
  plan: FlashPlanInput | EncodedFlashPlan
  version?: string
  capabilities?: Record<string, unknown>
}): WalletSendCallsRequest {
  return {
    version: parameters.version ?? '1.0',
    from: parameters.authority,
    chainId: numberToHex(parameters.chainId),
    atomicRequired: true,
    calls: [
      {
        to: parameters.authority,
        value: '0x0',
        data: encodeExecute(parameters.plan),
      },
    ],
    ...(parameters.capabilities ? { capabilities: parameters.capabilities } : {}),
  }
}

export function buildRpcEip7702TransactionRequest(parameters: {
  authority: Address
  chainId: number
  delegator: Address
  authorityNonce: number | bigint
  plan: FlashPlanInput | EncodedFlashPlan
  authorizationMode?: AuthorizationMode
  authorization?: Authorization<bigint>
  value?: bigint
}): RpcEip7702TransactionRequest {
  const request = buildEip7702ExecutionRequest(parameters)

  return {
    from: parameters.authority,
    to: request.to,
    data: request.data,
    value: numberToHex(request.value),
    chainId: numberToHex(parameters.chainId),
    type: '0x4',
    authorizationList: request.authorizationList.map(toRpcAuthorizationRequest),
  }
}

export function buildRpcEip7702CallRequest(parameters: {
  authority: Address
  chainId: number
  delegator: Address
  authorityNonce: number | bigint
  data: Hex
  authorizationMode?: AuthorizationMode
  authorization?: Authorization<bigint>
  value?: bigint
}): RpcEip7702TransactionRequest {
  const request = buildEip7702CallRequest(parameters)

  return {
    from: parameters.authority,
    to: request.to,
    data: request.data,
    value: numberToHex(request.value),
    chainId: numberToHex(parameters.chainId),
    type: '0x4',
    authorizationList: request.authorizationList.map(toRpcAuthorizationRequest),
  }
}

export function buildDelegationProbeData(parameters: {
  marketParams: MarketParams
}): Hex {
  return encodeFunctionData({
    abi: morpho7702DelegatorAbi,
    functionName: 'marketId',
    args: [parameters.marketParams],
  })
}

export function buildErc4626RedeemCall(parameters: {
  vault: Address
  shares: bigint
  account: Address
}): EncodedCall {
  return {
    target: parameters.vault,
    value: 0n,
    data: encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'redeem',
      args: [parameters.shares, parameters.account, parameters.account],
    }),
  }
}

export function buildErc20TransferCall(parameters: {
  token: Address
  to: Address
  amount: bigint
}): EncodedCall {
  return {
    target: parameters.token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [parameters.to, parameters.amount],
    }),
  }
}

function normalizeCalls(calls: readonly BuilderCall[] | undefined): EncodedCall[] {
  if (!calls) return []
  return calls.map((call) => ({
    target: call.target,
    value: call.value ?? 0n,
    data: call.data,
  }))
}

function isEncodedPlan(plan: FlashPlanInput | EncodedFlashPlan): plan is EncodedFlashPlan {
  return typeof (plan as EncodedFlashPlan).exitMode === 'number'
}

function toRpcAuthorizationRequest(
  authorization: AuthorizationRequest<bigint> | Authorization<bigint>,
): RpcAuthorizationRequest {
  const address =
    'contractAddress' in authorization ? authorization.contractAddress : authorization.address

  if (!address) {
    throw new Error('Authorization must include a delegate contract address.')
  }

  const rpcAuthorization: RpcAuthorizationRequest = {
    address,
    chainId: numberToHex(authorization.chainId),
    nonce: numberToHex(authorization.nonce),
  }

  if ('r' in authorization && typeof authorization.r !== 'undefined') {
    rpcAuthorization.r = authorization.r
  }
  if ('s' in authorization && typeof authorization.s !== 'undefined') {
    rpcAuthorization.s = authorization.s
  }
  if ('yParity' in authorization && typeof authorization.yParity !== 'undefined') {
    rpcAuthorization.yParity = numberToHex(authorization.yParity)
  }

  return rpcAuthorization
}
