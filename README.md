# Morpho Bundler3 Builder

当前前端默认走非 ERC-7702 路径：

- 钱包离线签 `Morpho.setAuthorizationWithSig`
- 通过 `Bundler3 + GeneralAdapter1` 执行 Morpho flash-loan redeem
- 可选在同一笔交易末尾 revoke 授权
- 链上只发送一笔普通交易，不需要部署 implementation，不需要 delegate EOA

## 当前实现

- 前端入口：`app/BundlerApp.tsx`
- Bundler builder：`sdk/morphoBundler.ts`
- 主网 `sUSDf/USDf` 预设：`sdk/markets.ts`

当前 UI 面向这类流程：

1. flash-loan `loanToken`
2. repay Morpho debt
3. withdraw collateral
4. redeem ERC-4626 collateral into the same `loanToken`
5. sweep remaining `loanToken` back to EOA
6. revoke Morpho authorization

## 安全边界

- 不使用 ERC-7702
- 不部署或信任新的 account-level delegator
- Morpho 授权对象是官方 `GeneralAdapter1`
- 默认会在同一笔交易末尾 revoke 授权

如果你关闭 `Auto revoke`，`GeneralAdapter1` 会在交易成功后继续保持授权。

## 备注

- 仓库里旧的 7702 builder 代码还在，但前端默认不再使用
- 当前页面默认是 Ethereum mainnet 参数
