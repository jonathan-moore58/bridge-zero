// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console, Vm} from "forge-std/Test.sol";
import {BridgeMinter} from "../../src/bridge/BridgeMinter.sol";
import {IGrandpaImporter} from "../../src/bridge/IGrandpaImporter.sol";
import {IWrappedTPOT, WrappedTPOT} from "../../src/bridge/WrappedTPOT.sol";
import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {LightClientBase} from "./LightClient.t.sol";

/// Lock 0 minted end to end from the mint bundle (fixtures/v3-testnet-mint, written by npm run mint
/// -- bundle and checked again offline by npm run check): V3 block B with its GRANDPA finality
/// proof, signed by both keys of the bundle's set, and under B's state root the vault's
/// AccountInfoOf entry, the root of its child trie and commitments[0]. The light client is a real
/// GrandpaLightClient, initialized at the bundle's set with B's parent as the checkpoint, so that
/// importAndMint imports B itself (a client that holds B already verifies it again and writes
/// nothing: test_checkpointAtB). The minter and the token are the deployer's nonce-31 and nonce-32
/// creations, at the addresses lock 0 and the minter name, on Sepolia's chain id.
contract BridgeMinterLiveTest is LightClientBase {
    string internal constant DIR = "../fixtures/v3-testnet-mint";

    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;
    uint256 internal constant V3_CHAIN_ID = 420_420_777;
    address internal constant DEPLOYER = 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071;
    uint64 internal constant MINTER_NONCE = 31;
    /// CREATE(DEPLOYER, 31): the dstMinter of lock 0.
    address internal constant MINTER = 0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E;
    address internal constant VAULT = 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd;
    /// keccak-256 of the vault's runtime code (deployments/v3-testnet.json), and the trie id
    /// pallet-revive gave the vault (fixtures/v3-testnet-vault).
    bytes32 internal constant VAULT_CODE_HASH = 0xa72553f50cdf645fb343b2cf089e431a1b26fb07e80f4e2236d55bf9811c663f;
    bytes32 internal constant TRIE_ID = 0xbe307c2d11dbc9391cda93d17e9772542d1300c9af14e7431918fb49e2f47c3a;
    /// Lock 0: 1 tPOT, in native base units, for the deployer itself.
    bytes32 internal constant LOCK0_COMMITMENT = 0x9eba08c90e4527bdb00da438eb8f15ad244cbb202e8886d929b0e12941e23435;
    address internal constant RECIPIENT = DEPLOYER;
    uint256 internal constant AMOUNT = 100_000_000_000_000;
    uint256 internal constant NONCE = 0;

    string internal json;
    bytes32 internal genesis;
    uint64 internal setId; // the set that signs B
    bytes32[] internal keys;
    bytes internal header; // B
    bytes32 internal blockHash;
    uint32 internal blockNumber;
    bytes32 internal stateRoot;
    bytes internal parent; // B's parent, the checkpoint
    bytes32 internal parentHash;
    bytes internal finalityProof; // grandpa_proveFinality(B)
    bytes internal signers; // the bundle's hint
    uint256 internal jOffset; // where the justification starts inside the finality proof
    /// Positions and authority indices of the counted precommits, by authority index: the hint.
    uint256[] internal pos;
    uint256[] internal idx;
    BridgeMinter.LockProof internal p;

    BridgeMinter internal minter;
    WrappedTPOT internal token;

    function setUp() public override {
        super.setUp();
        vm.chainId(SEPOLIA_CHAIN_ID);
        json = _json(DIR, "mint-bundle");
        assertEq(vm.parseJsonString(json, ".kind"), "mint-bundle");
        genesis = vm.parseJsonBytes32(json, ".provenance.genesisHash");
        setId = uint64(vm.parseJsonUint(json, ".signingSet.setId"));
        assertEq(vm.parseJsonUint(json, ".provenance.setId"), setId, "the bundle's set signs B");
        _keys(json, ".signingSet.authorities", keys);

        header = vm.parseJsonBytes(json, ".header.scale");
        blockHash = vm.parseJsonBytes32(json, ".header.hash");
        blockNumber = uint32(vm.parseJsonUint(json, ".header.number"));
        stateRoot = vm.parseJsonBytes32(json, ".header.stateRoot");
        assertEq(_hash(header), blockHash, "B's header hashes to B");
        parent = vm.parseJsonBytes(json, ".parentHeader.scale");
        parentHash = vm.parseJsonBytes32(json, ".parentHeader.hash");
        assertEq(_hash(parent), parentHash, "the parent header hashes to its hash");

        // FinalityProof = block hash, then the justification as Vec<u8>, then unknown headers.
        finalityProof = vm.parseJsonBytes(json, ".finalityProof.scale");
        bytes memory justification = vm.parseJsonBytes(json, ".justification.scale");
        jOffset = 32 + _compact(justification.length).length;
        assertEq(finalityProof.length, jOffset + justification.length + 1, "no unknown headers");
        for (uint256 i = 0; i < justification.length; i++) {
            assertEq(finalityProof[jOffset + i], justification[i]);
        }
        uint256 precommits = _count(json, ".justification.precommits");
        assertEq(uint8(justification[44]), precommits << 2, "one-byte compact precommit count");
        signers = vm.parseJsonBytes(json, ".signers.hint");
        (pos, idx) = _sorted(json);

        p.blockHash = blockHash;
        _store(vm.parseJsonBytesArray(json, ".account.proof.nodes"), p.accountProof);
        _store(vm.parseJsonBytesArray(json, ".childRoot.proof.nodes"), p.childRootProof);
        _store(vm.parseJsonBytesArray(json, ".slot.proof.nodes"), p.slotProof);
        p.recipient = vm.parseJsonAddress(json, ".lock.recipient");
        p.amount = vm.parseJsonUint(json, ".lock.amountNative");
        p.nonce = vm.parseJsonUint(json, ".lock.nonce");
    }

    // ------------------------------------------------------------------ the bundle

    /// The bundle is lock 0 for this minter on this chain, as the minter computes it: its fields
    /// give the commitment the vault stored, the keys are the ones the minter builds, and the hint
    /// is the one the light client tests build from the precommits. B changes no set, and neither
    /// does its parent, so a client checkpointed at the parent verifies B under the same set.
    function test_bundle_isLock0() public {
        _deploy(parent);
        assertEq(p.recipient, RECIPIENT);
        assertEq(p.amount, AMOUNT, "1 tPOT in native base units");
        assertEq(p.nonce, NONCE);
        assertEq(vm.parseJsonAddress(json, ".lock.dstMinter"), address(minter), "the lock names this minter");
        assertEq(vm.parseJsonUint(json, ".lock.dstChainId"), block.chainid, "and this chain");
        assertEq(vm.parseJsonAddress(json, ".vault.address"), VAULT);
        assertEq(vm.parseJsonUint(json, ".vault.chainId"), V3_CHAIN_ID);
        assertEq(vm.parseJsonBytes32(json, ".vault.codeHash"), VAULT_CODE_HASH);
        assertEq(vm.parseJsonBytes32(json, ".vault.trieId"), TRIE_ID);

        bytes32 commitment = minter.commitmentOf(p.recipient, p.amount, p.nonce);
        assertEq(commitment, LOCK0_COMMITMENT, "the commitment of lock 0");
        assertEq(vm.parseJsonBytes32(json, ".lock.commitment"), commitment);
        assertEq(vm.parseJsonBytes32(json, ".slot.value.hex"), commitment, "the proven word");
        assertEq(minter.accountInfoKey(), vm.parseJsonBytes(json, ".account.key.hex"), "AccountInfoOf key");
        assertEq(abi.encodePacked(minter.slotKeyOf(p.nonce)), vm.parseJsonBytes(json, ".slot.key.hex"), "slot key");

        bytes memory hint = new bytes(2 * pos.length);
        for (uint256 i = 0; i < pos.length; i++) {
            hint[2 * i] = bytes1(uint8(pos[i]));
            hint[2 * i + 1] = bytes1(uint8(idx[i]));
        }
        assertEq(hint, signers, "the bundle's hint: (position, index) in increasing index");
        assertEq(pos.length, lc.threshold(), "exactly the threshold");

        (Header.Decoded memory b,) = harness.header(header);
        (Header.Decoded memory a,) = harness.header(parent);
        assertEq(b.parentHash, parentHash, "the checkpoint is B's parent");
        assertEq(a.number + 1, blockNumber);
        assertEq(b.grandpaLogs.length, 0, "B changes no set");
        assertEq(a.grandpaLogs.length, 0, "nor does its parent");
    }

    // ------------------------------------------------------------------ one transaction

    /// importAndMint on a fresh minter: the light client imports B with its finality proof (2 of
    /// 2), the minter binds the vault from the account proof, proves commitments[0] in the vault's
    /// child trie and mints 1 wtPOT to the lock's recipient.
    function test_importAndMint() public {
        _deploy(parent);
        assertFalse(lc.isImported(blockHash));
        vm.expectEmit(address(lc));
        emit GrandpaLightClient.HeaderImported(blockHash, blockNumber, stateRoot, setId, pos.length);
        vm.expectEmit(address(minter));
        emit BridgeMinter.VaultBound(VAULT, TRIE_ID, blockHash);
        vm.expectEmit(address(token));
        emit WrappedTPOT.Transfer(address(0), RECIPIENT, AMOUNT);
        vm.expectEmit(address(minter));
        emit BridgeMinter.Minted(NONCE, RECIPIENT, AMOUNT, blockHash);
        bytes memory data = _call(finalityProof);
        (, uint256 txGas) =
            _sendTo(address(minter), "v3-testnet-mint: importAndMint lock 0 (import 2 of 2, bind, mint)", data);
        console.log("  share of the 16,777,216 cap, in basis points:", txGas * 10_000 / TX_GAS_CAP);
        console.log("  calldata bytes:", data.length);

        assertEq(token.balanceOf(RECIPIENT), AMOUNT, "100000000000000 wtPOT: 1 tPOT in native base units");
        assertEq(token.totalSupply(), AMOUNT);
        assertTrue(minter.used(NONCE));
        assertEq(minter.vaultTrieId(), TRIE_ID);
        assertTrue(lc.isImported(blockHash));
        (bytes32 latest, uint32 number) = lc.latestFinalized();
        assertEq(latest, blockHash, "B is the client's latest header");
        assertEq(number, blockNumber);
        (bytes32 root,) = lc.stateRootOf(blockHash);
        assertEq(root, stateRoot);
        assertEq(lc.headerOf(blockHash).setId, setId, "finalized by the bundle's set");
    }

    /// A flipped signature byte (R of the first counted precommit, s of the second) reverts with
    /// the client's InvalidSignature for that signer, and a flipped header byte (in the state root)
    /// with FinalityProofBlockMismatch: nothing is imported, bound or minted.
    function test_importAndMint_flippedSignature() public {
        _deploy(parent);
        bytes4 invalid = GrandpaLightClient.InvalidSignature.selector;
        _expectMinterFail(
            _call(_flip(finalityProof, jOffset + _pc(pos[0]) + 36)), abi.encodeWithSelector(invalid, 0, idx[0])
        );
        _expectMinterFail(
            _call(_flip(finalityProof, jOffset + _pc(pos[1]) + 68)), abi.encodeWithSelector(invalid, 1, idx[1])
        );
        bytes memory bad = _flip(header, 40);
        _expectMinterFail(
            abi.encodeCall(BridgeMinter.importAndMint, (bad, finalityProof, signers, p)),
            abi.encodeWithSelector(GrandpaLightClient.FinalityProofBlockMismatch.selector, blockHash, _hash(bad))
        );
        assertFalse(lc.isImported(blockHash), "no tampered header is imported");
        (bytes32 latest,) = lc.latestFinalized();
        assertEq(latest, parentHash, "the checkpoint is still the latest header");
        assertFalse(minter.bound());
        assertEq(token.totalSupply(), 0);
    }

    /// The same importAndMint again, after the mint: B is imported, so the client verifies its
    /// finality proof again instead of refusing it as NotNewer, and the minter then refuses the
    /// lock with NonceAlreadyUsed. That the signatures are checked again shows in the gas, and in
    /// a copy with a flipped signature byte, which still reverts InvalidSignature.
    function test_replay_verifiesBAgain() public {
        _deploy(parent);
        bytes memory data = _call(finalityProof);
        _sendTo(address(minter), "v3-testnet-mint: importAndMint lock 0", data);
        uint256 again = _failGas(
            address(minter),
            "v3-testnet-mint: importAndMint lock 0 again (B verified again, then NonceAlreadyUsed)",
            data,
            abi.encodeWithSelector(BridgeMinter.NonceAlreadyUsed.selector, NONCE)
        );
        assertGt(again, 1_000_000, "the two signatures were verified again");
        _expectMinterFail(
            _call(_flip(finalityProof, jOffset + _pc(pos[0]) + 36)),
            abi.encodeWithSelector(GrandpaLightClient.InvalidSignature.selector, 0, idx[0])
        );
        assertEq(token.balanceOf(RECIPIENT), AMOUNT, "minted once");
        (bytes32 latest,) = lc.latestFinalized();
        assertEq(latest, blockHash);
    }

    /// A client that holds B already (the relayer imported exactly B, or B is its checkpoint):
    /// importAndMint verifies B again, writes no header and emits no HeaderImported, then binds and
    /// mints.
    function test_checkpointAtB() public {
        _deploy(header);
        assertTrue(lc.isImported(blockHash));
        vm.recordLogs();
        _sendTo(
            address(minter),
            "v3-testnet-mint: importAndMint lock 0, B held already (verify, bind, mint)",
            _call(finalityProof)
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3, "VaultBound, Transfer and Minted only");
        assertEq(logs[0].emitter, address(minter));
        assertEq(logs[0].topics[0], BridgeMinter.VaultBound.selector);
        assertEq(logs[1].emitter, address(token));
        assertEq(logs[2].emitter, address(minter));
        assertEq(logs[2].topics[0], BridgeMinter.Minted.selector);
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    /// The same path as separate transactions, for the gas of each part: the import, bindVault,
    /// mint, and mint again (NonceAlreadyUsed).
    function test_stepByStep() public {
        _deploy(parent);
        _send("v3-testnet-mint: importFinalityProof (2 of 2)", _proofCall(header, finalityProof, signers));
        _sendTo(
            address(minter),
            "v3-testnet-mint: bindVault",
            abi.encodeCall(BridgeMinter.bindVault, (blockHash, p.accountProof))
        );
        assertEq(minter.vaultTrieId(), TRIE_ID);
        bytes memory mint = abi.encodeCall(BridgeMinter.mint, (p));
        _sendTo(address(minter), "v3-testnet-mint: mint", mint);
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
        _failGas(
            address(minter),
            "v3-testnet-mint: mint again (NonceAlreadyUsed)",
            mint,
            abi.encodeWithSelector(BridgeMinter.NonceAlreadyUsed.selector, NONCE)
        );
    }

    // ------------------------------------------------------------------ helpers

    /// Initializes the client at the bundle's set with `checkpoint`, then deploys the pair as the
    /// deployer does on Sepolia: the minter at nonce 31, the token at nonce 32, each with the
    /// other's address.
    function _deploy(bytes memory checkpoint) internal {
        lc.initialize(genesis, setId, keys, checkpoint);
        address tokenAt = vm.computeCreateAddress(DEPLOYER, MINTER_NONCE + 1);
        vm.setNonce(DEPLOYER, MINTER_NONCE);
        vm.prank(DEPLOYER);
        minter =
            new BridgeMinter(IGrandpaImporter(address(lc)), VAULT, V3_CHAIN_ID, VAULT_CODE_HASH, IWrappedTPOT(tokenAt));
        assertEq(address(minter), MINTER, "the minter lands at CREATE(deployer, 31)");
        vm.prank(DEPLOYER);
        token = new WrappedTPOT(address(minter));
        assertEq(address(token), tokenAt, "the token lands at CREATE(deployer, 32)");
    }

    /// importAndMint of the bundle, with `proof` as the finality proof.
    function _call(bytes memory proof) internal view returns (bytes memory) {
        return abi.encodeCall(BridgeMinter.importAndMint, (header, proof, signers, p));
    }

    /// Expects `data`, sent to the minter with the cap, to revert with exactly `reason`.
    function _expectMinterFail(bytes memory data, bytes memory reason) internal {
        vm.expectRevert(reason);
        // Under expectRevert a low-level call returns true only when the expected revert happened.
        (bool ok,) = address(minter).call{gas: TX_GAS_CAP}(data);
        assertTrue(ok, "the expected revert did not happen");
    }

    /// Sends `data` to `to` as its own transaction with the cap as gas limit; requires it to revert
    /// with exactly `reason` and returns the transaction's gas.
    function _failGas(address to, string memory label, bytes memory data, bytes memory reason)
        internal
        returns (uint256 txGas)
    {
        assertTrue(vm.isIsolateMode(), "run with isolate, so each call is measured as a transaction");
        (bool ok, bytes memory ret) = to.call{gas: TX_GAS_CAP}(data);
        txGas = vm.lastFrameGas().gasTotalUsed;
        assertFalse(ok, "the call must revert");
        assertEq(ret, reason);
        console.log(string.concat(label, ", transaction gas:"), txGas);
    }

    /// Offset of precommit `i` in a justification with a one-byte precommit count.
    function _pc(uint256 i) internal pure returns (uint256) {
        return 45 + i * 132;
    }

    function _store(bytes[] memory items, bytes[] storage to) internal {
        for (uint256 i = 0; i < items.length; i++) {
            to.push(items[i]);
        }
    }
}
