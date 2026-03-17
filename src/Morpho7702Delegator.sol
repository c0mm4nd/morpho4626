// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IERC4626Minimal {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

struct MarketParams7702 {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct Call7702 {
    address target;
    uint256 value;
    bytes data;
}

interface IMorpho7702 {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
    function repay(
        MarketParams7702 memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);
    function withdrawCollateral(
        MarketParams7702 memory marketParams,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external;
    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
}

interface IMorphoFlashLoanCallback7702 {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/// @notice Generic callback-capable Morpho delegator intended to be used through ERC-7702.
/// @dev The contract is designed to execute in the storage/context of the delegated EOA.
///      `execute` is self-call-only, so third parties cannot drive arbitrary plans after delegation.
contract Morpho7702Delegator is IMorphoFlashLoanCallback7702 {
    uint8 public constant REPAY_MODE_EXACT_ASSETS = 0;
    uint8 public constant REPAY_MODE_FULL_SHARES = 1;
    uint8 public constant EXIT_MODE_NONE = 0;
    uint8 public constant EXIT_MODE_ERC4626_REDEEM = 1;
    uint256 public constant WITHDRAW_ALL_COLLATERAL = type(uint256).max;

    address public immutable MORPHO;

    struct FlashPlan {
        MarketParams7702 marketParams;
        uint256 flashAssets;
        uint256 repayAssets;
        uint256 withdrawCollateralAssets;
        uint256 minLoanTokenProfit;
        uint8 repayMode;
        uint8 exitMode;
        address exitTarget;
        Call7702[] postCalls;
        Call7702[] afterCalls;
    }

    struct CallbackData {
        FlashPlan plan;
        uint256 startingLoanTokenBalance;
    }

    error NotFromSelf();
    error InvalidMorphoCaller();
    error InvalidRepayMode(uint8 mode);
    error InvalidExitMode(uint8 mode);
    error ZeroMorpho();
    error ZeroLoanToken();
    error ZeroCollateralToken();
    error ZeroFlashAssets();
    error ExactRepayExceedsFlashAssets(uint256 repayAssets, uint256 flashAssets);
    error ExactRepayAssetsRequired();
    error NoBorrowPosition();
    error NoCollateralPosition();
    error FlashLoanTooSmall(uint256 required, uint256 borrowed);
    error InsufficientLoanTokenForFlashSettlement(uint256 available, uint256 required);
    error MinimumLoanTokenProfitNotMet(uint256 actual, uint256 minimum);
    error TokenCallFailed();

    event FlashPlanExecuted(
        bytes32 indexed marketId,
        uint8 repayMode,
        uint256 flashAssets,
        uint256 repaidAssets,
        uint256 withdrawnCollateralAssets,
        uint256 loanTokenProfit
    );

    constructor(address morpho) {
        if (morpho == address(0)) revert ZeroMorpho();
        MORPHO = morpho;
    }

    modifier onlySelf() {
        _onlySelf();
        _;
    }

    /// @notice Executes a callback-driven Morpho flash-loan plan from the delegated EOA.
    /// @dev Intended to be the calldata target of a type-4 tx where `to == authority`.
    function execute(FlashPlan calldata plan) external payable onlySelf {
        _validatePlan(plan);

        uint256 startingLoanTokenBalance = IERC20Minimal(plan.marketParams.loanToken).balanceOf(address(this));

        IMorpho7702(MORPHO).flashLoan(
            plan.marketParams.loanToken,
            plan.flashAssets,
            abi.encode(CallbackData({plan: plan, startingLoanTokenBalance: startingLoanTokenBalance}))
        );

        // Clear any residual allowance if the exact repayment consumed less than the flash borrow.
        _forceApprove(plan.marketParams.loanToken, MORPHO, 0);

        uint256 endingLoanTokenBalance = IERC20Minimal(plan.marketParams.loanToken).balanceOf(address(this));
        uint256 loanTokenProfit = endingLoanTokenBalance > startingLoanTokenBalance
            ? endingLoanTokenBalance - startingLoanTokenBalance
            : 0;

        if (loanTokenProfit < plan.minLoanTokenProfit) {
            revert MinimumLoanTokenProfitNotMet(loanTokenProfit, plan.minLoanTokenProfit);
        }

        _batchCall(plan.afterCalls);

        emit FlashPlanExecuted(
            _marketId(plan.marketParams),
            plan.repayMode,
            plan.flashAssets,
            plan.repayMode == REPAY_MODE_EXACT_ASSETS ? plan.repayAssets : 0,
            plan.withdrawCollateralAssets == WITHDRAW_ALL_COLLATERAL ? 0 : plan.withdrawCollateralAssets,
            loanTokenProfit
        );
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != MORPHO) revert InvalidMorphoCaller();

        CallbackData memory callbackData = abi.decode(data, (CallbackData));
        FlashPlan memory plan = callbackData.plan;

        if (plan.repayMode == REPAY_MODE_EXACT_ASSETS) {
            _executeExactRepayPlan(plan, callbackData.startingLoanTokenBalance, assets);
            return;
        }

        if (plan.repayMode == REPAY_MODE_FULL_SHARES) {
            _executeFullRepayPlan(plan, callbackData.startingLoanTokenBalance, assets);
            return;
        }

        revert InvalidRepayMode(plan.repayMode);
    }

    function marketId(MarketParams7702 memory marketParams) external pure returns (bytes32) {
        return _marketId(marketParams);
    }

    function _executeExactRepayPlan(FlashPlan memory plan, uint256 startingLoanTokenBalance, uint256 assets) internal {
        _forceApprove(plan.marketParams.loanToken, MORPHO, plan.repayAssets + assets);

        (uint256 repaidAssets,) = IMorpho7702(MORPHO).repay(plan.marketParams, plan.repayAssets, 0, address(this), "");
        uint256 withdrawnCollateralAssets = _withdrawCollateral(plan);
        _runExit(plan, withdrawnCollateralAssets);

        _batchCall(plan.postCalls);
        _assertFlashSettlementCapacity(plan.marketParams.loanToken, startingLoanTokenBalance, assets);

        emit FlashPlanExecuted(
            _marketId(plan.marketParams),
            plan.repayMode,
            plan.flashAssets,
            repaidAssets,
            withdrawnCollateralAssets,
            0
        );
    }

    function _executeFullRepayPlan(FlashPlan memory plan, uint256 startingLoanTokenBalance, uint256 assets) internal {
        bytes32 id = _marketId(plan.marketParams);
        (, uint128 borrowShares,) = IMorpho7702(MORPHO).position(id, address(this));
        if (borrowShares == 0) revert NoBorrowPosition();

        // Upper-bound approval. Residual allowance is cleared in `execute`.
        _forceApprove(plan.marketParams.loanToken, MORPHO, assets * 2);

        (uint256 repaidAssets,) = IMorpho7702(MORPHO).repay(plan.marketParams, 0, borrowShares, address(this), "");
        if (repaidAssets > assets) revert FlashLoanTooSmall(repaidAssets, assets);

        uint256 withdrawnCollateralAssets = _withdrawCollateral(plan);
        _runExit(plan, withdrawnCollateralAssets);

        _batchCall(plan.postCalls);
        _assertFlashSettlementCapacity(plan.marketParams.loanToken, startingLoanTokenBalance, assets);

        emit FlashPlanExecuted(
            id,
            plan.repayMode,
            plan.flashAssets,
            repaidAssets,
            withdrawnCollateralAssets,
            0
        );
    }

    function _withdrawCollateral(FlashPlan memory plan) internal returns (uint256 withdrawnCollateralAssets) {
        withdrawnCollateralAssets = plan.withdrawCollateralAssets;

        if (withdrawnCollateralAssets == WITHDRAW_ALL_COLLATERAL) {
            (, , uint128 collateral) = IMorpho7702(MORPHO).position(_marketId(plan.marketParams), address(this));
            if (collateral == 0) revert NoCollateralPosition();
            withdrawnCollateralAssets = collateral;
        }

        if (withdrawnCollateralAssets == 0) return 0;

        IMorpho7702(MORPHO).withdrawCollateral(
            plan.marketParams,
            withdrawnCollateralAssets,
            address(this),
            address(this)
        );
    }

    function _runExit(FlashPlan memory plan, uint256 withdrawnCollateralAssets) internal {
        if (plan.exitMode == EXIT_MODE_NONE || withdrawnCollateralAssets == 0) return;

        if (plan.exitMode == EXIT_MODE_ERC4626_REDEEM) {
            IERC4626Minimal(plan.exitTarget).redeem(withdrawnCollateralAssets, address(this), address(this));
            return;
        }

        revert InvalidExitMode(plan.exitMode);
    }

    function _assertFlashSettlementCapacity(address loanToken, uint256 startingLoanTokenBalance, uint256 flashAssets)
        internal
        view
    {
        uint256 currentLoanTokenBalance = IERC20Minimal(loanToken).balanceOf(address(this));
        uint256 requiredLoanTokenBalance = startingLoanTokenBalance + flashAssets;

        if (currentLoanTokenBalance < requiredLoanTokenBalance) {
            uint256 availableForSettlement = currentLoanTokenBalance > startingLoanTokenBalance
                ? currentLoanTokenBalance - startingLoanTokenBalance
                : 0;
            revert InsufficientLoanTokenForFlashSettlement(
                availableForSettlement,
                flashAssets
            );
        }
    }

    function _validatePlan(FlashPlan calldata plan) internal pure {
        if (plan.marketParams.loanToken == address(0)) revert ZeroLoanToken();
        if (plan.marketParams.collateralToken == address(0)) revert ZeroCollateralToken();
        if (plan.flashAssets == 0) revert ZeroFlashAssets();

        if (plan.repayMode == REPAY_MODE_EXACT_ASSETS) {
            if (plan.repayAssets == 0) revert ExactRepayAssetsRequired();
            if (plan.repayAssets > plan.flashAssets) {
                revert ExactRepayExceedsFlashAssets(plan.repayAssets, plan.flashAssets);
            }
        } else if (plan.repayMode != REPAY_MODE_FULL_SHARES) {
            revert InvalidRepayMode(plan.repayMode);
        }

        if (plan.exitMode == EXIT_MODE_NONE) return;
        if (plan.exitMode == EXIT_MODE_ERC4626_REDEEM) {
            if (plan.exitTarget == address(0)) revert ZeroCollateralToken();
            return;
        }

        revert InvalidExitMode(plan.exitMode);
    }

    function _marketId(MarketParams7702 memory marketParams) internal pure returns (bytes32 id) {
        assembly ("memory-safe") {
            id := keccak256(marketParams, 160)
        }
    }

    function _batchCall(Call7702[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool success,) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) revert TokenCallFailed();
        }
    }

    function _onlySelf() internal view {
        if (msg.sender != address(this)) revert NotFromSelf();
    }

    function _forceApprove(address token, address spender, uint256 value) internal {
        if (_callOptionalReturn(token, abi.encodeCall(IERC20Minimal.approve, (spender, value)))) return;

        if (!_callOptionalReturn(token, abi.encodeCall(IERC20Minimal.approve, (spender, 0)))) revert TokenCallFailed();
        if (!_callOptionalReturn(token, abi.encodeCall(IERC20Minimal.approve, (spender, value)))) revert TokenCallFailed();
    }

    function _callOptionalReturn(address token, bytes memory data) internal returns (bool) {
        (bool success, bytes memory returndata) = token.call(data);
        if (!success) return false;
        return returndata.length == 0 || abi.decode(returndata, (bool));
    }
}
