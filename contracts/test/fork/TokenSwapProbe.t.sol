// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IProbeBem {
    function minter() external view returns (address);
    function decimals() external view returns (uint8);
    function MAX_SUPPLY() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function mint(address, uint256) external;
}

interface IProbeMiningControl {
    function owner() external view returns (address);
    function isSealed() external view returns (bool);
}

interface IProbeV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function factory() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool);
}

interface IProbeSmartRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function WETH9() external view returns (address);
    function factory() external view returns (address);
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
    function unwrapWETH9(uint256 amountMinimum, address recipient) external payable;
    function refundETH() external payable;
    function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory);
}

/// @notice Q8/Q9 evidence only. All state changes are local to a BSC fork.
/// @dev Router address: https://developer.pancakeswap.finance/contracts/v3/addresses
/// SmartRouter uses the seven-field, no-deadline exactInputSingle tuple. The deadline belongs to multicall.
contract TokenSwapProbeTest is Test {
    uint256 internal constant EXPECTED_BLOCK = 123728000;
    address internal constant SMART_ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant PANCAKE_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    uint256 internal constant SMALL_BNB = 0.001 ether;
    uint256 internal constant FEE_PPM = 10_000; // 1%, denominator 1,000,000.

    IProbeBem internal constant BEM = IProbeBem(Addresses.BEM);
    IProbeV3Pool internal constant POOL = IProbeV3Pool(Addresses.PANCAKE_V3_BEM_WBNB_POOL);
    IProbeSmartRouter internal constant ROUTER = IProbeSmartRouter(SMART_ROUTER);

    receive() external payable {}

    function setUp() public {
        uint256 forkBlock = vm.envUint("FORK_BLOCK");
        assertEq(forkBlock, EXPECTED_BLOCK, "All M0 probes must use the recorded block");
        vm.createSelectFork(vm.envString("BSC_RPC_URL"), forkBlock);
        assertEq(block.chainid, Addresses.CHAIN_ID);
        assertEq(block.number, EXPECTED_BLOCK);
    }

    function test_Q8_MintOnlyImmutableMiningMinterAndCap() public {
        assertEq(BEM.minter(), Addresses.MINING);
        assertEq(BEM.decimals(), 8);
        assertEq(BEM.MAX_SUPPLY(), 21_000_000 * 1e8);
        assertEq(IProbeMiningControl(Addresses.MINING).owner(), address(0));
        assertTrue(IProbeMiningControl(Addresses.MINING).isSealed());
        bytes32 implementationSlot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        assertEq(
            address(uint160(uint256(vm.load(Addresses.MINING, implementationSlot)))),
            address(0xa3DBe873DA37cD4e4a13c7cEf23a7dB6Ca60f898)
        );
        uint256 beforeSupply = BEM.totalSupply();
        uint256 beforeBalance = BEM.balanceOf(address(this));

        vm.expectRevert();
        BEM.mint(address(this), 1e8);

        // Impersonates the sole minter only within the fork, proving the token-level permission.
        // This does not imply that an EOA can instruct Mining to arbitrarily mint.
        vm.prank(Addresses.MINING);
        BEM.mint(address(this), 1e8);
        assertEq(BEM.totalSupply(), beforeSupply + 1e8);
        assertEq(BEM.balanceOf(address(this)), beforeBalance + 1e8);

        uint256 maxSupply = BEM.MAX_SUPPLY();
        vm.prank(Addresses.MINING);
        vm.expectRevert();
        BEM.mint(address(this), maxSupply);

        emit log_named_address("Q8 sole immutable minter", BEM.minter());
        emit log_named_uint("Q8 original totalSupply (BEM raw, 8 decimals)", beforeSupply);
        emit log_named_uint("Q8 MAX_SUPPLY (BEM raw, 8 decimals)", BEM.MAX_SUPPLY());
    }

    function test_Q9_PoolAndRouterIdentity() public view {
        assertEq(POOL.token0(), Addresses.BEM);
        assertEq(POOL.token1(), WBNB);
        assertEq(POOL.fee(), FEE_PPM);
        assertEq(POOL.factory(), PANCAKE_FACTORY);
        assertGt(POOL.liquidity(), 0);
        assertEq(ROUTER.factory(), PANCAKE_FACTORY);
        assertEq(ROUTER.WETH9(), WBNB);
        assertGt(SMART_ROUTER.code.length, 0);
    }

    function test_Q9_BnbToBemWithMinOutAndRefund() public {
        _buySmallBem();
    }

    function test_Q9_BemToNativeBnbWithMinOutAndUnwrap() public {
        // Real BEM holder at the fixed block; no ERC20 deal/store/mint and no prior pool mutation.
        address holder = 0x4e5DCf356443174f5F03E4ac134238201C1f2BD8;
        uint256 amountIn = 0.01 * 1e8;
        assertGe(BEM.balanceOf(holder), amountIn);
        vm.prank(holder);
        assertTrue(BEM.transfer(address(this), amountIn));
        uint256 spotOut = _spotQuote(false, amountIn);
        uint256 feeAdjustedSpotOut = Math.mulDiv(spotOut, 1_000_000 - FEE_PPM, 1_000_000);
        uint256 minimumOut = Math.mulDiv(feeAdjustedSpotOut, 99, 100);
        assertTrue(BEM.approve(SMART_ROUTER, amountIn));
        uint256 bnbBefore = address(this).balance;
        uint256 bemBefore = BEM.balanceOf(address(this));
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            IProbeSmartRouter.exactInputSingle,
            (IProbeSmartRouter.ExactInputSingleParams(
                    Addresses.BEM, WBNB, 10_000, SMART_ROUTER, amountIn, minimumOut, 0
                ))
        );
        calls[1] = abi.encodeCall(IProbeSmartRouter.unwrapWETH9, (minimumOut, address(this)));
        bytes[] memory results = ROUTER.multicall(block.timestamp + 60, calls);
        uint256 actualOut = abi.decode(results[0], (uint256));
        assertEq(BEM.balanceOf(address(this)), bemBefore - amountIn);
        assertEq(address(this).balance - bnbBefore, actualOut);
        assertGe(actualOut, minimumOut);
        assertGt(actualOut, 0);
        _recordQuote("Q9 SELL BEM raw -> native BNB wei", amountIn, spotOut, feeAdjustedSpotOut, minimumOut, actualOut);
    }

    function test_Q9_ExcessiveMinOutRevertsWithoutTakingBnb() public {
        vm.deal(address(this), SMALL_BNB);
        uint256 bemBefore = BEM.balanceOf(address(this));
        vm.expectRevert();
        ROUTER.exactInputSingle{value: SMALL_BNB}(
            IProbeSmartRouter.ExactInputSingleParams(
                WBNB, Addresses.BEM, 10_000, address(this), SMALL_BNB, type(uint256).max, 0
            )
        );
        assertEq(address(this).balance, SMALL_BNB);
        assertEq(BEM.balanceOf(address(this)), bemBefore);
    }

    function _buySmallBem() internal returns (uint256 actualOut) {
        vm.deal(address(this), SMALL_BNB);
        uint256 bemBefore = BEM.balanceOf(address(this));
        uint256 spotOut = _spotQuote(true, SMALL_BNB);
        uint256 feeAdjustedSpotOut = Math.mulDiv(spotOut, 1_000_000 - FEE_PPM, 1_000_000);
        uint256 minimumOut = Math.mulDiv(feeAdjustedSpotOut, 99, 100);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            IProbeSmartRouter.exactInputSingle,
            (IProbeSmartRouter.ExactInputSingleParams(
                    WBNB, Addresses.BEM, 10_000, address(this), SMALL_BNB, minimumOut, 0
                ))
        );
        calls[1] = abi.encodeCall(IProbeSmartRouter.refundETH, ());
        bytes[] memory results = ROUTER.multicall{value: SMALL_BNB}(block.timestamp + 60, calls);
        actualOut = abi.decode(results[0], (uint256));
        assertEq(BEM.balanceOf(address(this)) - bemBefore, actualOut);
        assertEq(address(this).balance, 0, "Full exact input spent; no unspent native BNB");
        assertGe(actualOut, minimumOut);
        assertGt(actualOut, 0);
        _recordQuote(
            "Q9 BUY BNB wei -> BEM raw (8 decimals)", SMALL_BNB, spotOut, feeAdjustedSpotOut, minimumOut, actualOut
        );
    }

    function _spotQuote(bool bnbIn, uint256 amountIn) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = POOL.slot0();
        // token1 raw / token0 raw in Q128. Handles sqrt prices above uint128 as well.
        uint256 ratioX128 = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
        return bnbIn ? Math.mulDiv(amountIn, 1 << 128, ratioX128) : Math.mulDiv(amountIn, ratioX128, 1 << 128);
    }

    function _recordQuote(
        string memory direction,
        uint256 amountIn,
        uint256 spotOut,
        uint256 feeAdjustedSpotOut,
        uint256 minimumOut,
        uint256 actualOut
    ) internal {
        emit log(direction);
        emit log_named_uint("input raw", amountIn);
        emit log_named_uint("instantaneous spot output, excluding fee and impact", spotOut);
        emit log_named_uint("spot output after nominal 1% pool fee", feeAdjustedSpotOut);
        emit log_named_uint("minimum output raw", minimumOut);
        emit log_named_uint("actual output raw", actualOut);
        emit log_named_uint("nominal pool fee ppm", FEE_PPM);
        // Shortfall to post-fee spot includes deterministic price impact and integer rounding.
        // It is NOT execution slippage versus a separately quoted/mempool-delayed price.
        if (actualOut <= feeAdjustedSpotOut) {
            emit log_named_uint(
                "price impact plus rounding ppb vs fee-adjusted spot (rounded down)",
                Math.mulDiv(feeAdjustedSpotOut - actualOut, 1_000_000_000, feeAdjustedSpotOut)
            );
        }
    }
}
