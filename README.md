# Morpho Bundler3 Builder

当前前端走 Morpho 官方授权 + Bundler3 路径：

- 钱包离线签 `Morpho.setAuthorizationWithSig`
- 通过 `Bundler3 + GeneralAdapter1` 执行 Morpho flash-loan redeem / deposit
- 可选在同一笔交易末尾 revoke 授权
- 链上只发送一笔普通交易

## 当前实现

- 前端入口：`app/BundlerApp.tsx`
- 市场发现：`app/morphoMarketDiscovery.ts`
- 市场选择 UI：`app/MarketSelector.tsx`
- Bundler builder：`sdk/morphoBundlerOfficial.ts`

当前 UI 面向这类流程：

1. 授权 `GeneralAdapter1`
2. 发起 Morpho flash loan
3. 执行 repay / withdraw / redeem 或 deposit / supply / borrow
4. 偿还 flash loan
5. 可选 revoke Morpho authorization

## 安全边界

- Morpho 授权对象是官方 `GeneralAdapter1`
- 默认会在同一笔交易末尾 revoke 授权

如果你关闭 `Auto revoke`，`GeneralAdapter1` 会在交易成功后继续保持授权。
