// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice A single simulated miner, created and owned by its sandbox pool.
/// @dev No external mint, forced transfer or formal collection address exists.
contract SandboxMockMiner is ERC721 {
    constructor() ERC721("BEMine Simulated Miner", "TEST-MINER") {
        _mint(msg.sender, 1);
    }
}
