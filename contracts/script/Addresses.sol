// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @notice BSC mainnet constants from development specification v0.4 sections 2.1/13.4,
/// the kickoff plan section 1.2, and the project owner's supplied address list.
/// @dev All external addresses: 待人工复核. No chain behavior is certified by this file.
library Addresses {
    uint256 internal constant CHAIN_ID = 56;

    // v0.4 section 2.1 — 待人工复核.
    address internal constant TAPEOUT_CIRCUITS = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address internal constant BEHEMOTH_CIRCUITS = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;
    address internal constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address internal constant CIRCUIT_MARKET = 0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f;
    address internal constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    // Existing protocol registry; NOT the PoolFactory that this project will implement.
    address internal constant PROTOCOL_FACTORY = 0x68224F668083c29e9800Be2a646d42d18cedF7e2;
    // ERC-6551 addresses are recorded only; outside phase-one execution paths.
    address internal constant CAPACITOR_IMPLEMENTATION = 0xAf4E78a2257C9c5480c2F8310E3b00437260751d;
    address internal constant CAPACITOR_OPENER = 0x021745DE2f42A7839d96f2d3634d0294487D81F1;

    // Kickoff plan / user supplement — 待人工复核.
    address internal constant PANCAKE_V3_BEM_WBNB_POOL = 0x28B12792F9D81Bd529Bc5572434E861C9EDbBBC2;
    address internal constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;
    // v0.4 section 13.4 — 待人工复核; reserved for phase two, not subscriptions.
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
}
