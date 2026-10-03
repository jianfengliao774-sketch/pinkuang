// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPoolVault, IPoolFactoryRoles} from "../interfaces/IPoolVault.sol";
import {PoolVaultState} from "../PoolVaultState.sol";
import {TargetOwnerState} from "../TargetOwnerState.sol";
import {PurchaseSelectionState} from "../PurchaseSelectionState.sol";

interface ITargetOwnerAuthority {
    function administratorOne() external view returns (address);
    function administratorTwo() external view returns (address);
}

/// @notice Internal-only helpers; compiled into the existing linked PoolFunds library.
library TargetOwner {
    bytes32 private constant STORAGE = 0x5e3815662d4c25a0aafa80ec36671d2b01c656be89eff3f6936c6387169fd700;
    // Existing opt-in namespace, unchanged from FlexiblePurchase.
    bytes32 private constant SELECTION_STORAGE = 0xabb161195ab2dca5bb4a3b74cf71ac027f503287a65da4d00c8f2426b582f100;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("BEMine Target Owner");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant CONFIGURE_TYPEHASH = keccak256(
        "ConfigureTargetOwner(address pool,address factory,address circuits,uint256 circuitId,address originalOwner,address authority,address administratorOne,address administratorTwo,uint256 nonce,uint256 deadline)"
    );

    event TargetOwnerConfigured(address indexed originalOwner, bool migrated, uint256 nonce);

    function initialize(PoolVaultState.VaultStorage storage s) internal {
        TargetOwnerState.TargetOwnerStorage storage t = state();
        if (t.configured) revert IPoolVault.TargetOwnerAlreadyConfigured();
        address owner = _readOwner(s);
        t.originalOwner = owner;
        t.configured = true;
        emit TargetOwnerConfigured(owner, false, 0);
    }

    function assertFundable(PoolVaultState.VaultStorage storage s) internal view {
        if (flexibleEnabled()) return;
        TargetOwnerState.TargetOwnerStorage storage t = state();
        if (!t.configured) revert IPoolVault.TargetOwnerNotConfigured();
        if (_readOwner(s) != t.originalOwner) revert IPoolVault.TargetOwnerChanged();
    }

    function unavailable(PoolVaultState.VaultStorage storage s) internal view returns (bool) {
        if (flexibleEnabled()) revert IPoolVault.FlexiblePurchaseDisabled();
        TargetOwnerState.TargetOwnerStorage storage t = state();
        if (!t.configured) revert IPoolVault.TargetOwnerNotConfigured();
        address owner = _readOwner(s);
        // Mere pool custody is not an external buyer. A successful purchase uses the existing Active transition.
        return owner != t.originalOwner && owner != address(this);
    }

    function configure(
        PoolVaultState.VaultStorage storage s,
        IPoolVault.TargetOwnerAuthorization memory a,
        bytes memory signatureOne,
        bytes memory signatureTwo
    ) internal {
        if (s.state != IPoolVault.State.Funding && s.state != IPoolVault.State.Funded) revert IPoolVault.WrongState();
        if (flexibleEnabled()) revert IPoolVault.FlexiblePurchaseDisabled();
        TargetOwnerState.TargetOwnerStorage storage t = state();
        if (t.configured) revert IPoolVault.TargetOwnerAlreadyConfigured();
        if (
            a.originalOwner == address(0) || a.originalOwner == address(this) || a.nonce != t.nonce
                || block.timestamp > a.deadline
        ) revert IPoolVault.InvalidTargetOwnerAuthorization();
        address authority = IPoolFactoryRoles(s.factory).operator();
        if (authority.code.length == 0 || a.authority != authority) {
            revert IPoolVault.InvalidTargetOwnerAuthorization();
        }
        address one = ITargetOwnerAuthority(authority).administratorOne();
        address two = ITargetOwnerAuthority(authority).administratorTwo();
        if (
            one == address(0) || two == address(0) || one == two || a.administratorOne != one
                || a.administratorTwo != two
        ) {
            revert IPoolVault.InvalidTargetOwnerAuthorization();
        }
        // The static authorization tuple encodes inline, identically to its six flattened typed fields.
        bytes32 structHash = keccak256(
            abi.encode(CONFIGURE_TYPEHASH, address(this), s.factory, s.params.circuits, s.params.circuitId, a)
        );
        bytes32 domainHash =
            keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainHash, structHash));
        if (ECDSA.recover(digest, signatureOne) != one || ECDSA.recover(digest, signatureTwo) != two) {
            revert IPoolVault.InvalidTargetOwnerAuthorization();
        }
        // Re-read the entire Authority binding after signature verification. No external callback may change roles.
        if (
            IPoolFactoryRoles(s.factory).operator() != authority
                || ITargetOwnerAuthority(authority).administratorOne() != one
                || ITargetOwnerAuthority(authority).administratorTwo() != two
        ) revert IPoolVault.InvalidTargetOwnerAuthorization();
        t.originalOwner = a.originalOwner;
        t.configured = true;
        t.nonce = a.nonce + 1;
        emit TargetOwnerConfigured(a.originalOwner, true, t.nonce);
    }

    function state() internal pure returns (TargetOwnerState.TargetOwnerStorage storage s) {
        bytes32 slot = STORAGE;
        assembly { s.slot := slot }
    }

    function flexibleEnabled() internal view returns (bool) {
        PurchaseSelectionState.SelectionStorage storage s;
        bytes32 slot = SELECTION_STORAGE;
        assembly { s.slot := slot }
        return s.enabled;
    }

    function _readOwner(PoolVaultState.VaultStorage storage s) private view returns (address owner) {
        // A missing token, reverting call or malformed ABI is unknown, never proof of a sale.
        owner = IERC721(s.params.circuits).ownerOf(s.params.circuitId);
        if (owner == address(0)) revert IPoolVault.TargetOwnerUnavailable();
    }
}
