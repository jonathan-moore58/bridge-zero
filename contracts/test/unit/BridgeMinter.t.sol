// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console, Vm} from "forge-std/Test.sol";
import {BridgeMinter} from "../../src/bridge/BridgeMinter.sol";
import {IGrandpaImporter} from "../../src/bridge/IGrandpaImporter.sol";
import {IWrappedTPOT, WrappedTPOT} from "../../src/bridge/WrappedTPOT.sol";
import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {SubstrateProofs} from "../../src/trie/SubstrateProofs.sol";
import {ReviveHarness} from "./ReviveStorage.t.sol";
import {UnitFixtures} from "./UnitFixtures.sol";

// ------------------------------------------------------------------ helpers

/// A finalized-state-roots source that takes the blocks it is told about as finalized, so the
/// minter runs on a captured block without a finality proof. importFinalityProof returns the hash
/// of `header` when that block is known, whatever the proof and the hint; stateRootOf answers for
/// known blocks. Both revert with the light client's UnknownBlock otherwise.
contract StubImporter is IGrandpaImporter {
    struct Known {
        bytes32 stateRoot;
        uint32 number;
        bool known;
    }

    mapping(bytes32 => Known) internal blocks;
    bytes32 internal genesis;

    constructor(bytes32 genesis_) {
        genesis = genesis_;
    }

    /// Takes the block of `header` as finalized, with the state root and number in the header.
    function know(bytes memory header) external returns (bytes32 hash) {
        Header.Decoded memory h = Header.decode(header);
        blocks[h.hash] = Known(h.stateRoot, h.number, true);
        return h.hash;
    }

    /// Takes a block that has no header as finalized, with state root `stateRoot` (synthetic
    /// state).
    function put(bytes32 blockHash, bytes32 stateRoot) external {
        blocks[blockHash] = Known(stateRoot, 0, true);
    }

    function importFinalityProof(bytes calldata header, bytes calldata, bytes calldata)
        external
        view
        returns (bytes32 blockHash)
    {
        blockHash = Header.hash(header);
        _known(blockHash);
    }

    function stateRootOf(bytes32 blockHash) external view returns (bytes32 stateRoot, uint32 number) {
        Known storage k = _known(blockHash);
        return (k.stateRoot, k.number);
    }

    function genesisHash() external view returns (bytes32) {
        return genesis;
    }

    function _known(bytes32 blockHash) internal view returns (Known storage k) {
        k = blocks[blockHash];
        if (!k.known) revert GrandpaLightClient.UnknownBlock(blockHash);
    }
}

/// The vault's first lock as capture-contract.ts captured it at V3 block #101,027
/// (fixtures/v3-testnet-vault/contract-storage.json, re-verified offline by npm run check): B's
/// header, the Revive.AccountInfoOf(vault) proof, the child-root proof and the proof of
/// commitments[0]. The minter is deployed as on Sepolia, by the deployer at its nonce 31, so it
/// sits at the address lock 0 names, and the chain id is Sepolia's; the token follows at nonce 32.
abstract contract BridgeMinterFixture is UnitFixtures {
    string internal constant DIR = "../fixtures/v3-testnet-vault";

    /// EIP-7825 transaction gas limit cap: the gas limit of every measured transaction.
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;
    uint256 internal constant V3_CHAIN_ID = 420_420_777;
    address internal constant DEPLOYER = 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071;
    uint64 internal constant MINTER_NONCE = 31;
    /// CREATE(DEPLOYER, 31): the dstMinter of lock 0.
    address internal constant MINTER = 0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E;
    address internal constant VAULT = 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd;
    /// keccak-256 of the vault's runtime code (deployments/v3-testnet.json).
    bytes32 internal constant VAULT_CODE_HASH = 0xa72553f50cdf645fb343b2cf089e431a1b26fb07e80f4e2236d55bf9811c663f;
    /// Lock 0 (deployments/v3-testnet.json): 1 tPOT for the deployer itself.
    address internal constant RECIPIENT = DEPLOYER;
    uint256 internal constant AMOUNT = 100_000_000_000_000;
    uint256 internal constant NONCE = 0;
    bytes32 internal constant LOCK0_COMMITMENT = 0x9eba08c90e4527bdb00da438eb8f15ad244cbb202e8886d929b0e12941e23435;
    bytes32 internal constant LOCK_TAG = keccak256("BridgeZero.Lock.v1");
    bytes32 internal constant BURN_TAG = keccak256("BridgeZero.Burn.v1");

    /// The vendored walk's revert when an item is not among the proof items.
    bytes internal INCOMPLETE;

    string internal json;
    bytes32 internal genesis;
    bytes internal header;
    bytes32 internal blockHash;
    uint32 internal blockNumber;
    bytes32 internal stateRoot;
    bytes32 internal trieId; // as the capture decoded it
    bytes32 internal codeHash; // as the capture decoded it
    bytes32 internal childRoot;
    bytes32 internal commitment; // the captured slot value
    bytes[] internal accountNodes;
    bytes[] internal rootNodes;
    bytes[] internal childNodes;
    /// Lock 0's proof, as the mint tool bundles it.
    BridgeMinter.LockProof internal p;

    IGrandpaImporter internal importer;
    BridgeMinter internal minter;
    WrappedTPOT internal token;
    ReviveHarness internal rh;

    /// The finalized-state-roots source the minter is deployed on, with B imported.
    function _importer() internal virtual returns (IGrandpaImporter);

    function setUp() public virtual override {
        super.setUp();
        vm.chainId(SEPOLIA_CHAIN_ID);
        rh = new ReviveHarness();
        INCOMPLETE = abi.encodeWithSignature("Error(string)", "Incomplete Proof!");

        json = _json(DIR, "contract-storage");
        assertEq(vm.parseJsonString(json, ".kind"), "contract-storage");
        assertEq(vm.parseJsonUint(json, ".evm.chainId"), V3_CHAIN_ID, "captured on V3");
        assertEq(vm.parseJsonAddress(json, ".account.address"), VAULT, "the capture is of the vault");
        assertEq(
            vm.parseJsonBytes32(json, ".slot.index"), keccak256(abi.encode(NONCE, 0)), "the slot is commitments[0]"
        );
        genesis = vm.parseJsonBytes32(json, ".provenance.genesisHash");
        header = vm.parseJsonBytes(json, ".header.scale");
        blockHash = vm.parseJsonBytes32(json, ".header.hash");
        blockNumber = uint32(vm.parseJsonUint(json, ".header.number"));
        stateRoot = vm.parseJsonBytes32(json, ".header.stateRoot");
        assertEq(Header.hash(header), blockHash, "fixture header hash");
        trieId = vm.parseJsonBytes32(json, ".account.value.decoded.trieId");
        codeHash = vm.parseJsonBytes32(json, ".account.value.decoded.codeHash");
        childRoot = vm.parseJsonBytes32(json, ".childRoot.root");
        commitment = vm.parseJsonBytes32(json, ".slot.value.hex");
        _store(vm.parseJsonBytesArray(json, ".account.proof.nodes"), accountNodes);
        _store(vm.parseJsonBytesArray(json, ".childRoot.proof.nodes"), rootNodes);
        _store(vm.parseJsonBytesArray(json, ".slot.proof.nodes"), childNodes);

        p.blockHash = blockHash;
        _store(accountNodes, p.accountProof);
        _store(rootNodes, p.childRootProof);
        _store(childNodes, p.slotProof);
        p.recipient = RECIPIENT;
        p.amount = AMOUNT;
        p.nonce = NONCE;

        importer = _importer();
        (minter, token) = _deployPair(importer, codeHash);
    }

    /// Deploys the pair as the deployer does on Sepolia: the minter at nonce 31, then the token at
    /// nonce 32, each with the other's address.
    function _deployPair(IGrandpaImporter lightClient, bytes32 vaultCodeHash)
        internal
        returns (BridgeMinter m, WrappedTPOT t)
    {
        address tokenAt = vm.computeCreateAddress(DEPLOYER, MINTER_NONCE + 1);
        vm.setNonce(DEPLOYER, MINTER_NONCE);
        vm.prank(DEPLOYER);
        m = new BridgeMinter(lightClient, VAULT, V3_CHAIN_ID, vaultCodeHash, IWrappedTPOT(tokenAt));
        assertEq(address(m), MINTER, "the minter lands at CREATE(deployer, 31)");
        vm.prank(DEPLOYER);
        t = new WrappedTPOT(address(m));
        assertEq(address(t), tokenAt, "the token lands at CREATE(deployer, 32)");
        assertEq(vm.getNonce(DEPLOYER), MINTER_NONCE + 2);
    }

    function _bind() internal {
        minter.bindVault(blockHash, accountNodes);
    }

    function _mintCall(BridgeMinter.LockProof memory q) internal pure returns (bytes memory) {
        return abi.encodeCall(BridgeMinter.mint, (q));
    }

    function _bindCall(bytes[] memory nodes) internal view returns (bytes memory) {
        return abi.encodeCall(BridgeMinter.bindVault, (blockHash, nodes));
    }

    function _withChildRoot(bytes[] memory nodes) internal view returns (bytes memory) {
        BridgeMinter.LockProof memory q = p;
        q.childRootProof = nodes;
        return _mintCall(q);
    }

    function _withSlot(bytes[] memory nodes) internal view returns (bytes memory) {
        BridgeMinter.LockProof memory q = p;
        q.slotProof = nodes;
        return _mintCall(q);
    }

    function _importAndMintCall(bytes memory h, BridgeMinter.LockProof memory q) internal pure returns (bytes memory) {
        return abi.encodeCall(BridgeMinter.importAndMint, (h, "", "", q));
    }

    /// Sends `data` to `to` as its own transaction (isolate mode) with the per-transaction cap as
    /// gas limit; requires success and returns the transaction's gas.
    function _send(address to, string memory label, bytes memory data) internal returns (uint256 txGas) {
        assertTrue(vm.isIsolateMode(), "run with isolate, so each call is measured as a transaction");
        (bool ok, bytes memory ret) = to.call{gas: TX_GAS_CAP}(data);
        txGas = vm.lastFrameGas().gasTotalUsed;
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        assertLe(txGas, TX_GAS_CAP, "within the EIP-7825 cap");
        console.log(string.concat(label, ", transaction gas:"), txGas);
        console.log("  share of the 16,777,216 cap, in basis points:", txGas * 10_000 / TX_GAS_CAP);
        console.log("  calldata bytes:", data.length);
    }

    /// Expects `data`, sent to the minter with the cap, to revert with exactly `reason`.
    function _expectFail(bytes memory data, bytes memory reason) internal {
        vm.expectRevert(reason);
        // Under expectRevert a low-level call returns true only when the expected revert happened.
        (bool ok,) = address(minter).call{gas: TX_GAS_CAP}(data);
        assertTrue(ok, "the expected revert did not happen");
    }

    /// `ret` is the library's KeyNotPresent(root, key), or the walk's "Incomplete Proof!".
    function _assertProofError(bytes memory ret, bytes32 root, bytes memory key) internal view {
        bytes memory absent = abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, root, key);
        assertTrue(
            keccak256(ret) == keccak256(absent) || keccak256(ret) == keccak256(INCOMPLETE),
            "absent, or not in the proof"
        );
    }

    /// Flips each byte of each item in turn and sends the call built from the changed list: every
    /// call must revert with "Incomplete Proof!". Returns the number of bytes flipped.
    function _everyByteFails(
        bytes[] storage items,
        function(bytes[] memory) internal view returns (bytes memory) callWith
    ) internal returns (uint256 checked) {
        bytes[] memory copy = items;
        for (uint256 i = 0; i < copy.length; i++) {
            bytes memory node = copy[i];
            for (uint256 j = 0; j < node.length; j++) {
                node[j] ^= 0x01;
                (bool ok, bytes memory ret) = address(minter).call(callWith(copy));
                node[j] ^= 0x01;
                assertFalse(ok, "a flipped byte must fail");
                assertEq(ret, INCOMPLETE, "the flipped item is not under its root");
                checked++;
            }
        }
    }

    /// Drops each item in turn: the walk looks the item up and fails ("Incomplete Proof!").
    function _droppedItemFails(
        bytes[] storage items,
        function(bytes[] memory) internal view returns (bytes memory) callWith
    ) internal {
        for (uint256 i = 0; i < items.length; i++) {
            (bool ok, bytes memory ret) = address(minter).call(callWith(_without(items, i)));
            assertFalse(ok, "a proof without one of its items must fail");
            assertEq(ret, INCOMPLETE, "the dropped item is looked up");
        }
    }

    function _without(bytes[] memory items, uint256 skip) internal pure returns (bytes[] memory fewer) {
        fewer = new bytes[](items.length - 1);
        for (uint256 k = 0; k < fewer.length; k++) {
            fewer[k] = items[k < skip ? k : k + 1];
        }
    }

    function _store(bytes[] memory items, bytes[] storage to) internal {
        for (uint256 i = 0; i < items.length; i++) {
            to.push(items[i]);
        }
    }

    function _one(bytes memory item) internal pure returns (bytes[] memory items) {
        items = new bytes[](1);
        items[0] = item;
    }

    function _flip(bytes memory data, uint256 at) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        out[at] = out[at] ^ 0x01;
    }

    /// The commitment as PortaldotVault.lock stores it, for a minter at `at` on chain `chainId`.
    function _commitment(uint256 chainId, address at, address recipient, uint256 amount, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(LOCK_TAG, V3_CHAIN_ID, VAULT, chainId, at, recipient, amount, nonce));
    }

    /// The burn id as the committee derives it (PortaldotVault.release).
    function _burnId(uint256 srcChainId, address srcMinter, uint256 burnNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(BURN_TAG, srcChainId, srcMinter, burnNonce));
    }
}

// ------------------------------------------------------------------ the suite, on a stub importer

/// The minter's rules on the real lock, with B taken as finalized by a stub (the capture holds no
/// finality proof for B; the live bundle test imports one through a real light client). The checks
/// the real state cannot reach (another word at a slot, a malformed account entry or child root)
/// run on synthetic state: tries of one node, at blocks the stub takes as finalized.
contract BridgeMinterTest is BridgeMinterFixture {
    StubImporter internal stub;

    function _importer() internal override returns (IGrandpaImporter) {
        stub = new StubImporter(genesis);
        assertEq(stub.know(header), blockHash);
        return stub;
    }

    // ------------------------------------------------------------------ deployment

    /// The pair as deployed: the minter at the address lock 0 names and the token at the address
    /// the minter's constructor was given, the immutables, the keys built on chain and the
    /// commitment of lock 0.
    function test_deployment() public view {
        assertEq(address(minter), vm.computeCreateAddress(DEPLOYER, 31));
        assertEq(address(token), vm.computeCreateAddress(DEPLOYER, 32));
        assertEq(address(minter.lightClient()), address(importer));
        assertEq(minter.vault(), VAULT);
        assertEq(minter.vaultChainId(), V3_CHAIN_ID);
        assertEq(minter.vaultCodeHash(), codeHash);
        assertEq(address(minter.token()), address(token));
        assertEq(token.minter(), address(minter));
        assertFalse(minter.bound());
        assertEq(minter.vaultTrieId(), bytes32(0));
        assertEq(minter.burnCount(), 0);
        assertEq(minter.LOCK_TAG(), LOCK_TAG);
        assertEq(minter.BURN_TAG(), BURN_TAG);
        assertEq(minter.COMMITMENTS_SLOT(), 0);

        assertEq(
            minter.accountInfoKey(), vm.parseJsonBytes(json, ".account.key.hex"), "AccountInfoOf key built on chain"
        );
        assertEq(
            bytes32(minter.accountInfoKey()),
            SubstrateProofs.storagePrefix("Revive", "AccountInfoOf"),
            "twox128(Revive) ++ twox128(AccountInfoOf)"
        );
        assertEq(minter.accountInfoKey(), rh.accountInfoKey(VAULT), "the key ReviveStorage.t.sol builds");
        assertEq(
            abi.encodePacked(minter.slotKeyOf(NONCE)),
            vm.parseJsonBytes(json, ".slot.key.hex"),
            "blake2_256(slot) built on chain"
        );
        assertEq(abi.encodePacked(minter.slotKeyOf(NONCE)), rh.slotKey(keccak256(abi.encode(NONCE, 0))));
        assertEq(minter.commitmentOf(RECIPIENT, AMOUNT, NONCE), commitment, "the captured word is lock 0's commitment");
        assertEq(
            minter.commitmentOf(RECIPIENT, AMOUNT, NONCE),
            _commitment(SEPOLIA_CHAIN_ID, MINTER, RECIPIENT, AMOUNT, NONCE),
            "the commitment as the vault computes it"
        );
        assertEq(commitment, LOCK0_COMMITMENT, "the commitment deployments/v3-testnet.json records for lock 0");
    }

    function test_constructor_rejectsZero() public {
        bytes4 zero = BridgeMinter.ZeroArgument.selector;
        IWrappedTPOT t = IWrappedTPOT(address(token));
        vm.expectRevert(zero);
        new BridgeMinter(IGrandpaImporter(address(0)), VAULT, V3_CHAIN_ID, codeHash, t);
        vm.expectRevert(zero);
        new BridgeMinter(importer, address(0), V3_CHAIN_ID, codeHash, t);
        vm.expectRevert(zero);
        new BridgeMinter(importer, VAULT, 0, codeHash, t);
        vm.expectRevert(zero);
        new BridgeMinter(importer, VAULT, V3_CHAIN_ID, bytes32(0), t);
        vm.expectRevert(zero);
        new BridgeMinter(importer, VAULT, V3_CHAIN_ID, codeHash, IWrappedTPOT(address(0)));
    }

    /// Nothing is payable, and there is no fallback.
    function test_noReceiveOrFallback() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(minter).call{value: 1}("");
        assertFalse(ok, "a plain value transfer reverts");
        (ok,) = address(minter).call("");
        assertFalse(ok, "an empty call reverts");
        (ok,) = address(minter).call(hex"deadbeef");
        assertFalse(ok, "an unknown selector reverts");
        assertEq(address(minter).balance, 0);
    }

    // ------------------------------------------------------------------ bind

    /// bindVault proves Revive.AccountInfoOf(vault) at B, checks the code hash and stores the trie
    /// id, the one the capture decoded and ReviveStorage.t.sol's decoder reads.
    function test_bindVault() public {
        vm.expectEmit(address(minter));
        emit BridgeMinter.VaultBound(VAULT, trieId, blockHash);
        _send(address(minter), "bindVault, AccountInfoOf proof", _bindCall(accountNodes));
        assertTrue(minter.bound());
        assertEq(minter.vaultTrieId(), trieId);
        assertEq(minter.vaultTrieId(), 0xbe307c2d11dbc9391cda93d17e9772542d1300c9af14e7431918fb49e2f47c3a);
        (bytes memory id, bytes32 hash) = rh.contractInfo(vm.parseJsonBytes(json, ".account.value.scale"));
        assertEq(bytes32(id), minter.vaultTrieId(), "the trie id the reference decoder reads");
        assertEq(hash, minter.vaultCodeHash(), "the code hash the reference decoder reads");
        assertEq(
            keccak256(vm.parseJsonBytes(json, ".code.hex")), minter.vaultCodeHash(), "keccak-256 of the vault's code"
        );
        assertEq(minter.vaultCodeHash(), VAULT_CODE_HASH, "the code hash deployments/v3-testnet.json records");
    }

    function test_bindVault_twice() public {
        _bind();
        _expectFail(_bindCall(accountNodes), abi.encodeWithSelector(BridgeMinter.VaultAlreadyBound.selector));
        assertEq(minter.vaultTrieId(), trieId);
    }

    /// A minter deployed for another code hash refuses the vault's entry.
    function test_bindVault_wrongCodeHash() public {
        BridgeMinter other = new BridgeMinter(importer, VAULT, V3_CHAIN_ID, codeHash ^ bytes32(uint256(1)), token);
        vm.expectRevert(abi.encodeWithSelector(BridgeMinter.VaultCodeMismatch.selector, codeHash));
        other.bindVault(blockHash, accountNodes);
        assertFalse(other.bound());
    }

    function test_bindVault_unknownBlock() public {
        bytes32 other = keccak256("not imported");
        _expectFail(
            abi.encodeCall(BridgeMinter.bindVault, (other, accountNodes)),
            abi.encodeWithSelector(GrandpaLightClient.UnknownBlock.selector, other)
        );
        assertFalse(minter.bound());
    }

    /// Changing any single byte of any item of the AccountInfoOf proof, the value item included,
    /// breaks the bind.
    function test_bindVault_everyByteFlipFails() public {
        assertEq(_everyByteFails(accountNodes, _bindCall), vm.parseJsonUint(json, ".account.proof.bytes"));
        assertFalse(minter.bound());
    }

    /// Only a 130-byte Contract entry with a 32-byte trie id binds: an EOA's entry, the vault's
    /// entry with the EOA variant, a byte short or long, or with a 31-byte trie id, each proven in
    /// a synthetic state, revert NotAContract. The vault's real entry in the same construction
    /// binds.
    function test_bindVault_notAContract() public {
        bytes memory real = vm.parseJsonBytes(json, ".account.value.scale");
        // AccountType::EOA (variant 1), then AccountInfo.dust (u32).
        _expectBindFails(hex"0100000000", 5, 1);
        bytes memory eoa = bytes.concat(real);
        eoa[0] = 0x01;
        _expectBindFails(eoa, 130, 1);
        _expectBindFails(_cut(real, 1), 129, 0);
        _expectBindFails(bytes.concat(real, hex"00"), 131, 0);
        bytes memory shortId = bytes.concat(real);
        shortId[1] = 0x7c; // compact 31
        _expectBindFails(shortId, 130, 0);
        assertFalse(minter.bound());

        bytes memory leaf = _leaf(minter.accountInfoKey(), real);
        minter.bindVault(_syntheticBlock(leaf), _one(leaf));
        assertEq(minter.vaultTrieId(), trieId, "the synthetic state is read like the real one");
    }

    // ------------------------------------------------------------------ mint

    /// mint proves commitments[0] under the bound trie id and credits exactly the lock's amount to
    /// its recipient, once.
    function test_mint() public {
        _bind();
        vm.expectEmit(address(token));
        emit WrappedTPOT.Transfer(address(0), RECIPIENT, AMOUNT);
        vm.expectEmit(address(minter));
        emit BridgeMinter.Minted(NONCE, RECIPIENT, AMOUNT, blockHash);
        _send(address(minter), "mint, child root + slot proofs", _mintCall(p));
        assertTrue(minter.used(NONCE));
        assertEq(token.balanceOf(RECIPIENT), AMOUNT, "100000000000000 wtPOT: 1 tPOT in native base units");
        assertEq(token.totalSupply(), AMOUNT);
    }

    /// Anyone can submit the lock's proof, and it mints to the lock's recipient whoever sends it; a
    /// copy of the transaction from another sender then reverts on the nonce.
    function test_mint_byAnyone() public {
        _bind();
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        minter.mint(p);
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
        assertEq(token.balanceOf(anyone), 0, "nothing for the sender");
        vm.prank(RECIPIENT);
        vm.expectRevert(abi.encodeWithSelector(BridgeMinter.NonceAlreadyUsed.selector, NONCE));
        minter.mint(p);
        assertEq(token.totalSupply(), AMOUNT);
    }

    function test_mint_beforeBind() public {
        _expectFail(_mintCall(p), abi.encodeWithSelector(BridgeMinter.VaultNotBound.selector));
        assertEq(token.totalSupply(), 0);
    }

    function test_mint_replay() public {
        _bind();
        minter.mint(p);
        _expectFail(_mintCall(p), abi.encodeWithSelector(BridgeMinter.NonceAlreadyUsed.selector, NONCE));
        assertEq(token.balanceOf(RECIPIENT), AMOUNT, "minted once");
    }

    /// The proof is checked before the replay guard: after the mint, a copy with a tampered proof
    /// or another amount reverts with the proof or commitment error, not with NonceAlreadyUsed.
    function test_mint_proofBeforeReplayGuard() public {
        _bind();
        minter.mint(p);
        bytes[] memory bad = childNodes;
        bad[0] = _flip(childNodes[0], childNodes[0].length / 2);
        _expectFail(_withSlot(bad), INCOMPLETE);
        BridgeMinter.LockProof memory q = p;
        q.amount = AMOUNT + 1;
        _expectFail(
            _mintCall(q),
            abi.encodeWithSelector(
                BridgeMinter.CommitmentMismatch.selector, minter.commitmentOf(RECIPIENT, AMOUNT + 1, NONCE), commitment
            )
        );
    }

    function test_mint_zeroAmount() public {
        _bind();
        BridgeMinter.LockProof memory q = p;
        q.amount = 0;
        _expectFail(_mintCall(q), abi.encodeWithSelector(BridgeMinter.ZeroAmount.selector));
    }

    function test_mint_unknownBlock() public {
        _bind();
        BridgeMinter.LockProof memory q = p;
        q.blockHash = keccak256("not imported");
        _expectFail(_mintCall(q), abi.encodeWithSelector(GrandpaLightClient.UnknownBlock.selector, q.blockHash));
        assertFalse(minter.used(NONCE));
    }

    /// Another recipient or amount gives another commitment than the proven word.
    function test_mint_wrongRecipientOrAmount() public {
        _bind();
        BridgeMinter.LockProof memory q = p;
        q.recipient = address(0xB0B);
        _expectFail(
            _mintCall(q),
            abi.encodeWithSelector(
                BridgeMinter.CommitmentMismatch.selector, minter.commitmentOf(address(0xB0B), AMOUNT, NONCE), commitment
            )
        );
        q = p;
        q.amount = AMOUNT * 2;
        _expectFail(
            _mintCall(q),
            abi.encodeWithSelector(
                BridgeMinter.CommitmentMismatch.selector, minter.commitmentOf(RECIPIENT, AMOUNT * 2, NONCE), commitment
            )
        );
        assertFalse(minter.used(NONCE));
        assertEq(token.totalSupply(), 0);
    }

    /// The nonce names the slot, so with the captured proof another nonce is another key, which
    /// the proof does not hold: the walk shows it absent, or needs an item the proof lacks.
    function test_mint_otherNonce_isAnotherSlot() public {
        _bind();
        BridgeMinter.LockProof memory q = p;
        q.nonce = 1;
        (bool ok, bytes memory ret) = address(minter).call(_mintCall(q));
        assertFalse(ok, "lock 1 is not proven");
        _assertProofError(ret, childRoot, abi.encodePacked(minter.slotKeyOf(1)));
        assertFalse(minter.used(1));
    }

    /// The nonce is in the commitment as well: a vault state that holds lock 0's word at
    /// commitments[1] does not mint lock 1, and one that holds lock 1's word at commitments[0] does
    /// not mint lock 0. With lock 1's word at commitments[1], lock 1 mints.
    function test_mint_wrongNonce() public {
        _bind();
        bytes32 lock1 = minter.commitmentOf(RECIPIENT, AMOUNT, 1);
        _expectFail(
            _mintCall(_synthetic(1, abi.encodePacked(commitment), RECIPIENT, AMOUNT, 1)),
            abi.encodeWithSelector(BridgeMinter.CommitmentMismatch.selector, lock1, commitment)
        );
        _expectFail(
            _mintCall(_synthetic(0, abi.encodePacked(lock1), RECIPIENT, AMOUNT, 0)),
            abi.encodeWithSelector(BridgeMinter.CommitmentMismatch.selector, commitment, lock1)
        );
        assertFalse(minter.used(0));
        assertFalse(minter.used(1));
        minter.mint(_synthetic(1, abi.encodePacked(lock1), RECIPIENT, AMOUNT, 1));
        assertTrue(minter.used(1));
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    /// The commitment names the minter: the same lock at a minter at another address does not mint.
    function test_mint_otherMinterAddress() public {
        BridgeMinter other = new BridgeMinter(importer, VAULT, V3_CHAIN_ID, codeHash, token);
        assertTrue(address(other) != MINTER);
        other.bindVault(blockHash, accountNodes);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeMinter.CommitmentMismatch.selector,
                _commitment(SEPOLIA_CHAIN_ID, address(other), RECIPIENT, AMOUNT, NONCE),
                commitment
            )
        );
        other.mint(p);
    }

    /// The commitment names the chain: the same minter on another chain does not mint.
    function test_mint_otherChainId() public {
        _bind();
        vm.chainId(1);
        _expectFail(
            _mintCall(p),
            abi.encodeWithSelector(
                BridgeMinter.CommitmentMismatch.selector, _commitment(1, MINTER, RECIPIENT, AMOUNT, NONCE), commitment
            )
        );
        vm.chainId(SEPOLIA_CHAIN_ID);
        minter.mint(p);
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    /// The proven value has to be one 32-byte word: a slot holding 31 or 33 bytes reverts.
    function test_mint_commitmentLength() public {
        _bind();
        bytes memory word = abi.encodePacked(commitment);
        _expectFail(
            _mintCall(_synthetic(0, _cut(word, 1), RECIPIENT, AMOUNT, 0)),
            abi.encodeWithSelector(BridgeMinter.CommitmentLength.selector, 31)
        );
        _expectFail(
            _mintCall(_synthetic(0, bytes.concat(word, hex"00"), RECIPIENT, AMOUNT, 0)),
            abi.encodeWithSelector(BridgeMinter.CommitmentLength.selector, 33)
        );
        assertFalse(minter.used(0));
    }

    /// The child-trie root read from the main trie has to be 32 bytes and not zero, as
    /// SubstrateProofs.childRootOf requires. The real root in the same construction, with the
    /// captured child proof, mints lock 0.
    function test_mint_childRootChecks() public {
        _bind();
        _expectFail(
            _mintCall(_syntheticRoot(_cut(abi.encodePacked(childRoot), 1))),
            abi.encodeWithSelector(SubstrateProofs.ChildRootLength.selector, 31)
        );
        _expectFail(
            _mintCall(_syntheticRoot(bytes.concat(abi.encodePacked(childRoot), hex"00"))),
            abi.encodeWithSelector(SubstrateProofs.ChildRootLength.selector, 33)
        );
        _expectFail(
            _mintCall(_syntheticRoot(new bytes(32))), abi.encodeWithSelector(SubstrateProofs.ZeroChildRoot.selector)
        );
        assertFalse(minter.used(NONCE));
        minter.mint(_syntheticRoot(abi.encodePacked(childRoot)));
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    function testFuzz_commitmentOf(address recipient, uint256 amount, uint256 nonce) public view {
        assertEq(
            minter.commitmentOf(recipient, amount, nonce),
            keccak256(abi.encode(LOCK_TAG, V3_CHAIN_ID, VAULT, SEPOLIA_CHAIN_ID, MINTER, recipient, amount, nonce))
        );
    }

    /// Every other recipient or amount for lock 0 is refused with the commitment it would need.
    function testFuzz_mint_rejectsOtherRecipientOrAmount(address recipient, uint256 amount) public {
        vm.assume(amount != 0);
        vm.assume(recipient != RECIPIENT || amount != AMOUNT);
        _bind();
        BridgeMinter.LockProof memory q = p;
        q.recipient = recipient;
        q.amount = amount;
        _expectFail(
            _mintCall(q),
            abi.encodeWithSelector(
                BridgeMinter.CommitmentMismatch.selector, minter.commitmentOf(recipient, amount, NONCE), commitment
            )
        );
        assertFalse(minter.used(NONCE));
    }

    /// Any lock the vault could hold: with commitmentOf(recipient, amount, nonce) at
    /// commitments[nonce] of a synthetic vault state, exactly that lock mints, once. The same proof
    /// with another recipient reverts CommitmentMismatch, and with another nonce it proves nothing.
    function testFuzz_mint_anyLock(address recipient, uint256 amount, uint256 nonce) public {
        vm.assume(recipient != address(0));
        amount = bound(amount, 1, type(uint256).max);
        _bind();
        bytes32 word = minter.commitmentOf(recipient, amount, nonce);
        BridgeMinter.LockProof memory q = _synthetic(nonce, abi.encodePacked(word), recipient, amount, nonce);

        BridgeMinter.LockProof memory other = _synthetic(nonce, abi.encodePacked(word), recipient, amount, nonce);
        other.recipient = address(uint160(recipient) ^ 1);
        _expectFail(
            _mintCall(other),
            abi.encodeWithSelector(
                BridgeMinter.CommitmentMismatch.selector, minter.commitmentOf(other.recipient, amount, nonce), word
            )
        );
        other.recipient = recipient;
        unchecked {
            other.nonce = nonce + 1;
        }
        bytes32 root = SubstrateProofs.blake2_256(q.slotProof[0]);
        _expectFail(
            _mintCall(other),
            abi.encodeWithSelector(
                SubstrateProofs.KeyNotPresent.selector, root, abi.encodePacked(minter.slotKeyOf(other.nonce))
            )
        );

        vm.expectEmit(address(minter));
        emit BridgeMinter.Minted(nonce, recipient, amount, q.blockHash);
        minter.mint(q);
        assertTrue(minter.used(nonce));
        assertEq(token.balanceOf(recipient), amount);
        assertEq(token.totalSupply(), amount);
        _expectFail(_mintCall(q), abi.encodeWithSelector(BridgeMinter.NonceAlreadyUsed.selector, nonce));
    }

    /// Changing any single byte of any item of the child-root proof breaks the mint.
    function test_childRootProof_everyByteFlipFails() public {
        _bind();
        assertEq(_everyByteFails(rootNodes, _withChildRoot), vm.parseJsonUint(json, ".childRoot.proof.bytes"));
        assertFalse(minter.used(NONCE));
    }

    /// The same for every byte of the child proof.
    function test_slotProof_everyByteFlipFails() public {
        _bind();
        assertEq(_everyByteFails(childNodes, _withSlot), vm.parseJsonUint(json, ".slot.proof.bytes"));
        assertFalse(minter.used(NONCE));
    }

    /// Leaving out any one item of any of the three proofs fails, as does swapping the two mint
    /// proofs.
    function test_droppedOrSwappedItemsFail() public {
        _droppedItemFails(accountNodes, _bindCall);
        _bind();
        _droppedItemFails(rootNodes, _withChildRoot);
        _droppedItemFails(childNodes, _withSlot);
        BridgeMinter.LockProof memory q = p;
        (q.childRootProof, q.slotProof) = (p.slotProof, p.childRootProof);
        _expectFail(_mintCall(q), INCOMPLETE);
        assertFalse(minter.used(NONCE));
    }

    // ------------------------------------------------------------------ importAndMint

    /// One call on a fresh minter: the import (B is known to the stub), the bind from the account
    /// proof and the mint.
    function test_importAndMint_bindsAndMints() public {
        assertFalse(minter.bound());
        vm.expectEmit(address(minter));
        emit BridgeMinter.VaultBound(VAULT, trieId, blockHash);
        vm.expectEmit(address(token));
        emit WrappedTPOT.Transfer(address(0), RECIPIENT, AMOUNT);
        vm.expectEmit(address(minter));
        emit BridgeMinter.Minted(NONCE, RECIPIENT, AMOUNT, blockHash);
        _send(address(minter), "importAndMint on the stub (bind + mint, no signatures)", _importAndMintCall(header, p));
        assertEq(minter.vaultTrieId(), trieId);
        assertTrue(minter.used(NONCE));
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    /// Once bound, importAndMint only imports and mints; the account proof is not read.
    function test_importAndMint_whenBound() public {
        _bind();
        BridgeMinter.LockProof memory q = p;
        q.accountProof = new bytes[](0);
        vm.recordLogs();
        minter.importAndMint(header, "", "", q);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "Transfer and Minted only");
        assertEq(logs[0].emitter, address(token));
        assertEq(logs[1].emitter, address(minter));
        assertEq(logs[1].topics[0], BridgeMinter.Minted.selector);
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    /// While the minter is not bound, importAndMint binds from p.accountProof, so the mint needs
    /// it.
    function test_importAndMint_unboundNeedsTheAccountProof() public {
        BridgeMinter.LockProof memory q = p;
        q.accountProof = new bytes[](0);
        _expectFail(_importAndMintCall(header, q), abi.encodeWithSelector(SubstrateProofs.EmptyProof.selector));
        q.accountProof = p.slotProof;
        _expectFail(_importAndMintCall(header, q), INCOMPLETE);
        assertFalse(minter.bound());
        assertEq(token.totalSupply(), 0);
    }

    function test_importAndMint_blockMismatch() public {
        BridgeMinter.LockProof memory q = p;
        q.blockHash = keccak256("another block");
        _expectFail(
            _importAndMintCall(header, q),
            abi.encodeWithSelector(BridgeMinter.BlockMismatch.selector, q.blockHash, blockHash)
        );
        assertFalse(minter.bound());
    }

    /// A header the importer does not accept stops the call before any proof is read.
    function test_importAndMint_rejectedHeader() public {
        bytes memory bad = _flip(header, 40); // inside the state root
        _expectFail(
            _importAndMintCall(bad, p),
            abi.encodeWithSelector(GrandpaLightClient.UnknownBlock.selector, Header.hash(bad))
        );
        assertFalse(minter.bound());
    }

    // ------------------------------------------------------------------ burn (trusted return path)

    /// burn takes the units from the caller and emits the burn id the committee releases against:
    /// the vault's convention, keccak256(abi.encode(BURN_TAG, srcChainId, srcMinter, burnNonce)).
    function test_burn() public {
        _bind();
        minter.mint(p);
        address v3Recipient = address(0xB0B);
        bytes32 burnId = _burnId(SEPOLIA_CHAIN_ID, MINTER, 0);
        assertEq(minter.burnIdOf(0), burnId);
        vm.prank(RECIPIENT);
        vm.expectEmit(address(token));
        emit WrappedTPOT.Transfer(RECIPIENT, address(0), AMOUNT / 4);
        vm.expectEmit(address(minter));
        emit BridgeMinter.BurnRequested(0, RECIPIENT, v3Recipient, AMOUNT / 4, burnId);
        uint256 burnNonce = minter.burn(AMOUNT / 4, v3Recipient);
        assertEq(burnNonce, 0);
        assertEq(minter.burnCount(), 1);
        assertEq(token.balanceOf(RECIPIENT), AMOUNT - AMOUNT / 4);
        assertEq(token.totalSupply(), AMOUNT - AMOUNT / 4);

        vm.prank(RECIPIENT);
        assertEq(minter.burn(1, v3Recipient), 1, "burn nonces count up");
        assertEq(minter.burnIdOf(1), _burnId(SEPOLIA_CHAIN_ID, MINTER, 1));
        assertEq(minter.burnCount(), 2);
    }

    /// The burn id names this chain and this minter: another chain or minter gives another id.
    function test_burnId_namesChainAndMinter() public {
        bytes32 id = minter.burnIdOf(7);
        BridgeMinter other = new BridgeMinter(importer, VAULT, V3_CHAIN_ID, codeHash, token);
        assertTrue(other.burnIdOf(7) != id, "minter");
        vm.chainId(1);
        assertTrue(minter.burnIdOf(7) != id, "chain");
    }

    function test_burn_moreThanBalance() public {
        _bind();
        minter.mint(p);
        vm.prank(RECIPIENT);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientBalance.selector, AMOUNT, AMOUNT + 1));
        minter.burn(AMOUNT + 1, address(0xB0B));
        vm.prank(address(0xB0B));
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientBalance.selector, 0, 1));
        minter.burn(1, address(0xB0B));
        assertEq(minter.burnCount(), 0, "a failed burn takes no nonce");
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    function test_burn_zero() public {
        _bind();
        minter.mint(p);
        vm.prank(RECIPIENT);
        vm.expectRevert(BridgeMinter.ZeroAmount.selector);
        minter.burn(0, address(0xB0B));
        vm.prank(RECIPIENT);
        vm.expectRevert(BridgeMinter.ZeroRecipient.selector);
        minter.burn(1, address(0));
        assertEq(minter.burnCount(), 0);
    }

    /// A burn needs no allowance: the token burns for the minter from the minter's caller only.
    function test_burn_withoutAllowance() public {
        _bind();
        minter.mint(p);
        assertEq(token.allowance(RECIPIENT, address(minter)), 0);
        vm.prank(RECIPIENT);
        minter.burn(AMOUNT, address(0xB0B));
        assertEq(token.balanceOf(RECIPIENT), 0);
        assertEq(token.totalSupply(), 0);
    }

    // ------------------------------------------------------------------ storage layout

    /// Slots 0 to 2: the trie id, the used mapping (entry nonce at keccak256(abi.encode(nonce, 1)))
    /// and the burn count. The mint tool reads them through the getters.
    function test_storageLayout() public {
        _bind();
        minter.mint(p);
        vm.prank(RECIPIENT);
        minter.burn(1, address(0xB0B));
        assertEq(vm.load(address(minter), bytes32(uint256(0))), trieId, "slot 0: vaultTrieId");
        assertEq(vm.load(address(minter), bytes32(uint256(1))), bytes32(0), "a mapping's own slot stays empty");
        assertEq(vm.load(address(minter), keccak256(abi.encode(NONCE, 1))), bytes32(uint256(1)), "used[0]");
        assertEq(vm.load(address(minter), keccak256(abi.encode(uint256(1), 1))), bytes32(0), "used[1]");
        assertEq(vm.load(address(minter), bytes32(uint256(2))), bytes32(uint256(1)), "slot 2: burnCount");
    }

    // ------------------------------------------------------------------ synthetic state

    /// A trie of one node: a leaf whose partial key is all of `key`, with `value` inline (the walk
    /// reads an inline value of any length, as in trie V0). Its root is blake2_256 of the node.
    function _leaf(bytes memory key, bytes memory value) internal pure returns (bytes memory) {
        uint256 nibbles = 2 * key.length;
        bytes memory head;
        if (nibbles < 63) {
            head = abi.encodePacked(uint8(0x40 | nibbles));
        } else {
            // Leaf prefix 0b01 with 63 in the low bits, then the rest of the count in bytes of at
            // most 255.
            head = hex"7f";
            uint256 rest = nibbles - 63;
            for (; rest >= 255; rest -= 255) {
                head = bytes.concat(head, hex"ff");
            }
            head = bytes.concat(head, abi.encodePacked(uint8(rest)));
        }
        return bytes.concat(head, key, _compact(value.length), value);
    }

    /// A block the stub takes as finalized, whose state is the trie of one node `leaf`.
    function _syntheticBlock(bytes memory leaf) internal returns (bytes32 hash) {
        hash = keccak256(abi.encode("synthetic block", leaf));
        stub.put(hash, SubstrateProofs.blake2_256(leaf));
    }

    /// Lock 0's proof at a synthetic block whose main trie holds only `rootValue` at the key of the
    /// bound vault's child-trie root; the slot proof is the captured one.
    function _syntheticRoot(bytes memory rootValue) internal returns (BridgeMinter.LockProof memory q) {
        bytes memory leaf = _leaf(SubstrateProofs.childRootKey(abi.encodePacked(minter.vaultTrieId())), rootValue);
        q = p;
        q.blockHash = _syntheticBlock(leaf);
        q.childRootProof = _one(leaf);
    }

    /// Lock `nonce` of `amount` for `recipient`, proven at a synthetic block whose vault child trie
    /// holds only `word` at commitments[slotNonce].
    function _synthetic(uint256 slotNonce, bytes memory word, address recipient, uint256 amount, uint256 nonce)
        internal
        returns (BridgeMinter.LockProof memory q)
    {
        bytes memory slotLeaf = _leaf(abi.encodePacked(minter.slotKeyOf(slotNonce)), word);
        q = _syntheticRoot(abi.encodePacked(SubstrateProofs.blake2_256(slotLeaf)));
        q.slotProof = _one(slotLeaf);
        q.recipient = recipient;
        q.amount = amount;
        q.nonce = nonce;
    }

    /// bindVault on a synthetic state holding `value` as the vault's AccountInfoOf entry reverts
    /// NotAContract(length, variant).
    function _expectBindFails(bytes memory value, uint256 length, uint8 variant) internal {
        bytes memory leaf = _leaf(minter.accountInfoKey(), value);
        _expectFail(
            abi.encodeCall(BridgeMinter.bindVault, (_syntheticBlock(leaf), _one(leaf))),
            abi.encodeWithSelector(BridgeMinter.NotAContract.selector, length, variant)
        );
    }
}

// ------------------------------------------------------------------ on a real light client

/// The same minter on a GrandpaLightClient that holds B as its checkpoint (set 28; the keys are the
/// testnet's two as fixtures/v3-testnet captured them, which no signature is checked against here).
/// B is taken as finalized by initialize; the state root the client stores for it is what
/// bindVault and mint read, with the client's own gas. The import of a finality proof is the live
/// bundle test's.
contract BridgeMinterCheckpointedClientTest is BridgeMinterFixture {
    GrandpaLightClient internal lc;

    function _importer() internal override returns (IGrandpaImporter) {
        string memory as_ = _json("../fixtures/v3-testnet", "authority-set");
        string memory path = ".authoritySet.authorities";
        bytes32[] memory keys = new bytes32[](_count(as_, path));
        for (uint256 i = 0; i < keys.length; i++) {
            keys[i] = vm.parseJsonBytes32(as_, _at(path, i, ".id"));
        }
        lc = new GrandpaLightClient();
        lc.initialize(genesis, uint64(vm.parseJsonUint(json, ".provenance.setId")), keys, header);
        (bytes32 root, uint32 number) = lc.stateRootOf(blockHash);
        assertEq(root, stateRoot, "the client holds B's state root");
        assertEq(number, blockNumber);
        return IGrandpaImporter(address(lc));
    }

    /// The minter's interface to the light client (declared on its own) has the client's selectors.
    function test_importerInterface_isTheClients() public pure {
        assertEq(IGrandpaImporter.stateRootOf.selector, GrandpaLightClient.stateRootOf.selector);
        assertEq(IGrandpaImporter.genesisHash.selector, GrandpaLightClient.genesisHash.selector);
        assertEq(IGrandpaImporter.importFinalityProof.selector, GrandpaLightClient.importFinalityProof.selector);
    }

    /// bindVault and mint as transactions against the client: the gas a Sepolia mint pays after the
    /// header is imported.
    function test_bindAndMint_onTheClient() public {
        _send(address(minter), "v3-testnet-vault: bindVault on the light client", _bindCall(accountNodes));
        assertEq(minter.vaultTrieId(), trieId);
        vm.expectEmit(address(minter));
        emit BridgeMinter.Minted(NONCE, RECIPIENT, AMOUNT, blockHash);
        _send(address(minter), "v3-testnet-vault: mint on the light client", _mintCall(p));
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
        _expectFail(_mintCall(p), abi.encodeWithSelector(BridgeMinter.NonceAlreadyUsed.selector, NONCE));
    }

    /// A block the client has not imported reverts with its UnknownBlock, for the bind and the
    /// mint.
    function test_unknownBlock_fromTheClient() public {
        bytes32 other = keccak256("not imported");
        assertFalse(lc.isImported(other));
        _expectFail(
            abi.encodeCall(BridgeMinter.bindVault, (other, accountNodes)),
            abi.encodeWithSelector(GrandpaLightClient.UnknownBlock.selector, other)
        );
        _bind();
        BridgeMinter.LockProof memory q = p;
        q.blockHash = other;
        _expectFail(_mintCall(q), abi.encodeWithSelector(GrandpaLightClient.UnknownBlock.selector, other));
    }

    /// importAndMint needs a finality proof the client accepts: without one nothing is bound or
    /// minted.
    function test_importAndMint_needsAFinalityProof() public {
        (bool ok,) = address(minter).call{gas: TX_GAS_CAP}(_importAndMintCall(header, p));
        assertFalse(ok, "an empty finality proof does not import");
        assertFalse(minter.bound());
        assertEq(token.totalSupply(), 0);
    }
}
