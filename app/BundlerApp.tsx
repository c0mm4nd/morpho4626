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
        (!vaultSnapshot?.asset || vaultSnapshot.asset.toLowerCase() != marketParams.loanToken.toLowerCase())
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
    <div className="shell">
      <header className="hero">
        <div className="hero__copy">
          <p className="eyebrow">morpho4626</p>
          <h1>Single-transaction flash-loan redeem / deposit builder</h1>
          <p className="lede">
            Sign Morpho <code>setAuthorizationWithSig</code> off-chain, run either a flash-loan exit or leveraged
            deposit through <code>Bundler3</code>, optionally revoke at the end, and submit one normal Ethereum
            transaction.
          </p>
        </div>
        <div className={`status-card status-card--${status.tone}`}>
          <span className="status-card__label">Status</span>
          <p>{status.text}</p>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panel__heading">
            <h2>Wallet</h2>
            <button className="ghost-button" onClick={connectWallet} type="button">
              {account ? 'Reconnect' : 'Connect'}
            </button>
          </div>

          <label className="field">
            <span>Injected provider</span>
            <select value={selectedProviderId} onChange={(event) => setSelectedProviderId(event.target.value)}>
              {providers.length === 0 ? <option>No injected provider found</option> : null}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>

          <div className="wallet-grid">
            <Stat label="Account" value={account || 'Not connected'} monospace />
            <Stat
              label="Chain"
              value={
                currentMorphoChain
                  ? `${currentMorphoChain.network} (${chainId}, ${numberToHex(chainId)})`
                  : `${chainId} (${numberToHex(chainId)})`
              }
              monospace
            />
            <Stat label="Morpho" value={currentMorphoAddress || 'Unsupported chain'} monospace />
            <Stat label="Last tx hash" value={lastTxHash || 'None'} monospace />
          </div>

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

          <div className="note">
            <p>
              <strong>Chain support.</strong> The builder now follows Morpho&apos;s official Blue API chain list and uses the
              current wallet chain. {currentMorphoChain ? `Current chain: ${currentMorphoChain.network}.` : 'Current chain is not listed by Morpho.'}
            </p>
            <p>
              <strong>Trust model.</strong> The only temporary privilege is Morpho authorization for <code>GeneralAdapter1</code>.
            </p>
            <p>
              <strong>Recommended mode.</strong> Keep <code>Auto revoke</code> enabled so the authorization is removed at
              the end of the same transaction.
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel__heading">
            <h2>Snapshot</h2>
            <span className="pill">{baseSnapshot ? 'On-chain' : 'Pending'}</span>
          </div>

          <div className="wallet-grid">
            <Stat label="Market ID" value={baseSnapshot?.marketId || marketIdInput || 'Not loaded'} monospace />
            <Stat
              label="Borrow shares"
              value={baseSnapshot ? baseSnapshot.borrowShares.toString() : snapshotError || 'Not loaded'}
              monospace
            />
            <Stat
              label="Borrow assets"
              value={
                baseSnapshot
                  ? `${formatUnits(baseSnapshot.borrowAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                  : 'Not loaded'
              }
            />
            <Stat
              label="Collateral"
              value={
                baseSnapshot
                  ? `${formatUnits(baseSnapshot.collateral, baseSnapshot.collateralTokenDecimals)} ${baseSnapshot.collateralTokenSymbol}`
                  : 'Not loaded'
              }
            />
            <Stat
              label="Current LTV"
              value={baseSnapshot ? formatWadPercent(baseSnapshot.accrualPosition.ltv) : 'Not loaded'}
            />
            <Stat
              label="Health factor"
              value={baseSnapshot ? formatFactor(baseSnapshot.accrualPosition.healthFactor) : 'Not loaded'}
            />
            <Stat
              label="Borrow APY now"
              value={baseSnapshot ? formatPercent(baseSnapshot.market.borrowApy) : 'Not loaded'}
            />
            <Stat
              label="Supply APY now"
              value={baseSnapshot ? formatPercent(baseSnapshot.market.supplyApy) : 'Not loaded'}
            />
            <Stat
              label="Utilization now"
              value={baseSnapshot ? formatWadPercent(baseSnapshot.market.utilization) : 'Not loaded'}
            />
            <Stat
              label="Full repay estimate"
              value={
                baseSnapshot
                  ? `${formatUnits(baseSnapshot.estimatedFullRepayAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                  : 'Not loaded'
              }
            />
            <Stat
              label="Max flash loan"
              value={
                baseSnapshot
                  ? `${formatUnits(baseSnapshot.maxFlashLoanAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                  : 'Not loaded'
              }
            />
            <Stat
              label="Morpho nonce"
              value={baseSnapshot ? baseSnapshot.morphoNonce.toString() : 'Not loaded'}
              monospace
            />
            <Stat
              label="Wallet loan balance"
              value={
                baseSnapshot
                  ? `${formatUnits(baseSnapshot.walletLoanTokenBalance, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                  : 'Not loaded'
              }
            />
            <Stat
              label="Adapter allowance"
              value={
                baseSnapshot
                  ? `${formatUnits(baseSnapshot.walletLoanTokenAllowanceToAdapter, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`
                  : 'Not loaded'
              }
            />
            <Stat label="GeneralAdapter1" value={baseSnapshot?.generalAdapter1 || 'Not loaded'} monospace />
            <Stat label="Bundler3" value={baseSnapshot?.bundler3 || 'Not loaded'} monospace />
            <Stat label="Authorized now" value={baseSnapshot ? (baseSnapshot.isBundlerAuthorized ? 'Yes' : 'No') : 'Unknown'} />
            <Stat
              label="Vault asset"
              value={vaultSnapshot?.asset || vaultError || 'Not loaded'}
              monospace={Boolean(vaultSnapshot?.asset || vaultError)}
            />
          </div>

          {builderMode === 'redeem' && baseSnapshot && baseSnapshot.borrowShares === 0n && baseSnapshot.collateral === 0n ? (
            <div className="warning">The connected account has no position on the selected Morpho market.</div>
          ) : null}
          {snapshotError ? <div className="warning">{snapshotError}</div> : null}
          {vaultError ? <div className="warning">{vaultError}</div> : null}
        </section>

        <section className="panel">
          <div className="panel__heading">
            <h2>Market Discovery</h2>
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

        <section className="panel">
          <div className="panel__heading">
            <h2>Market Config</h2>
            <span className="pill pill--soft">Auto fill from Market ID</span>
          </div>

          <div className="market-manual">
            <p className="market-manual__copy">
              Paste a Morpho Market ID. The app resolves loan token, collateral token, oracle, IRM, decimals, and vault
              automatically on the active chain.
            </p>
            <div className="market-manual__fields">
              <TextField label="Market ID" value={marketIdInput} onChange={setMarketIdInput} />
            </div>
            {resolvingMarketConfig ? <div className="warning">Resolving market parameters from Market ID...</div> : null}
            {marketConfigError ? <div className="warning">{marketConfigError}</div> : null}
            <div className="wallet-grid">
              <Stat label="Loan token" value={hasResolvedCurrentMarketConfig ? loanToken : 'Not resolved'} monospace />
              <Stat
                label="Collateral token"
                value={hasResolvedCurrentMarketConfig ? collateralToken : 'Not resolved'}
                monospace
              />
              <Stat label="Oracle" value={hasResolvedCurrentMarketConfig ? oracle : 'Not resolved'} monospace />
              <Stat label="IRM" value={hasResolvedCurrentMarketConfig ? irm : 'Not resolved'} monospace />
              <Stat label="LLTV (wad)" value={hasResolvedCurrentMarketConfig ? lltv : 'Not resolved'} monospace />
              <Stat
                label="Loan token decimals"
                value={hasResolvedCurrentMarketConfig ? loanTokenDecimals : 'Not resolved'}
              />
              <Stat
                label="Collateral token decimals"
                value={hasResolvedCurrentMarketConfig ? collateralTokenDecimals : 'Not resolved'}
              />
              <Stat
                label="ERC-4626 vault"
                value={hasResolvedCurrentMarketConfig ? vaultAddress : 'Not resolved'}
                monospace
              />
            </div>
          </div>
        </section>

        <section className="panel panel--wide">
          <div className="panel__heading">
            <h2>Plan</h2>
            <span className="pill">
              {builderMode === 'redeem'
                ? repayMode === 'full-shares'
                  ? 'Close by shares'
                  : 'Repay exact assets'
                : 'Leverage'}
            </span>
          </div>

          <div className="two-col">
            <label className="field">
              <span>Builder mode</span>
              <select value={builderMode} onChange={(event) => setBuilderMode(event.target.value as BuilderMode)}>
                <option value="redeem">Redeem / close</option>
                <option value="deposit">Deposit / leverage</option>
              </select>
            </label>
            {builderMode === 'redeem' ? (
              <>
                <TextField label="Flash assets" value={flashAssets} onChange={setFlashAssets} />
                <TextField label="Flash buffer (bps)" value={flashBufferBps} onChange={setFlashBufferBps} />
                <label className="field">
                  <span>Repay mode</span>
                  <select value={repayMode} onChange={(event) => setRepayMode(event.target.value as RepayMode)}>
                    <option value="full-shares">Full borrow shares</option>
                    <option value="exact-assets">Exact loan assets</option>
                  </select>
                </label>

                <TextField
                  label="Repay assets"
                  value={repayAssets}
                  onChange={setRepayAssets}
                  disabled={repayMode !== 'exact-assets'}
                />

                <label className="field field--toggle">
                  <span>Withdraw all collateral</span>
                  <input
                    checked={withdrawAllCollateral}
                    onChange={(event) => setWithdrawAllCollateral(event.target.checked)}
                    type="checkbox"
                  />
                </label>

                <TextField
                  label="Withdraw collateral assets"
                  value={withdrawCollateralAssets}
                  onChange={setWithdrawCollateralAssets}
                  disabled={withdrawAllCollateral}
                />

                <TextField label="Redeem slippage (bps)" value={redeemSlippageBps} onChange={setRedeemSlippageBps} />
              </>
            ) : (
              <>
                <TextField label="Wallet assets in" value={walletAssets} onChange={setWalletAssets} />
                <TextField label="Deposit slippage (bps)" value={depositSlippageBps} onChange={setDepositSlippageBps} />
                <TextField label="Max LTV after (%)" value={maxLtvAfter} onChange={setMaxLtvAfter} />
                <TextField label="Min health after (x)" value={minHealthAfter} onChange={setMinHealthAfter} />
                <TextField
                  label="Target utilization after (%)"
                  value={targetUtilizationAfter}
                  onChange={applyTargetUtilizationAfter}
                />
                <div className="field field--span-2">
                  <span>Utilization after</span>
                  <div className="utilization-slider">
                    <div className="utilization-slider__header">
                      <div>
                        <div className="utilization-slider__label">Auto leverage</div>
                        <div className="utilization-slider__value">
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

                    <div className="utilization-slider__range-wrap">
                      <div className="utilization-slider__track">
                        <div
                          className="utilization-slider__track-fill"
                          style={{ width: `${depositAutoLeverageProgress}%` }}
                        />
                      </div>
                      <input
                        className="utilization-slider__range"
                        type="range"
                        min={0}
                        max={Math.max(depositAutoLeveragePoints.length - 1, 0)}
                        step={1}
                        value={Math.min(
                          clampNumber(depositAutoLeverageIndex, 0, depositAutoLeveragePoints.length - 1),
                          Math.max(depositAutoLeveragePoints.length - 1, 0),
                        )}
                        onChange={(event) => setDepositAutoLeverageIndex(Number(event.target.value))}
                        disabled={depositAutoLeverageLoading || depositAutoLeveragePoints.length <= 1}
                      />
                    </div>

                    <div className="utilization-slider__legend">
                      <span>{`Current ${baseSnapshot ? formatWadPercent(baseSnapshot.market.utilization) : 'N/A'}`}</span>
                      <span>
                        {depositAutoLeverageMaxPoint
                          ? `Max feasible ${formatWadPercent(depositAutoLeverageMaxPoint.utilizationAfter)}`
                          : 'Max feasible N/A'}
                      </span>
                    </div>

                    <div className="utilization-slider__stats">
                      <Stat
                        label="Flash assets"
                        value={
                          activeDepositAutoLeveragePoint && baseSnapshot
                            ? `${formatUnits(activeDepositAutoLeveragePoint.flashAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`.trim()
                            : 'Not ready'
                        }
                      />
                      <Stat
                        label="Target borrow after"
                        value={
                          activeDepositAutoLeveragePoint && baseSnapshot
                            ? `${formatUnits(activeDepositAutoLeveragePoint.targetBorrowAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`.trim()
                            : 'Not ready'
                        }
                      />
                      <Stat
                        label="Vault deposit"
                        value={
                          activeDepositAutoLeveragePoint && baseSnapshot
                            ? `${formatUnits(activeDepositAutoLeveragePoint.totalDepositAssets, baseSnapshot.loanTokenDecimals)} ${baseSnapshot.loanTokenSymbol}`.trim()
                            : 'Not ready'
                        }
                      />
                    </div>
                  </div>
                </div>
              </>
            )}

            <TextField
              label="Auth deadline (minutes)"
              value={authorizationDeadlineMinutes}
              onChange={setAuthorizationDeadlineMinutes}
            />

            <label className="field field--toggle">
              <span>Auto revoke Morpho authorization</span>
              <input checked={autoRevoke} onChange={(event) => setAutoRevoke(event.target.checked)} type="checkbox" />
            </label>
          </div>

          <div className="actions">
            {builderMode === 'redeem' ? (
              <>
                <button className="ghost-button" onClick={applyMaxFlashLoan} type="button" disabled={!baseSnapshot}>
                  Use max flash loan
                </button>
                <button
                  className="ghost-button"
                  onClick={() => applyRepayFraction(1n, 4n)}
                  type="button"
                  disabled={!baseSnapshot || baseSnapshot.borrowAssets === 0n}
                >
                  Repay 25%
                </button>
                <button
                  className="ghost-button"
                  onClick={() => applyRepayFraction(1n, 2n)}
                  type="button"
                  disabled={!baseSnapshot || baseSnapshot.borrowAssets === 0n}
                >
                  Repay 50%
                </button>
                <button
                  className="ghost-button"
                  onClick={() => applyRepayFraction(3n, 4n)}
                  type="button"
                  disabled={!baseSnapshot || baseSnapshot.borrowAssets === 0n}
                >
                  Repay 75%
                </button>
                <button
                  className="ghost-button"
                  onClick={() => applyRepayFraction(1n, 1n)}
                  type="button"
                  disabled={!baseSnapshot || baseSnapshot.borrowAssets === 0n}
                >
                  Repay 100%
                </button>
              </>
            ) : (
              <>
                <button
                  className="ghost-button"
                  onClick={() => setDepositAutoLeverageIndex(0)}
                  type="button"
                  disabled={depositAutoLeverageLoading || depositAutoLeveragePoints.length === 0}
                >
                  Current point
                </button>
                <button
                  className="ghost-button"
                  onClick={() => setDepositAutoLeverageIndex(Math.max(depositAutoLeveragePoints.length - 1, 0))}
                  type="button"
                  disabled={depositAutoLeverageLoading || depositAutoLeveragePoints.length <= 1}
                >
                  Max leverage
                </button>
                <button className="ghost-button" onClick={applyWalletBalance} type="button" disabled={!baseSnapshot}>
                  Use wallet balance
                </button>
                <button
                  className="ghost-button"
                  onClick={approveLoanToken}
                  type="button"
                  disabled={!baseSnapshot || !walletAssets.trim() || walletAssets.trim() === '0'}
                >
                  Approve exact amount
                </button>
              </>
            )}
          </div>

          {builderMode === 'redeem' ? (
            <div className="actions">
              <button
                className="ghost-button"
                onClick={() => applyWithdrawFraction(1n, 4n)}
                type="button"
                disabled={!baseSnapshot || baseSnapshot.collateral === 0n}
              >
                Withdraw 25%
              </button>
              <button
                className="ghost-button"
                onClick={() => applyWithdrawFraction(1n, 2n)}
                type="button"
                disabled={!baseSnapshot || baseSnapshot.collateral === 0n}
              >
                Withdraw 50%
              </button>
              <button
                className="ghost-button"
                onClick={() => applyWithdrawFraction(3n, 4n)}
                type="button"
                disabled={!baseSnapshot || baseSnapshot.collateral === 0n}
              >
                Withdraw 75%
              </button>
              <button
                className="ghost-button"
                onClick={() => applyWithdrawFraction(1n, 1n)}
                type="button"
                disabled={!baseSnapshot || baseSnapshot.collateral === 0n}
              >
                Withdraw 100%
              </button>
              <button
                className="ghost-button"
                onClick={applyMaxSafeWithdraw}
                type="button"
                disabled={!redeemPreview?.maxSafeWithdrawAfterRepay}
              >
                Max safe withdraw
              </button>
            </div>
          ) : null}

          <div className="note">
            {builderMode === 'redeem' ? (
              <>
                <p>
                  <strong>Callback sequence.</strong> authorize <code>GeneralAdapter1</code>, flash-loan loan token,
                  repay Morpho debt, withdraw collateral, redeem the ERC-4626 collateral into loan token, sweep leftover
                  loan token through the official Morpho Bundler flow, then optionally revoke authorization.
                </p>
                <p>
                  <strong>Loop mode.</strong> When the market&apos;s flash-loan liquidity is below the full debt, the
                  builder automatically caps <code>Flash assets</code> to Morpho&apos;s available balance and rolls
                  multiple repay-withdraw-redeem legs inside the same callback.
                </p>
              </>
            ) : (
              <>
                <p>
                  <strong>Callback sequence.</strong> optionally pull loan tokens from the connected wallet, optionally
                  flash-loan more loan tokens, deposit wallet + flash into the ERC-4626 vault, supply the minted vault
                  shares as Morpho collateral, then borrow against that collateral through the official Morpho Bundler
                  flow, sweep any remaining loan token back to the wallet, and optionally revoke authorization.
                </p>
                <p>
                  <strong>Leverage semantics.</strong> There is exactly one borrow leg
                  after the initial vault deposit. Borrow equal to <code>Flash assets</code> only repays the flash
                  principal; any additional borrow is swept back to the wallet instead of being redeposited.
                  The borrow leg can only use Morpho&apos;s remaining loan-token liquidity after the flash is already
                  outstanding, so the maximum feasible leverage flash is usually below Morpho&apos;s raw flash-loan cap.
                </p>
                <p>
                  <strong>Allowance model.</strong> Deposit mode needs an ERC20 approval on the loan token for
                  <code> GeneralAdapter1 </code> when <code>Wallet assets in</code> is non-zero. The button above sends
                  an exact-amount approval.
                </p>
                <p>
                  <strong>Slider model.</strong> The <code>Utilization after</code> slider keeps
                  <code> Wallet assets in </code> fixed, then automatically grows flash + borrow along the current
                  feasible leverage path until Morpho, LLTV, or your Max LTV / Min health constraints stop it. You can
                  drag the slider or type a target utilization directly.
                </p>
              </>
            )}
            <p>
              <strong>Vault requirement.</strong> The ERC-4626 vault asset must be the same token as the Morpho loan
              token. The discovered market list only keeps markets where this holds on-chain.
            </p>
          </div>

          {builderMode === 'deposit' && depositAutoLeverageError ? (
            <div className="warning">{depositAutoLeverageError}</div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel__heading">
            <h2>Expected effect</h2>
            <span className="pill pill--soft">Local simulation</span>
          </div>

          {builderMode === 'deposit' ? (
            <>
              <div className="wallet-grid">
                <Stat
                  label="Wallet assets in"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.walletAssetsIn, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Flash used"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.flashAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Target borrow after"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.targetBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Vault deposit"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.totalDepositAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Preview deposit shares"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.previewDepositShares, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Added borrow"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.additionalBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Final borrow leg"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.finalBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Liquid out after flash"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.netLoanTokenOut, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Max safe after initial"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.maxSafeBorrowAfterInitialDeposit, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Callback liquidity after flash"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.callbackBorrowLiquidityAfterFlash, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Max target after constraints"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.maxTargetBorrowAssetsAfterConstraints, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Borrow after"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.finalPosition.borrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Collateral after"
                  value={
                    depositPreview
                      ? `${formatUnits(depositPreview.finalPosition.collateral, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="LTV after"
                  value={depositPreview ? formatWadPercent(depositPreview.finalPosition.ltv) : 'Not ready'}
                />
                <Stat
                  label="Health after"
                  value={depositPreview ? formatFactor(depositPreview.finalPosition.healthFactor) : 'Not ready'}
                />
                <Stat
                  label="Borrow APY after"
                  value={depositPreview ? formatPercent(depositPreview.finalPosition.market.borrowApy) : 'Not ready'}
                />
                <Stat
                  label="Supply APY after"
                  value={depositPreview ? formatPercent(depositPreview.finalPosition.market.supplyApy) : 'Not ready'}
                />
                <Stat
                  label="Utilization after"
                  value={depositPreview ? formatWadPercent(depositPreview.finalPosition.market.utilization) : 'Not ready'}
                />
              </div>
              {depositPreview?.message ? <div className="warning">{depositPreview.message}</div> : null}
            </>
          ) : (
            <div className="wallet-grid">
              <Stat
                label="Repay used"
                value={
                  redeemPreview
                    ? `${formatUnits(redeemPreview.repayAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                    : 'Not ready'
                }
              />
              <Stat
                label="Requested withdraw"
                value={
                  redeemPreview
                    ? `${formatUnits(redeemPreview.requestedWithdrawCollateral, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim()
                    : 'Not ready'
                }
              />
              <Stat
                label="Max safe withdraw"
                value={
                  redeemPreview?.maxSafeWithdrawAfterRepay != null
                    ? `${formatUnits(redeemPreview.maxSafeWithdrawAfterRepay, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim()
                    : 'Not ready'
                }
              />
              <Stat
                label="Loop legs"
                value={redeemPreview?.usedLoop ? String(redeemPreview.loopIterations ?? 0) : '1'}
              />
              <Stat
                label="Borrow after"
                value={
                  redeemPreview?.afterWithdrawPosition
                    ? `${formatUnits(redeemPreview.afterWithdrawPosition.borrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                    : redeemPreview
                      ? `${formatUnits(redeemPreview.afterRepayPosition.borrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                }
              />
              <Stat
                label="Collateral after"
                value={
                  redeemPreview?.afterWithdrawPosition
                    ? `${formatUnits(redeemPreview.afterWithdrawPosition.collateral, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim()
                    : redeemPreview
                      ? `${formatUnits(redeemPreview.afterRepayPosition.collateral, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim()
                      : 'Not ready'
                }
              />
              <Stat
                label="LTV after"
                value={
                  redeemPreview?.afterWithdrawPosition
                    ? formatWadPercent(redeemPreview.afterWithdrawPosition.ltv)
                    : redeemPreview
                      ? formatWadPercent(redeemPreview.afterRepayPosition.ltv)
                      : 'Not ready'
                }
              />
              <Stat
                label="Health after"
                value={
                  redeemPreview?.afterWithdrawPosition
                    ? formatFactor(redeemPreview.afterWithdrawPosition.healthFactor)
                    : redeemPreview
                      ? formatFactor(redeemPreview.afterRepayPosition.healthFactor)
                      : 'Not ready'
                }
              />
              <Stat
                label="Borrow APY after"
                value={
                  redeemPreview
                    ? formatPercent(redeemPreview.afterRepayPosition.market.borrowApy)
                    : 'Not ready'
                }
              />
              <Stat
                label="Supply APY after"
                value={
                  redeemPreview
                    ? formatPercent(redeemPreview.afterRepayPosition.market.supplyApy)
                    : 'Not ready'
                }
              />
              <Stat
                label="Utilization after"
                value={
                  redeemPreview
                    ? formatWadPercent(redeemPreview.afterRepayPosition.market.utilization)
                    : 'Not ready'
                }
              />
            </div>
          )}

          {redeemPreview?.withdrawError ? (
            <div className="warning">{redeemPreview.withdrawError}</div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel__heading">
            <h2>Preview</h2>
            <span className="pill pill--soft">Dry build</span>
          </div>

          <div className="wallet-grid">
            {builderMode === 'deposit' ? (
              <>
                <Stat
                  label="Vault deposit"
                  value={
                    previewAmount != null
                      ? `${formatUnits(previewAmount, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Preview deposit shares"
                  value={
                    previewShares != null
                      ? `${formatUnits(previewShares, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Target borrow after"
                  value={
                    draft.targetBorrowAssets != null
                      ? `${formatUnits(draft.targetBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Estimated added borrow"
                  value={
                    previewExpectedBorrowAssets != null
                      ? `${formatUnits(previewExpectedBorrowAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Liquid out after flash"
                  value={
                    previewEstimatedNetAssets != null
                      ? `${formatUnits(previewEstimatedNetAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
              </>
            ) : (
              <>
                <Stat
                  label="Withdraw shares"
                  value={
                    previewShares != null
                      ? `${formatUnits(previewShares, Number(collateralTokenDecimals))} ${baseSnapshot?.collateralTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Preview redeem"
                  value={
                    previewAmount != null
                      ? `${formatUnits(previewAmount, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Estimated repay"
                  value={
                    previewExpectedRepayAssets != null
                      ? `${formatUnits(previewExpectedRepayAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
                <Stat
                  label="Estimated net out"
                  value={
                    previewEstimatedNetAssets != null
                      ? `${formatUnits(previewEstimatedNetAssets, Number(loanTokenDecimals))} ${baseSnapshot?.loanTokenSymbol || ''}`.trim()
                      : 'Not ready'
                  }
                />
              </>
            )}
          </div>

          {draft.error ? <div className="warning">{draft.error}</div> : null}
          {draft.warnings.map((warning: string) => (
            <div className="warning" key={warning}>
              {warning}
            </div>
          ))}

          <div className="actions">
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

        <section className="panel panel--wide">
          <div className="panel__heading">
            <h2>Payloads</h2>
            <span className="pill">Builder output</span>
          </div>

          <PayloadBlock
            label="Unsigned actions"
            value={actionJson}
            helper="These are the Bundler3 actions that will be encoded on send. Any null Morpho authorization signatures are requested from the wallet immediately before submission."
          />
          <PayloadBlock
            label="Authorization typed data"
            value={lastTypedDataJson || typedDataJson}
            helper="The wallet signs these EIP-712 messages off-chain. With auto-revoke enabled there are two signatures: authorize, then revoke."
          />
          <PayloadBlock
            label="Signed transaction request"
            value={lastSignedRequestJson}
            helper="After signatures are collected, this is the single standard Ethereum transaction submitted to Bundler3."
          />
        </section>
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
