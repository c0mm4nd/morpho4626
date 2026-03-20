import { useEffect, useMemo, useState } from 'react'
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  isAddress,
  numberToHex,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from 'viem'

import { AccrualPosition, getChainAddresses, type Market } from '@morpho-org/blue-sdk'
import { fetchMarket, fetchPosition, fetchToken, fetchUser, getAuthorizationTypedData } from '@morpho-org/blue-sdk-viem'

import {
  buildMarketId,
  buildMorphoBundlerDepositPlan,
  buildMorphoBundlerRedeemPlan,
  computeMaxSharePriceE27,
  computeMinSharePriceE27,
  encodeMorphoBundlerRedeemTransactionRequest,
  type MarketParams,
  type RepayMode,
} from '../sdk/morphoBundlerOfficial.js'
import { MarketSelector } from './MarketSelector.js'
import {
  discoverErc4626MarketsOnChain,
  fetchMorphoChains,
  type DiscoveredVaultMarket,
  type MorphoChainInfo,
  supportsLocalMorphoChain,
} from './morphoMarketDiscovery.js'

type Eip1193Provider = {
  isMetaMask?: boolean
  isOkxWallet?: boolean
  isOKExWallet?: boolean
  isCoinbaseWallet?: boolean
  isRabby?: boolean
  providers?: Eip1193Provider[]
  on?: (event: string, listener: (...args: any[]) => void) => void
  removeListener?: (event: string, listener: (...args: any[]) => void) => void
  request: (args: { method: string; params?: unknown[] | object }) => Promise<any>
}

type WindowWithWallets = Window & {
  ethereum?: Eip1193Provider
  okxwallet?: Eip1193Provider | { ethereum?: Eip1193Provider }
}

type Eip6963ProviderDetail = {
  info?: {
    name?: string
  }
  provider?: Eip1193Provider
}

type ProviderOption = {
  id: string
  label: string
  provider: Eip1193Provider
}

type StatusTone = 'idle' | 'success' | 'error'

type StatusMessage = {
  tone: StatusTone
  text: string
}

type BuilderMode = 'redeem' | 'deposit'

type BaseSnapshot = {
  marketId: Hex
  market: Market
  accrualPosition: AccrualPosition
  marketParams: MarketParams
  borrowShares: bigint
  borrowAssets: bigint
  collateral: bigint
  estimatedFullRepayAssets: bigint
  morphoNonce: bigint
  isBundlerAuthorized: boolean
  bundler3: Address
  generalAdapter1: Address
  loanTokenSymbol: string
  collateralTokenSymbol: string
  loanTokenDecimals: number
  collateralTokenDecimals: number
  maxFlashLoanAssets: bigint
  walletLoanTokenBalance: bigint
  walletLoanTokenAllowanceToAdapter: bigint
}

type VaultSnapshot = {
  asset: Address | null
  previewRedeemAssets: bigint
  redeemShares: bigint
  previewDepositShares: bigint
  depositAssets: bigint
}

type ResolvedMarketConfig = {
  marketId: Hex
  marketParams: MarketParams
  loanTokenDecimals: number
  collateralTokenDecimals: number
}

type RedeemExecutionPreview = {
  kind: 'redeem'
  repayAssets: bigint
  repayShares: bigint
  requestedWithdrawCollateral: bigint
  maxSafeWithdrawAfterRepay: bigint | undefined
  afterRepayPosition: AccrualPosition
  afterWithdrawPosition: AccrualPosition | null
  withdrawError: string | null
  loopIterations?: number
  netLoanTokenOut?: bigint
  usedLoop?: boolean
}

type DepositExecutionPreview = {
  kind: 'deposit'
  walletAssetsIn: bigint
  currentBorrowAssets: bigint
  targetBorrowAssets: bigint
  flashAssets: bigint
  initialDepositAssets: bigint
  totalDepositAssets: bigint
  previewDepositShares: bigint
  suppliedCollateralAssets: bigint
  additionalBorrowAssets: bigint
  maxSafeBorrowAfterInitialDeposit: bigint
  callbackBorrowLiquidityAfterFlash: bigint
  maxTargetBorrowAssetsAfterConstraints: bigint
  finalBorrowAssets: bigint
  netLoanTokenOut: bigint
  finalPosition: AccrualPosition
  completed: boolean
  message?: string
}

type DepositAutoLeveragePoint = {
  flashAssets: bigint
  targetBorrowAssets: bigint
  totalDepositAssets: bigint
  utilizationAfter: bigint
  previewDepositShares: bigint
}

type DepositRiskConstraints = {
  maxLtvAfter?: bigint
  minHealthAfter?: bigint
}

type ExecutionPreview = RedeemExecutionPreview | DepositExecutionPreview

type RedeemAutoPoint = {
  fractionWad: bigint
  repayMode: RepayMode
  repayAssets: bigint
  withdrawCollateral: bigint
  flashAssets: bigint
  ltvAfter: bigint | null
  healthAfter: bigint | null
}

type DraftState = {
  error: string
  plan:
    | Awaited<ReturnType<typeof buildMorphoBundlerRedeemPlan>>
    | Awaited<ReturnType<typeof buildMorphoBundlerDepositPlan>>
    | null
  warnings: string[]
  authorizationDeadline?: bigint
  withdrawShares?: bigint
  minVaultSharePriceE27?: bigint
  maxVaultSharePriceE27?: bigint
  expectedRepayAssets?: bigint
  expectedBorrowAssets?: bigint
  targetBorrowAssets?: bigint
  previewAssets?: bigint
  previewShares?: bigint
  estimatedNetAssets?: bigint
  walletAssetsIn?: bigint
  executionPreview?: ExecutionPreview
}

const erc4626InspectorAbi = parseAbi([
  'function previewDeposit(uint256 assets) view returns (uint256 shares)',
  'function previewRedeem(uint256 shares) view returns (uint256 assets)',
  'function asset() view returns (address)',
])

const erc20BalanceOfAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
const erc20AllowanceAbi = parseAbi(['function allowance(address owner,address spender) view returns (uint256)'])
const erc20ApproveAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)'])

const defaultStatus: StatusMessage = {
  tone: 'idle',
  text: 'Connect a wallet, refresh the position snapshot, then build either a redeem or deposit Bundler3 transaction.',
}

export function BundlerApp() {
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [account, setAccount] = useState<Address | ''>('')
  const [chainId, setChainId] = useState<number>(1)
  const [status, setStatus] = useState<StatusMessage>(defaultStatus)
  const [lastTxHash, setLastTxHash] = useState<string>('')
  const [refreshingSnapshot, setRefreshingSnapshot] = useState<boolean>(false)
  const [sendingBundle, setSendingBundle] = useState<boolean>(false)
  const [baseSnapshot, setBaseSnapshot] = useState<BaseSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string>('')
  const [vaultSnapshot, setVaultSnapshot] = useState<VaultSnapshot | null>(null)
  const [vaultError, setVaultError] = useState<string>('')
  const [lastTypedDataJson, setLastTypedDataJson] = useState<string>('')
  const [lastSignedRequestJson, setLastSignedRequestJson] = useState<string>('')
  const [resolvingMarketConfig, setResolvingMarketConfig] = useState<boolean>(false)
  const [marketConfigError, setMarketConfigError] = useState<string>('')
  const [resolvedMarketIdInput, setResolvedMarketIdInput] = useState<string>('')
  const [morphoChains, setMorphoChains] = useState<MorphoChainInfo[]>([])
  const [morphoChainsError, setMorphoChainsError] = useState<string>('')
  const [discoveringMarkets, setDiscoveringMarkets] = useState<boolean>(false)
  const [discoveredMarketsError, setDiscoveredMarketsError] = useState<string>('')
  const [discoveredVaultMarkets, setDiscoveredVaultMarkets] = useState<DiscoveredVaultMarket[]>([])
  const [discoveredMarketsChainId, setDiscoveredMarketsChainId] = useState<number | null>(null)

  const [loanToken, setLoanToken] = useState<string>('')
  const [collateralToken, setCollateralToken] = useState<string>('')
  const [oracle, setOracle] = useState<string>('')
  const [irm, setIrm] = useState<string>('')
  const [lltv, setLltv] = useState<string>('')
  const [marketIdInput, setMarketIdInput] = useState<string>('')
  const [loanTokenDecimals, setLoanTokenDecimals] = useState<string>('18')
  const [collateralTokenDecimals, setCollateralTokenDecimals] = useState<string>('18')
  const [vaultAddress, setVaultAddress] = useState<string>('')

  const [builderMode, setBuilderMode] = useState<BuilderMode>('redeem')
  const [repayMode, setRepayMode] = useState<RepayMode>('full-shares')
  const [flashAssets, setFlashAssets] = useState<string>('0')
  const [walletAssets, setWalletAssets] = useState<string>('0')
  const [targetBorrowAssets, setTargetBorrowAssets] = useState<string>('0')
  const [repayAssets, setRepayAssets] = useState<string>('9000')
  const [withdrawAllCollateral, setWithdrawAllCollateral] = useState<boolean>(true)
  const [withdrawCollateralAssets, setWithdrawCollateralAssets] = useState<string>('0')
  const [flashBufferBps, setFlashBufferBps] = useState<string>('30')
  const [depositSlippageBps, setDepositSlippageBps] = useState<string>('30')
  const [maxLtvAfter, setMaxLtvAfter] = useState<string>('')
  const [minHealthAfter, setMinHealthAfter] = useState<string>('')
  const [targetUtilizationAfter, setTargetUtilizationAfter] = useState<string>('')
  const [redeemSlippageBps, setRedeemSlippageBps] = useState<string>('30')
  const [authorizationDeadlineMinutes, setAuthorizationDeadlineMinutes] = useState<string>('30')
  const [autoRevoke, setAutoRevoke] = useState<boolean>(true)
  const [depositAutoLeveragePoints, setDepositAutoLeveragePoints] = useState<DepositAutoLeveragePoint[]>([])
  const [depositAutoLeverageIndex, setDepositAutoLeverageIndex] = useState<number>(0)
  const [depositAutoLeverageLoading, setDepositAutoLeverageLoading] = useState<boolean>(false)
  const [depositAutoLeverageError, setDepositAutoLeverageError] = useState<string>('')

  const [redeemAutoPoints, setRedeemAutoPoints] = useState<RedeemAutoPoint[]>([])
  const [redeemAutoIndex, setRedeemAutoIndex] = useState<number>(20)
  const [redeemAutoLoading, setRedeemAutoLoading] = useState<boolean>(false)
  const [redeemAutoError, setRedeemAutoError] = useState<string>('')
  const [redeemMaxLtvAfter, setRedeemMaxLtvAfter] = useState<string>('')
  const [redeemMinHealthAfter, setRedeemMinHealthAfter] = useState<string>('')

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null
  const currentMorphoChain = morphoChains.find((chain) => chain.id === chainId) ?? null
  const isChainSupportedLocally = supportsLocalMorphoChain(chainId)
  const isCurrentChainSupported = currentMorphoChain ? isChainSupportedLocally : morphoChainsError ? isChainSupportedLocally : false
  const currentMorphoAddress = isChainSupportedLocally ? getChainAddresses(chainId).morpho : null
  const hasDiscoveredMarketsForCurrentChain = discoveredMarketsChainId === chainId
  const selectedDiscoveredMarketId =
    discoveredVaultMarkets.find((market) => market.marketId.toLowerCase() === marketIdInput.trim().toLowerCase())?.marketId ?? ''
  const currentChainLabel = currentMorphoChain
    ? `${currentMorphoChain.network} (${currentMorphoChain.currency})`
    : `Chain ${chainId}`
  const marketSelectorHelperText = !selectedProvider
    ? 'Connect a wallet to optionally discover markets, or paste a Market ID below and let Market Config auto-fill.'
    : !isCurrentChainSupported
      ? currentMorphoChain
        ? 'The current chain is not supported by the installed Morpho SDK.'
        : morphoChainsError || 'Switch to a Morpho-supported chain to discover markets.'
      : `Discovery is optional. Click Discover markets to browse Morpho listed ERC-4626 vaults on ${currentChainLabel}, or paste a Market ID below.`
  const hasResolvedCurrentMarketConfig =
    Boolean(marketIdInput.trim()) &&
    marketIdInput.trim().toLowerCase() === resolvedMarketIdInput &&
    !resolvingMarketConfig &&
    !marketConfigError

  useEffect(() => {
    const syncProviders = () => {
      const detectedProviders = detectInjectedProviders()
      setProviders((currentProviders) => mergeProviderOptions(currentProviders, detectedProviders))
    }

    syncProviders()

    const intervalId = window.setInterval(syncProviders, 1000)
    const timeoutId = window.setTimeout(() => window.clearInterval(intervalId), 15000)
    const handleProviderInitialized = () => syncProviders()
    const handleEip6963Announcement = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail
      const provider = detail?.provider
      if (!provider) return

      setProviders((currentProviders) =>
        mergeProviderOptions(currentProviders, [buildProviderOption(provider, detail.info?.name)]),
      )
    }

    window.addEventListener('ethereum#initialized', handleProviderInitialized as EventListener)
    window.addEventListener('eip6963:announceProvider', handleEip6963Announcement as EventListener)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    return () => {
      window.clearInterval(intervalId)
      window.clearTimeout(timeoutId)
      window.removeEventListener('ethereum#initialized', handleProviderInitialized as EventListener)
      window.removeEventListener('eip6963:announceProvider', handleEip6963Announcement as EventListener)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const chains = await fetchMorphoChains()
        if (cancelled) return
        setMorphoChains(chains)
        setMorphoChainsError('')
      } catch (error) {
        if (cancelled) return
        setMorphoChains([])
        setMorphoChainsError(error instanceof Error ? error.message : 'Failed to load Morpho supported chains.')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!providers[0]) {
      if (selectedProviderId) setSelectedProviderId('')
      return
    }

    if (!providers.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(providers[0].id)
    }
  }, [providers, selectedProviderId])

  useEffect(() => {
    if (!selectedProvider) return

    const handleAccountsChanged = (accounts: string[]) => {
      const nextAccount = accounts[0]
      setAccount(nextAccount && isAddress(nextAccount) ? nextAccount : '')
      setLastTxHash('')
    }

    const handleChainChanged = (nextChainIdHex: string) => {
      setChainId(Number.parseInt(nextChainIdHex, 16))
    }

    selectedProvider.provider.on?.('accountsChanged', handleAccountsChanged)
    selectedProvider.provider.on?.('chainChanged', handleChainChanged)

    return () => {
      selectedProvider.provider.removeListener?.('accountsChanged', handleAccountsChanged)
      selectedProvider.provider.removeListener?.('chainChanged', handleChainChanged)
    }
  }, [selectedProvider])

  useEffect(() => {
    if (!selectedProvider || !account) return
    void refreshWalletChain(selectedProvider.provider, setChainId)
  }, [selectedProvider, account])

  useEffect(() => {
    if (!selectedProvider || !isCurrentChainSupported) {
      setDiscoveringMarkets(false)
      setDiscoveredMarketsError('')
      setDiscoveredVaultMarkets([])
      setDiscoveredMarketsChainId(null)
      setResolvedMarketIdInput('')
      return
    }
    if (discoveredMarketsChainId === chainId) return

    setBaseSnapshot(null)
    setVaultSnapshot(null)
    setDiscoveredVaultMarkets([])
    setDiscoveredMarketsError('')
    setDiscoveredMarketsChainId(null)
    setResolvedMarketIdInput('')
  }, [selectedProvider, isCurrentChainSupported, discoveredMarketsChainId, chainId])

  useEffect(() => {
    if (!selectedProvider || !account || !isCurrentChainSupported) {
      setBaseSnapshot(null)
      setSnapshotError(
        account
          ? currentMorphoChain
            ? 'The current chain is not supported by the installed Morpho SDK.'
            : morphoChainsError
              ? morphoChainsError
              : 'Switch to a Morpho-supported chain to load Morpho state.'
          : '',
      )
      return
    }
    if (!marketIdInput.trim()) {
      setBaseSnapshot(null)
      setSnapshotError('Paste a Market ID or click Discover markets.')
      return
    }
    if (resolvingMarketConfig) {
      setBaseSnapshot(null)
      setSnapshotError('Resolving market parameters from Market ID...')
      return
    }
    if (marketConfigError) {
      setBaseSnapshot(null)
      setSnapshotError(marketConfigError)
      return
    }
    if (marketIdInput.trim().toLowerCase() !== resolvedMarketIdInput) {
      setBaseSnapshot(null)
      setSnapshotError('Resolving market parameters from Market ID...')
      return
    }

    void refreshBaseSnapshot()
  }, [
    selectedProvider,
    account,
    isCurrentChainSupported,
    currentMorphoChain,
    marketConfigError,
    morphoChainsError,
    marketIdInput,
    resolvedMarketIdInput,
    resolvingMarketConfig,
    loanToken,
    collateralToken,
    oracle,
    irm,
    lltv,
  ])

  useEffect(() => {
    if (!selectedProvider || !isCurrentChainSupported) {
      setResolvingMarketConfig(false)
      setMarketConfigError('')
      setResolvedMarketIdInput('')
      return
    }

    let cancelled = false
    const trimmed = marketIdInput.trim()
    if (!trimmed) {
      setResolvingMarketConfig(false)
      setMarketConfigError('')
      setResolvedMarketIdInput('')
      return
    }

    let parsedMarketId: Hex
    try {
      parsedMarketId = parseOptionalMarketId(trimmed) as Hex
    } catch (error) {
      setResolvingMarketConfig(false)
      setMarketConfigError(error instanceof Error ? error.message : 'Invalid market id.')
      setResolvedMarketIdInput('')
      return
    }

    setResolvingMarketConfig(true)
    setMarketConfigError('')
    setResolvedMarketIdInput('')

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const config = await fetchMarketConfigById({
            provider: selectedProvider.provider,
            marketId: parsedMarketId,
            chainId,
          })
          if (cancelled) return

          setLoanToken(config.marketParams.loanToken)
          setCollateralToken(config.marketParams.collateralToken)
          setOracle(config.marketParams.oracle)
          setIrm(config.marketParams.irm)
          setLltv(config.marketParams.lltv.toString())
          setLoanTokenDecimals(String(config.loanTokenDecimals))
          setCollateralTokenDecimals(String(config.collateralTokenDecimals))
          setVaultAddress(config.marketParams.collateralToken)
          setMarketConfigError('')
          setResolvedMarketIdInput(parsedMarketId.toLowerCase())
        } catch (error) {
          if (cancelled) return
          setResolvedMarketIdInput('')
          setMarketConfigError(error instanceof Error ? error.message : 'Failed to resolve market parameters from Market ID.')
        } finally {
          if (!cancelled) setResolvingMarketConfig(false)
        }
      })()
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [selectedProvider, isCurrentChainSupported, chainId, marketIdInput])

  useEffect(() => {
    if (!selectedProvider || !account || !isCurrentChainSupported) {
      setVaultSnapshot(null)
      setVaultError('')
      return
    }

    try {
      const withdrawShares =
        builderMode === 'redeem'
          ? readWithdrawShares({
              withdrawAllCollateral,
              withdrawCollateralAssets,
              collateralTokenDecimals,
              collateralFromSnapshot: baseSnapshot?.collateral,
            })
          : 0n
      const depositAssets =
        builderMode === 'deposit'
          ? readDepositAssets({
              walletAssets,
              flashAssets,
              loanTokenDecimals,
            })
          : 0n

      if (
        ((builderMode === 'redeem' && (!withdrawShares || withdrawShares <= 0n)) ||
          (builderMode === 'deposit' && (!depositAssets || depositAssets <= 0n))) ||
        !isAddress(vaultAddress)
      ) {
        setVaultSnapshot(null)
        setVaultError('')
        return
      }

      void refreshVaultSnapshot({
        shares: withdrawShares,
        assets: depositAssets,
      })
    } catch (error) {
      setVaultSnapshot(null)
      setVaultError(error instanceof Error ? error.message : 'Failed to parse the vault preview inputs.')
    }
  }, [
    builderMode,
    selectedProvider,
    account,
    isCurrentChainSupported,
    vaultAddress,
    flashAssets,
    loanTokenDecimals,
    walletAssets,
    withdrawAllCollateral,
    withdrawCollateralAssets,
    collateralTokenDecimals,
    baseSnapshot?.collateral,
  ])

  useEffect(() => {
    if (builderMode !== 'deposit' || !baseSnapshot) return

    let shouldHydrateTargetBorrow = !targetBorrowAssets.trim()
    if (!shouldHydrateTargetBorrow) {
      try {
        shouldHydrateTargetBorrow = parseUnits(targetBorrowAssets, baseSnapshot.loanTokenDecimals) === 0n
      } catch {
        shouldHydrateTargetBorrow = true
      }
    }
    if (!shouldHydrateTargetBorrow) return

    try {
      const flashAssetsValue = parseUnits(flashAssets || '0', baseSnapshot.loanTokenDecimals)
      setTargetBorrowAssets(formatUnits(baseSnapshot.borrowAssets + flashAssetsValue, baseSnapshot.loanTokenDecimals))
    } catch {
      // Ignore parse failures while the user is editing and keep the existing field value.
    }
  }, [baseSnapshot, builderMode, flashAssets, targetBorrowAssets])

  useEffect(() => {
    if (builderMode !== 'deposit') {
      setDepositAutoLeverageLoading(false)
      setDepositAutoLeverageError('')
      setDepositAutoLeveragePoints([])
      setDepositAutoLeverageIndex(0)
      return
    }
    if (!selectedProvider || !account || !baseSnapshot || !isCurrentChainSupported || !isAddress(vaultAddress)) {
      setDepositAutoLeverageLoading(false)
      setDepositAutoLeverageError('')
      setDepositAutoLeveragePoints([])
      setDepositAutoLeverageIndex(0)
      return
    }

    let cancelled = false
    const previousPointsLength = depositAutoLeveragePoints.length
    setDepositAutoLeverageLoading(true)
    setDepositAutoLeverageError('')

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const walletAssetsValue = walletAssets.trim() ? parseUnits(walletAssets, baseSnapshot.loanTokenDecimals) : 0n
          if (walletAssetsValue > baseSnapshot.walletLoanTokenBalance) {
            throw new Error(
              `Wallet assets exceed the connected wallet balance. Available balance is ${formatUnits(
                baseSnapshot.walletLoanTokenBalance,
                baseSnapshot.loanTokenDecimals,
              )} ${baseSnapshot.loanTokenSymbol}.`,
            )
          }

          const nextPoints = await computeDepositAutoLeveragePoints({
            walletAssetsValue,
          })
          if (cancelled) return

          let currentFlashAssetsValue: bigint | null = null
          let currentTargetBorrowAssetsValue: bigint | null = null
          try {
            currentFlashAssetsValue = flashAssets.trim() ? parseUnits(flashAssets, baseSnapshot.loanTokenDecimals) : 0n
          } catch {
            currentFlashAssetsValue = null
          }
          try {
            currentTargetBorrowAssetsValue = targetBorrowAssets.trim()
              ? parseUnits(targetBorrowAssets, baseSnapshot.loanTokenDecimals)
              : baseSnapshot.borrowAssets
          } catch {
            currentTargetBorrowAssetsValue = null
          }

          setDepositAutoLeveragePoints(nextPoints)
          setDepositAutoLeverageIndex(
            previousPointsLength > 0
              ? findClosestDepositAutoLeveragePoint({
                  points: nextPoints,
                  flashAssets: currentFlashAssetsValue,
                  targetBorrowAssets: currentTargetBorrowAssetsValue,
                })
              : 0,
          )
        } catch (error) {
          if (cancelled) return
          setDepositAutoLeveragePoints([])
          setDepositAutoLeverageIndex(0)
          setDepositAutoLeverageError(
            error instanceof Error ? error.message : 'Failed to compute the current auto-leverage range.',
          )
        } finally {
          if (!cancelled) setDepositAutoLeverageLoading(false)
        }
      })()
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [
    account,
    baseSnapshot,
    builderMode,
    chainId,
    depositSlippageBps,
    isCurrentChainSupported,
    maxLtvAfter,
    minHealthAfter,
    selectedProvider,
    vaultAddress,
    walletAssets,
  ])

  useEffect(() => {
    if (builderMode !== 'deposit' || !baseSnapshot) return

    const point = depositAutoLeveragePoints[clampNumber(depositAutoLeverageIndex, 0, depositAutoLeveragePoints.length - 1)]
    if (!point) return

    const nextFlashAssets = formatUnits(point.flashAssets, baseSnapshot.loanTokenDecimals)
    const nextTargetBorrowAssets = formatUnits(point.targetBorrowAssets, baseSnapshot.loanTokenDecimals)

    setFlashAssets((currentValue) => (currentValue === nextFlashAssets ? currentValue : nextFlashAssets))
    setTargetBorrowAssets((currentValue) =>
      currentValue === nextTargetBorrowAssets ? currentValue : nextTargetBorrowAssets,
    )
  }, [baseSnapshot, builderMode, depositAutoLeverageIndex, depositAutoLeveragePoints])

  // Compute redeem auto points whenever relevant inputs change
  useEffect(() => {
    if (builderMode !== 'redeem') {
      setRedeemAutoPoints([])
      setRedeemAutoIndex(20)
      setRedeemAutoLoading(false)
      setRedeemAutoError('')
      return
    }
    if (!baseSnapshot || baseSnapshot.borrowAssets <= 0n) {
      setRedeemAutoPoints([])
      setRedeemAutoIndex(20)
      setRedeemAutoLoading(false)
      return
    }

    let cancelled = false
    setRedeemAutoLoading(true)
    setRedeemAutoError('')

    const timeoutId = window.setTimeout(() => {
      try {
        const riskConstraints = {
          maxLtvAfter: parseOptionalPercentWad(redeemMaxLtvAfter, 'Max LTV after'),
          minHealthAfter: parseOptionalFactorWad(redeemMinHealthAfter, 'Min health after'),
        }
        const points = computeRedeemAutoPoints({
          snapshot: baseSnapshot,
          flashBufferBps: parseBps(flashBufferBps),
          riskConstraints,
        })
        if (cancelled) return
        setRedeemAutoPoints(points)
        if (points.length === 0) {
          setRedeemAutoError('No feasible exit point satisfies the current constraints.')
        } else {
          setRedeemAutoIndex((prev) => clampNumber(prev, 0, points.length - 1))
        }
      } catch (error) {
        if (cancelled) return
        setRedeemAutoError(error instanceof Error ? error.message : 'Failed to compute redeem points.')
        setRedeemAutoPoints([])
      } finally {
        if (!cancelled) setRedeemAutoLoading(false)
      }
    }, 200)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [builderMode, baseSnapshot, redeemMaxLtvAfter, redeemMinHealthAfter, flashBufferBps])

  // Sync redeem slider index → repay/withdraw state
  useEffect(() => {
    if (builderMode !== 'redeem' || !baseSnapshot || redeemAutoPoints.length === 0) return
    const point = redeemAutoPoints[clampNumber(redeemAutoIndex, 0, redeemAutoPoints.length - 1)]
    if (!point) return

    const nextRepayAssets = formatUnits(point.repayAssets, baseSnapshot.loanTokenDecimals)
    const nextFlashAssets = formatUnits(point.flashAssets, baseSnapshot.loanTokenDecimals)
    const nextWithdrawCollateral = formatUnits(point.withdrawCollateral, baseSnapshot.collateralTokenDecimals)
    const nextWithdrawAll = point.withdrawCollateral >= baseSnapshot.collateral

    setRepayMode(point.repayMode)
    setRepayAssets((v) => (v === nextRepayAssets ? v : nextRepayAssets))
    setFlashAssets((v) => (v === nextFlashAssets ? v : nextFlashAssets))
    setWithdrawAllCollateral(nextWithdrawAll)
    setWithdrawCollateralAssets((v) => (v === nextWithdrawCollateral ? v : nextWithdrawCollateral))
  }, [builderMode, redeemAutoIndex, redeemAutoPoints, baseSnapshot])

  useEffect(() => {
    if (builderMode !== 'deposit') {
      setTargetUtilizationAfter('')
      return
    }
    const point = depositAutoLeveragePoints[clampNumber(depositAutoLeverageIndex, 0, depositAutoLeveragePoints.length - 1)]
    if (!point) return

    const nextValue = formatWadPercentValue(point.utilizationAfter)
    setTargetUtilizationAfter((currentValue) => (currentValue === nextValue ? currentValue : nextValue))
  }, [builderMode, depositAutoLeverageIndex, depositAutoLeveragePoints])

  const activeDepositAutoLeveragePoint =
    builderMode === 'deposit'
      ? depositAutoLeveragePoints[clampNumber(depositAutoLeverageIndex, 0, depositAutoLeveragePoints.length - 1)] ?? null
      : null

  const activeRedeemAutoPoint =
    builderMode === 'redeem'
      ? redeemAutoPoints[clampNumber(redeemAutoIndex, 0, redeemAutoPoints.length - 1)] ?? null
      : null
  const redeemAutoProgress =
    redeemAutoPoints.length > 1
      ? (clampNumber(redeemAutoIndex, 0, redeemAutoPoints.length - 1) / (redeemAutoPoints.length - 1)) * 100
      : 0

  const draft = useMemo<DraftState>(() => {
    try {
      if (!account) {
        return { error: 'Connect a wallet to build the bundle.', plan: null, warnings: [] }
      }
      if (!isCurrentChainSupported) {
        return {
          error: currentMorphoChain
            ? 'The current chain is not supported by the installed Morpho SDK.'
            : morphoChainsError || 'Switch to a Morpho-supported chain to build the bundle.',
          plan: null,
          warnings: [],
        }
      }
      if (!baseSnapshot) {
        return { error: snapshotError || 'Refresh the onchain snapshot first.', plan: null, warnings: [] }
      }
      if (builderMode === 'deposit' && depositAutoLeverageLoading) {
        return { error: 'Refreshing the auto-leverage path…', plan: null, warnings: [] }
      }
      if (builderMode === 'deposit' && !activeDepositAutoLeveragePoint) {
        return {
          error: depositAutoLeverageError || 'Auto leverage is not ready yet.',
          plan: null,
          warnings: [],
        }
      }
      if (builderMode === 'redeem' && !vaultSnapshot) {
        return { error: vaultError || 'Vault preview is not ready yet.', plan: null, warnings: [] }
      }

      const marketParams = parseMarketParams({ loanToken, collateralToken, oracle, irm, lltv })
      const vault = assertAddress(vaultAddress)
      const redeemVaultSnapshot = builderMode === 'redeem' ? vaultSnapshot : null
      const depositAutoPoint = builderMode === 'deposit' ? activeDepositAutoLeveragePoint : null
      const flashAssetsValue = parseUnits(flashAssets || '0', Number(loanTokenDecimals))
      if (flashAssetsValue > baseSnapshot.maxFlashLoanAssets) {
        throw new Error(
          `Requested flash assets exceed Morpho's available flash-loan liquidity. Max available is ${formatUnits(
            baseSnapshot.maxFlashLoanAssets,
            baseSnapshot.loanTokenDecimals,
          )} ${baseSnapshot.loanTokenSymbol}.`,
        )
      }
      if (
        builderMode === 'redeem' &&
        (!vaultSnapshot?.asset || vaultSnapshot.asset.toLowerCase() !== marketParams.loanToken.toLowerCase())
      ) {
        throw new Error('The ERC-4626 vault asset must match the Morpho loan token for this builder.')
      }
      const authorizationDeadline =
        BigInt(Math.floor(Date.now() / 1000)) +
        BigInt(parseUnsignedInt(authorizationDeadlineMinutes, 'Authorization deadline')) * 60n

      if (builderMode === 'redeem') {
        const repayAssetsValue =
          repayMode === 'exact-assets' ? parseUnits(repayAssets || '0', Number(loanTokenDecimals)) : undefined
        const withdrawShares = readWithdrawShares({
          withdrawAllCollateral,
          withdrawCollateralAssets,
          collateralTokenDecimals,
          collateralFromSnapshot: baseSnapshot.collateral,
        })

        if (!withdrawShares || withdrawShares <= 0n) {
          throw new Error('Withdraw collateral assets must be greater than zero.')
        }
        if (withdrawShares > baseSnapshot.collateral) {
          throw new Error('Withdraw collateral assets exceed the current Morpho collateral balance.')
        }
        if (repayMode === 'exact-assets' && flashAssetsValue < (repayAssetsValue ?? 0n)) {
          throw new Error('flashAssets must be at least repayAssets in exact-assets mode.')
        }

        const expectedRepayAssets =
          repayMode === 'exact-assets' ? repayAssetsValue ?? 0n : baseSnapshot.estimatedFullRepayAssets
        const minVaultSharePriceE27 = computeMinSharePriceE27({
          shares: withdrawShares,
          previewAssets: redeemVaultSnapshot!.previewRedeemAssets,
          slippageBps: parseBps(redeemSlippageBps),
        })

        const plan = buildMorphoBundlerRedeemPlan({
          chainId,
          account: assertAddress(account),
          marketParams,
          vault,
          flashAssets: flashAssetsValue,
          repayMode,
          repayAssets: repayAssetsValue,
          withdrawCollateralAssets: withdrawShares,
          minVaultSharePriceE27,
          authorizationNonce: baseSnapshot.morphoNonce,
          authorizationDeadline,
          autoRevoke,
          skipInitialAuthorization: baseSnapshot.isBundlerAuthorized,
          accrualPosition: baseSnapshot.accrualPosition,
          previewRedeemAssets: redeemVaultSnapshot!.previewRedeemAssets,
        })
        const executionPreview = simulateRedeemExecutionPreview({
          snapshot: baseSnapshot,
          repayMode,
          repayAssets: expectedRepayAssets,
          requestedWithdrawCollateral: withdrawShares,
          loopSummary: plan.loop,
        })

        if (executionPreview.withdrawError) {
          throw new Error(executionPreview.withdrawError)
        }
        if (
          !plan.loop.enabled &&
          withdrawAllCollateral &&
          executionPreview.maxSafeWithdrawAfterRepay != null &&
          executionPreview.maxSafeWithdrawAfterRepay < baseSnapshot.collateral
        ) {
          throw new Error(
            `Withdraw all collateral is not safe for this market. Max safe withdraw after repay is ${formatUnits(
              executionPreview.maxSafeWithdrawAfterRepay,
              baseSnapshot.collateralTokenDecimals,
            )} ${baseSnapshot.collateralTokenSymbol}.`,
          )
        }

        if (plan.loop.enabled && !plan.loop.completed) {
          throw new Error(plan.loop.message || 'The flash-loan loop could not complete the requested exit.')
        }

        const warnings: string[] = []
        if (repayMode === 'full-shares' && redeemVaultSnapshot!.previewRedeemAssets < expectedRepayAssets) {
          warnings.push('Previewed vault assets are below the current full-repay estimate. Increase flashAssets or re-check the position before sending.')
        }
        if (repayMode === 'exact-assets' && redeemVaultSnapshot!.previewRedeemAssets < expectedRepayAssets) {
          warnings.push('Previewed vault assets are below repayAssets. This bundle will likely revert.')
        }
        if (!autoRevoke) {
          warnings.push('Auto-revoke is disabled. GeneralAdapter1 will stay authorized on Morpho after the bundle succeeds.')
        } else if (baseSnapshot.isBundlerAuthorized) {
          warnings.push('GeneralAdapter1 is already authorized now. With auto-revoke enabled, the account will end the transaction deauthorized.')
        }
        if (plan.loop.enabled) {
          warnings.push(`Flash-loan constrained market detected. Builder will use ${plan.loop.iterationCount} loop leg(s) to finish the exit.`)
          warnings.push('Loop mode uses a conservative collateral buffer on each in-debt withdraw leg so the on-chain Morpho health check matches the local preview more closely.')
        }

        return {
          error: '',
          plan,
          warnings,
          authorizationDeadline,
          withdrawShares,
          minVaultSharePriceE27,
          expectedRepayAssets,
          previewAssets: redeemVaultSnapshot!.previewRedeemAssets,
          previewShares: withdrawShares,
          estimatedNetAssets: plan.loop.netLoanTokenOut,
          executionPreview,
        }
      }

      const walletAssetsValue = parseUnits(walletAssets || '0', Number(loanTokenDecimals))
      const totalDepositAssets = walletAssetsValue + flashAssetsValue
      const targetBorrowAssetsValue = targetBorrowAssets.trim()
        ? parseUnits(targetBorrowAssets, Number(loanTokenDecimals))
        : baseSnapshot.borrowAssets + flashAssetsValue
      if (totalDepositAssets <= 0n) {
        throw new Error('Wallet assets plus flash assets must be greater than zero.')
      }
      if (walletAssetsValue > baseSnapshot.walletLoanTokenBalance) {
        throw new Error(
          `Wallet assets exceed the connected wallet balance. Available balance is ${formatUnits(
            baseSnapshot.walletLoanTokenBalance,
            baseSnapshot.loanTokenDecimals,
          )} ${baseSnapshot.loanTokenSymbol}.`,
        )
      }
      if (walletAssetsValue > baseSnapshot.walletLoanTokenAllowanceToAdapter) {
        throw new Error(
          `Wallet assets exceed the current GeneralAdapter1 allowance. Approve ${formatUnits(
            walletAssetsValue,
            baseSnapshot.loanTokenDecimals,
          )} ${baseSnapshot.loanTokenSymbol} first.`,
        )
      }

      const maxVaultSharePriceE27 = computeMaxSharePriceE27({
        assets: totalDepositAssets,
        previewShares: depositAutoPoint!.previewDepositShares,
        slippageBps: parseBps(depositSlippageBps),
      })

      const plan = buildMorphoBundlerDepositPlan({
        chainId,
        account: assertAddress(account),
        marketParams,
        vault,
        morphoLiquidityAssets: baseSnapshot.maxFlashLoanAssets,
        walletAssets: walletAssetsValue,
        flashAssets: flashAssetsValue,
        targetBorrowAssets: targetBorrowAssetsValue,
        maxVaultSharePriceE27,
        borrowSlippageBps: parseBps(depositSlippageBps),
        authorizationNonce: baseSnapshot.morphoNonce,
        authorizationDeadline,
        autoRevoke,
        skipInitialAuthorization: baseSnapshot.isBundlerAuthorized,
        accrualPosition: baseSnapshot.accrualPosition,
        previewDepositShares: depositAutoPoint!.previewDepositShares,
      })
      const executionPreview = simulateDepositExecutionPreview({
        summary: plan.summary,
        previewDepositShares: depositAutoPoint!.previewDepositShares,
      })
      if (!plan.summary.completed) {
        throw new Error(plan.summary.message || 'The deposit builder could not reach the requested borrow target.')
      }

      const warnings: string[] = []
      if (!autoRevoke) {
        warnings.push('Auto-revoke is disabled. GeneralAdapter1 will stay authorized on Morpho after the bundle succeeds.')
      } else if (baseSnapshot.isBundlerAuthorized) {
        warnings.push('GeneralAdapter1 is already authorized now. With auto-revoke enabled, the account will end the transaction deauthorized.')
      }
      if (flashAssetsValue > 0n) {
        warnings.push('Leverage deposits wallet + flash collateral once, then borrows once. Any borrow above Flash assets is swept back to the wallet.')
      }
      if (plan.summary.netLoanTokenOut > 0n) {
        warnings.push(
          `The bundle is expected to leave ${formatUnits(plan.summary.netLoanTokenOut, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol} liquid in the wallet after flash repayment.`,
        )
      }
      if (walletAssetsValue > 0n) {
        warnings.push('Deposit mode pulls loan tokens from the connected wallet. Keep the allowance scoped to the exact amount you intend to deposit.')
      }

      return {
        error: '',
        plan,
        warnings,
        authorizationDeadline,
        maxVaultSharePriceE27,
        expectedBorrowAssets: plan.summary.additionalBorrowAssets,
        targetBorrowAssets: targetBorrowAssetsValue,
        previewAssets: plan.summary.initialDepositAssets,
        previewShares: depositAutoPoint!.previewDepositShares,
        estimatedNetAssets: plan.summary.netLoanTokenOut,
        walletAssetsIn: walletAssetsValue,
        executionPreview,
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Failed to build the bundle draft.',
        plan: null,
        warnings: [],
      }
    }
  }, [
    account,
    authorizationDeadlineMinutes,
    autoRevoke,
    baseSnapshot,
    builderMode,
    chainId,
    collateralToken,
    collateralTokenDecimals,
    currentMorphoChain,
    depositSlippageBps,
    depositAutoLeverageError,
    depositAutoLeverageLoading,
    flashAssets,
    irm,
    isCurrentChainSupported,
    loanToken,
    loanTokenDecimals,
    lltv,
    morphoChainsError,
    oracle,
    redeemSlippageBps,
    repayAssets,
    repayMode,
    snapshotError,
    targetBorrowAssets,
    activeDepositAutoLeveragePoint,
    vaultAddress,
    vaultError,
    vaultSnapshot,
    walletAssets,
    withdrawAllCollateral,
    withdrawCollateralAssets,
  ])

  const actionJson = draft.plan ? stringifyForDisplay(draft.plan.actions) : ''
  const previewShares = draft.previewShares
  const previewAmount = draft.previewAssets
  const previewExpectedRepayAssets = draft.expectedRepayAssets
  const previewExpectedBorrowAssets = draft.expectedBorrowAssets
  const previewEstimatedNetAssets = draft.estimatedNetAssets
  const redeemPreview = draft.executionPreview?.kind === 'redeem' ? draft.executionPreview : null
  const depositPreview = draft.executionPreview?.kind === 'deposit' ? draft.executionPreview : null
  const depositAutoLeverageMaxPoint =
    builderMode === 'deposit' && depositAutoLeveragePoints.length > 0
      ? depositAutoLeveragePoints[depositAutoLeveragePoints.length - 1]
      : null
  const depositAutoLeverageProgress =
    depositAutoLeveragePoints.length > 1
      ? (clampNumber(depositAutoLeverageIndex, 0, depositAutoLeveragePoints.length - 1) /
          (depositAutoLeveragePoints.length - 1)) *
        100
      : 0
  const typedDataJson = draft.plan
    ? stringifyForDisplay(
        [draft.plan.authorization.authorizeTypedData, draft.plan.authorization.revokeTypedData].filter(Boolean),
      )
    : ''

  async function connectWallet() {
    const providerOption = selectedProvider ?? refreshProviderSelection(providers, setProviders, setSelectedProviderId)
    if (!providerOption) {
      setStatus({ tone: 'error', text: 'No injected provider was detected.' })
      return
    }

    try {
      const accounts = await providerOption.provider.request({ method: 'eth_requestAccounts' })
      const nextAccount = Array.isArray(accounts) ? accounts[0] : ''
      if (!nextAccount || !isAddress(nextAccount)) {
        throw new Error('Wallet did not return a usable address.')
      }

      setAccount(nextAccount)
      await refreshWalletChain(providerOption.provider, setChainId)
      setStatus({ tone: 'success', text: `Connected ${providerOption.label}.` })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Failed to connect wallet.',
      })
    }
  }

  async function refreshBaseSnapshot() {
    if (!selectedProvider || !account) return

    setRefreshingSnapshot(true)
    setSnapshotError('')

    try {
      const snapshot = await fetchBaseSnapshot({
        provider: selectedProvider.provider,
        account: assertAddress(account),
        marketId: parseOptionalMarketId(marketIdInput),
        marketParams: parseMarketParams({ loanToken, collateralToken, oracle, irm, lltv }),
        chainId,
      })

      setBaseSnapshot(snapshot)
      syncMarketInputsFromSnapshot(snapshot)
      setLoanTokenDecimals(String(snapshot.loanTokenDecimals))
      setCollateralTokenDecimals(String(snapshot.collateralTokenDecimals))
      let shouldHydrateRepayAssets = builderMode === 'redeem' && (repayMode !== 'exact-assets' || !repayAssets.trim())
      if (shouldHydrateRepayAssets) {
        try {
          shouldHydrateRepayAssets = parseUnits(repayAssets, snapshot.loanTokenDecimals) === 0n
        } catch {
          shouldHydrateRepayAssets = true
        }
      }
      if (builderMode === 'redeem' && shouldHydrateRepayAssets) {
        setRepayAssets(formatUnits(snapshot.borrowAssets, snapshot.loanTokenDecimals))
      }

      if (builderMode === 'redeem' && withdrawAllCollateral) {
        setWithdrawCollateralAssets(formatUnits(snapshot.collateral, snapshot.collateralTokenDecimals))
      }
      if (builderMode === 'redeem' && repayMode === 'full-shares' && snapshot.estimatedFullRepayAssets > 0n) {
        setFlashAssets(
          formatUnits(
            clampFlashAssets(
              applyBpsBuffer(snapshot.estimatedFullRepayAssets, parseBps(flashBufferBps)),
              snapshot.maxFlashLoanAssets,
            ),
            snapshot.loanTokenDecimals,
          ),
        )
      }
      if (builderMode === 'deposit') {
        let shouldHydrateTargetBorrow = !targetBorrowAssets.trim()
        if (!shouldHydrateTargetBorrow) {
          try {
            shouldHydrateTargetBorrow = parseUnits(targetBorrowAssets, snapshot.loanTokenDecimals) === 0n
          } catch {
            shouldHydrateTargetBorrow = true
          }
        }
        if (shouldHydrateTargetBorrow) {
          const flashAssetsValue = parseUnits(flashAssets || '0', snapshot.loanTokenDecimals)
          setTargetBorrowAssets(formatUnits(snapshot.borrowAssets + flashAssetsValue, snapshot.loanTokenDecimals))
        }
      }

      setStatus({
        tone: 'success',
        text: 'Loaded the latest Morpho position, wallet balances, allowance, user nonce, and token metadata.',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh the Morpho snapshot.'
      setBaseSnapshot(null)
      setSnapshotError(message)
      setStatus({ tone: 'error', text: message })
    } finally {
      setRefreshingSnapshot(false)
    }
  }

  async function refreshVaultSnapshot(parameters: { shares: bigint; assets: bigint }) {
    if (!selectedProvider) return

    setVaultError('')

    try {
      const snapshot = await fetchVaultSnapshot({
        provider: selectedProvider.provider,
        vault: assertAddress(vaultAddress),
        shares: parameters.shares,
        assets: parameters.assets,
      })

      setVaultSnapshot(snapshot)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load the vault preview.'
      setVaultSnapshot(null)
      setVaultError(message)
    }
  }

  async function refreshDiscoveredVaultMarkets() {
    if (!selectedProvider || !isCurrentChainSupported) return

    setDiscoveringMarkets(true)
    setDiscoveredMarketsError('')

    try {
      const markets = await discoverErc4626MarketsOnChain({
        provider: selectedProvider.provider,
        chainId,
      })

      setDiscoveredVaultMarkets(markets)
      setDiscoveredMarketsChainId(chainId)

      if (markets.length === 0) {
        setDiscoveredMarketsError(
          'No ERC-4626 collateral markets with vault asset matching the loan token were found on this chain.',
        )
        return
      }
    } catch (error) {
      setDiscoveredVaultMarkets([])
      setDiscoveredMarketsChainId(chainId)
      setDiscoveredMarketsError(
        error instanceof Error ? error.message : 'Failed to discover ERC-4626 markets on the current chain.',
      )
    } finally {
      setDiscoveringMarkets(false)
    }
  }

  async function sendBundle() {
    setStatus({
      tone: 'idle',
      text: `Preparing ${builderMode === 'redeem' ? 'redeem' : 'deposit'} Bundler3 transaction...`,
    })
    if (!selectedProvider || !account) {
      setStatus({ tone: 'error', text: 'Connect a wallet before sending the bundle.' })
      return
    }
    if (!isCurrentChainSupported) {
      setStatus({
        tone: 'error',
        text: currentMorphoChain
          ? 'The current chain is not supported by the installed Morpho SDK.'
          : morphoChainsError || 'Switch to a Morpho-supported chain before sending.',
      })
      return
    }

    setSendingBundle(true)
    setLastTxHash('')

    try {
      setStatus({ tone: 'idle', text: 'Refreshing Morpho state and vault preview before signing...' })

      const requestedMarketParams = parseMarketParams({ loanToken, collateralToken, oracle, irm, lltv })
      const freshBaseSnapshot = await fetchBaseSnapshot({
        provider: selectedProvider.provider,
        account: assertAddress(account),
        marketId: parseOptionalMarketId(marketIdInput),
        marketParams: requestedMarketParams,
        chainId,
      })
      const marketParams = freshBaseSnapshot.marketParams
      const flashAssetsValue = parseUnits(flashAssets || '0', freshBaseSnapshot.loanTokenDecimals)
      if (flashAssetsValue > freshBaseSnapshot.maxFlashLoanAssets) {
        throw new Error(
          `Requested flash assets exceed Morpho's available flash-loan liquidity. Max available is ${formatUnits(
            freshBaseSnapshot.maxFlashLoanAssets,
            freshBaseSnapshot.loanTokenDecimals,
          )} ${freshBaseSnapshot.loanTokenSymbol}.`,
        )
      }
      const authorizationDeadline =
        BigInt(Math.floor(Date.now() / 1000)) +
        BigInt(parseUnsignedInt(authorizationDeadlineMinutes, 'Authorization deadline')) * 60n

      const freshVaultSnapshot =
        builderMode === 'redeem'
          ? await fetchVaultSnapshot({
              provider: selectedProvider.provider,
              vault: assertAddress(vaultAddress),
              shares: readWithdrawShares({
                withdrawAllCollateral,
                withdrawCollateralAssets,
                collateralTokenDecimals: String(freshBaseSnapshot.collateralTokenDecimals),
                collateralFromSnapshot: freshBaseSnapshot.collateral,
              }),
              assets: 0n,
            })
          : await fetchVaultSnapshot({
              provider: selectedProvider.provider,
              vault: assertAddress(vaultAddress),
              shares: 0n,
              assets: readDepositAssets({
                walletAssets,
                flashAssets,
                loanTokenDecimals: String(freshBaseSnapshot.loanTokenDecimals),
              }),
            })

      if (!freshVaultSnapshot.asset || freshVaultSnapshot.asset.toLowerCase() !== marketParams.loanToken.toLowerCase()) {

        throw new Error('The ERC-4626 vault asset must match the Morpho loan token for this builder.')
      }

      const plan =
        builderMode === 'redeem'
          ? (() => {
              const withdrawShares = readWithdrawShares({
                withdrawAllCollateral,
                withdrawCollateralAssets,
                collateralTokenDecimals: String(freshBaseSnapshot.collateralTokenDecimals),
                collateralFromSnapshot: freshBaseSnapshot.collateral,
              })
              if (!withdrawShares || withdrawShares <= 0n) {
                throw new Error('Withdraw collateral assets must be greater than zero.')
              }
              if (withdrawShares > freshBaseSnapshot.collateral) {
                throw new Error('Withdraw collateral assets exceed the current Morpho collateral balance.')
              }

              const repayAssetsValue =
                repayMode === 'exact-assets'
                  ? parseUnits(repayAssets || '0', freshBaseSnapshot.loanTokenDecimals)
                  : undefined
              const minVaultSharePriceE27 = computeMinSharePriceE27({
                shares: withdrawShares,
                previewAssets: freshVaultSnapshot.previewRedeemAssets,
                slippageBps: parseBps(redeemSlippageBps),
              })
              const nextPlan = buildMorphoBundlerRedeemPlan({
                chainId,
                account: assertAddress(account),
                marketParams,
                vault: assertAddress(vaultAddress),
                flashAssets: flashAssetsValue,
                repayMode,
                repayAssets: repayAssetsValue,
                withdrawCollateralAssets: withdrawShares,
                minVaultSharePriceE27,
                authorizationNonce: freshBaseSnapshot.morphoNonce,
                authorizationDeadline,
                autoRevoke,
                skipInitialAuthorization: freshBaseSnapshot.isBundlerAuthorized,
                accrualPosition: freshBaseSnapshot.accrualPosition,
                previewRedeemAssets: freshVaultSnapshot.previewRedeemAssets,
              })
              if (nextPlan.loop.enabled && !nextPlan.loop.completed) {
                throw new Error(nextPlan.loop.message || 'The flash-loan loop could not complete the requested exit.')
              }
              return nextPlan
            })()
          : (() => {
              const walletAssetsValue = parseUnits(walletAssets || '0', freshBaseSnapshot.loanTokenDecimals)
              const totalDepositAssets = walletAssetsValue + flashAssetsValue
              const targetBorrowAssetsValue = targetBorrowAssets.trim()
                ? parseUnits(targetBorrowAssets || '0', freshBaseSnapshot.loanTokenDecimals)
                : freshBaseSnapshot.borrowAssets + flashAssetsValue
              if (totalDepositAssets <= 0n) {
                throw new Error('Wallet assets plus flash assets must be greater than zero.')
              }
              if (walletAssetsValue > freshBaseSnapshot.walletLoanTokenBalance) {
                throw new Error('Wallet assets exceed the connected wallet balance.')
              }
              if (walletAssetsValue > freshBaseSnapshot.walletLoanTokenAllowanceToAdapter) {
                throw new Error('Wallet assets exceed the current GeneralAdapter1 allowance.')
              }
              const maxVaultSharePriceE27 = computeMaxSharePriceE27({
                assets: totalDepositAssets,
                previewShares: freshVaultSnapshot.previewDepositShares,
                slippageBps: parseBps(depositSlippageBps),
              })
              return buildMorphoBundlerDepositPlan({
                chainId,
                account: assertAddress(account),
                marketParams,
                vault: assertAddress(vaultAddress),
                morphoLiquidityAssets: freshBaseSnapshot.maxFlashLoanAssets,
                walletAssets: walletAssetsValue,
                flashAssets: flashAssetsValue,
                targetBorrowAssets: targetBorrowAssetsValue,
                maxVaultSharePriceE27,
                borrowSlippageBps: parseBps(depositSlippageBps),
                authorizationNonce: freshBaseSnapshot.morphoNonce,
                authorizationDeadline,
                autoRevoke,
                skipInitialAuthorization: freshBaseSnapshot.isBundlerAuthorized,
                accrualPosition: freshBaseSnapshot.accrualPosition,
                previewDepositShares: freshVaultSnapshot.previewDepositShares,
              })
            })()

      if (builderMode === 'deposit' && 'summary' in plan && !plan.summary.completed) {
        throw new Error(plan.summary.message || 'The deposit builder could not reach the requested target.')
      }

      const morphoSignatureActions = plan.actions.filter(
        (action) => action.type === 'morphoSetAuthorizationWithSig' && action.args[1] == null,
      )
      setLastTypedDataJson(
        stringifyForDisplay(
          morphoSignatureActions.map((action) =>
            action.type === 'morphoSetAuthorizationWithSig' ? getAuthorizationTypedData(action.args[0], chainId) : null,
          ),
        ),
      )

      if (morphoSignatureActions.length > 0) {
        setStatus({ tone: 'idle', text: 'Requesting Morpho authorization signatures...' })
        for (const action of morphoSignatureActions) {
          if (action.type !== 'morphoSetAuthorizationWithSig') continue
          const authorization = action.args[0]
          const typedData = getAuthorizationTypedData(authorization, chainId)
          const signature = await signTypedDataWithProvider(
            selectedProvider.provider,
            assertAddress(account),
            typedData,
          )
          action.args[1] = signature
        }
      }

      const { request: finalRequest } = encodeMorphoBundlerRedeemTransactionRequest({
        chainId,
        from: assertAddress(account),
        actions: plan.actions,
      })

      setLastSignedRequestJson(stringifyForDisplay(finalRequest))
      setStatus({ tone: 'idle', text: 'Requesting wallet confirmation for the Bundler3 transaction...' })

      const txHash = await requestWithFallback(selectedProvider.provider, 'eth_sendTransaction', 'wallet_sendTransaction', [
        finalRequest,
      ])

      setBaseSnapshot(freshBaseSnapshot)
      syncMarketInputsFromSnapshot(freshBaseSnapshot)
      setVaultSnapshot(freshVaultSnapshot)
      setLastTxHash(String(txHash))
      setStatus({
        tone: 'success',
        text: `Bundler3 ${builderMode === 'redeem' ? 'redeem' : 'deposit'} transaction submitted. The wallet signed Morpho authorization off-chain and sent one standard on-chain transaction.`,
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Failed to send the Bundler3 transaction.',
      })
    } finally {
      setSendingBundle(false)
    }
  }

  function syncMarketInputsFromSnapshot(snapshot: BaseSnapshot) {
    setMarketIdInput(snapshot.marketId)
    setResolvedMarketIdInput(snapshot.marketId.toLowerCase())
    setLoanToken(snapshot.marketParams.loanToken)
    setCollateralToken(snapshot.marketParams.collateralToken)
    setOracle(snapshot.marketParams.oracle)
    setIrm(snapshot.marketParams.irm)
    setLltv(snapshot.marketParams.lltv.toString())
    setVaultAddress(snapshot.marketParams.collateralToken)
  }

  function applyDiscoveredMarket(market: DiscoveredVaultMarket) {
    setMarketIdInput(market.marketId)
    setResolvedMarketIdInput(market.marketId.toLowerCase())
    setLoanToken(market.marketParams.loanToken)
    setCollateralToken(market.marketParams.collateralToken)
    setOracle(market.marketParams.oracle)
    setIrm(market.marketParams.irm)
    setLltv(market.marketParams.lltv.toString())
    setLoanTokenDecimals(String(market.loanTokenDecimals))
    setCollateralTokenDecimals(String(market.collateralTokenDecimals))
    setVaultAddress(market.vaultAddress)
  }

  function applyRepayFraction(numerator: bigint, denominator: bigint) {
    if (!baseSnapshot || denominator === 0n) return
    const repayValue = (baseSnapshot.borrowAssets * numerator) / denominator
    const normalizedRepay = repayValue > 0n ? repayValue : baseSnapshot.borrowAssets
    setRepayMode('exact-assets')
    setRepayAssets(formatUnits(normalizedRepay, baseSnapshot.loanTokenDecimals))
    setFlashAssets(
      formatUnits(
        clampFlashAssets(applyBpsBuffer(normalizedRepay, parseBps(flashBufferBps)), baseSnapshot.maxFlashLoanAssets),
        baseSnapshot.loanTokenDecimals,
      ),
    )
  }

  function applyWithdrawFraction(numerator: bigint, denominator: bigint) {
    if (!baseSnapshot || denominator === 0n) return
    const withdrawValue = (baseSnapshot.collateral * numerator) / denominator
    const normalizedWithdraw = withdrawValue > 0n ? withdrawValue : baseSnapshot.collateral
    setWithdrawAllCollateral(numerator === denominator)
    setWithdrawCollateralAssets(formatUnits(normalizedWithdraw, baseSnapshot.collateralTokenDecimals))
  }

  function applyMaxSafeWithdraw() {
    if (!baseSnapshot || !redeemPreview?.maxSafeWithdrawAfterRepay) {
      return
    }
    setWithdrawAllCollateral(redeemPreview.maxSafeWithdrawAfterRepay === baseSnapshot.collateral)
    setWithdrawCollateralAssets(
      formatUnits(redeemPreview.maxSafeWithdrawAfterRepay, baseSnapshot.collateralTokenDecimals),
    )
  }

  async function buildFreshDepositPlan(parameters: {
    walletAssetsValue: bigint
    flashAssetsValue: bigint
    targetBorrowAssetsValue: bigint
    authorizationDeadline?: bigint
  }) {
    if (!selectedProvider || !baseSnapshot || !account) {
      throw new Error('Connect a wallet and refresh the snapshot before building the leverage plan.')
    }

    const totalDepositAssets = parameters.walletAssetsValue + parameters.flashAssetsValue
    if (totalDepositAssets <= 0n) {
      throw new Error('Wallet assets plus flash assets must be greater than zero.')
    }

    const vault = assertAddress(vaultAddress)
    const vaultPreview = await fetchVaultSnapshot({
      provider: selectedProvider.provider,
      vault,
      shares: 0n,
      assets: totalDepositAssets,
    })

    if (!vaultPreview.asset || vaultPreview.asset.toLowerCase() !== baseSnapshot.marketParams.loanToken.toLowerCase()) {
      throw new Error('The ERC-4626 vault asset must match the Morpho loan token for this builder.')
    }

    const plan = buildDepositPlanWithPreview({
      chainId,
      account: assertAddress(account),
      snapshot: baseSnapshot,
      vault,
      walletAssetsValue: parameters.walletAssetsValue,
      flashAssetsValue: parameters.flashAssetsValue,
      targetBorrowAssetsValue: parameters.targetBorrowAssetsValue,
      previewDepositShares: vaultPreview.previewDepositShares,
      depositSlippageBps: parseBps(depositSlippageBps),
      authorizationDeadline: parameters.authorizationDeadline ?? 1n,
      autoRevoke,
    })

    return { plan, vaultPreview }
  }

  async function computeDepositAutoLeveragePoints(parameters: { walletAssetsValue: bigint }) {
    if (!selectedProvider || !baseSnapshot || !account) {
      throw new Error('Connect a wallet and refresh the snapshot before computing the leverage range.')
    }

    const vault = assertAddress(vaultAddress)
    const riskConstraints: DepositRiskConstraints = {
      maxLtvAfter: parseOptionalPercentWad(maxLtvAfter, 'Max LTV after'),
      minHealthAfter: parseOptionalFactorWad(minHealthAfter, 'Min health after'),
    }
    const points: DepositAutoLeveragePoint[] = []
    const appendPoint = (point: DepositAutoLeveragePoint | null) => {
      if (!point) return

      if (
        points.some(
          (currentPoint) =>
            currentPoint.flashAssets === point.flashAssets &&
            currentPoint.targetBorrowAssets === point.targetBorrowAssets &&
            currentPoint.totalDepositAssets === point.totalDepositAssets,
        )
      ) {
        return
      }

      points.push(point)
    }
    const resolveRiskBoundedTargetBorrowAssets = (riskSearch: {
      flashAssetsValue: bigint
      minimumTargetBorrowAssets: bigint
      maximumTargetBorrowAssets: bigint
      previewDepositShares: bigint
      minimumPlan: Awaited<ReturnType<typeof buildMorphoBundlerDepositPlan>>
    }) => {
      if (!hasDepositRiskConstraints(riskConstraints)) {
        return riskSearch.maximumTargetBorrowAssets
      }

      const buildPlanAtTarget = (targetBorrowAssetsValue: bigint) =>
        targetBorrowAssetsValue === riskSearch.minimumPlan.summary.targetBorrowAssets
          ? riskSearch.minimumPlan
          : buildDepositPlanWithPreview({
              chainId,
              account: assertAddress(account),
              snapshot: baseSnapshot,
              vault,
              walletAssetsValue: parameters.walletAssetsValue,
              flashAssetsValue: riskSearch.flashAssetsValue,
              targetBorrowAssetsValue,
              previewDepositShares: riskSearch.previewDepositShares,
              depositSlippageBps: parseBps(depositSlippageBps),
              authorizationDeadline: 1n,
              autoRevoke,
            })

      const minimumPlan = riskSearch.minimumPlan
      if (!satisfiesDepositRiskConstraints(minimumPlan.summary.finalPosition, riskConstraints)) {
        return null
      }

      const maximumPlan = buildPlanAtTarget(riskSearch.maximumTargetBorrowAssets)
      if (satisfiesDepositRiskConstraints(maximumPlan.summary.finalPosition, riskConstraints)) {
        return riskSearch.maximumTargetBorrowAssets
      }

      let low = riskSearch.minimumTargetBorrowAssets
      let high = riskSearch.maximumTargetBorrowAssets
      let bestTargetBorrowAssets = riskSearch.minimumTargetBorrowAssets

      for (let index = 0; index < 24 && low < high; index += 1) {
        const mid = low + (high - low + 1n) / 2n
        const candidatePlan = buildPlanAtTarget(mid)

        if (satisfiesDepositRiskConstraints(candidatePlan.summary.finalPosition, riskConstraints)) {
          bestTargetBorrowAssets = mid
          low = mid
        } else {
          high = mid - 1n
        }
      }

      return bestTargetBorrowAssets
    }
    const buildFlashRange = async (flashAssetsValue: bigint) => {
      const minimumTargetBorrowAssets = baseSnapshot.borrowAssets + flashAssetsValue
      const { plan, vaultPreview } = await buildFreshDepositPlan({
        walletAssetsValue: parameters.walletAssetsValue,
        flashAssetsValue,
        targetBorrowAssetsValue: minimumTargetBorrowAssets,
      })

      if (plan.summary.maxTargetBorrowAssetsAfterConstraints < minimumTargetBorrowAssets) {
        return null
      }

      const maxTargetBorrowAssetsValue = plan.summary.maxTargetBorrowAssetsAfterConstraints
      const riskBoundedTargetBorrowAssetsValue = resolveRiskBoundedTargetBorrowAssets({
        flashAssetsValue,
        minimumTargetBorrowAssets,
        maximumTargetBorrowAssets: maxTargetBorrowAssetsValue,
        previewDepositShares: vaultPreview.previewDepositShares,
        minimumPlan: plan,
      })
      if (riskBoundedTargetBorrowAssetsValue == null) {
        return null
      }

      return {
        flashAssetsValue,
        minimumTargetBorrowAssets,
        maximumTargetBorrowAssets: riskBoundedTargetBorrowAssetsValue,
        previewDepositShares: vaultPreview.previewDepositShares,
        minimumPlan: plan,
      }
    }
    const buildPointFromTargetBorrowAssets = (pointBuild: {
      flashAssetsValue: bigint
      previewDepositShares: bigint
      minimumPlan: Awaited<ReturnType<typeof buildMorphoBundlerDepositPlan>>
      targetBorrowAssetsValue: bigint
    }): DepositAutoLeveragePoint => {
      const plan =
        pointBuild.targetBorrowAssetsValue === pointBuild.minimumPlan.summary.targetBorrowAssets
          ? pointBuild.minimumPlan
          : buildDepositPlanWithPreview({
              chainId,
              account: assertAddress(account),
              snapshot: baseSnapshot,
              vault,
              walletAssetsValue: parameters.walletAssetsValue,
              flashAssetsValue: pointBuild.flashAssetsValue,
              targetBorrowAssetsValue: pointBuild.targetBorrowAssetsValue,
              previewDepositShares: pointBuild.previewDepositShares,
              depositSlippageBps: parseBps(depositSlippageBps),
              authorizationDeadline: 1n,
              autoRevoke,
            })

      return {
        flashAssets: pointBuild.flashAssetsValue,
        targetBorrowAssets: plan.summary.targetBorrowAssets,
        totalDepositAssets: plan.summary.totalDepositAssets,
        utilizationAfter: plan.summary.finalPosition.market.utilization,
        previewDepositShares: pointBuild.previewDepositShares,
      }
    }
    const buildPointSeries = async (flashAssetsValue: bigint) => {
      const flashRange = await buildFlashRange(flashAssetsValue)
      if (!flashRange) return []

      const targetBorrowSamples = new Set<string>()
      const sampleCount = 20n
      targetBorrowSamples.add(flashRange.minimumTargetBorrowAssets.toString())
      targetBorrowSamples.add(flashRange.maximumTargetBorrowAssets.toString())

      if (flashRange.maximumTargetBorrowAssets > flashRange.minimumTargetBorrowAssets) {
        const delta = flashRange.maximumTargetBorrowAssets - flashRange.minimumTargetBorrowAssets
        for (let index = 1n; index < sampleCount; index += 1n) {
          targetBorrowSamples.add((flashRange.minimumTargetBorrowAssets + (delta * index) / sampleCount).toString())
        }
      }

      return [...targetBorrowSamples]
        .map((value) => BigInt(value))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((targetBorrowAssetsValue) =>
          buildPointFromTargetBorrowAssets({
            flashAssetsValue,
            previewDepositShares: flashRange.previewDepositShares,
            minimumPlan: flashRange.minimumPlan,
            targetBorrowAssetsValue,
          }),
        )
    }

    if (parameters.walletAssetsValue <= 0n) {
      if (satisfiesDepositRiskConstraints(baseSnapshot.accrualPosition, riskConstraints)) {
        appendPoint({
          flashAssets: 0n,
          targetBorrowAssets: baseSnapshot.borrowAssets,
          totalDepositAssets: 0n,
          utilizationAfter: baseSnapshot.market.utilization,
          previewDepositShares: 0n,
        })
      }
    } else {
      for (const point of await buildPointSeries(0n)) {
        appendPoint(point)
      }
    }

    let bestFlashAssets = 0n
    let low = 0n
    let high = baseSnapshot.maxFlashLoanAssets

    for (let index = 0; index < 24 && low < high; index += 1) {
      const mid = low + (high - low + 1n) / 2n
      const minimumTargetBorrowAssets = baseSnapshot.borrowAssets + mid
      const candidate = await buildFreshDepositPlan({
        walletAssetsValue: parameters.walletAssetsValue,
        flashAssetsValue: mid,
        targetBorrowAssetsValue: minimumTargetBorrowAssets,
      })

      if (candidate.plan.summary.maxTargetBorrowAssetsAfterConstraints >= minimumTargetBorrowAssets) {
        const flashRange = await buildFlashRange(mid)
        if (flashRange) {
          bestFlashAssets = mid
          low = mid
        } else {
          high = mid - 1n
        }
      } else {
        high = mid - 1n
      }
    }

    if (bestFlashAssets > 0n) {
      const sampleCount = 20n
      const flashSamples = new Set<string>()

      for (let index = 1n; index <= sampleCount; index += 1n) {
        flashSamples.add(((bestFlashAssets * index) / sampleCount).toString())
      }
      flashSamples.add(bestFlashAssets.toString())

      const sortedFlashSamples = [...flashSamples]
        .map((value) => BigInt(value))
        .filter((value) => value > 0n)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

      for (const flashAssetsValue of sortedFlashSamples) {
        for (const point of await buildPointSeries(flashAssetsValue)) {
          appendPoint(point)
        }
      }
    }

    if (points.length === 0) {
      throw new Error('No leverage point satisfies the current Max LTV after / Min health after constraints.')
    }

    return [...points].sort((left, right) => {
      if (left.utilizationAfter < right.utilizationAfter) return -1
      if (left.utilizationAfter > right.utilizationAfter) return 1
      if (left.flashAssets < right.flashAssets) return -1
      if (left.flashAssets > right.flashAssets) return 1
      if (left.targetBorrowAssets < right.targetBorrowAssets) return -1
      if (left.targetBorrowAssets > right.targetBorrowAssets) return 1
      return 0
    })
  }

  async function applyMaxFlashLoan() {
    if (!baseSnapshot) return

    const nextValue = formatUnits(baseSnapshot.maxFlashLoanAssets, baseSnapshot.loanTokenDecimals)
    setFlashAssets(nextValue)
    setStatus({
      tone: 'success',
      text: `Filled Flash assets with Morpho's current max flash-loan liquidity: ${nextValue} ${baseSnapshot.loanTokenSymbol}.`,
    })
  }

  function applyWalletBalance() {
    if (!baseSnapshot) return
    const nextValue = formatUnits(baseSnapshot.walletLoanTokenBalance, baseSnapshot.loanTokenDecimals)
    setWalletAssets(nextValue)
    setStatus({
      tone: 'success',
      text: `Filled Wallet assets in with the connected wallet balance: ${nextValue} ${baseSnapshot.loanTokenSymbol}.`,
    })
  }

  async function approveLoanToken() {
    if (!selectedProvider || !account || !baseSnapshot) {
      setStatus({ tone: 'error', text: 'Connect a wallet and refresh the snapshot before approving.' })
      return
    }

    try {
      const amount = parseUnits(walletAssets || '0', baseSnapshot.loanTokenDecimals)
      if (amount <= 0n) {
        throw new Error('Wallet assets must be greater than zero before approving.')
      }
      if (amount <= baseSnapshot.walletLoanTokenAllowanceToAdapter) {
        setStatus({ tone: 'success', text: 'Current GeneralAdapter1 allowance already covers the requested wallet assets.' })
        return
      }

      setStatus({ tone: 'idle', text: 'Requesting wallet confirmation for the exact ERC20 approval...' })

      const approveData = encodeFunctionData({
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [baseSnapshot.generalAdapter1, amount],
      })
      const txHash = await requestWithFallback(
        selectedProvider.provider,
        'eth_sendTransaction',
        'wallet_sendTransaction',
        [
          {
            from: assertAddress(account),
            to: baseSnapshot.marketParams.loanToken,
            data: approveData,
            value: '0x0',
          },
        ],
      )

      setLastTxHash(String(txHash))
      setStatus({
        tone: 'success',
        text: 'Approval transaction submitted. Refresh the snapshot after it confirms to update the allowance.',
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Failed to submit the ERC20 approval.',
      })
    }
  }

  function applyTargetUtilizationAfter(value: string) {
    setTargetUtilizationAfter(value)

    const trimmed = value.trim()
    if (!trimmed || depositAutoLeveragePoints.length === 0) return

    try {
      const targetUtilizationAfterValue = parseOptionalPercentWad(trimmed, 'Target utilization after')
      if (targetUtilizationAfterValue == null) return

      setDepositAutoLeverageIndex(
        findDepositAutoLeverageIndexForUtilization({
          points: depositAutoLeveragePoints,
          targetUtilizationAfter: targetUtilizationAfterValue,
        }),
      )
    } catch {
      // Keep the user's in-progress text while leaving the current feasible point unchanged.
    }
  }

  return (
    <div className="admin-shell">
      {/* ── Top bar ── */}
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__name">morpho4626</span>
          <span className="topbar__tag">Bundler3 Flash Engine</span>
        </div>
        <div className={`topbar__chip ${isCurrentChainSupported ? 'topbar__chip--ok' : 'topbar__chip--warn'}`}>
          <span className={`topbar__dot ${isCurrentChainSupported ? '' : 'topbar__dot--warn'}`} />
          {currentMorphoChain ? currentMorphoChain.network : `Chain ${chainId}`}
        </div>
        <div className="topbar__chip">
          {account ? `${account.slice(0, 6)}…${account.slice(-4)}` : 'Not connected'}
        </div>
        <button className="topbar__connect-btn" onClick={connectWallet} type="button">
          {account ? 'Reconnect' : 'Connect wallet'}
        </button>
      </header>

      {/* ── Sidebar ── */}
      <nav className="sidebar">
        <div className="workflow-label">Workflow</div>
        <div className="workflow-steps">

          {/* Step 1: Connect */}
          <a className={`workflow-step ${account ? 'workflow-step--done' : 'workflow-step--active'}`} href="#snapshot">
            <span className="workflow-step__badge">{account ? '✓' : '1'}</span>
            <div className="workflow-step__content">
              <div className="workflow-step__title">Connect Wallet</div>
              <div className="workflow-step__sub">{account ? `${account.slice(0,6)}…${account.slice(-4)}` : 'Not connected'}</div>
            </div>
            <span className="workflow-step__line" />
          </a>

          {/* Step 2: Select Market */}
          <a className={`workflow-step ${hasResolvedCurrentMarketConfig ? 'workflow-step--done' : account ? 'workflow-step--active' : ''}`} href="#market">
            <span className="workflow-step__badge">{hasResolvedCurrentMarketConfig ? '✓' : '2'}</span>
            <div className="workflow-step__content">
              <div className="workflow-step__title">Select Market</div>
              <div className="workflow-step__sub">{hasResolvedCurrentMarketConfig ? 'Market loaded' : 'Browse or paste ID'}</div>
            </div>
            <span className="workflow-step__line" />
          </a>

          {/* Step 3: Load Snapshot */}
          <a className={`workflow-step ${baseSnapshot ? 'workflow-step--done' : hasResolvedCurrentMarketConfig ? 'workflow-step--active' : ''}`} href="#snapshot">
            <span className="workflow-step__badge">{baseSnapshot ? '✓' : '3'}</span>
            <div className="workflow-step__content">
              <div className="workflow-step__title">Load Snapshot</div>
              <div className="workflow-step__sub">
                {baseSnapshot
                  ? `${baseSnapshot.loanTokenSymbol} / ${baseSnapshot.collateralTokenSymbol}`
                  : 'Refresh position'}
              </div>
            </div>
            <span className="workflow-step__line" />
          </a>

          {/* Step 4: Build Plan */}
          <a className={`workflow-step ${draft.plan && !draft.error ? 'workflow-step--done' : baseSnapshot ? 'workflow-step--active' : ''}`} href="#plan">
            <span className="workflow-step__badge">{draft.plan && !draft.error ? '✓' : '4'}</span>
            <div className="workflow-step__content">
              <div className="workflow-step__title">Build Plan</div>
              <div className="workflow-step__sub">{builderMode === 'redeem' ? 'Flash-loan exit' : 'Leveraged deposit'}</div>
            </div>
            <span className="workflow-step__line" />
          </a>

          {/* Step 5: Sign & Send */}
          <a className={`workflow-step ${lastTxHash ? 'workflow-step--done' : draft.plan && !draft.error ? 'workflow-step--active' : ''}`} href="#preview">
            <span className="workflow-step__badge">{lastTxHash ? '✓' : '5'}</span>
            <div className="workflow-step__content">
              <div className="workflow-step__title">Sign &amp; Send</div>
              <div className="workflow-step__sub">{lastTxHash ? 'Submitted' : 'Review and execute'}</div>
            </div>
          </a>

        </div>

        <div className="sidebar__divider" />
        <div className="sidebar__section-label">Debug</div>
        <a className="sidebar__item" href="#payloads">
          <svg className="sidebar__item-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h10l2 4v8H1V6zm2 1l-1 3h8l-1-3z"/></svg>
          Payloads
        </a>

        <div className="sidebar__divider" />
        <div className="sidebar__status">
          <div className="sidebar__status-label">Status</div>
          <div className={`sidebar__status-text sidebar__status-text--${status.tone}`}>{status.text}</div>
        </div>
      </nav>

      {/* ── Main content ── */}
      <main className="main-content">

        {/* Workflow progress bar */}
        <div className="progress-bar-wrap">
          {[
            { label: 'Connect', done: Boolean(account) },
            { label: 'Market', done: hasResolvedCurrentMarketConfig },
            { label: 'Snapshot', done: Boolean(baseSnapshot) },
            { label: 'Plan', done: Boolean(draft.plan && !draft.error) },
            { label: 'Send', done: Boolean(lastTxHash) },
          ].map((step, i, arr) => (
            <div key={step.label} className={`progress-step ${step.done ? 'progress-step--done' : i === arr.findIndex(s => !s.done) ? 'progress-step--active' : ''}`}>
              <span className="progress-step__dot" />
              <span className="progress-step__label">{step.label}</span>
              {i < arr.length - 1 && <span className="progress-step__connector" />}
            </div>
          ))}
        </div>

        {lastTxHash ? (
          <div className="status-banner status-banner--success">
            ✓ Transaction submitted: <span className="mono">{lastTxHash}</span>
          </div>
        ) : null}

        <div className="content-grid">

          {/* ── Market Discovery ── */}
          <section className="panel panel--wide" id="market">
            <div className="panel__heading">
              <div className="panel__heading-left">
                <span className="step-num">2</span>
                <h2>Select Market</h2>
              </div>
              <span className="pill">{currentChainLabel}</span>
            </div>
            <MarketSelector
              markets={discoveredVaultMarkets}
              selectedMarketId={selectedDiscoveredMarketId}
              chainLabel={currentChainLabel}
              helperText={marketSelectorHelperText}
              hasLoadedMarkets={hasDiscoveredMarketsForCurrentChain}
              discovering={discoveringMarkets}
              discoveredMarketsError={discoveredMarketsError}
              refreshDisabled={!selectedProvider || !isCurrentChainSupported || discoveringMarkets}
              onRefresh={() => void refreshDiscoveredVaultMarkets()}
              onSelectMarket={applyDiscoveredMarket}
            />
          </section>

          {/* ── Market Config ── */}
          <section className="panel" id="config">
            <div className="panel__heading">
              <div className="panel__heading-left">
                <span className="step-num step-num--sub">2b</span>
                <h2>Market Config</h2>
              </div>
              <span className="pill pill--soft">Auto-fill from ID</span>
            </div>
            <div className="market-manual">
              <p className="market-manual__copy">
                Paste a Morpho Market ID — loan token, collateral, oracle, IRM, decimals, and vault address are resolved automatically.
              </p>
              <div className="market-manual__fields">
                <TextField label="Market ID" value={marketIdInput} onChange={setMarketIdInput} />
              </div>
              {resolvingMarketConfig ? <div className="warning">Resolving market parameters…</div> : null}
              {marketConfigError ? <div className="warning">{marketConfigError}</div> : null}
              <div className="wallet-grid">
                <Stat label="Loan token" value={hasResolvedCurrentMarketConfig ? loanToken : '—'} monospace />
                <Stat label="Collateral token" value={hasResolvedCurrentMarketConfig ? collateralToken : '—'} monospace />
                <Stat label="Oracle" value={hasResolvedCurrentMarketConfig ? oracle : '—'} monospace />
                <Stat label="IRM" value={hasResolvedCurrentMarketConfig ? irm : '—'} monospace />
                <Stat label="LLTV (wad)" value={hasResolvedCurrentMarketConfig ? lltv : '—'} monospace />
                <Stat label="Loan decimals" value={hasResolvedCurrentMarketConfig ? loanTokenDecimals : '—'} />
                <Stat label="Collateral decimals" value={hasResolvedCurrentMarketConfig ? collateralTokenDecimals : '—'} />
                <Stat label="ERC-4626 vault" value={hasResolvedCurrentMarketConfig ? vaultAddress : '—'} monospace />
              </div>
            </div>
          </section>

          {/* ── Wallet + Snapshot (left) ── */}
          <section className="panel" id="snapshot">
            <div className="panel__heading">
              <div className="panel__heading-left">
                <span className="step-num">1</span>
                <h2>Connect Wallet</h2>
              </div>
              <span className="pill">{account ? 'Connected' : 'Disconnected'}</span>
            </div>
            <label className="field">
              <span>Injected provider</span>
              <select value={selectedProviderId} onChange={(event) => setSelectedProviderId(event.target.value)}>
                {providers.length === 0 ? <option>No injected provider found</option> : null}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
            </label>
            <div className="actions">
              <button
                className="primary-button"
                onClick={refreshBaseSnapshot}
                type="button"
                disabled={!selectedProvider || !account || refreshingSnapshot || !isCurrentChainSupported}
              >
                {refreshingSnapshot ? 'Refreshing…' : 'Refresh snapshot'}
              </button>
            </div>
            <div className="wallet-grid">
              <Stat label="Account" value={account || 'Not connected'} monospace />
              <Stat label="Chain" value={currentMorphoChain ? `${currentMorphoChain.network} (${chainId})` : `${chainId} (${numberToHex(chainId)})`} monospace />
              <Stat label="Morpho" value={currentMorphoAddress || 'Unsupported'} monospace />
              <Stat label="Bundler3" value={baseSnapshot?.bundler3 || '—'} monospace />
              <Stat label="GeneralAdapter1" value={baseSnapshot?.generalAdapter1 || '—'} monospace />
              <Stat label="Authorized now" value={baseSnapshot ? (baseSnapshot.isBundlerAuthorized ? 'Yes' : 'No') : '—'} />
            </div>
            <div className="note">
              <p><strong>Trust model.</strong> The only temporary privilege is Morpho authorization for <code>GeneralAdapter1</code>. Keep <strong>Auto revoke</strong> enabled to remove it in the same transaction.</p>
            </div>
          </section>

          {/* ── Position Snapshot (right) ── */}
          <section className="panel">
            <div className="panel__heading">
              <div className="panel__heading-left">
                <span className="step-num">3</span>
                <h2>Position Snapshot</h2>
              </div>
              <span className={`pill ${baseSnapshot ? 'pill--green' : ''}`}>{baseSnapshot ? 'Loaded' : 'Pending'}</span>
            </div>
            <div className="wallet-grid">
              <Stat label="Market ID" value={baseSnapshot?.marketId || marketIdInput || '—'} monospace />
              <Stat label="Borrow assets" value={baseSnapshot ? `${formatUnits(baseSnapshot.borrowAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}` : '—'} />
              <Stat label="Borrow shares" value={baseSnapshot ? baseSnapshot.borrowShares.toString() : '—'} monospace />
              <Stat label="Collateral" value={baseSnapshot ? `${formatUnits(baseSnapshot.collateral, baseSnapshot.collateralTokenDecimals)} ${baseSnapshot.collateralTokenSymbol}` : '—'} />
              <Stat label="Current LTV" value={baseSnapshot ? formatWadPercent(baseSnapshot.accrualPosition.ltv) : '—'} />
              <Stat label="Health factor" value={baseSnapshot ? formatFactor(baseSnapshot.accrualPosition.healthFactor) : '—'} />
              <Stat label="Borrow APY" value={baseSnapshot ? formatPercent(baseSnapshot.market.borrowApy) : '—'} />
              <Stat label="Supply APY" value={baseSnapshot ? formatPercent(baseSnapshot.market.supplyApy) : '—'} />
              <Stat label="Utilization" value={baseSnapshot ? formatWadPercent(baseSnapshot.market.utilization) : '—'} />
              <Stat label="Full repay est." value={baseSnapshot ? `${formatUnits(baseSnapshot.estimatedFullRepayAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}` : '—'} />
              <Stat label="Max flash loan" value={baseSnapshot ? `${formatUnits(baseSnapshot.maxFlashLoanAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}` : '—'} />
              <Stat label="Morpho nonce" value={baseSnapshot ? baseSnapshot.morphoNonce.toString() : '—'} monospace />
              <Stat label="Wallet loan bal." value={baseSnapshot ? `${formatUnits(baseSnapshot.walletLoanTokenBalance, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}` : '—'} />
              <Stat label="Adapter allowance" value={baseSnapshot ? `${formatUnits(baseSnapshot.walletLoanTokenAllowanceToAdapter, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}` : '—'} />
              <Stat label="Vault asset" value={vaultSnapshot?.asset || vaultError || '—'} monospace={Boolean(vaultSnapshot?.asset)} />
            </div>
            {builderMode === 'redeem' && baseSnapshot && baseSnapshot.borrowShares === 0n && baseSnapshot.collateral === 0n ? (
              <div className="warning">The connected account has no position on this market.</div>
            ) : null}
            {snapshotError ? <div className="warning">{snapshotError}</div> : null}
            {vaultError ? <div className="warning">{vaultError}</div> : null}
          </section>

          {/* ── Plan ── */}
          <section className="panel panel--wide" id="plan">
            <div className="panel__heading">
              <div className="panel__heading-left">
                <span className="step-num">4</span>
                <h2>Build Plan</h2>
              </div>
              <span className="pill">
                {builderMode === 'redeem' ? 'Flash-loan exit' : 'Leveraged deposit'}
              </span>
            </div>

            {/* Mode toggle */}
            <div className="mode-tabs">
              <button
                className={`mode-tab ${builderMode === 'redeem' ? 'mode-tab--active' : ''}`}
                onClick={() => setBuilderMode('redeem')}
                type="button"
              >
                Redeem / Exit
              </button>
              <button
                className={`mode-tab ${builderMode === 'deposit' ? 'mode-tab--active' : ''}`}
                onClick={() => setBuilderMode('deposit')}
                type="button"
              >
                Deposit / Leverage
              </button>
            </div>

            {builderMode === 'redeem' ? (
              /* ── REDEEM MODE ── */
              <div className="two-col">
                {/* Constraint inputs */}
                <TextField label="Max LTV after (%)" value={redeemMaxLtvAfter} onChange={setRedeemMaxLtvAfter} />
                <TextField label="Min health after (x)" value={redeemMinHealthAfter} onChange={setRedeemMinHealthAfter} />

                {/* Exit slider */}
                <div className="field field--span-2">
                  <span>Exit fraction</span>
                  <div className="exit-slider">
                    <div className="exit-slider__header">
                      <div>
                        <div className="exit-slider__label">Position exit</div>
                        <div className="exit-slider__value">
                          {activeRedeemAutoPoint
                            ? `${((Number(activeRedeemAutoPoint.fractionWad) / 1e18) * 100).toFixed(0)}%`
                            : redeemAutoLoading ? '…' : 'N/A'}
                        </div>
                      </div>
                      <span className="pill pill--soft">
                        {redeemAutoLoading
                          ? 'Computing path'
                          : redeemAutoPoints.length > 0
                            ? `${redeemAutoPoints.length} steps`
                            : 'Unavailable'}
                      </span>
                    </div>

                    <div className="exit-slider__range-wrap">
                      <div className="exit-slider__track">
                        <div className="exit-slider__track-fill" style={{ width: `${redeemAutoProgress}%` }} />
                      </div>
                      <input
                        className="exit-slider__range"
                        type="range"
                        min={0}
                        max={Math.max(redeemAutoPoints.length - 1, 0)}
                        step={1}
                        value={clampNumber(redeemAutoIndex, 0, Math.max(redeemAutoPoints.length - 1, 0))}
                        onChange={(event) => setRedeemAutoIndex(Number(event.target.value))}
                        disabled={redeemAutoLoading || redeemAutoPoints.length <= 1}
                      />
                    </div>

                    <div className="exit-slider__legend">
                      <span>Hold (0% exit)</span>
                      <span>Full exit (100%)</span>
                    </div>

                    <div className="exit-slider__stats">
                      <Stat
                        label="Repay"
                        value={activeRedeemAutoPoint && baseSnapshot
                          ? `${formatUnits(activeRedeemAutoPoint.repayAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                          : '—'}
                      />
                      <Stat
                        label="Withdraw collateral"
                        value={activeRedeemAutoPoint && baseSnapshot
                          ? `${formatUnits(activeRedeemAutoPoint.withdrawCollateral, baseSnapshot.collateralTokenDecimals)} ${baseSnapshot.collateralTokenSymbol}`
                          : '—'}
                      />
                      <Stat
                        label="Health after"
                        value={activeRedeemAutoPoint
                          ? (activeRedeemAutoPoint.healthAfter != null ? formatFactor(activeRedeemAutoPoint.healthAfter) : 'Full exit')
                          : '—'}
                      />
                    </div>
                  </div>
                </div>

                {/* Quick exit buttons */}
                <div className="field field--span-2">
                  <span>Quick exit</span>
                  <div className="actions">
                    <button className="ghost-button" onClick={() => setRedeemAutoIndex(0)} type="button" disabled={redeemAutoLoading || redeemAutoPoints.length === 0}>Hold</button>
                    <button className="ghost-button" onClick={() => setRedeemAutoIndex(Math.floor(redeemAutoPoints.length * 0.25))} type="button" disabled={redeemAutoLoading || redeemAutoPoints.length < 4}>25%</button>
                    <button className="ghost-button" onClick={() => setRedeemAutoIndex(Math.floor(redeemAutoPoints.length * 0.5))} type="button" disabled={redeemAutoLoading || redeemAutoPoints.length < 2}>50%</button>
                    <button className="ghost-button" onClick={() => setRedeemAutoIndex(Math.floor(redeemAutoPoints.length * 0.75))} type="button" disabled={redeemAutoLoading || redeemAutoPoints.length < 4}>75%</button>
                    <button className="ghost-button" onClick={() => setRedeemAutoIndex(redeemAutoPoints.length - 1)} type="button" disabled={redeemAutoLoading || redeemAutoPoints.length === 0}>Full exit</button>
                    <button className="ghost-button" onClick={applyMaxSafeWithdraw} type="button" disabled={!redeemPreview?.maxSafeWithdrawAfterRepay}>Max safe withdraw</button>
                  </div>
                </div>

                <TextField label="Redeem slippage (bps)" value={redeemSlippageBps} onChange={setRedeemSlippageBps} />
                <TextField label="Flash buffer (bps)" value={flashBufferBps} onChange={setFlashBufferBps} />
                <TextField label="Auth deadline (min)" value={authorizationDeadlineMinutes} onChange={setAuthorizationDeadlineMinutes} />
                <label className="field--toggle">
                  <span>Auto revoke Morpho authorization</span>
                  <label className="toggle">
                    <input checked={autoRevoke} onChange={(event) => setAutoRevoke(event.target.checked)} type="checkbox" />
                    <span className="toggle__track"><span className="toggle__thumb" /></span>
                  </label>
                </label>

                {redeemAutoError ? <div className="warning field--span-2">{redeemAutoError}</div> : null}

                <div className="note field--span-2">
                  <p><strong>Callback sequence.</strong> Authorize <code>GeneralAdapter1</code>, flash-loan loan token, repay Morpho debt, withdraw collateral, redeem ERC-4626 vault shares into loan token, sweep leftover, optionally revoke authorization.</p>
                  <p><strong>Slider.</strong> Drag from 0 % (hold position) to 100 % (full exit). At each step the app auto-sizes flash assets with your buffer and finds the maximum safe collateral withdrawal. Set <em>Max LTV after</em> or <em>Min health after</em> to cap how much collateral is withdrawn per step.</p>
                  <p><strong>Loop mode.</strong> When flash liquidity is below the full debt, the builder automatically caps flash assets and adds multi-leg loop iterations in a single callback.</p>
                </div>
              </div>
            ) : (
              /* ── DEPOSIT MODE ── */
              <div className="two-col">
                <TextField label="Wallet assets in" value={walletAssets} onChange={setWalletAssets} />
                <TextField label="Deposit slippage (bps)" value={depositSlippageBps} onChange={setDepositSlippageBps} />
                <TextField label="Max LTV after (%)" value={maxLtvAfter} onChange={setMaxLtvAfter} />
                <TextField label="Min health after (x)" value={minHealthAfter} onChange={setMinHealthAfter} />
                <TextField label="Target utilization after (%)" value={targetUtilizationAfter} onChange={applyTargetUtilizationAfter} />

                <div className="field field--span-2">
                  <span>Utilization after</span>
                  <div className="leverage-slider">
                    <div className="leverage-slider__header">
                      <div>
                        <div className="leverage-slider__label">Auto leverage</div>
                        <div className="leverage-slider__value">
                          {activeDepositAutoLeveragePoint
                            ? formatWadPercent(activeDepositAutoLeveragePoint.utilizationAfter)
                            : 'Not ready'}
                        </div>
                      </div>
                      <span className="pill pill--soft">
                        {depositAutoLeverageLoading
                          ? 'Computing path'
                          : depositAutoLeveragePoints.length > 0
                            ? `${depositAutoLeveragePoints.length} feasible steps`
                            : 'Unavailable'}
                      </span>
                    </div>

                    <div className="leverage-slider__range-wrap">
                      <div className="leverage-slider__track">
                        <div className="leverage-slider__track-fill" style={{ width: `${depositAutoLeverageProgress}%` }} />
                      </div>
                      <input
                        className="leverage-slider__range"
                        type="range"
                        min={0}
                        max={Math.max(depositAutoLeveragePoints.length - 1, 0)}
                        step={1}
                        value={clampNumber(depositAutoLeverageIndex, 0, Math.max(depositAutoLeveragePoints.length - 1, 0))}
                        onChange={(event) => setDepositAutoLeverageIndex(Number(event.target.value))}
                        disabled={depositAutoLeverageLoading || depositAutoLeveragePoints.length <= 1}
                      />
                    </div>

                    <div className="leverage-slider__legend">
                      <span>{`Current ${baseSnapshot ? formatWadPercent(baseSnapshot.market.utilization) : 'N/A'}`}</span>
                      <span>
                        {depositAutoLeverageMaxPoint
                          ? `Max ${formatWadPercent(depositAutoLeverageMaxPoint.utilizationAfter)}`
                          : 'Max N/A'}
                      </span>
                    </div>

                    <div className="leverage-slider__stats">
                      <Stat
                        label="Flash assets"
                        value={activeDepositAutoLeveragePoint && baseSnapshot
                          ? `${formatUnits(activeDepositAutoLeveragePoint.flashAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                          : '—'}
                      />
                      <Stat
                        label="Target borrow after"
                        value={activeDepositAutoLeveragePoint && baseSnapshot
                          ? `${formatUnits(activeDepositAutoLeveragePoint.targetBorrowAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                          : '—'}
                      />
                      <Stat
                        label="Vault deposit"
                        value={activeDepositAutoLeveragePoint && baseSnapshot
                          ? `${formatUnits(activeDepositAutoLeveragePoint.totalDepositAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                          : '—'}
                      />
                    </div>
                  </div>
                </div>

                <div className="actions field--span-2">
                  <button className="ghost-button" onClick={() => setDepositAutoLeverageIndex(0)} type="button" disabled={depositAutoLeverageLoading || depositAutoLeveragePoints.length === 0}>Current point</button>
                  <button className="ghost-button" onClick={() => setDepositAutoLeverageIndex(Math.max(depositAutoLeveragePoints.length - 1, 0))} type="button" disabled={depositAutoLeverageLoading || depositAutoLeveragePoints.length <= 1}>Max leverage</button>
                  <button className="ghost-button" onClick={applyWalletBalance} type="button" disabled={!baseSnapshot}>Use wallet balance</button>
                  <button className="ghost-button" onClick={approveLoanToken} type="button" disabled={!baseSnapshot || !walletAssets.trim() || walletAssets.trim() === '0'}>Approve exact amount</button>
                </div>

                <TextField label="Auth deadline (min)" value={authorizationDeadlineMinutes} onChange={setAuthorizationDeadlineMinutes} />
                <label className="field--toggle">
                  <span>Auto revoke Morpho authorization</span>
                  <label className="toggle">
                    <input checked={autoRevoke} onChange={(event) => setAutoRevoke(event.target.checked)} type="checkbox" />
                    <span className="toggle__track"><span className="toggle__thumb" /></span>
                  </label>
                </label>

                {depositAutoLeverageError ? <div className="warning field--span-2">{depositAutoLeverageError}</div> : null}

                <div className="note field--span-2">
                  <p><strong>Callback sequence.</strong> Optionally pull loan tokens from wallet, flash-loan, deposit into ERC-4626 vault, supply vault shares as Morpho collateral, borrow against collateral, sweep remainder back to wallet, optionally revoke authorization.</p>
                  <p><strong>Slider.</strong> Keeps <em>Wallet assets in</em> fixed and grows flash + borrow along the feasible leverage path. Drag or type a target utilization. Max LTV after / Min health after constraints limit the upper end of the slider.</p>
                  <p><strong>Allowance.</strong> Deposit mode needs an ERC20 approval on the loan token for <code>GeneralAdapter1</code> when <em>Wallet assets in</em> &gt; 0.</p>
                </div>
              </div>
            )}
          </section>

          {/* ── Expected Effect ── */}
          <section className="panel" id="effect">
            <div className="panel__heading">
              <h2>Expected Effect</h2>
              <span className="pill pill--soft">Local simulation</span>
            </div>

            {builderMode === 'deposit' ? (
              <div className="wallet-grid">
                <Stat label="Wallet assets in" value={depositPreview ? `${formatUnits(depositPreview.walletAssetsIn, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Flash used" value={depositPreview ? `${formatUnits(depositPreview.flashAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Target borrow after" value={depositPreview ? `${formatUnits(depositPreview.targetBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Vault deposit" value={depositPreview ? `${formatUnits(depositPreview.totalDepositAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Preview deposit shares" value={depositPreview ? `${formatUnits(depositPreview.previewDepositShares, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Added borrow" value={depositPreview ? `${formatUnits(depositPreview.additionalBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Final borrow" value={depositPreview ? `${formatUnits(depositPreview.finalBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Liquid out after flash" value={depositPreview ? `${formatUnits(depositPreview.netLoanTokenOut, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Borrow after" value={depositPreview ? `${formatUnits(depositPreview.finalPosition.borrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Collateral after" value={depositPreview ? `${formatUnits(depositPreview.finalPosition.collateral, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="LTV after" value={depositPreview ? formatWadPercent(depositPreview.finalPosition.ltv) : '—'} />
                <Stat label="Health after" value={depositPreview ? formatFactor(depositPreview.finalPosition.healthFactor) : '—'} />
                <Stat label="Borrow APY after" value={depositPreview ? formatPercent(depositPreview.finalPosition.market.borrowApy) : '—'} />
                <Stat label="Utilization after" value={depositPreview ? formatWadPercent(depositPreview.finalPosition.market.utilization) : '—'} />
              </div>
            ) : (
              <div className="wallet-grid">
                <Stat label="Repay used" value={redeemPreview ? `${formatUnits(redeemPreview.repayAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Requested withdraw" value={redeemPreview ? `${formatUnits(redeemPreview.requestedWithdrawCollateral, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Max safe withdraw" value={redeemPreview?.maxSafeWithdrawAfterRepay != null ? `${formatUnits(redeemPreview.maxSafeWithdrawAfterRepay, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Loop legs" value={redeemPreview?.usedLoop ? String(redeemPreview.loopIterations ?? 0) : '1'} />
                <Stat label="Borrow after" value={redeemPreview?.afterWithdrawPosition ? `${formatUnits(redeemPreview.afterWithdrawPosition.borrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : redeemPreview ? `${formatUnits(redeemPreview.afterRepayPosition.borrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="Collateral after" value={redeemPreview?.afterWithdrawPosition ? `${formatUnits(redeemPreview.afterWithdrawPosition.collateral, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim() : redeemPreview ? `${formatUnits(redeemPreview.afterRepayPosition.collateral, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim() : '—'} />
                <Stat label="LTV after" value={redeemPreview?.afterWithdrawPosition ? formatWadPercent(redeemPreview.afterWithdrawPosition.ltv) : redeemPreview ? formatWadPercent(redeemPreview.afterRepayPosition.ltv) : '—'} />
                <Stat label="Health after" value={redeemPreview?.afterWithdrawPosition ? formatFactor(redeemPreview.afterWithdrawPosition.healthFactor) : redeemPreview ? formatFactor(redeemPreview.afterRepayPosition.healthFactor) : '—'} />
                <Stat label="Borrow APY after" value={redeemPreview ? formatPercent(redeemPreview.afterRepayPosition.market.borrowApy) : '—'} />
                <Stat label="Utilization after" value={redeemPreview ? formatWadPercent(redeemPreview.afterRepayPosition.market.utilization) : '—'} />
              </div>
            )}
            {redeemPreview?.withdrawError ? <div className="warning">{redeemPreview.withdrawError}</div> : null}
            {depositPreview?.message ? <div className="warning">{depositPreview.message}</div> : null}
          </section>

          {/* ── Preview & Send ── */}
          <section className="panel" id="preview">
            <div className="panel__heading">
              <div className="panel__heading-left">
                <span className="step-num">5</span>
                <h2>Sign &amp; Send</h2>
              </div>
              <span className="pill pill--soft">Dry build</span>
            </div>

            <div className="wallet-grid">
              {builderMode === 'deposit' ? (
                <>
                  <Stat label="Vault deposit" value={previewAmount != null ? `${formatUnits(previewAmount, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                  <Stat label="Preview deposit shares" value={previewShares != null ? `${formatUnits(previewShares, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim() : '—'} />
                  <Stat label="Target borrow after" value={draft.targetBorrowAssets != null ? `${formatUnits(draft.targetBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                  <Stat label="Estimated added borrow" value={previewExpectedBorrowAssets != null ? `${formatUnits(previewExpectedBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                  <Stat label="Liquid out after flash" value={previewEstimatedNetAssets != null ? `${formatUnits(previewEstimatedNetAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                </>
              ) : (
                <>
                  <Stat label="Withdraw shares" value={previewShares != null ? `${formatUnits(previewShares, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim() : '—'} />
                  <Stat label="Preview redeem" value={previewAmount != null ? `${formatUnits(previewAmount, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                  <Stat label="Estimated repay" value={previewExpectedRepayAssets != null ? `${formatUnits(previewExpectedRepayAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                  <Stat label="Estimated net out" value={previewEstimatedNetAssets != null ? `${formatUnits(previewEstimatedNetAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim() : '—'} />
                </>
              )}
            </div>

            {draft.error ? <div className="warning">{draft.error}</div> : null}
            {draft.warnings.map((w: string) => <div className="warning" key={w}>{w}</div>)}

            <div className="actions" style={{ marginTop: 16 }}>
              <button
                className="primary-button"
                onClick={sendBundle}
                type="button"
                disabled={!selectedProvider || !account || Boolean(draft.error) || sendingBundle}
              >
                {sendingBundle ? 'Signing + sending…' : `Sign and send ${builderMode === 'redeem' ? 'redeem' : 'deposit'} tx`}
              </button>
            </div>
          </section>

          {/* ── Payloads ── */}
          <section className="panel panel--wide" id="payloads">
            <div className="panel__heading">
              <h2>Payloads</h2>
              <span className="pill">Builder output</span>
            </div>
            <PayloadBlock label="Unsigned actions" value={actionJson} helper="Bundler3 actions that will be encoded on send. Null Morpho authorization signatures are requested from the wallet immediately before submission." />
            <PayloadBlock label="Authorization typed data" value={lastTypedDataJson || typedDataJson} helper="The wallet signs these EIP-712 messages off-chain. With auto-revoke enabled there are two signatures: authorize then revoke." />
            <PayloadBlock label="Signed transaction request" value={lastSignedRequestJson} helper="After signatures are collected, this is the single standard Ethereum transaction submitted to Bundler3." />
          </section>

        </div>
      </main>
    </div>
  )
}

async function fetchBaseSnapshot(parameters: {
  provider: Eip1193Provider
  account: Address
  marketId?: Hex | null
  marketParams: MarketParams
  chainId: number
}): Promise<BaseSnapshot> {
  const client = createPublicClient({
    transport: custom(parameters.provider),
  })

  const marketId = (parameters.marketId ?? buildMarketId(parameters.marketParams)) as unknown as Parameters<
    typeof fetchMarket
  >[0]
  const [market, user] = await Promise.all([
    fetchMarket(marketId, client, { chainId: parameters.chainId }),
    fetchUser(parameters.account, client, { chainId: parameters.chainId }),
  ])
  const [position, loanTokenInfo, collateralTokenInfo] = await Promise.all([
    fetchPosition(parameters.account, marketId, client, { chainId: parameters.chainId }),
    fetchToken(market.params.loanToken, client, { chainId: parameters.chainId }),
    fetchToken(market.params.collateralToken, client, { chainId: parameters.chainId }),
  ])
  const accrualPosition = new AccrualPosition(position, market)
  const { bundler3, morpho } = getChainAddresses(parameters.chainId)
  const borrowAssets = market.toBorrowAssets(position.borrowShares)
  const [maxFlashLoanAssets, walletLoanTokenBalance, walletLoanTokenAllowanceToAdapter] = await Promise.all([
    client.readContract({
      address: market.params.loanToken,
      abi: erc20BalanceOfAbi,
      functionName: 'balanceOf',
      args: [morpho],
    }),
    client.readContract({
      address: market.params.loanToken,
      abi: erc20BalanceOfAbi,
      functionName: 'balanceOf',
      args: [parameters.account],
    }),
    client.readContract({
      address: market.params.loanToken,
      abi: erc20AllowanceAbi,
      functionName: 'allowance',
      args: [parameters.account, bundler3.generalAdapter1],
    }),
  ])

  return {
    marketId: market.id as Hex,
    market,
    accrualPosition,
    marketParams: {
      loanToken: market.params.loanToken,
      collateralToken: market.params.collateralToken,
      oracle: market.params.oracle,
      irm: market.params.irm,
      lltv: market.params.lltv,
    },
    borrowShares: position.borrowShares,
    borrowAssets,
    collateral: position.collateral,
    estimatedFullRepayAssets: borrowAssets,
    morphoNonce: user.morphoNonce,
    isBundlerAuthorized: user.isBundlerAuthorized,
    bundler3: bundler3.bundler3,
    generalAdapter1: bundler3.generalAdapter1,
    loanTokenSymbol: loanTokenInfo.symbol ?? 'Loan token',
    collateralTokenSymbol: collateralTokenInfo.symbol ?? 'Collateral token',
    loanTokenDecimals: loanTokenInfo.decimals ?? 18,
    collateralTokenDecimals: collateralTokenInfo.decimals ?? 18,
    maxFlashLoanAssets,
    walletLoanTokenBalance,
    walletLoanTokenAllowanceToAdapter,
  }
}

async function fetchMarketConfigById(parameters: {
  provider: Eip1193Provider
  marketId: Hex
  chainId: number
}): Promise<ResolvedMarketConfig> {
  const client = createPublicClient({
    transport: custom(parameters.provider),
  })

  const market = await fetchMarket(parameters.marketId as Parameters<typeof fetchMarket>[0], client, {
    chainId: parameters.chainId,
  })
  const [loanTokenInfo, collateralTokenInfo] = await Promise.all([
    fetchToken(market.params.loanToken, client, { chainId: parameters.chainId }),
    fetchToken(market.params.collateralToken, client, { chainId: parameters.chainId }),
  ])

  return {
    marketId: market.id as Hex,
    marketParams: {
      loanToken: market.params.loanToken,
      collateralToken: market.params.collateralToken,
      oracle: market.params.oracle,
      irm: market.params.irm,
      lltv: market.params.lltv,
    },
    loanTokenDecimals: loanTokenInfo.decimals ?? 18,
    collateralTokenDecimals: collateralTokenInfo.decimals ?? 18,
  }
}

async function fetchVaultSnapshot(parameters: {
  provider: Eip1193Provider
  vault: Address
  shares: bigint
  assets: bigint
}): Promise<VaultSnapshot> {
  const client = createPublicClient({
    transport: custom(parameters.provider),
  })

  const [asset, previewRedeemAssets, previewDepositShares] = await Promise.all([
    client
      .readContract({
        address: parameters.vault,
        abi: erc4626InspectorAbi,
        functionName: 'asset',
      })
      .then((value) => assertAddress(value))
      .catch(() => null),
    parameters.shares > 0n
      ? client.readContract({
          address: parameters.vault,
          abi: erc4626InspectorAbi,
          functionName: 'previewRedeem',
          args: [parameters.shares],
        })
      : 0n,
    parameters.assets > 0n
      ? client.readContract({
          address: parameters.vault,
          abi: erc4626InspectorAbi,
          functionName: 'previewDeposit',
          args: [parameters.assets],
        })
      : 0n,
  ])

  return {
    asset,
    previewRedeemAssets,
    redeemShares: parameters.shares,
    previewDepositShares,
    depositAssets: parameters.assets,
  }
}

function buildDepositPlanWithPreview(parameters: {
  chainId: number
  account: Address
  snapshot: BaseSnapshot
  vault: Address
  walletAssetsValue: bigint
  flashAssetsValue: bigint
  targetBorrowAssetsValue: bigint
  previewDepositShares: bigint
  depositSlippageBps: bigint
  authorizationDeadline: bigint
  autoRevoke: boolean
}) {
  const maxVaultSharePriceE27 = computeMaxSharePriceE27({
    assets: parameters.walletAssetsValue + parameters.flashAssetsValue,
    previewShares: parameters.previewDepositShares,
    slippageBps: parameters.depositSlippageBps,
  })

  return buildMorphoBundlerDepositPlan({
    chainId: parameters.chainId,
    account: parameters.account,
    marketParams: parameters.snapshot.marketParams,
    vault: parameters.vault,
    morphoLiquidityAssets: parameters.snapshot.maxFlashLoanAssets,
    walletAssets: parameters.walletAssetsValue,
    flashAssets: parameters.flashAssetsValue,
    targetBorrowAssets: parameters.targetBorrowAssetsValue,
    maxVaultSharePriceE27,
    borrowSlippageBps: parameters.depositSlippageBps,
    authorizationNonce: parameters.snapshot.morphoNonce,
    authorizationDeadline: parameters.authorizationDeadline,
    autoRevoke: parameters.autoRevoke,
    skipInitialAuthorization: parameters.snapshot.isBundlerAuthorized,
    accrualPosition: parameters.snapshot.accrualPosition,
    previewDepositShares: parameters.previewDepositShares,
  })
}


async function signTypedDataWithProvider(
  provider: Eip1193Provider,
  account: Address,
  typedData: any,
): Promise<Hex> {
  try {
    const client = createWalletClient({
      account,
      transport: custom(provider),
    })

    return await client.signTypedData({
      ...typedData,
      account,
    })
  } catch (error) {
    const payload = stringifyForDisplay(typedData)

    try {
      return String(
        await provider.request({
          method: 'eth_signTypedData_v4',
          params: [account, payload],
        }),
      ) as Hex
    } catch (fallbackError) {
      throw fallbackError instanceof Error ? fallbackError : error
    }
  }
}

function detectInjectedProviders(): ProviderOption[] {
  const globalWindow = window as WindowWithWallets
  const seen = new Set<Eip1193Provider>()
  const options: ProviderOption[] = []

  const addProvider = (provider: Eip1193Provider | undefined, fallbackLabel?: string) => {
    if (!provider || seen.has(provider)) return
    seen.add(provider)
    options.push(buildProviderOption(provider, fallbackLabel))
  }

  const okxProvider =
    globalWindow.okxwallet && 'ethereum' in globalWindow.okxwallet
      ? globalWindow.okxwallet.ethereum
      : globalWindow.okxwallet && 'request' in globalWindow.okxwallet
        ? globalWindow.okxwallet
        : undefined

  addProvider(okxProvider, 'OKX Wallet')

  const ethereumProviders = globalWindow.ethereum?.providers ?? (globalWindow.ethereum ? [globalWindow.ethereum] : [])

  for (const provider of ethereumProviders) {
    if (provider.isOkxWallet || provider.isOKExWallet) addProvider(provider, 'OKX Wallet')
    else if (provider.isMetaMask) addProvider(provider, 'MetaMask')
    else if (provider.isCoinbaseWallet) addProvider(provider, 'Coinbase Wallet')
    else if (provider.isRabby) addProvider(provider, 'Rabby')
    else addProvider(provider, 'Injected wallet')
  }

  return options
}

function buildProviderOption(provider: Eip1193Provider, fallbackLabel = 'Injected wallet'): ProviderOption {
  const label = describeProvider(provider, fallbackLabel)
  return {
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
    provider,
  }
}

function describeProvider(provider: Eip1193Provider, fallbackLabel: string) {
  if (provider.isOkxWallet || provider.isOKExWallet) return 'OKX Wallet'
  if (provider.isMetaMask) return 'MetaMask'
  if (provider.isCoinbaseWallet) return 'Coinbase Wallet'
  if (provider.isRabby) return 'Rabby'
  return fallbackLabel.trim() || 'Injected wallet'
}

function mergeProviderOptions(currentProviders: ProviderOption[], nextProviders: ProviderOption[]) {
  if (nextProviders.length === 0) return currentProviders

  const mergedProviders = [...currentProviders]

  for (const nextProvider of nextProviders) {
    const existingIndex = mergedProviders.findIndex((provider) => provider.provider === nextProvider.provider)

    if (existingIndex >= 0) {
      mergedProviders[existingIndex] = nextProvider
      continue
    }

    if (!mergedProviders.some((provider) => provider.id === nextProvider.id && provider.label === nextProvider.label)) {
      mergedProviders.push(nextProvider)
      continue
    }

    mergedProviders.push({
      ...nextProvider,
      id: `${nextProvider.id}-${mergedProviders.length}`,
    })
  }

  return mergedProviders
}

function refreshProviderSelection(
  currentProviders: ProviderOption[],
  setProviders: (value: ProviderOption[] | ((value: ProviderOption[]) => ProviderOption[])) => void,
  setSelectedProviderId: (value: string) => void,
) {
  const detectedProviders = detectInjectedProviders()
  const nextProviders = mergeProviderOptions(currentProviders, detectedProviders)

  setProviders(nextProviders)

  const nextProvider = nextProviders[0] ?? null
  if (nextProvider) setSelectedProviderId(nextProvider.id)
  return nextProvider
}

async function refreshWalletChain(provider: Eip1193Provider, setChainId: (value: number) => void) {
  const chainIdHex = await provider.request({ method: 'eth_chainId' })
  setChainId(Number.parseInt(String(chainIdHex), 16))
}

async function requestWithFallback(
  provider: Eip1193Provider,
  primaryMethod: string,
  fallbackMethod: string,
  params: unknown[],
) {
  try {
    return await provider.request({ method: primaryMethod, params })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/Method not found|unsupported|not support|Invalid params/i.test(message)) throw error
    return provider.request({ method: fallbackMethod, params })
  }
}

function parseMarketParams(parameters: {
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: string
}): MarketParams {
  return {
    loanToken: assertAddress(parameters.loanToken),
    collateralToken: assertAddress(parameters.collateralToken),
    oracle: assertAddress(parameters.oracle),
    irm: assertAddress(parameters.irm),
    lltv: BigInt(parameters.lltv),
  }
}

function parseOptionalMarketId(value: string): Hex | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(`Invalid market id: ${value}`)
  }
  return trimmed as Hex
}

function readWithdrawShares(parameters: {
  withdrawAllCollateral: boolean
  withdrawCollateralAssets: string
  collateralTokenDecimals: string
  collateralFromSnapshot?: bigint
}) {
  if (parameters.withdrawAllCollateral) return parameters.collateralFromSnapshot ?? 0n
  if (!parameters.withdrawCollateralAssets.trim()) return 0n
  return parseUnits(parameters.withdrawCollateralAssets, Number(parameters.collateralTokenDecimals))
}

function readDepositAssets(parameters: {
  walletAssets: string
  flashAssets: string
  loanTokenDecimals: string
}) {
  const walletAssets = parameters.walletAssets.trim() ? parseUnits(parameters.walletAssets, Number(parameters.loanTokenDecimals)) : 0n
  const flashAssets = parameters.flashAssets.trim() ? parseUnits(parameters.flashAssets, Number(parameters.loanTokenDecimals)) : 0n
  return walletAssets + flashAssets
}

function simulateRedeemExecutionPreview(parameters: {
  snapshot: BaseSnapshot
  repayMode: RepayMode
  repayAssets: bigint
  requestedWithdrawCollateral: bigint
  loopSummary?: Awaited<ReturnType<typeof buildMorphoBundlerRedeemPlan>>['loop']
}): RedeemExecutionPreview {
  if (parameters.loopSummary?.enabled) {
    return {
      kind: 'redeem',
      repayAssets: parameters.loopSummary.totalRepayAssets,
      repayShares: parameters.snapshot.borrowShares - parameters.loopSummary.finalPosition.borrowShares,
      requestedWithdrawCollateral: parameters.loopSummary.totalWithdrawCollateralAssets,
      maxSafeWithdrawAfterRepay: parameters.loopSummary.completed
        ? parameters.requestedWithdrawCollateral
        : parameters.loopSummary.totalWithdrawCollateralAssets,
      afterRepayPosition: parameters.loopSummary.finalPosition,
      afterWithdrawPosition: parameters.loopSummary.finalPosition,
      withdrawError: parameters.loopSummary.completed ? null : parameters.loopSummary.message ?? 'Loop did not complete.',
      loopIterations: parameters.loopSummary.iterationCount,
      netLoanTokenOut: parameters.loopSummary.netLoanTokenOut,
      usedLoop: true,
    }
  }

  const repayResult =
    parameters.repayMode === 'full-shares'
      ? parameters.snapshot.accrualPosition.repay(0n, parameters.snapshot.borrowShares)
      : parameters.snapshot.accrualPosition.repay(parameters.repayAssets, 0n)

  const afterRepayPosition = repayResult.position
  const maxSafeWithdrawAfterRepay = afterRepayPosition.withdrawableCollateral

  try {
    const afterWithdrawPosition = afterRepayPosition.withdrawCollateral(parameters.requestedWithdrawCollateral)
    return {
      kind: 'redeem',
      repayAssets: repayResult.assets,
      repayShares: repayResult.shares,
      requestedWithdrawCollateral: parameters.requestedWithdrawCollateral,
      maxSafeWithdrawAfterRepay,
      afterRepayPosition,
      afterWithdrawPosition,
      withdrawError: null,
      loopIterations: 1,
      usedLoop: false,
    }
  } catch (error) {
    return {
      kind: 'redeem',
      repayAssets: repayResult.assets,
      repayShares: repayResult.shares,
      requestedWithdrawCollateral: parameters.requestedWithdrawCollateral,
      maxSafeWithdrawAfterRepay,
      afterRepayPosition,
      afterWithdrawPosition: null,
      withdrawError: error instanceof Error ? error.message : 'Withdraw would leave the position unhealthy.',
      loopIterations: 1,
      usedLoop: false,
    }
  }
}

function simulateDepositExecutionPreview(parameters: {
  summary: Awaited<ReturnType<typeof buildMorphoBundlerDepositPlan>>['summary']
  previewDepositShares: bigint
}): DepositExecutionPreview {
  return {
    kind: 'deposit',
    walletAssetsIn: parameters.summary.walletAssetsIn,
    currentBorrowAssets: parameters.summary.currentBorrowAssets,
    targetBorrowAssets: parameters.summary.targetBorrowAssets,
    flashAssets: parameters.summary.flashAssets,
    initialDepositAssets: parameters.summary.initialDepositAssets,
    totalDepositAssets: parameters.summary.totalDepositAssets,
    previewDepositShares: parameters.previewDepositShares,
    suppliedCollateralAssets: parameters.summary.suppliedCollateralAssets,
    additionalBorrowAssets: parameters.summary.additionalBorrowAssets,
    maxSafeBorrowAfterInitialDeposit: parameters.summary.maxSafeBorrowAfterInitialDeposit,
    callbackBorrowLiquidityAfterFlash: parameters.summary.callbackBorrowLiquidityAfterFlash,
    maxTargetBorrowAssetsAfterConstraints: parameters.summary.maxTargetBorrowAssetsAfterConstraints,
    finalBorrowAssets: parameters.summary.finalBorrowAssets,
    netLoanTokenOut: parameters.summary.netLoanTokenOut,
    finalPosition: parameters.summary.finalPosition,
    completed: parameters.summary.completed,
    message: parameters.summary.message,
  }
}

function formatPercent(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  return `${(value * 100).toFixed(digits)}%`
}

function formatWadPercent(value: bigint | null | undefined, digits = 2) {
  if (value == null) return 'N/A'
  return `${(Number(formatUnits(value, 18)) * 100).toFixed(digits)}%`
}

function formatWadPercentValue(value: bigint | null | undefined, digits = 2) {
  if (value == null) return ''
  return (Number(formatUnits(value, 18)) * 100).toFixed(digits)
}

function formatFactor(value: bigint | null | undefined, digits = 3) {
  if (value == null) return 'N/A'
  const normalized = Number(formatUnits(value, 18))
  if (!Number.isFinite(normalized)) return 'N/A'
  return `${normalized.toFixed(digits)}x`
}

function parseUnsignedInt(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`)
  return parsed
}

function parseBps(value: string) {
  return BigInt(parseUnsignedInt(value, 'Bps'))
}

function parseOptionalPercentWad(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = parseUnits(trimmed, 16)
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero.`)
  if (parsed > 1_000_000_000_000_000_000n) throw new Error(`${label} cannot exceed 100%.`)
  return parsed
}

function parseOptionalFactorWad(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = parseUnits(trimmed, 18)
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero.`)
  return parsed
}

function hasDepositRiskConstraints(constraints: DepositRiskConstraints) {
  return constraints.maxLtvAfter != null || constraints.minHealthAfter != null
}

function satisfiesDepositRiskConstraints(position: AccrualPosition, constraints: DepositRiskConstraints) {
  const positionLtv = position.ltv
  const positionHealthFactor = position.healthFactor

  if (constraints.maxLtvAfter != null && (positionLtv == null || positionLtv > constraints.maxLtvAfter)) {
    return false
  }
  if (
    constraints.minHealthAfter != null &&
    (positionHealthFactor == null || positionHealthFactor < constraints.minHealthAfter)
  ) {
    return false
  }
  return true
}

function findClosestDepositAutoLeveragePoint(parameters: {
  points: DepositAutoLeveragePoint[]
  flashAssets: bigint | null
  targetBorrowAssets: bigint | null
}) {
  if (parameters.points.length === 0) return 0

  let bestIndex = 0
  let bestScore: bigint | null = null

  for (let index = 0; index < parameters.points.length; index += 1) {
    const point = parameters.points[index]
    const flashDistance = parameters.flashAssets == null ? 0n : absBigInt(point.flashAssets - parameters.flashAssets)
    const targetDistance =
      parameters.targetBorrowAssets == null ? 0n : absBigInt(point.targetBorrowAssets - parameters.targetBorrowAssets)
    const score = targetDistance * 2n + flashDistance

    if (bestScore == null || score < bestScore) {
      bestIndex = index
      bestScore = score
    }
  }

  return bestIndex
}

function findDepositAutoLeverageIndexForUtilization(parameters: {
  points: DepositAutoLeveragePoint[]
  targetUtilizationAfter: bigint
}) {
  if (parameters.points.length === 0) return 0

  let bestIndex = 0
  for (let index = 0; index < parameters.points.length; index += 1) {
    const point = parameters.points[index]
    if (point.utilizationAfter <= parameters.targetUtilizationAfter) {
      bestIndex = index
      continue
    }
    break
  }

  return bestIndex
}

function applyBpsBuffer(value: bigint, bps: bigint) {
  if (bps < 0n) throw new Error('Buffer bps cannot be negative.')
  return (value * (10_000n + bps) + 9_999n) / 10_000n
}

function clampFlashAssets(requested: bigint, maxAvailable: bigint) {
  return requested < maxAvailable ? requested : maxAvailable
}

const WAD = 1_000_000_000_000_000_000n

function computeRedeemAutoPoints(parameters: {
  snapshot: BaseSnapshot
  flashBufferBps: bigint
  riskConstraints: { maxLtvAfter?: bigint; minHealthAfter?: bigint }
}): RedeemAutoPoint[] {
  const { snapshot, flashBufferBps, riskConstraints } = parameters
  if (snapshot.borrowAssets <= 0n) return []

  const STEPS = 20
  const seen = new Set<string>()
  const points: RedeemAutoPoint[] = []

  const addPoint = (point: RedeemAutoPoint) => {
    const key = `${point.repayAssets}-${point.withdrawCollateral}`
    if (seen.has(key)) return
    seen.add(key)
    points.push(point)
  }

  for (let step = 0; step <= STEPS; step++) {
    const fractionWad = (BigInt(step) * WAD) / BigInt(STEPS)
    const isFullExit = fractionWad >= WAD

    let repayAssets: bigint
    let repayMode: RepayMode

    if (isFullExit) {
      repayAssets = snapshot.borrowAssets
      repayMode = 'full-shares'
    } else {
      repayAssets = (snapshot.borrowAssets * fractionWad) / WAD
      repayMode = 'exact-assets'
    }

    // Simulate after-repay position
    let afterRepayPosition: AccrualPosition
    try {
      if (isFullExit) {
        afterRepayPosition = snapshot.accrualPosition.repay(0n, snapshot.borrowShares).position
      } else if (repayAssets > 0n) {
        afterRepayPosition = snapshot.accrualPosition.repay(repayAssets, 0n).position
      } else {
        afterRepayPosition = snapshot.accrualPosition
      }
    } catch {
      continue
    }

    // Compute max safe withdraw
    const rawMax = afterRepayPosition.withdrawableCollateral ?? 0n
    const maxWithdraw = rawMax < snapshot.collateral ? rawMax : snapshot.collateral

    let withdrawCollateral: bigint
    if (isFullExit) {
      withdrawCollateral = snapshot.collateral
    } else if (!hasDepositRiskConstraints(riskConstraints)) {
      withdrawCollateral = maxWithdraw
    } else {
      withdrawCollateral = findMaxWithdrawForConstraints({
        afterRepayPosition,
        maxWithdraw,
        riskConstraints,
      })
    }

    if (withdrawCollateral < 0n) withdrawCollateral = 0n

    // Verify constraints are satisfied for non-full-exit
    if (!isFullExit && hasDepositRiskConstraints(riskConstraints)) {
      try {
        const testPos = withdrawCollateral > 0n
          ? afterRepayPosition.withdrawCollateral(withdrawCollateral)
          : afterRepayPosition
        if (!satisfiesDepositRiskConstraints(testPos, riskConstraints)) continue
      } catch {
        continue
      }
    }

    // Compute position metrics after withdraw
    let ltvAfter: bigint | null = null
    let healthAfter: bigint | null = null
    try {
      if (isFullExit) {
        ltvAfter = 0n
        healthAfter = null
      } else if (withdrawCollateral > 0n) {
        const afterWithdraw = afterRepayPosition.withdrawCollateral(withdrawCollateral)
        ltvAfter = afterWithdraw.ltv ?? null
        healthAfter = afterWithdraw.healthFactor ?? null
      } else {
        ltvAfter = afterRepayPosition.ltv ?? null
        healthAfter = afterRepayPosition.healthFactor ?? null
      }
    } catch {
      ltvAfter = null
      healthAfter = null
    }

    const flashAssets = clampFlashAssets(
      applyBpsBuffer(repayAssets, flashBufferBps),
      snapshot.maxFlashLoanAssets,
    )

    addPoint({ fractionWad, repayMode, repayAssets, withdrawCollateral, flashAssets, ltvAfter, healthAfter })
  }

  return points
}

function findMaxWithdrawForConstraints(parameters: {
  afterRepayPosition: AccrualPosition
  maxWithdraw: bigint
  riskConstraints: { maxLtvAfter?: bigint; minHealthAfter?: bigint }
}): bigint {
  const { afterRepayPosition, maxWithdraw, riskConstraints } = parameters

  if (!hasDepositRiskConstraints(riskConstraints)) return maxWithdraw
  if (maxWithdraw <= 0n) return 0n

  // 0 withdrawal check
  if (!satisfiesDepositRiskConstraints(afterRepayPosition, riskConstraints)) return 0n

  // Max withdrawal check
  try {
    const atMax = afterRepayPosition.withdrawCollateral(maxWithdraw)
    if (satisfiesDepositRiskConstraints(atMax, riskConstraints)) return maxWithdraw
  } catch { /* fall through to binary search */ }

  // Binary search
  let low = 0n
  let high = maxWithdraw
  let best = 0n

  for (let i = 0; i < 24 && low < high; i++) {
    const mid = low + (high - low + 1n) / 2n
    try {
      const pos = afterRepayPosition.withdrawCollateral(mid)
      if (satisfiesDepositRiskConstraints(pos, riskConstraints)) {
        best = mid
        low = mid
      } else {
        high = mid - 1n
      }
    } catch {
      high = mid - 1n
    }
  }

  return best
}

function assertAddress(value: string): Address {
  if (!isAddress(value)) throw new Error(`Invalid address: ${value}`)
  return value
}

function stringifyForDisplay(value: unknown): string {
  return JSON.stringify(
    value,
    (_, currentValue) => (typeof currentValue === 'bigint' ? currentValue.toString() : currentValue),
    2,
  )
}

function absBigInt(value: bigint) {
  return value < 0n ? -value : value
}

function clampNumber(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function Stat(props: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="stat">
      <span className="stat__label">{props.label}</span>
      <span className={props.monospace ? 'stat__value stat__value--mono' : 'stat__value'}>{props.value}</span>
    </div>
  )
}

function TextField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input disabled={props.disabled} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  )
}

function PayloadBlock(props: { label: string; value: string; helper: string }) {
  return (
    <label className="field payload">
      <span>{props.label}</span>
      <p className="payload__helper">{props.helper}</p>
      <textarea readOnly value={props.value} rows={12} />
    </label>
  )
}
