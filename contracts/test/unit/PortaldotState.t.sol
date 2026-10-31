// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {IFinalizedStateRoots} from "../../src/kit/IFinalizedStateRoots.sol";
import {IPortaldotStateReader} from "../../src/kit/IPortaldotStateReader.sol";
import {PortaldotState} from "../../src/kit/PortaldotState.sol";
import {PortaldotStateReader} from "../../src/kit/PortaldotStateReader.sol";
import {SubstrateProofs} from "../../src/trie/SubstrateProofs.sol";
import {LightClientBase} from "./LightClient.t.sol";

/// PortaldotState's keys and decoders as external functions, so that their reverts can be
/// expected.
contract PortaldotStateHarness {
    function systemAccountKey(bytes32 accountId) external view returns (bytes memory) {
        return PortaldotState.systemAccountKey(accountId);
    }

    function assetsAccountKey(uint32 assetId, bytes32 accountId) external view returns (bytes memory) {
        return PortaldotState.assetsAccountKey(assetId, accountId);
    }

    function nftsItemKey(uint32 collection, uint32 item) external view returns (bytes memory) {
        return PortaldotState.nftsItemKey(collection, item);
    }

    function reviveAccountInfoKey(address account) external pure returns (bytes memory) {
        return PortaldotState.reviveAccountInfoKey(account);
    }

    function reviveSlotKey(bytes32 slot) external view returns (bytes32) {
        return PortaldotState.reviveSlotKey(slot);
    }

    function mappingSlot(uint256 key, uint256 slot) external pure returns (bytes32) {
        return PortaldotState.mappingSlot(key, slot);
    }

    function ethAccountId(address account) external pure returns (bytes32) {
        return PortaldotState.ethAccountId(account);
    }

    function decodeAccountInfo(bytes calldata value) external pure returns (IPortaldotStateReader.AccountInfo memory) {
        return PortaldotState.decodeAccountInfo(value);
    }

    function decodeAssetAccount(bytes calldata value) external pure returns (uint128 balance, uint8 status) {
        return PortaldotState.decodeAssetAccount(value);
    }

    function decodeNftOwner(bytes calldata value) external pure returns (bytes32) {
        return PortaldotState.decodeNftOwner(value);
    }

    function decodeContractInfo(bytes calldata value) external pure returns (bytes32 trieId, bytes32 codeHash) {
        return PortaldotState.decodeContractInfo(value);
    }

    function decodeSlot(bytes calldata value) external pure returns (bytes32) {
        return PortaldotState.decodeSlot(value);
    }

    function freeBalanceAt(IFinalizedStateRoots lc, bytes32 blockHash, bytes32 accountId, bytes[] calldata proof)
        external
        view
        returns (uint128 free, uint32 number)
    {
        return PortaldotState.freeBalanceAt(lc, blockHash, accountId, proof);
    }
}

/// A light client that holds one block with a state root of the test's making, for the walk's cases
/// that the fixture's proofs do not reach.
contract OneBlockRoots is IFinalizedStateRoots {
    error UnknownBlock(bytes32 blockHash);

    bytes32 internal immutable blockHash_;
    bytes32 internal immutable stateRoot_;

    constructor(bytes32 blockHash, bytes32 stateRoot) {
        blockHash_ = blockHash;
        stateRoot_ = stateRoot;
    }

    function stateRootOf(bytes32 blockHash) external view returns (bytes32, uint32) {
        if (blockHash != blockHash_) revert UnknownBlock(blockHash);
        return (stateRoot_, 1);
    }

    function genesisHash() external pure returns (bytes32) {
        return bytes32(0);
    }
}

/// The consumer docs/PROOF-KIT.md ("Absent values") gives for a slot that may be empty: the
/// contract's code pinned with contractInfo first, then the slot read with childSlot and that trie
/// id, and only childSlot's KeyNotPresent read as zero. contractSlot cannot do this: its
/// KeyNotPresent may also come from an address with no contract, or a contract that has stored
/// nothing, and then it returns no code hash to pin.
contract PinnedSlotOrZero {
    IPortaldotStateReader internal immutable reader;
    address internal immutable target;
    bytes32 internal immutable codeHash;

    error WrongCode(bytes32 found);

    constructor(IPortaldotStateReader reader_, address target_, bytes32 codeHash_) {
        reader = reader_;
        target = target_;
        codeHash = codeHash_;
    }

    function slotOrZero(
        bytes32 blockHash,
        bytes32 slot,
        bytes[] calldata accountProof,
        bytes[] calldata childRootProof,
        bytes[] calldata slotProof
    ) external view returns (bytes32 word) {
        (bytes32 trieId, bytes32 code,) = reader.contractInfo(blockHash, target, accountProof);
        if (code != codeHash) revert WrongCode(code);
        try reader.childSlot(blockHash, trieId, slot, childRootProof, slotProof) returns (bytes32 w, uint32) {
            word = w;
        } catch (bytes memory reason) {
            if (bytes4(reason) != IPortaldotStateReader.KeyNotPresent.selector) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
    }
}

/// The proof kit's reads at V3 block B (#264,729) from fixtures/v3-testnet-kit, written by npm run
/// kit -- capture and checked again offline by npm run kit -- check. The light client is a real
/// GrandpaLightClient, initialized at set 73 with B's parent as the checkpoint, that imports B with
/// its GRANDPA finality proof (2 of 2) as GrandpaLightClient #2 on Sepolia did on Oct 31; B carries
/// the change to set 74. A PortaldotStateReader on top of it makes every read: the light client's
/// state root of B, the walk in the linked StorageProofs, the decoder.
contract PortaldotStateTest is LightClientBase {
    string internal constant DIR = "../fixtures/v3-testnet-kit";

    uint32 internal constant B_NUMBER = 264_729;
    bytes32 internal constant B = 0x6dc44fe16f3e36c49978c422cc11550971f4b3234f9ca23dbac9b99bb0556f50;
    bytes32 internal constant STATE_ROOT = 0x9b0ab2c32f5a4f7aa22c50788457b17b1ed262e51e0714f243b220f0c8695aaa;
    address internal constant DEPLOYER = 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071;
    address internal constant OWNER_WALLET = 0xc6e997A757F0be410714eD04B869EFA1aEE32011;
    address internal constant HOLDER = 0x3E79403610c21de20144960A0694b578EBc0dcDF;
    address internal constant VAULT = 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd;
    /// An address with no Revive.AccountInfoOf entry at B: read 15's proof, of 0x0000...0001's entry,
    /// holds every node on its key's path and shows the key absent.
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 internal constant VAULT_CODE_HASH = 0xa72553f50cdf645fb343b2cf089e431a1b26fb07e80f4e2236d55bf9811c663f;
    bytes32 internal constant TRIE_ID = 0xbe307c2d11dbc9391cda93d17e9772542d1300c9af14e7431918fb49e2f47c3a;
    bytes32 internal constant CHILD_ROOT = 0x6d322d0f1a20b6bace63db43c37fcff7288c5c263d7d658990454bffe706db6f;
    /// Lock 1's commitment, which BridgeMinter.commitmentOf(deployer, 10^14, 1) computes on Sepolia.
    bytes32 internal constant LOCK1_COMMITMENT = 0x2d1ab009f006fd70b9653d09a56a3b4927775d6251c4879df9c7a1364b0ad0a7;
    string internal constant INCOMPLETE = "Incomplete Proof!";

    string internal json;
    bytes32 internal parentHash;
    PortaldotStateReader internal reader;
    PortaldotStateHarness internal kit;
    bytes32[] internal keys;

    function setUp() public override {
        super.setUp();
        json = _json(DIR, "state-reads");
        assertEq(vm.parseJsonString(json, ".kind"), "state-reads");
        assertEq(vm.parseJsonBytes32(json, ".header.hash"), B);
        uint64 setId = uint64(vm.parseJsonUint(json, ".signingSet.setId"));
        assertEq(setId, 73, "set 73 signs B");
        _keys(json, ".signingSet.authorities", keys);
        bytes memory parent = vm.parseJsonBytes(json, ".parentHeader.scale");
        parentHash = vm.parseJsonBytes32(json, ".parentHeader.hash");
        lc.initialize(vm.parseJsonBytes32(json, ".provenance.genesisHash"), setId, keys, parent);
        bytes32 imported = lc.importFinalityProof(
            vm.parseJsonBytes(json, ".header.scale"),
            vm.parseJsonBytes(json, ".finalityProof.scale"),
            vm.parseJsonBytes(json, ".signers.hint")
        );
        assertEq(imported, B);
        reader = new PortaldotStateReader(IFinalizedStateRoots(address(lc)));
        kit = new PortaldotStateHarness();
    }

    // ------------------------------------------------------------------ the block

    /// The client holds B with the state root its header names, finalized by set 73, and has
    /// enacted set 74; the Reader answers the same root and number.
    function test_lightClientHoldsB() public view {
        (bytes32 root, uint32 number) = lc.stateRootOf(B);
        assertEq(root, STATE_ROOT);
        assertEq(number, B_NUMBER);
        assertEq(root, vm.parseJsonBytes32(json, ".header.stateRoot"));
        assertEq(root, vm.parseJsonBytes32(json, ".lightClient.stateRootOf.stateRoot"), "as GrandpaLightClient #2 answered");
        assertEq(lc.headerOf(B).setId, 73);
        assertEq(lc.currentSetId(), 74, "B enacts set 74");
        (bytes32 readerRoot, uint32 readerNumber) = reader.stateRootOf(B);
        assertEq(readerRoot, STATE_ROOT);
        assertEq(readerNumber, B_NUMBER);
        assertEq(address(reader.lightClient()), address(lc));
    }

    function test_constructor_zeroLightClient() public {
        vm.expectRevert(IPortaldotStateReader.ZeroLightClient.selector);
        new PortaldotStateReader(IFinalizedStateRoots(address(0)));
    }

    /// The Reader is the interface a consumer compiles: same functions, same selectors.
    function test_interfaceSelectors() public pure {
        assertEq(PortaldotStateReader.accountInfo.selector, IPortaldotStateReader.accountInfo.selector);
        assertEq(PortaldotStateReader.assetAccount.selector, bytes4(keccak256("assetAccount(bytes32,uint32,bytes32,bytes[])")));
        assertEq(PortaldotStateReader.nftOwner.selector, bytes4(keccak256("nftOwner(bytes32,uint32,uint32,bytes[])")));
        assertEq(PortaldotStateReader.contractInfo.selector, bytes4(keccak256("contractInfo(bytes32,address,bytes[])")));
        assertEq(
            PortaldotStateReader.contractSlot.selector,
            bytes4(keccak256("contractSlot(bytes32,address,bytes32,(bytes[],bytes[],bytes[]))"))
        );
        assertEq(PortaldotStateReader.childSlot.selector, bytes4(keccak256("childSlot(bytes32,bytes32,bytes32,bytes[],bytes[])")));
        assertEq(PortaldotStateReader.readMain.selector, bytes4(keccak256("readMain(bytes32,bytes,bytes[])")));
        assertEq(PortaldotStateReader.accountInfo.selector, bytes4(keccak256("accountInfo(bytes32,bytes32,bytes[])")));
    }

    // ------------------------------------------------------------------ reads

    /// Read 1: the deployer's EVM account, an 80-byte AccountInfo that trie V1 stores behind its
    /// hash: nonce 6, free 159.47352201127852 tPOT.
    function test_accountInfo_deployer() public view {
        (IPortaldotStateReader.AccountInfo memory a, uint32 number) =
            reader.accountInfo(B, PortaldotState.ethAccountId(DEPLOYER), _proof(1));
        assertEq(number, B_NUMBER);
        assertEq(a.nonce, 6);
        assertEq(a.consumers, 0);
        assertEq(a.providers, 1);
        assertEq(a.sufficients, 0);
        assertEq(a.free, 15_947_352_201_127_852);
        assertEq(a.reserved, 0);
        assertEq(a.frozen, 0);
        assertEq(a.flags, uint128(1) << 127, "the new AccountData layout's flag");
        assertEq(a.free, vm.parseJsonUint(json, ".reads[0].value.decoded.free"));
        (uint128 free,) = kit.freeBalanceAt(IFinalizedStateRoots(address(lc)), B, PortaldotState.ethAccountId(DEPLOYER), _proof(1));
        assertEq(free, a.free);
    }

    /// Read 2: the owner's wallet, the account rows 114 to 126 funded and used.
    function test_accountInfo_ownerWallet() public view {
        (IPortaldotStateReader.AccountInfo memory a,) =
            reader.accountInfo(B, PortaldotState.ethAccountId(OWNER_WALLET), _proof(2));
        assertEq(a.nonce, 2, "the wallet's two locks");
        assertEq(a.free, 437_157_579_762_075);
    }

    /// Reads 3 to 8: Assets.Account values of 18 bytes, a 66-byte DepositFrom stored behind its
    /// hash, and a Frozen balance.
    function test_assetAccount() public view {
        _asset(3, 7777, PortaldotState.ethAccountId(HOLDER), 60_500_000, PortaldotState.LIQUID);
        _asset(4, 7777, PortaldotState.ethAccountId(0x18DD7b945aAb902034617A1a2Cdc0D936A464cFA), 4_500_000, 0);
        _asset(5, 7777, PortaldotState.ethAccountId(0x9Ceaa6aBFb2bC1aC202f96496Cdc683d86Bc458a), 1_550_000, 0);
        _asset(6, 7777, PortaldotState.ethAccountId(0x4f7D38D29172f91F77d3050A9e0F75A1AAe5df25), 100_000, 0);
        _asset(7, 7777, 0xfc5b8f7a52ef94d8a6ace06be6d6992e0700f97f1e930f4cfa3369682826d636, 136_781_096, 0);
        assertEq(vm.parseJsonUint(json, ".reads[6].value.bytes"), 66);
        assertTrue(vm.parseJsonBool(json, ".reads[6].value.hashed"), "trie V1 keeps the 66-byte value behind its hash");
        _asset(8, 4601, 0x0a90ff27c9c8a35251352dbc066ab66f0567ea7b92aeaca670e9c273f487bc49, 20_000_000, PortaldotState.FROZEN);
    }

    /// Reads 11 and 12: an item owned by an EVM account and one owned by a Substrate account.
    function test_nftOwner() public view {
        (bytes32 owner, uint32 number) = reader.nftOwner(B, 10, 3_163_806_249, _proof(11));
        assertEq(owner, PortaldotState.ethAccountId(0x104EB403971709e4a13C4c9D9200CAEd2bd78161));
        assertEq(number, B_NUMBER);
        (owner,) = reader.nftOwner(B, 0, 0, _proof(12));
        assertEq(owner, 0x80270a11d7b2e2b8b2dfb1ca3a45ab3b3f2339613709108c72f04074a8048467);
    }

    /// Read 14: the vault's AccountInfoOf entry names its trie id and the code hash BridgeMinter
    /// pins.
    function test_contractInfo_vault() public view {
        (bytes32 trieId, bytes32 codeHash, uint32 number) = reader.contractInfo(B, VAULT, _proof(14));
        assertEq(trieId, TRIE_ID);
        assertEq(codeHash, VAULT_CODE_HASH);
        assertEq(number, B_NUMBER);
    }

    /// commitments[1], nextNonce and outstanding of the vault, each with the trie id proven from
    /// the vault's address.
    function test_contractSlot() public view {
        (bytes32 word, bytes32 codeHash, uint32 number) = reader.contractSlot(B, VAULT, PortaldotState.mappingSlot(1, 0), _slotProof(1));
        assertEq(word, LOCK1_COMMITMENT);
        assertEq(codeHash, VAULT_CODE_HASH);
        assertEq(number, B_NUMBER);
        (word,,) = reader.contractSlot(B, VAULT, bytes32(uint256(1)), _slotProof(9));
        assertEq(uint256(word), 8, "nextNonce: locks 0 to 7");
        (word,,) = reader.contractSlot(B, VAULT, bytes32(uint256(2)), _slotProof(10));
        assertEq(uint256(word), 141_100_000_000_000, "outstanding: 1.411 tPOT");
    }

    /// commitments[0] to [7] under the bound trie id, each the word the fixture records.
    function test_childSlot() public view {
        bytes[] memory childRoot = vm.parseJsonBytesArray(json, ".contract.childRoot.proof.nodes");
        for (uint256 n = 0; n < 8; n++) {
            bytes32 slot = PortaldotState.mappingSlot(n, 0);
            assertEq(slot, vm.parseJsonBytes32(json, _at(".contract.slots", n, ".index")));
            (bytes32 word, uint32 number) =
                reader.childSlot(B, TRIE_ID, slot, childRoot, vm.parseJsonBytesArray(json, _at(".contract.slots", n, ".proof.nodes")));
            assertEq(word, vm.parseJsonBytes32(json, _at(".contract.slots", n, ".value.hex")));
            assertEq(number, B_NUMBER);
        }
    }

    /// readMain returns any key's raw value: read 1's 80 bytes, and the vault's child root.
    function test_readMain() public view {
        (bytes memory value, uint32 number) = reader.readMain(B, _key(1), _proof(1));
        assertEq(value, vm.parseJsonBytes(json, ".reads[0].value.scale"));
        assertEq(number, B_NUMBER);
        (value,) = reader.readMain(
            B, vm.parseJsonBytes(json, ".contract.childRoot.key.hex"), vm.parseJsonBytesArray(json, ".contract.childRoot.proof.nodes")
        );
        assertEq(bytes32(value), CHILD_ROOT);
    }

    /// The library's keys are the fixture's, which the TypeScript builds independently (state.ts).
    function test_keys() public view {
        assertEq(kit.systemAccountKey(PortaldotState.ethAccountId(DEPLOYER)), _key(1));
        assertEq(kit.systemAccountKey(PortaldotState.ethAccountId(DEPLOYER)).length, 80);
        assertEq(kit.assetsAccountKey(7777, kit.ethAccountId(HOLDER)), _key(3));
        assertEq(kit.assetsAccountKey(7777, kit.ethAccountId(HOLDER)).length, 100);
        assertEq(kit.assetsAccountKey(4601, 0x0a90ff27c9c8a35251352dbc066ab66f0567ea7b92aeaca670e9c273f487bc49), _key(8));
        assertEq(kit.nftsItemKey(10, 3_163_806_249), _key(11));
        assertEq(kit.nftsItemKey(0, 0), _key(12));
        assertEq(kit.nftsItemKey(0, 0).length, 72);
        assertEq(kit.reviveAccountInfoKey(VAULT), _key(14));
        assertEq(kit.reviveAccountInfoKey(VAULT).length, 52);
        assertEq(bytes32(_key(10)), PortaldotState.ASSETS_ACCOUNT, "the Assets.Account prefix");
        assertEq(bytes32(_key(13)), PortaldotState.NFTS_ITEM, "the Nfts.Item prefix");
        assertEq(bytes32(_key(1)), SubstrateProofs.SYSTEM_ACCOUNT_PREFIX);
        assertEq(PortaldotState.SYSTEM_ACCOUNT, SubstrateProofs.SYSTEM_ACCOUNT_PREFIX);
        assertEq(PortaldotState.ASSETS_ACCOUNT, SubstrateProofs.storagePrefix("Assets", "Account"));
        assertEq(PortaldotState.NFTS_ITEM, SubstrateProofs.storagePrefix("Nfts", "Item"));
        assertEq(PortaldotState.REVIVE_ACCOUNT_INFO_OF, SubstrateProofs.storagePrefix("Revive", "AccountInfoOf"));
        for (uint256 n = 0; n < 11; n++) {
            bytes32 index = vm.parseJsonBytes32(json, _at(".contract.slots", n, ".index"));
            assertEq(kit.reviveSlotKey(index), vm.parseJsonBytes32(json, _at(".contract.slots", n, ".key.hex")));
        }
        assertEq(kit.mappingSlot(8, 0), vm.parseJsonBytes32(json, ".contract.slots[8].index"), "commitments[8]");
        assertEq(kit.ethAccountId(DEPLOYER), vm.parseJsonBytes32(json, ".reads[0].args.accountId"));
    }

    // ------------------------------------------------------------------ tampers

    /// Every single-byte flip of read 3's proof (9 items, 2,110 bytes) reverts "Incomplete Proof!":
    /// a changed item no longer has the hash its parent names. Items 0 to 4 here (476 bytes), the
    /// others below, about 500 flips per test.
    function test_flips_read3_items0to4() public {
        _everyFlip(0, 5);
    }

    function test_flips_read3_items5to6() public {
        _everyFlip(5, 7);
    }

    function test_flips_read3_item7() public {
        _everyFlip(7, 8);
    }

    function test_flips_read3_item8() public {
        _everyFlip(8, 9);
    }

    /// One flip per item, in its middle byte, for every other read with a value, the child root and
    /// every stored slot: each reverts "Incomplete Proof!".
    function test_flips_onePerItem() public {
        uint8[11] memory ids = [1, 2, 4, 5, 6, 7, 8, 11, 12, 14, 15];
        for (uint256 r = 0; r < ids.length; r++) {
            bytes[] memory proof = _proof(ids[r]);
            for (uint256 i = 0; i < proof.length; i++) {
                bytes[] memory copy = _copy(proof);
                copy[i] = _flip(copy[i], copy[i].length / 2);
                _expectReaderFail(abi.encodeCall(PortaldotStateReader.readMain, (B, _key(ids[r]), copy)), _string(INCOMPLETE));
            }
        }
        bytes[] memory childRoot = vm.parseJsonBytesArray(json, ".contract.childRoot.proof.nodes");
        for (uint256 i = 0; i < childRoot.length; i++) {
            bytes[] memory copy = _copy(childRoot);
            copy[i] = _flip(copy[i], copy[i].length / 2);
            _expectReaderFail(
                abi.encodeCall(PortaldotStateReader.childSlot, (B, TRIE_ID, PortaldotState.mappingSlot(1, 0), copy, _slotItems(1))),
                _string(INCOMPLETE)
            );
        }
        for (uint256 n = 0; n < 11; n++) {
            if (n == 8) continue; // commitments[8] is absent
            bytes[] memory items = _slotItems(n);
            bytes32 slot = vm.parseJsonBytes32(json, _at(".contract.slots", n, ".index"));
            for (uint256 i = 0; i < items.length; i++) {
                bytes[] memory copy = _copy(items);
                copy[i] = _flip(copy[i], copy[i].length / 2);
                _expectReaderFail(abi.encodeCall(PortaldotStateReader.childSlot, (B, TRIE_ID, slot, childRoot, copy)), _string(INCOMPLETE));
            }
        }
    }

    /// A read's proof used for another key: the outcome the TypeScript mirror recorded in the
    /// fixture's tampers (KeyNotPresent where the walk ends at an empty branch slot or another
    /// leaf, EmptyValue at a branch without a value, "Incomplete Proof!" where it needs a node the
    /// proof does not hold).
    function test_wrongKeys() public {
        uint256 count = _count(json, ".tampers");
        assertEq(count, 6);
        for (uint256 t = 0; t < count; t++) {
            uint256 id = vm.parseJsonUint(json, _at(".tampers", t, ".read"));
            bytes memory key = vm.parseJsonBytes(json, _at(".tampers", t, ".key"));
            string memory outcome = vm.parseJsonString(json, _at(".tampers", t, ".outcome"));
            _expectReaderFail(abi.encodeCall(PortaldotStateReader.readMain, (B, key, _proof(id))), _reason(outcome, STATE_ROOT, key));
        }
        // The same through the typed reads: another holder with read 3's proof, another item with read 11's.
        _expectReaderFail(
            abi.encodeCall(
                PortaldotStateReader.assetAccount, (B, 7777, PortaldotState.ethAccountId(0x18DD7b945aAb902034617A1a2Cdc0D936A464cFA), _proof(3))
            ),
            _string(INCOMPLETE)
        );
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.nftOwner, (B, 10, 1, _proof(11))),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, STATE_ROOT, kit.nftsItemKey(10, 1))
        );
    }

    /// A block the client did not import: UnknownBlock, before any walk. B's grandparent is below
    /// the checkpoint.
    function test_unknownBlock() public {
        bytes32 grandparent = vm.parseJsonBytes32(json, ".parentHeader.parentHash");
        bytes32[2] memory blocks = [grandparent, bytes32(uint256(1))];
        for (uint256 i = 0; i < 2; i++) {
            bytes memory reason = abi.encodeWithSelector(GrandpaLightClient.UnknownBlock.selector, blocks[i]);
            _expectReaderFail(
                abi.encodeCall(PortaldotStateReader.accountInfo, (blocks[i], PortaldotState.ethAccountId(DEPLOYER), _proof(1))), reason
            );
            _expectReaderFail(abi.encodeCall(PortaldotStateReader.stateRootOf, (blocks[i])), reason);
            _expectReaderFail(abi.encodeCall(PortaldotStateReader.contractSlot, (blocks[i], VAULT, bytes32(uint256(1)), _slotProof(9))), reason);
        }
    }

    /// Read 10: the prefix of asset 7777's holders ends on a branch without a value: EmptyValue.
    function test_emptyValue() public {
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.readMain, (B, _key(10), _proof(10))),
            abi.encodeWithSelector(SubstrateProofs.EmptyValue.selector, STATE_ROOT, _key(10))
        );
    }

    /// Absent keys, each a proof that the key holds nothing: read 9 (the deployer holds no pUSD),
    /// read 13 (no item 1 in collection 10) and commitments[8] (no lock 8 at B), in the vault's
    /// child trie.
    function test_keyNotPresent() public {
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.assetAccount, (B, 7777, PortaldotState.ethAccountId(DEPLOYER), _proof(9))),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, STATE_ROOT, _key(9))
        );
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.nftOwner, (B, 10, 1, _proof(13))),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, STATE_ROOT, _key(13))
        );
        bytes32 slot8 = PortaldotState.mappingSlot(8, 0);
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.contractSlot, (B, VAULT, slot8, _slotProof(8))),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, CHILD_ROOT, abi.encodePacked(kit.reviveSlotKey(slot8)))
        );
    }

    /// An address with no Revive.AccountInfoOf entry (0x...dEaD, read 15's proof): contractInfo and
    /// contractSlot revert KeyNotPresent on its 52-byte AccountInfoOf key, and contractSlot returns
    /// no code hash with it. A consumer that read every KeyNotPresent of contractSlot as a zero slot
    /// would read a zero slot of a contract that is not there.
    function test_keyNotPresent_noContract() public {
        bytes memory key = PortaldotState.reviveAccountInfoKey(DEAD);
        bytes memory reason = abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, STATE_ROOT, key);
        _expectReaderFail(abi.encodeCall(PortaldotStateReader.contractInfo, (B, DEAD, _proof(15))), reason);
        IPortaldotStateReader.ContractSlotProof memory p = _slotProof(1);
        p.account = _proof(15);
        _expectReaderFail(abi.encodeCall(PortaldotStateReader.contractSlot, (B, DEAD, PortaldotState.mappingSlot(1, 0), p)), reason);
    }

    /// A trie id with no child trie at B: the vault's child-root proof shows another trie id's
    /// 55-byte child-root key absent, so childSlot reverts KeyNotPresent, as contractSlot does for a
    /// contract that has stored nothing. childSlot's trie id comes from a pinned contractInfo.
    function test_keyNotPresent_unboundTrieId() public {
        bytes32 other = TRIE_ID ^ bytes32(uint256(1));
        bytes memory key = SubstrateProofs.childRootKey(abi.encodePacked(other));
        assertEq(key.length, 55);
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.childSlot, (B, other, PortaldotState.mappingSlot(1, 0), _childRoot(), _slotItems(1))),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, STATE_ROOT, key)
        );
    }

    /// PinnedSlotOrZero, the pattern of docs/PROOF-KIT.md: lock 1's commitment, and zero for the
    /// absent commitments[8], from the vault pinned by its code hash. It never reads zero for other
    /// code, an address with no contract or an externally owned account, nor for a walk error.
    function test_pinnedSlotOrZero() public {
        bytes32 slot = PortaldotState.mappingSlot(1, 0);
        bytes[] memory vaultEntry = _proof(14);
        bytes[] memory eoaEntry = _proof(15);
        bytes[] memory childRoot = _childRoot();
        bytes[] memory lock1 = _slotItems(1);
        PinnedSlotOrZero vault = new PinnedSlotOrZero(reader, VAULT, VAULT_CODE_HASH);
        assertEq(vault.slotOrZero(B, slot, vaultEntry, childRoot, lock1), LOCK1_COMMITMENT);
        assertEq(vault.slotOrZero(B, PortaldotState.mappingSlot(8, 0), vaultEntry, childRoot, _slotItems(8)), bytes32(0), "no lock 8 at B");

        PinnedSlotOrZero otherCode = new PinnedSlotOrZero(reader, VAULT, keccak256("another contract's code"));
        vm.expectRevert(abi.encodeWithSelector(PinnedSlotOrZero.WrongCode.selector, VAULT_CODE_HASH));
        otherCode.slotOrZero(B, slot, vaultEntry, childRoot, lock1);

        // 0x...dEaD has no contract (read 15's proof shows it): KeyNotPresent from contractInfo, not a zero.
        PinnedSlotOrZero none = new PinnedSlotOrZero(reader, DEAD, VAULT_CODE_HASH);
        bytes memory deadKey = PortaldotState.reviveAccountInfoKey(DEAD);
        vm.expectRevert(abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, STATE_ROOT, deadKey));
        none.slotOrZero(B, slot, eoaEntry, childRoot, lock1);

        PinnedSlotOrZero eoa = new PinnedSlotOrZero(reader, address(1), VAULT_CODE_HASH);
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.NotAContract.selector, 5, 1));
        eoa.slotOrZero(B, slot, eoaEntry, childRoot, lock1);

        bytes[] memory flipped = _copy(lock1);
        flipped[0] = _flip(lock1[0], lock1[0].length / 2);
        vm.expectRevert(_string(INCOMPLETE));
        vault.slotOrZero(B, slot, vaultEntry, childRoot, flipped);
    }

    /// A key that holds an empty value reverts EmptyValue, as read 10's branch without a value does:
    /// the walk reports both alike, so EmptyValue is neither presence nor absence to a consumer. On
    /// V3, a map whose value is `()` (Nfts.Account, for one) stores each of its keys with an empty
    /// value. Here, a trie of one leaf (the key 0x12, an empty value) under a stand-in light client.
    function test_emptyValue_presentKey() public {
        // A leaf: 2 nibbles (0x42), the nibbles 1 and 2 (0x12), an empty inline value (compact 0).
        bytes memory leaf = hex"421200";
        bytes32 root = SubstrateProofs.blake2_256(leaf);
        bytes32 blockHash = keccak256("a block whose trie is one leaf");
        PortaldotStateReader one = new PortaldotStateReader(new OneBlockRoots(blockHash, root));
        bytes[] memory proof = new bytes[](1);
        proof[0] = leaf;
        bytes memory present = hex"12";
        bytes memory absent = hex"13";
        vm.expectRevert(abi.encodeWithSelector(SubstrateProofs.EmptyValue.selector, root, present));
        one.readMain(blockHash, present, proof);
        vm.expectRevert(abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, root, absent));
        one.readMain(blockHash, absent, proof);
    }

    /// Proof items the walk does not need are accepted, as the walk accepts them: read 3's items and
    /// an item that is no trie node, then read 1's proof, still prove the deployer's account.
    function test_extraItemsAccepted() public view {
        bytes[] memory one = _proof(1);
        bytes[] memory three = _proof(3);
        bytes[] memory items = new bytes[](three.length + 1 + one.length);
        for (uint256 i = 0; i < three.length; i++) {
            items[i] = three[i];
        }
        items[three.length] = hex"deadbeef";
        for (uint256 i = 0; i < one.length; i++) {
            items[three.length + 1 + i] = one[i];
        }
        (IPortaldotStateReader.AccountInfo memory a,) = reader.accountInfo(B, PortaldotState.ethAccountId(DEPLOYER), items);
        assertEq(a.free, 15_947_352_201_127_852);
    }

    /// No proof items, or an empty key: EmptyProof and EmptyKey, before any walk.
    function test_emptyProofAndKey() public {
        bytes memory emptyProof = abi.encodeWithSelector(SubstrateProofs.EmptyProof.selector);
        _expectReaderFail(abi.encodeCall(PortaldotStateReader.readMain, (B, _key(1), new bytes[](0))), emptyProof);
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.accountInfo, (B, PortaldotState.ethAccountId(DEPLOYER), new bytes[](0))), emptyProof
        );
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.readMain, (B, "", _proof(1))), abi.encodeWithSelector(SubstrateProofs.EmptyKey.selector)
        );
    }

    /// Read 15: 0x0000...0001's entry is an externally owned account's, 5 bytes of variant 1.
    function test_notAContract_eoa() public {
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.contractInfo, (B, address(1), _proof(15))),
            abi.encodeWithSelector(PortaldotState.NotAContract.selector, 5, 1)
        );
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.contractSlot, (B, address(1), bytes32(uint256(1)), _eoaSlotProof())),
            abi.encodeWithSelector(PortaldotState.NotAContract.selector, 5, 1)
        );
    }

    /// B's proofs read at its parent, which the client holds (the checkpoint): the walk starts from
    /// another root and finds no item with its hash.
    function test_proofsAtAnotherBlock() public {
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.accountInfo, (parentHash, PortaldotState.ethAccountId(DEPLOYER), _proof(1))),
            _string(INCOMPLETE)
        );
        _expectReaderFail(
            abi.encodeCall(PortaldotStateReader.contractSlot, (parentHash, VAULT, PortaldotState.mappingSlot(1, 0), _slotProof(1))),
            _string(INCOMPLETE)
        );
    }

    /// Values of another length or variant than V3's: each decoder's named error.
    function test_decoders_reject() public {
        bytes memory info = vm.parseJsonBytes(json, ".reads[0].value.scale");
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.AccountInfoLength.selector, 79));
        kit.decodeAccountInfo(_cut(info, 1));
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.AccountInfoLength.selector, 81));
        kit.decodeAccountInfo(bytes.concat(info, hex"00"));

        bytes memory asset = vm.parseJsonBytes(json, ".reads[2].value.scale"); // 18 bytes, Liquid, Consumer
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.AssetAccountMalformed.selector, 17, 0, 0));
        kit.decodeAssetAccount(_cut(asset, 1));
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.AssetAccountMalformed.selector, 19, 0, 0));
        kit.decodeAssetAccount(bytes.concat(asset, hex"00"));
        bytes memory held = bytes.concat(asset);
        held[17] = 0x02; // DepositHeld needs its u128: 34 bytes
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.AssetAccountMalformed.selector, 18, 0, 2));
        kit.decodeAssetAccount(held);
        bytes memory status = bytes.concat(asset);
        status[16] = 0x03;
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.AssetAccountMalformed.selector, 18, 3, 0));
        kit.decodeAssetAccount(status);
        bytes memory reason = bytes.concat(asset);
        reason[17] = 0x05;
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.AssetAccountMalformed.selector, 18, 0, 5));
        kit.decodeAssetAccount(reason);
        bytes memory from = vm.parseJsonBytes(json, ".reads[6].value.scale"); // 66 bytes, DepositFrom
        (uint128 balance, uint8 st) = kit.decodeAssetAccount(from);
        assertEq(balance, 136_781_096);
        assertEq(st, 0);
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.AssetAccountMalformed.selector, 65, 0, 4));
        kit.decodeAssetAccount(_cut(from, 1));

        bytes memory item = vm.parseJsonBytes(json, ".reads[10].value.scale"); // 81 bytes, no approvals
        assertEq(kit.decodeNftOwner(item), PortaldotState.ethAccountId(0x104EB403971709e4a13C4c9D9200CAEd2bd78161));
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.NftItemMalformed.selector, 80));
        kit.decodeNftOwner(_cut(item, 1));
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.NftItemMalformed.selector, 82));
        kit.decodeNftOwner(bytes.concat(item, hex"00"));
        bytes memory oneApproval = bytes.concat(_cut(item, 49), hex"04", bytes32(uint256(7)), hex"00", _tail(item, 48));
        assertEq(kit.decodeNftOwner(oneApproval), PortaldotState.ethAccountId(0x104EB403971709e4a13C4c9D9200CAEd2bd78161));
        bytes memory deadline = bytes.concat(_cut(item, 49), hex"04", bytes32(uint256(7)), hex"0109000000", _tail(item, 48));
        assertEq(kit.decodeNftOwner(deadline), PortaldotState.ethAccountId(0x104EB403971709e4a13C4c9D9200CAEd2bd78161));
        bytes memory badOption = bytes.concat(_cut(item, 49), hex"04", bytes32(uint256(7)), hex"02", _tail(item, 48));
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.NftItemMalformed.selector, badOption.length));
        kit.decodeNftOwner(badOption);
        bytes memory nonCanonical = bytes.concat(_cut(item, 49), hex"0100", _tail(item, 48));
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.NftItemMalformed.selector, nonCanonical.length));
        kit.decodeNftOwner(nonCanonical);

        bytes memory contractInfo = vm.parseJsonBytes(json, ".reads[13].value.scale"); // 130 bytes
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.NotAContract.selector, 129, 0));
        kit.decodeContractInfo(_cut(contractInfo, 1));
        bytes memory longId = bytes.concat(contractInfo);
        longId[1] = 0x84; // a 33-byte trie id
        vm.expectRevert(abi.encodeWithSelector(PortaldotState.NotAContract.selector, 130, 0));
        kit.decodeContractInfo(longId);

        vm.expectRevert(abi.encodeWithSelector(PortaldotState.SlotLength.selector, 31));
        kit.decodeSlot(_cut(abi.encodePacked(LOCK1_COMMITMENT), 1));
        assertEq(kit.decodeSlot(abi.encodePacked(LOCK1_COMMITMENT)), LOCK1_COMMITMENT);
    }

    /// ItemDetails with two approvals, one with a deadline, and with 64, the first count a compact
    /// writes in two bytes: the owner, with exactly the 48 bytes of deposit after the approvals. A
    /// count of 65 over the same 64 approvals does not parse.
    function test_decodeNftOwner_approvals() public view {
        bytes memory item = vm.parseJsonBytes(json, ".reads[10].value.scale"); // 81 bytes, no approvals
        bytes32 owner = PortaldotState.ethAccountId(0x104EB403971709e4a13C4c9D9200CAEd2bd78161);
        bytes memory two =
            bytes.concat(_cut(item, 49), hex"08", bytes32(uint256(7)), hex"00", bytes32(uint256(8)), hex"0109000000", _tail(item, 48));
        assertEq(kit.decodeNftOwner(two), owner);
        bytes memory approvals;
        for (uint256 i = 0; i < 64; i++) {
            approvals = bytes.concat(approvals, bytes32(i + 1));
            if (i % 2 == 0) approvals = bytes.concat(approvals, hex"00");
            else approvals = bytes.concat(approvals, hex"0101000000");
        }
        assertEq(approvals.length, 64 * 33 + 32 * 4);
        // Compact 64: (64 << 2) | 0b01, little-endian.
        bytes memory many = bytes.concat(_cut(item, 49), hex"0101", approvals, _tail(item, 48));
        assertEq(kit.decodeNftOwner(many), owner);
        bytes memory overcounted = bytes.concat(_cut(item, 49), hex"0501", approvals, _tail(item, 48));
        (bool ok, bytes memory ret) = address(kit).staticcall(abi.encodeCall(PortaldotStateHarness.decodeNftOwner, (overcounted)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(PortaldotState.NftItemMalformed.selector, overcounted.length));
    }

    // ------------------------------------------------------------------ gas

    /// Each read as its own transaction (isolate), the 21,000 base and the calldata included: the
    /// figures docs/PROOF-KIT.md gives.
    function test_gas_reads() public {
        _sendTo(
            address(reader),
            "kit: accountInfo (read 1, 8 items)",
            abi.encodeCall(PortaldotStateReader.accountInfo, (B, PortaldotState.ethAccountId(DEPLOYER), _proof(1)))
        );
        _sendTo(
            address(reader),
            "kit: assetAccount, 18-byte value (read 3, 9 items)",
            abi.encodeCall(PortaldotStateReader.assetAccount, (B, 7777, PortaldotState.ethAccountId(HOLDER), _proof(3)))
        );
        _sendTo(
            address(reader),
            "kit: assetAccount, 66-byte value (read 7, 9 items)",
            abi.encodeCall(
                PortaldotStateReader.assetAccount, (B, 7777, 0xfc5b8f7a52ef94d8a6ace06be6d6992e0700f97f1e930f4cfa3369682826d636, _proof(7))
            )
        );
        _sendTo(
            address(reader),
            "kit: assetAccount, Frozen (read 8, 8 items)",
            abi.encodeCall(
                PortaldotStateReader.assetAccount, (B, 4601, 0x0a90ff27c9c8a35251352dbc066ab66f0567ea7b92aeaca670e9c273f487bc49, _proof(8))
            )
        );
        _sendTo(address(reader), "kit: nftOwner (read 11, 8 items)", abi.encodeCall(PortaldotStateReader.nftOwner, (B, 10, 3_163_806_249, _proof(11))));
        _sendTo(address(reader), "kit: contractInfo (read 14, 9 items)", abi.encodeCall(PortaldotStateReader.contractInfo, (B, VAULT, _proof(14))));
        _sendTo(
            address(reader),
            "kit: contractSlot commitments[1] (9 + 8 + 3 items)",
            abi.encodeCall(PortaldotStateReader.contractSlot, (B, VAULT, PortaldotState.mappingSlot(1, 0), _slotProof(1)))
        );
        _sendTo(
            address(reader),
            "kit: childSlot commitments[1] (8 + 3 items)",
            abi.encodeCall(
                PortaldotStateReader.childSlot,
                (B, TRIE_ID, PortaldotState.mappingSlot(1, 0), vm.parseJsonBytesArray(json, ".contract.childRoot.proof.nodes"), _slotItems(1))
            )
        );
        _sendTo(address(reader), "kit: readMain (read 1, 8 items)", abi.encodeCall(PortaldotStateReader.readMain, (B, _key(1), _proof(1))));
    }

    // ------------------------------------------------------------------ helpers

    function _asset(uint256 id, uint32 assetId, bytes32 accountId, uint128 expected, uint8 expectedStatus) internal view {
        assertEq(kit.assetsAccountKey(assetId, accountId), _key(id), "the key is the fixture's");
        (uint128 balance, uint8 status, uint32 number) = reader.assetAccount(B, assetId, accountId, _proof(id));
        assertEq(balance, expected);
        assertEq(status, expectedStatus);
        assertEq(number, B_NUMBER);
        assertEq(balance, vm.parseJsonUint(json, _at(".reads", id - 1, ".value.decoded.balance")));
    }

    function _everyFlip(uint256 from, uint256 to) internal {
        bytes[] memory proof = _proof(3);
        assertEq(proof.length, 9);
        bytes memory key = _key(3);
        uint256 flips;
        for (uint256 i = from; i < to; i++) {
            for (uint256 j = 0; j < proof[i].length; j++) {
                bytes[] memory copy = _copy(proof);
                copy[i] = _flip(proof[i], j);
                _expectReaderFail(abi.encodeCall(PortaldotStateReader.readMain, (B, key, copy)), _string(INCOMPLETE));
                flips++;
            }
        }
        console.log("read 3, items", from, to - 1);
        console.log("  single-byte flips, each reverted:", flips);
    }

    /// Expects `data`, sent to the Reader with the per-transaction cap, to revert with exactly
    /// `reason`.
    function _expectReaderFail(bytes memory data, bytes memory reason) internal {
        vm.expectRevert(reason);
        // Under expectRevert a low-level call returns true only when the expected revert happened.
        (bool ok,) = address(reader).call{gas: TX_GAS_CAP}(data);
        assertTrue(ok, "the expected revert did not happen");
    }

    /// The revert data of an outcome the fixture records.
    function _reason(string memory outcome, bytes32 root, bytes memory key) internal pure returns (bytes memory) {
        bytes32 o = keccak256(bytes(outcome));
        if (o == keccak256("KeyNotPresent")) return abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, root, key);
        if (o == keccak256("EmptyValue")) return abi.encodeWithSelector(SubstrateProofs.EmptyValue.selector, root, key);
        return _string(outcome);
    }

    function _string(string memory reason) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("Error(string)", reason);
    }

    function _proof(uint256 id) internal view returns (bytes[] memory) {
        return vm.parseJsonBytesArray(json, _at(".reads", id - 1, ".proof.nodes"));
    }

    function _key(uint256 id) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, _at(".reads", id - 1, ".key.hex"));
    }

    function _slotItems(uint256 n) internal view returns (bytes[] memory) {
        return vm.parseJsonBytesArray(json, _at(".contract.slots", n, ".proof.nodes"));
    }

    function _childRoot() internal view returns (bytes[] memory) {
        return vm.parseJsonBytesArray(json, ".contract.childRoot.proof.nodes");
    }

    /// The vault's three proofs for slot `n` of the fixture: read 14, the child root and the slot.
    function _slotProof(uint256 n) internal view returns (IPortaldotStateReader.ContractSlotProof memory p) {
        p.account = _proof(14);
        p.childRoot = vm.parseJsonBytesArray(json, ".contract.childRoot.proof.nodes");
        p.slot = _slotItems(n);
    }

    function _eoaSlotProof() internal view returns (IPortaldotStateReader.ContractSlotProof memory p) {
        p = _slotProof(1);
        p.account = _proof(15);
    }

    function _copy(bytes[] memory items) internal pure returns (bytes[] memory out) {
        out = new bytes[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            out[i] = items[i];
        }
    }

    /// The last `n` bytes of `data`.
    function _tail(bytes memory data, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = data[data.length - n + i];
        }
    }
}
