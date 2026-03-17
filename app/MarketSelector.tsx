import type { DiscoveredVaultMarket } from './morphoMarketDiscovery.js'

type MarketSelectorProps = {
  markets: DiscoveredVaultMarket[]
  selectedMarketId: string
  chainLabel: string
  helperText: string
  discovering: boolean
  discoveredMarketsError: string
  resolvingMarketConfig: boolean
  marketConfigError: string
  refreshDisabled: boolean
  onRefresh: () => void
  onSelectMarket: (market: DiscoveredVaultMarket) => void
}

type MarketGroupProps = {
  title: string
  description: string
  emptyLabel: string
  markets: DiscoveredVaultMarket[]
  selectedMarketId: string
  onSelectMarket: (market: DiscoveredVaultMarket) => void
}

export function MarketSelector(props: MarketSelectorProps) {
  const directRedeemMarkets = props.markets.filter((market) => market.canDirectRedeem)
  const depositOnlyMarkets = props.markets.filter((market) => market.canDirectDeposit && !market.canDirectRedeem)

  return (
    <div className="market-selector">
      <div className="market-selector__header">
        <div>
          <h3>Discovered ERC-4626 markets</h3>
          <p>{props.helperText}</p>
        </div>
        <button className="ghost-button" onClick={props.onRefresh} type="button" disabled={props.refreshDisabled}>
          {props.discovering ? 'Discovering...' : 'Refresh markets'}
        </button>
      </div>

      <div className="market-selector__summary">
        <span className="pill">{props.chainLabel}</span>
        <span className="pill">{`${directRedeemMarkets.length} direct redeem`}</span>
        <span className="pill">{`${depositOnlyMarkets.length} deposit only`}</span>
      </div>

      {props.discovering ? <div className="warning">Discovering ERC-4626 markets on the current chain...</div> : null}
      {props.discoveredMarketsError ? <div className="warning">{props.discoveredMarketsError}</div> : null}
      {props.resolvingMarketConfig ? <div className="warning">Resolving market parameters from Market ID...</div> : null}
      {props.marketConfigError ? <div className="warning">{props.marketConfigError}</div> : null}

      <div className="market-selector__groups">
        <MarketGroup
          title="Direct redeem"
          description="Vault previews both direct deposit and direct redeem back into the loan token."
          emptyLabel="No directly redeemable ERC-4626 markets were found on this chain."
          markets={directRedeemMarkets}
          selectedMarketId={props.selectedMarketId}
          onSelectMarket={props.onSelectMarket}
        />
        <MarketGroup
          title="Deposit only"
          description="Vault previews direct deposit, but direct redeem is not available from the ERC-4626 probe."
          emptyLabel="No deposit-only ERC-4626 markets were found on this chain."
          markets={depositOnlyMarkets}
          selectedMarketId={props.selectedMarketId}
          onSelectMarket={props.onSelectMarket}
        />
      </div>
    </div>
  )
}

function MarketGroup(props: MarketGroupProps) {
  return (
    <section className="market-group">
      <div className="market-group__header">
        <h4>{props.title}</h4>
        <span className="pill pill--soft">{`${props.markets.length} markets`}</span>
      </div>
      <p className="market-group__description">{props.description}</p>

      {props.markets.length === 0 ? (
        <div className="market-group__empty">{props.emptyLabel}</div>
      ) : (
        <div className="market-group__list">
          {props.markets.map((market) => {
            const isSelected = market.marketId.toLowerCase() === props.selectedMarketId.toLowerCase()

            return (
              <button
                key={market.marketId}
                className={isSelected ? 'market-card market-card--selected' : 'market-card'}
                onClick={() => props.onSelectMarket(market)}
                type="button"
              >
                <div className="market-card__header">
                  <div>
                    <div className="market-card__title">{market.vaultName}</div>
                    <div className="market-card__subtitle">
                      {`${market.collateralTokenSymbol} collateral / ${market.loanTokenSymbol} underlying`}
                    </div>
                  </div>
                  <div className="market-card__size">{formatUsdCompact(market.marketSizeUsd)}</div>
                </div>

                <div className="market-card__badges">
                  <span className="market-card__badge market-card__badge--active">
                    {market.canDirectRedeem ? 'Direct redeem' : 'Deposit only'}
                  </span>
                  {isSelected ? <span className="market-card__badge">Selected</span> : null}
                </div>

                <div className="market-card__meta">
                  <MetaRow label="Curator" value={formatCurator(market)} />
                  <MetaRow label="Market size" value={formatUsd(market.marketSizeUsd)} />
                  <MetaRow label="Liquidity" value={formatUsd(market.marketLiquidityUsd)} />
                  <MetaRow label="Underlying" value={`${market.underlyingName} (${market.loanTokenSymbol})`} />
                </div>

                <div className="market-card__address-grid">
                  <AddressBlock label="Vault" value={market.vaultAddress} />
                  <AddressBlock label="Underlying" value={market.vaultAsset} />
                  <AddressBlock label="Market ID" value={market.marketId} />
                </div>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function MetaRow(props: { label: string; value: string }) {
  return (
    <div className="market-card__meta-row">
      <span className="market-card__meta-label">{props.label}</span>
      <span className="market-card__meta-value">{props.value}</span>
    </div>
  )
}

function AddressBlock(props: { label: string; value: string }) {
  return (
    <div className="market-card__address">
      <span className="market-card__meta-label">{props.label}</span>
      <span className="market-card__address-value">{props.value}</span>
    </div>
  )
}

function formatCurator(market: DiscoveredVaultMarket) {
  if (market.curatorName && market.curatorAddress) {
    return `${market.curatorName} (${shortAddress(market.curatorAddress)})`
  }
  if (market.curatorName) return market.curatorName
  if (market.curatorAddress) return shortAddress(market.curatorAddress)
  return 'Unknown'
}

function formatUsdCompact(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: value >= 1_000_000 ? 1 : 2,
  }).format(value)
}

function formatUsd(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value)
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}
