# morpho4626

`morpho4626` 是一个面向 Morpho Blue + Bundler3 的 TypeScript/React 参考实现，用于围绕 ERC-4626 金库抵押品构建单笔交易的退出与加杠杆流程。

在线部署地址：<https://morpho4626.web3resear.ch>

仓库当前包含两部分能力：

- 一个浏览器端操作界面，用于连接钱包、发现市场、预览执行结果并发送交易。
- 一组可复用的 TypeScript 构建器，用于生成 Morpho 授权、Bundler3 action plan 和最终交易请求。

## 项目状态

本项目目前更适合作为研究、集成和运维工具，而不是已经过审计的生产级金融前端。

- 已实现核心交易构建与发送路径。
- 已实现 ERC-4626 市场发现、链上快照读取和本地结果预览。
- 未提供自动化测试套件。
- 未声明审计完成；在主网使用前应自行评估风险。

## 主要能力

- 支持 Morpho 官方授权流程：钱包离线签署 `setAuthorizationWithSig`。
- 支持通过 `Bundler3 + GeneralAdapter1` 发送单笔普通链上交易。
- 支持两类主要流程：
  - `redeem`：flash-loan assisted exit，偿还债务、提取抵押品并赎回 ERC-4626 金库份额。
  - `deposit`：leveraged deposit，将资产存入 ERC-4626 金库、作为 Morpho 抵押并借出贷款资产。
- 支持在同一笔交易末尾自动撤销 Morpho 授权。
- 支持在 flash-loan 流动性不足时使用 loop 模式构造多轮 repay/withdraw/redeem callback。
- 支持基于 Morpho Blue API 和链上 `previewDeposit` / `previewRedeem` 探测自动发现兼容市场。

## 适用范围

本仓库只处理一类明确约束下的策略路径：

- 抵押品必须是 ERC-4626 金库份额。
- 该金库的底层资产必须与 Morpho market 的 loan token 相同。
- 当前链必须同时被本地 Morpho SDK 和 Morpho Blue API 支持。
- 钱包必须提供兼容 EIP-1193 的注入式 provider。

这不是通用型 Morpho 前端，也不是资产管理、清算、风控或策略回测平台。

## 仓库结构

- `app/BundlerApp.tsx`：主界面，负责钱包连接、状态读取、参数输入、签名与交易发送。
- `app/morphoMarketDiscovery.ts`：链列表和市场发现逻辑，组合 Morpho Blue API 与链上 ERC-4626 探测。
- `app/MarketSelector.tsx`：市场选择界面组件。
- `sdk/morphoBundlerOfficial.ts`：核心构建器，负责 plan 生成、授权封装和交易请求编码。
- `sdk/markets.ts`：示例常量与预设 market 参数。
- `sdk/index.ts`：SDK 导出入口。

## 快速开始

### 环境要求

- Node.js 20+ 建议
- npm 10+ 建议
- 一个支持 EIP-1193 的浏览器钱包

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

默认由 Vite 启动本地开发服务器。

### 类型检查

```bash
npm run typecheck
```

### 构建

```bash
npm run build
```

构建产物会输出到：

- `dist/sdk`
- `dist/web`

## 使用流程

1. 连接浏览器钱包并切换到目标链。
2. 选择一个由 Morpho Blue API 列出且通过链上探测确认兼容的 ERC-4626 market。
3. 刷新 Morpho position、vault preview、token balance 和 allowance 快照。
4. 选择 `redeem` 或 `deposit` 模式并填写参数。
5. 由钱包签署 Morpho typed data 授权。
6. 提交一笔标准 Ethereum 交易到 `Bundler3`。
7. 如果启用 `Auto revoke`，在交易末尾撤销 `GeneralAdapter1` 授权。

## SDK 能力

SDK 入口位于 `sdk/index.ts`，当前主要暴露以下构建能力：

- `buildMarketId`
- `computeMinSharePriceE27`
- `computeMaxSharePriceE27`
- `buildMorphoBundlerRedeemPlan`
- `buildMorphoBundlerDepositPlan`
- `buildMorphoBundlerRedeemTransactionRequest`
- `buildMorphoBundlerDepositTransactionRequest`

这些函数适合被上层应用复用，用于把链上状态和用户输入变成可签名、可发送、可审计的 Bundler3 请求。

## 安全模型

本项目的安全边界必须被明确理解：

- 临时权限主体是 Morpho 官方 `GeneralAdapter1`，不是任意自定义合约。
- 默认推荐开启 `Auto revoke`，在同一笔交易末尾撤销授权。
- `deposit` 模式在 `Wallet assets in > 0` 时，需要对 loan token 进行 ERC20 `approve`。
- 本地预览只是构建前校验，不构成链上执行保证；市场流动性、vault 汇率、LLTV、利率和余额都可能在签名与打包之间变化。
- 当 flash-loan 流动性不足时，loop 模式会自动收缩为 Morpho 当前可用流动性并分轮执行；这会改变执行路径与可行上限。

## 已知限制

- 没有自动化测试和 CI 护栏。
- 没有集成后端服务、任务队列或交易中继。
- 没有做多钱包会话管理、权限分层或审计日志归档。
- 没有覆盖通用型 Morpho 交互，只覆盖 ERC-4626 相关的两类核心路径。
- Foundry 配置已存在，但仓库当前不包含完整 Solidity 测试套件。

## 开发约定

如果你打算继续把这个仓库作为公开项目维护，建议至少保持以下标准：

- 所有行为变更都附带类型检查通过。
- 任何新增交易路径都写明授权对象、资产流向和失败条件。
- 任何影响资金安全的修改都先补文档，再补测试，再上线。
- 发布前补齐 `LICENSE` 文件、CI、测试和安全披露流程。

## 贡献

欢迎提交 issue 和 pull request。建议贡献内容聚焦于以下方向：

- 新增或修正交易构建逻辑
- 改进市场发现准确性
- 提升错误信息与可观测性
- 增加测试、CI 与安全文档

提交变更前建议至少运行：

```bash
npm run typecheck
npm run build
```

## 许可证

本仓库采用 `MIT` 许可证，详见 `LICENSE`。

## 免责声明

本项目不构成投资建议、交易建议或安全保证。任何主网使用都应由操作者自行承担风险，并在真实资产使用前完成代码审查、测试和权限验证。
