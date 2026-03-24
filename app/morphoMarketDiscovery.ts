import { getChainAddresses } from '@morpho-org/blue-sdk'
import { BLUE_API_GRAPHQL_URL } from '@morpho-org/morpho-ts'
import { createPublicClient, custom, isAddress, parseAbi, type Address, type Hex } from 'viem'

import { findSupportedLitePsmRouteConfig, type SupportedLitePsmRouteConfig } from './depositFunding.js'
import type { MarketParams } from '../sdk/morphoBundlerOfficial.js'

type ProviderWithRequest = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<any>
}

type DiscoveredVaultMarketCandidate = {
  marketId: Hex
  marketParams: MarketParams
  loanTokenSymbol: string
  loanTokenName: string
  collateralTokenSymbol: string
  collateralTokenName: string
  loanTokenDecimals: number
  collateralTokenDecimals: number
  vaultAddress: Address
  vaultAssetSymbol: string
  vaultAssetName: string
  vaultName: string
  underlyingName: string
  curatorName: string | null
  curatorAddress: Address | null
  marketSizeUsd: number | null
  marketLiquidityUsd: number | null
}

type CuratorInfo = {
  name: string | null
  verified: boolean
  addresses: Array<{ address: Address }>
}

const erc4626ProbeAbi = parseAbi([
  'function asset() view returns (address)',
  'function previewDeposit(uint256 assets) view returns (uint256 shares)',
  'function previewRedeem(uint256 shares) view returns (uint256 assets)',
])
const erc20MetadataAbi = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)'])

export type MorphoChainInfo = {
  id: number
  network: string
  currency: string
}

export type DiscoveredVaultMarket = {
  marketId: Hex
  marketParams: MarketParams
  loanTokenSymbol: string
  loanTokenName: string
  collateralTokenSymbol: string
  collateralTokenName: string
  loanTokenDecimals: number
  collateralTokenDecimals: number
  vaultAddress: Address
  vaultAsset: Address
  vaultAssetSymbol: string
  vaultAssetName: string
  vaultName: string
  underlyingName: string
  curatorName: string | null
  curatorAddress: Address | null
  marketSizeUsd: number | null
  marketLiquidityUsd: number | null
  depositRouteKind: 'direct' | 'psm'
  canDirectDeposit: boolean
  canDirectRedeem: boolean
}

export function supportsLocalMorphoChain(chainId: number) {
  try {
    getChainAddresses(chainId)
    return true
  } catch {
    return false
  }
}

export async function fetchMorphoChains(): Promise<MorphoChainInfo[]> {
  const data = await queryMorphoBlueApi<{ chains: MorphoChainInfo[] }>(`
    query MorphoChains {
      chains {
        id
        network
        currency
      }
    }
  `)

  return data.chains
}

export async function discoverErc4626MarketsOnChain(parameters: {
  provider: ProviderWithRequest
  chainId: number
  customLitePsmRoutes?: SupportedLitePsmRouteConfig[]
}): Promise<DiscoveredVaultMarket[]> {
  if (!supportsLocalMorphoChain(parameters.chainId)) {
    throw new Error('The current chain is not supported by the installed Morpho SDK.')
  }

  const discoveredCandidates: DiscoveredVaultMarketCandidate[] = []
  let skip = 0
  const first = 100

  for (;;) {
    const data = await queryMorphoBlueApi<{
      markets: {
        items: Array<{
          uniqueKey: Hex
          lltv: string
          irmAddress: Address
          oracle: { address: Address } | null
          state: {
            sizeUsd: number | null
            totalLiquidityUsd: number | null
            liquidityAssetsUsd: number | null
          } | null
          loanAsset: {
            address: Address
            symbol: string
            name: string | null
            decimals: number
          }
          collateralAsset:
            | {
                address: Address
                symbol: string
                name: string | null
                decimals: number
                vault:
                  | {
                      address: Address
                      name: string | null
                      asset: {
                        address: Address
                        symbol: string
                        name: string | null
                      } | null
                      state:
                        | {
                            totalAssetsUsd: number | null
                            totalAssets: string
                            curator: Address
                            curators: CuratorInfo[]
                          }
                        | null
                    }
                  | null
              }
            | null
        }>
        pageInfo: { count: number; countTotal: number }
      }
    }>(
      `
        query DiscoverMarkets($chainId: Int!, $first: Int!, $skip: Int!) {
          markets(first: $first, skip: $skip, where: { chainId_in: [$chainId], listed: true }) {
            items {
              uniqueKey
              lltv
              irmAddress
              oracle {
                address
              }
              state {
                sizeUsd
                totalLiquidityUsd
                liquidityAssetsUsd
              }
              loanAsset {
                address
                symbol
                name
                decimals
              }
              collateralAsset {
                address
                symbol
                name
                decimals
                vault {
                  address
                  name
                  asset {
                    address
                    symbol
                    name
                  }
                  state {
                    totalAssetsUsd
                    totalAssets
                    curator
                    curators {
                      name
                      verified
                      addresses {
                        address
                      }
                    }
                  }
                }
              }
            }
            pageInfo {
              count
              countTotal
            }
          }
        }
      `,
      {
        chainId: parameters.chainId,
        first,
        skip,
      },
    )

    for (const market of data.markets.items) {
      if (!market.collateralAsset || !market.oracle) continue

      const primaryCurator = pickPrimaryCurator(market.collateralAsset.vault?.state?.curators ?? [])
      const fallbackCuratorAddress = normalizeOptionalAddress(market.collateralAsset.vault?.state?.curator ?? null)

      discoveredCandidates.push({
        marketId: market.uniqueKey,
        marketParams: {
          loanToken: market.loanAsset.address,
          collateralToken: market.collateralAsset.address,
          oracle: market.oracle.address,
          irm: market.irmAddress,
          lltv: BigInt(market.lltv),
        },
        loanTokenSymbol: market.loanAsset.symbol,
        loanTokenName: market.loanAsset.name?.trim() || market.loanAsset.symbol,
        collateralTokenSymbol: market.collateralAsset.symbol,
        collateralTokenName: market.collateralAsset.name?.trim() || market.collateralAsset.symbol,
        loanTokenDecimals: Number(market.loanAsset.decimals),
        collateralTokenDecimals: Number(market.collateralAsset.decimals),
        vaultAddress: market.collateralAsset.address,
        vaultAssetSymbol: market.collateralAsset.vault?.asset?.symbol?.trim() || market.loanAsset.symbol,
        vaultAssetName:
          market.collateralAsset.vault?.asset?.name?.trim() ||
          market.loanAsset.name?.trim() ||
          market.loanAsset.symbol,
        vaultName:
          market.collateralAsset.vault?.name?.trim() ||
          market.collateralAsset.name?.trim() ||
          market.collateralAsset.symbol,
        underlyingName:
          market.collateralAsset.vault?.asset?.name?.trim() ||
          market.loanAsset.name?.trim() ||
          market.loanAsset.symbol,
        curatorName: primaryCurator?.name?.trim() || null,
        curatorAddress: primaryCurator?.address ?? fallbackCuratorAddress,
        marketSizeUsd: market.state?.sizeUsd ?? market.collateralAsset.vault?.state?.totalAssetsUsd ?? null,
        marketLiquidityUsd: market.state?.liquidityAssetsUsd ?? market.state?.totalLiquidityUsd ?? null,
      })
    }

    skip += data.markets.pageInfo.count
    if (skip >= data.markets.pageInfo.countTotal || data.markets.pageInfo.count === 0) break
  }

  const client = createPublicClient({
    transport: custom(parameters.provider),
  })

  const assetMatchedCandidates: Array<
    DiscoveredVaultMarketCandidate & {
      vaultAsset: Address
      vaultAssetDecimals: number
      depositRouteKind: 'direct' | 'psm'
    }
  > = []
  for (let index = 0; index < discoveredCandidates.length; index += 25) {
    const chunk = discoveredCandidates.slice(index, index + 25)
    const results = await Promise.all(
      chunk.map(async (candidate) => {
        try {
          const vaultAsset = assertAddress(await client.readContract({
            address: candidate.vaultAddress,
            abi: erc4626ProbeAbi,
            functionName: 'asset',
          }))
          const vaultAssetDecimals = Number(
            await client.readContract({
              address: vaultAsset,
              abi: erc20MetadataAbi,
              functionName: 'decimals',
            }),
          )
          const depositRouteKind =
            vaultAsset.toLowerCase() === candidate.marketParams.loanToken.toLowerCase()
              ? 'direct'
              : findSupportedLitePsmRouteConfig({
                    chainId: parameters.chainId,
                    loanToken: candidate.marketParams.loanToken,
                    vaultAsset,
                    customRoutes: parameters.customLitePsmRoutes,
                  })
                ? 'psm'
                : null

          if (!depositRouteKind) return null

          return {
            ...candidate,
            vaultAsset,
            vaultAssetDecimals,
            depositRouteKind,
          }
        } catch {
          return null
        }
      }),
    )

    assetMatchedCandidates.push(
      ...results.filter(
        (
          candidate,
        ): candidate is DiscoveredVaultMarketCandidate & {
          vaultAsset: Address
          vaultAssetDecimals: number
          depositRouteKind: 'direct' | 'psm'
        } => candidate != null,
      ),
    )
  }

  const discovered: DiscoveredVaultMarket[] = []
  for (let index = 0; index < assetMatchedCandidates.length; index += 12) {
    const chunk = assetMatchedCandidates.slice(index, index + 12)
    const results: Array<DiscoveredVaultMarket | null> = await Promise.all(
      chunk.map(async (candidate) => {
        const previewDepositShares = await previewPositiveDepositShares({
          client,
          vault: candidate.vaultAddress,
          decimals: candidate.vaultAssetDecimals,
        })

        if (previewDepositShares === 0n) return null

        const previewRedeemAssets = await previewPositiveRedeemAssets({
          client,
          vault: candidate.vaultAddress,
          shares: previewDepositShares,
        })

        const discoveredMarket: DiscoveredVaultMarket = {
          ...candidate,
          depositRouteKind: candidate.depositRouteKind,
          canDirectDeposit: true,
          canDirectRedeem: candidate.depositRouteKind === 'direct' && previewRedeemAssets > 0n,
        }

        return discoveredMarket
      }),
    )

    discovered.push(...results.filter((market): market is DiscoveredVaultMarket => market != null))
  }

  return discovered.sort(compareDiscoveredMarkets)
}

async function queryMorphoBlueApi<TData>(query: string, variables?: Record<string, unknown>) {
  const response = await fetch(BLUE_API_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`Morpho Blue API request failed with status ${response.status}.`)
  }

  const payload = (await response.json()) as {
    data?: TData
    errors?: Array<{ message?: string }>
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message || 'Unknown GraphQL error').join(' | '))
  }
  if (!payload.data) {
    throw new Error('Morpho Blue API returned no data.')
  }

  return payload.data
}

function compareDiscoveredMarkets(left: DiscoveredVaultMarket, right: DiscoveredVaultMarket) {
  if (left.canDirectRedeem !== right.canDirectRedeem) {
    return left.canDirectRedeem ? -1 : 1
  }

  const leftSize = left.marketSizeUsd ?? left.marketLiquidityUsd ?? 0
  const rightSize = right.marketSizeUsd ?? right.marketLiquidityUsd ?? 0
  if (leftSize !== rightSize) {
    return rightSize - leftSize
  }

  const leftLabel = `${left.vaultName} ${left.collateralTokenSymbol}/${left.loanTokenSymbol}`.toLowerCase()
  const rightLabel = `${right.vaultName} ${right.collateralTokenSymbol}/${right.loanTokenSymbol}`.toLowerCase()
  return leftLabel.localeCompare(rightLabel)
}

async function previewPositiveDepositShares(parameters: {
  client: ReturnType<typeof createPublicClient>
  vault: Address
  decimals: number
}) {
  for (const assets of buildProbeAssetAmounts(parameters.decimals)) {
    try {
      const shares = await parameters.client.readContract({
        address: parameters.vault,
        abi: erc4626ProbeAbi,
        functionName: 'previewDeposit',
        args: [assets],
      })
      if (shares > 0n) return shares
    } catch {
      continue
    }
  }

  return 0n
}

async function previewPositiveRedeemAssets(parameters: {
  client: ReturnType<typeof createPublicClient>
  vault: Address
  shares: bigint
}) {
  const attempts = parameters.shares > 0n ? [parameters.shares, parameters.shares * 1000n] : []

  for (const shares of attempts) {
    try {
      const assets = await parameters.client.readContract({
        address: parameters.vault,
        abi: erc4626ProbeAbi,
        functionName: 'previewRedeem',
        args: [shares],
      })
      if (assets > 0n) return assets
    } catch {
      continue
    }
  }

  return 0n
}

function buildProbeAssetAmounts(decimals: number) {
  const normalizedDecimals = BigInt(Math.max(0, Math.min(decimals, 18)))
  const oneUnit = 1n
  const oneToken = 10n ** normalizedDecimals
  const largerProbe = oneToken * 1000n

  return Array.from(new Set([oneUnit, oneToken, largerProbe].map((value) => value.toString()))).map((value) => BigInt(value))
}

function pickPrimaryCurator(curators: CuratorInfo[]) {
  const candidate = curators.find((curator) => curator.verified) ?? curators[0]
  if (!candidate) return null

  return {
    name: candidate.name || null,
    address: normalizeOptionalAddress(candidate.addresses[0]?.address ?? null),
  }
}

function normalizeOptionalAddress(value: string | null | undefined): Address | null {
  if (!value || !isAddress(value)) return null
  return value
}

function assertAddress(value: string): Address {
  if (!isAddress(value)) throw new Error(`Invalid address: ${value}`)
  return value
}
