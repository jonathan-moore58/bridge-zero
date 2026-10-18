// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {Scale} from "../../src/grandpa/Scale.sol";
import {SubstrateProofs} from "../../src/trie/SubstrateProofs.sol";
import {ProofsHarness} from "./Proofs.t.sol";
import {UnitFixtures} from "./UnitFixtures.sol";

/// Reads a pallet-revive contract's storage with the production proof library (SubstrateProofs),
/// from a separate contract so reverts can be expected and gas measured. The layout
/// (relayer/src/revive.ts): Revive.AccountInfoOf(address) holds the contract's trie id and code
/// hash; Revive.CodeInfoOf(code hash) the code's length and type; the root of the contract's child
/// trie is in the main trie under ":child_storage:default:" ++ trie id; a 32-byte slot is in the
/// child trie under blake2_256(slot), and its value is the stored word. Revive.BlockHash(number)
/// holds the hash of the Ethereum block the runtime built for that block.
contract ReviveHarness {
    using Scale for Scale.Cursor;

    /// twox128("Revive") ++ twox128("AccountInfoOf").
    bytes32 internal constant ACCOUNT_INFO_OF_PREFIX =
        0x735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc;
    /// twox128("Revive") ++ twox128("CodeInfoOf").
    bytes32 internal constant CODE_INFO_OF_PREFIX = 0x735f040a5d490f1107ad9c56f5ca00d208362995834169885de7f4fd67196e67;
    /// twox128("Revive") ++ twox128("BlockHash").
    bytes32 internal constant BLOCK_HASH_PREFIX = 0x735f040a5d490f1107ad9c56f5ca00d2a44704b568d21667356a5a050c118746;
    /// AccountInfo bytes after the code hash: storage_bytes and storage_items (u32), three u128
    /// deposits, immutable_data_len (u32), then AccountInfo.dust (u32).
    uint256 internal constant AFTER_CODE_HASH = 64;
    /// CodeInfo.owner, an AccountId32: the bytes before the deposit.
    uint256 internal constant CODE_OWNER = 32;
    /// CodeInfo.code_type of a PolkaVM program and of EVM bytecode (BytecodeType in the metadata).
    uint8 internal constant CODE_TYPE_PVM = 0;
    uint8 internal constant CODE_TYPE_EVM = 1;

    /// The AccountInfoOf value is not AccountType::Contract (variant 0).
    error NotAContract(uint8 variant);
    /// The CodeInfoOf value's code_type is not a BytecodeType.
    error UnknownCodeType(uint8 codeType);

    /// Revive.AccountInfoOf(account): the prefix, then the 20-byte address (Identity hasher).
    function accountInfoKey(address account) public pure returns (bytes memory) {
        return bytes.concat(ACCOUNT_INFO_OF_PREFIX, bytes20(account));
    }

    /// Revive.CodeInfoOf(codeHash): the prefix, then the code hash (Identity hasher).
    function codeInfoKey(bytes32 codeHash) public pure returns (bytes memory) {
        return bytes.concat(CODE_INFO_OF_PREFIX, codeHash);
    }

    /// Revive.BlockHash(number): the prefix, then the number as a little-endian u32 (Identity hasher).
    function blockHashKey(uint32 number) public pure returns (bytes memory) {
        return bytes.concat(BLOCK_HASH_PREFIX, bytes4(Scale.swap32(number)));
    }

    /// The child-trie key of a 32-byte slot: blake2_256(slot).
    function slotKey(bytes32 index) public view returns (bytes memory) {
        return abi.encodePacked(SubstrateProofs.blake2_256(abi.encodePacked(index)));
    }

    /// The trie id and code hash in an AccountInfo value. Reverts unless it is the Contract
    /// variant with exactly the fields that follow the code hash.
    function contractInfo(bytes memory value) public pure returns (bytes memory trieId, bytes32 codeHash) {
        Scale.Cursor memory c = Scale.cursor(value);
        uint8 variant = c.readU8();
        if (variant != 0) revert NotAContract(variant);
        trieId = new bytes(c.readLength());
        for (uint256 i = 0; i < trieId.length; i++) {
            trieId[i] = bytes1(c.readU8());
        }
        codeHash = c.readBytes32();
        c.skip(AFTER_CODE_HASH);
        c.done();
    }

    /// code_len and code_type of a CodeInfo value: owner (AccountId32), deposit (Compact<u128>),
    /// refcount (Compact<u64>), code_len (u32), code_type (u8), behaviour_version (u32). Reverts on
    /// an unknown code_type, and unless the value ends right after behaviour_version.
    function codeInfoFields(bytes memory value) public pure returns (uint32 codeLen, uint8 codeType) {
        Scale.Cursor memory c = Scale.cursor(value);
        c.skip(CODE_OWNER);
        c.readCompact(); // deposit
        c.readCompact(); // refcount
        codeLen = c.readU32();
        codeType = c.readU8();
        if (codeType != CODE_TYPE_PVM && codeType != CODE_TYPE_EVM) revert UnknownCodeType(codeType);
        c.skip(4); // behaviour_version
        c.done();
    }

    /// Revive.AccountInfoOf(account) proven under `stateRoot`: the contract's trie id and code hash.
    function accountInfo(bytes32 stateRoot, bytes[] memory nodes, address account)
        external
        view
        returns (bytes memory trieId, bytes32 codeHash, uint256 gasUsed)
    {
        uint256 before = gasleft();
        (trieId, codeHash) = contractInfo(SubstrateProofs.verifyMain(stateRoot, nodes, accountInfoKey(account)));
        gasUsed = before - gasleft();
    }

    /// Revive.CodeInfoOf(codeHash) proven under `stateRoot`: the code's length and type.
    function codeInfo(bytes32 stateRoot, bytes[] memory nodes, bytes32 codeHash)
        external
        view
        returns (uint32 codeLen, uint8 codeType)
    {
        return codeInfoFields(SubstrateProofs.verifyMain(stateRoot, nodes, codeInfoKey(codeHash)));
    }

    /// Revive.BlockHash(number) proven under `stateRoot`: the stored value, an H256.
    function ethBlockHash(bytes32 stateRoot, bytes[] memory nodes, uint32 number) external view returns (bytes memory) {
        return SubstrateProofs.verifyMain(stateRoot, nodes, blockHashKey(number));
    }

    /// Slot `index` of the contract with trie id `trieId`: the child root proven under `stateRoot`
    /// with `rootNodes`, then blake2_256(index) under the child root with `childNodes`.
    /// The trie id comes from the caller here, which suits a test. Production code must take it
    /// only from a proven Revive.AccountInfoOf entry, as `read` does: a terminated contract's child
    /// trie stays in the main trie, queued in Revive.DeletionQueue, until it is cleared, so a stale
    /// trie id can still prove values that no live contract holds.
    function readSlot(
        bytes32 stateRoot,
        bytes[] memory rootNodes,
        bytes[] memory childNodes,
        bytes memory trieId,
        bytes32 index
    ) external view returns (bytes memory value, bytes32 childRoot, uint256 gasUsed) {
        uint256 before = gasleft();
        (value, childRoot) = SubstrateProofs.verifyChild(stateRoot, rootNodes, childNodes, trieId, slotKey(index));
        gasUsed = before - gasleft();
    }

    /// The whole read from a contract address: its AccountInfoOf entry names the child trie, which
    /// holds the slot.
    function read(
        bytes32 stateRoot,
        bytes[] memory accountNodes,
        address account,
        bytes[] memory rootNodes,
        bytes[] memory childNodes,
        bytes32 index
    ) external view returns (bytes memory value, uint256 gasUsed) {
        uint256 before = gasleft();
        (bytes memory trieId,) =
            contractInfo(SubstrateProofs.verifyMain(stateRoot, accountNodes, accountInfoKey(account)));
        (value,) = SubstrateProofs.verifyChild(stateRoot, rootNodes, childNodes, trieId, slotKey(index));
        gasUsed = before - gasleft();
    }
}

/// One pallet-revive contract slot captured by relayer/src/capture-contract.ts (re-verified offline
/// by npm run check): every value is read from the fixture and checked with the production
/// libraries, from the header to the slot's value, the code's CodeInfoOf entry and the EVM block.
abstract contract ReviveStorageSnapshotTest is UnitFixtures {
    using Scale for Scale.Cursor;

    /// EIP-7825 transaction gas limit cap: the gas limit of the measured transaction.
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    /// The state root an eth-rpc that serves the runtime's Ethereum blocks reports for them: the
    /// root of an empty Ethereum trie, keccak-256 of RLP("") (the byte 0x80). A placeholder.
    bytes32 internal constant EMPTY_TRIE_ROOT = keccak256(hex"80");

    ReviveHarness internal rh;
    ProofsHarness internal ph;
    /// The vendored walk's revert when an item is not among the proof items.
    bytes internal INCOMPLETE;

    string internal json;
    bytes internal header;
    bytes32 internal blockHash;
    uint32 internal blockNumber;
    bytes32 internal stateRoot;
    address internal account;
    bytes internal accountValue;
    bytes[] internal accountNodes;
    bytes internal trieId; // as the capture decoded it
    bytes32 internal codeHash; // as the capture decoded it
    bytes internal codeInfoValue;
    bytes[] internal codeInfoNodes;
    bytes32 internal childRoot;
    bytes[] internal rootNodes;
    bytes32 internal index;
    bytes internal value;
    bytes[] internal childNodes;
    bytes internal word; // eth_getStorageAt(account, index) at the same block
    bytes32 internal ethBlockHash; // Revive.BlockHash(B) as the capture read it
    bytes[] internal blockHashNodes;
    bytes32 internal parentEthBlockHash; // Revive.BlockHash(B - 1) as the capture read it
    bytes[] internal parentBlockHashNodes;

    function _dir() internal pure virtual returns (string memory);

    function setUp() public override {
        super.setUp();
        rh = new ReviveHarness();
        ph = new ProofsHarness();
        INCOMPLETE = abi.encodeWithSignature("Error(string)", "Incomplete Proof!");
        json = _json(_dir(), "contract-storage");
        assertEq(vm.parseJsonString(json, ".kind"), "contract-storage");
        header = vm.parseJsonBytes(json, ".header.scale");
        blockHash = vm.parseJsonBytes32(json, ".header.hash");
        blockNumber = uint32(vm.parseJsonUint(json, ".header.number"));
        stateRoot = vm.parseJsonBytes32(json, ".header.stateRoot");
        account = vm.parseJsonAddress(json, ".account.address");
        accountValue = vm.parseJsonBytes(json, ".account.value.scale");
        _store(vm.parseJsonBytesArray(json, ".account.proof.nodes"), accountNodes);
        trieId = vm.parseJsonBytes(json, ".account.value.decoded.trieId");
        codeHash = vm.parseJsonBytes32(json, ".account.value.decoded.codeHash");
        codeInfoValue = vm.parseJsonBytes(json, ".codeInfo.value.scale");
        _store(vm.parseJsonBytesArray(json, ".codeInfo.proof.nodes"), codeInfoNodes);
        childRoot = vm.parseJsonBytes32(json, ".childRoot.root");
        _store(vm.parseJsonBytesArray(json, ".childRoot.proof.nodes"), rootNodes);
        index = vm.parseJsonBytes32(json, ".slot.index");
        value = vm.parseJsonBytes(json, ".slot.value.hex");
        _store(vm.parseJsonBytesArray(json, ".slot.proof.nodes"), childNodes);
        word = vm.parseJsonBytes(json, ".evm.storageAt.result");
        ethBlockHash = vm.parseJsonBytes32(json, ".evm.reviveBlockHash.value");
        _store(vm.parseJsonBytesArray(json, ".evm.reviveBlockHash.proof.nodes"), blockHashNodes);
        parentEthBlockHash = vm.parseJsonBytes32(json, ".evm.reviveParentBlockHash.value");
        _store(vm.parseJsonBytesArray(json, ".evm.reviveParentBlockHash.proof.nodes"), parentBlockHashNodes);
    }

    // ------------------------------------------------------------------ header to slot

    /// The header decodes and hashes to block B's hash, and its state root is where every proof
    /// starts.
    function test_header_hashAndStateRoot() public view {
        (Header.Decoded memory h,) = harness.header(header);
        assertEq(h.hash, blockHash, "blake2b-256 of the SCALE header is the block hash");
        assertEq(h.hash, vm.parseJsonBytes32(json, ".provenance.block.hash"), "the block the capture read at");
        assertEq(h.number, vm.parseJsonUint(json, ".provenance.block.number"), "block number");
        assertEq(h.number, blockNumber, "the header's number field");
        assertEq(h.stateRoot, stateRoot, "the state root inside the header");
        assertNotEq(Header.hash(_flip(header, 40)), blockHash, "a flipped state-root byte changes the hash");
    }

    /// The EVM RPC's block with B's number is B. Revive.BlockHash(B) and Revive.BlockHash(B - 1),
    /// proven under B's state root, are the hashes of the Ethereum blocks the runtime built for B
    /// and for its parent. With relation "substrate-block" the EVM block has B's own hash, parent
    /// hash and state root; with "revive-block-hash" its hash and parent hash are those two proven
    /// hashes, and its state root is the empty-trie root, a placeholder. No other relation is
    /// accepted.
    function test_evmBlock_isB() public view {
        (Header.Decoded memory h,) = harness.header(header);
        bytes memory key = rh.blockHashKey(h.number);
        assertEq(key, vm.parseJsonBytes(json, ".evm.reviveBlockHash.key.hex"), "Revive.BlockHash key built on chain");
        assertEq(
            bytes32(key), SubstrateProofs.storagePrefix("Revive", "BlockHash"), "twox128(Revive) ++ twox128(BlockHash)"
        );
        (bytes memory v,) = ph.verifyMain(stateRoot, blockHashNodes, key);
        assertEq(v.length, 32, "an H256");
        assertEq(bytes32(v), ethBlockHash, "the captured Revive.BlockHash(B)");
        assertEq(rh.ethBlockHash(stateRoot, blockHashNodes, h.number), v, "the harness reads the same value");

        bytes memory parentKey = rh.blockHashKey(h.number - 1);
        assertEq(
            parentKey,
            vm.parseJsonBytes(json, ".evm.reviveParentBlockHash.key.hex"),
            "Revive.BlockHash(B - 1) key built on chain"
        );
        (bytes memory p,) = ph.verifyMain(stateRoot, parentBlockHashNodes, parentKey);
        assertEq(p.length, 32, "an H256");
        assertEq(bytes32(p), parentEthBlockHash, "the captured Revive.BlockHash(B - 1)");

        assertEq(vm.parseJsonUint(json, ".evm.block.number"), h.number, "EVM block number");
        bytes32 evmHash = vm.parseJsonBytes32(json, ".evm.block.hash");
        bytes32 evmParentHash = vm.parseJsonBytes32(json, ".evm.block.parentHash");
        bytes32 evmStateRoot = vm.parseJsonBytes32(json, ".evm.block.stateRoot");
        string memory relation = vm.parseJsonString(json, ".evm.relation");
        if (keccak256(bytes(relation)) == keccak256("substrate-block")) {
            assertEq(evmHash, h.hash, "the EVM block's hash is B's");
            assertEq(evmParentHash, h.parentHash, "its parent hash is B's");
            assertEq(evmStateRoot, h.stateRoot, "its state root is B's");
        } else {
            assertEq(relation, "revive-block-hash", "a known relation");
            assertEq(evmHash, bytes32(v), "the EVM block's hash is Revive.BlockHash(B), proven at B");
            assertEq(evmParentHash, bytes32(p), "its parent hash is Revive.BlockHash(B - 1), proven at B");
            assertEq(evmStateRoot, EMPTY_TRIE_ROOT, "its state root is the empty-trie root, a placeholder");
        }
    }

    /// eth_getCode and eth_getStorageAt were asked for this contract, and this slot, at the EVM
    /// block: by its hash ({blockHash} alone, EIP-1898), or by B's number where the RPC refused it.
    function test_evmCalls_atTheEvmBlock() public view {
        bytes32 evmHash = vm.parseJsonBytes32(json, ".evm.block.hash");
        assertEq(_count(json, ".code.params"), 2, "eth_getCode(address, block)");
        assertEq(vm.parseJsonAddress(json, ".code.params[0]"), account, "eth_getCode of the contract");
        _atEvmBlock(".code.params[1]", evmHash);
        assertEq(_count(json, ".evm.storageAt.params"), 3, "eth_getStorageAt(address, slot, block)");
        assertEq(vm.parseJsonAddress(json, ".evm.storageAt.params[0]"), account, "eth_getStorageAt of the contract");
        assertEq(vm.parseJsonUint(json, ".evm.storageAt.params[1]"), uint256(index), "eth_getStorageAt of the slot");
        _atEvmBlock(".evm.storageAt.params[2]", evmHash);
    }

    /// Revive.AccountInfoOf(address) is proven under the state root. It is a contract, and names
    /// the trie id and code hash the capture decoded; keccak-256 of the code eth_getCode returned
    /// is that code hash.
    function test_accountInfo_trieIdAndCodeHash() public view {
        bytes memory key = rh.accountInfoKey(account);
        assertEq(key, vm.parseJsonBytes(json, ".account.key.hex"), "AccountInfoOf key built on chain");
        assertEq(
            bytes32(key),
            SubstrateProofs.storagePrefix("Revive", "AccountInfoOf"),
            "twox128(Revive) ++ twox128(AccountInfoOf)"
        );
        (bytes memory v,) = ph.verifyMain(stateRoot, accountNodes, key);
        assertEq(v, accountValue, "the captured AccountInfo");
        (bytes memory id, bytes32 hash, uint256 gasUsed) = rh.accountInfo(stateRoot, accountNodes, account);
        assertEq(id, trieId, "trie id");
        assertEq(hash, codeHash, "code hash");
        assertEq(keccak256(vm.parseJsonBytes(json, ".code.hex")), hash, "keccak-256 of the contract's code");
        console.log(string.concat(_dir(), ": AccountInfoOf proof, gas"), gasUsed);

        // Every field, as the capture decoded it.
        Scale.Cursor memory c = Scale.cursor(v);
        assertEq(c.readU8(), 0, "AccountType::Contract");
        assertEq(c.readLength(), id.length, "trie id length");
        c.skip(id.length);
        assertEq(c.readBytes32(), hash);
        assertEq(c.readU32(), _uint(".account.value.decoded.storageBytes"), "storage_bytes");
        assertEq(c.readU32(), _uint(".account.value.decoded.storageItems"), "storage_items");
        assertEq(_u128(c), _uintString(".account.value.decoded.storageByteDeposit"), "storage_byte_deposit");
        assertEq(_u128(c), _uintString(".account.value.decoded.storageItemDeposit"), "storage_item_deposit");
        assertEq(_u128(c), _uintString(".account.value.decoded.storageBaseDeposit"), "storage_base_deposit");
        assertEq(c.readU32(), _uint(".account.value.decoded.immutableDataLen"), "immutable_data_len");
        assertEq(c.readU32(), _uint(".account.value.decoded.dust"), "dust");
        c.done();

        // In trie V1 a value over 32 bytes is not inline in its leaf: the leaf holds its hash, and
        // the value is a proof item of its own.
        if (vm.parseJsonUint(json, ".trieVersion") == 1 && v.length > 32) {
            uint256 at = type(uint256).max;
            for (uint256 i = 0; i < accountNodes.length; i++) {
                if (keccak256(accountNodes[i]) == keccak256(v)) at = i;
            }
            assertLt(at, accountNodes.length, "the AccountInfo value is a proof item of its own");
            (bool ok, bytes memory ret) = address(rh).staticcall(_accountCall(_without(accountNodes, at)));
            assertFalse(ok, "without the value item the walk cannot read the value");
            assertEq(ret, INCOMPLETE, "the value item is looked up by its hash");
        }
    }

    /// Revive.CodeInfoOf(code hash) is proven under the state root, with the code hash from the
    /// proven AccountInfo. Its code_len is the length of the code eth_getCode returned, and its
    /// code_type is what that code is: 0 for a PolkaVM program ("PVM\0"), 1 for EVM bytecode.
    function test_codeInfo_typeAndLength() public view {
        (, bytes32 hash,) = rh.accountInfo(stateRoot, accountNodes, account);
        bytes memory key = rh.codeInfoKey(hash);
        assertEq(key, vm.parseJsonBytes(json, ".codeInfo.key.hex"), "CodeInfoOf key built on chain");
        assertEq(
            bytes32(key),
            SubstrateProofs.storagePrefix("Revive", "CodeInfoOf"),
            "twox128(Revive) ++ twox128(CodeInfoOf)"
        );
        (bytes memory v,) = ph.verifyMain(stateRoot, codeInfoNodes, key);
        assertEq(v, codeInfoValue, "the captured CodeInfo");

        (uint32 codeLen, uint8 codeType) = rh.codeInfo(stateRoot, codeInfoNodes, hash);
        bytes memory code = vm.parseJsonBytes(json, ".code.hex");
        assertEq(codeLen, code.length, "code_len is the length of the code");
        assertEq(codeType, bytes4(code) == bytes4("PVM\x00") ? 0 : 1, "code_type: 0 a PolkaVM program, 1 EVM bytecode");
        assertEq(codeLen, _uint(".codeInfo.value.decoded.codeLen"), "code_len as the capture decoded it");
        string memory name = codeType == 1 ? string("Evm") : string("Pvm");
        assertEq(
            name, vm.parseJsonString(json, ".codeInfo.value.decoded.codeType"), "code_type as the capture decoded it"
        );
    }

    /// The child root is proven under the state root at ":child_storage:default:" ++ trie id, with
    /// the trie id decoded from the proven AccountInfo.
    function test_childRoot() public view {
        (bytes memory id,,) = rh.accountInfo(stateRoot, accountNodes, account);
        bytes memory key = SubstrateProofs.childRootKey(id);
        assertEq(key, vm.parseJsonBytes(json, ".childRoot.key.hex"), "child-root key built on chain");
        (bytes memory v,) = ph.verifyMain(stateRoot, rootNodes, key);
        assertEq(v.length, 32, "a 32-byte root");
        assertEq(bytes32(v), childRoot, "the captured child root");
    }

    /// The slot under that child root: blake2_256(slot) in the child trie holds exactly the
    /// captured value, and the word eth_getStorageAt returned for the slot at the same block is
    /// that value, compared as the capture's `matches` says: equal, or left-padded to 32 bytes.
    function test_slot_equalsEthGetStorageAt() public view {
        (bytes memory id,,) = rh.accountInfo(stateRoot, accountNodes, account);
        assertEq(rh.slotKey(index), vm.parseJsonBytes(json, ".slot.key.hex"), "blake2_256(slot) built on chain");
        (bytes memory v, bytes32 root,) = rh.readSlot(stateRoot, rootNodes, childNodes, id, index);
        assertEq(root, childRoot, "child root proven in the main trie");
        assertEq(v, value, "the captured value");
        bytes memory w = word;
        string memory matches = vm.parseJsonString(json, ".evm.storageAt.matches");
        if (keccak256(bytes(matches)) == keccak256("equal")) {
            assertEq(v, w, "eth_getStorageAt's word, byte for byte");
        } else {
            assertEq(matches, "left-padded", "a known relation");
            assertEq(w.length, 32, "a 32-byte word");
            assertLt(v.length, 32, "a value shorter than the word");
            assertEq(w, bytes.concat(new bytes(32 - v.length), v), "the value after zero bytes");
        }
        console.log(string.concat(_dir(), ": slot value as a number"), uint256(bytes32(w)) >> (8 * (32 - w.length)));
    }

    /// Gas of the full read from the contract address (AccountInfoOf, child root, slot): the
    /// library work in one call frame, and the same call as a transaction, calldata included.
    function test_fullRead_gas() public {
        (,, uint256 accountGas) = rh.accountInfo(stateRoot, accountNodes, account);
        (,, uint256 slotGas) = rh.readSlot(stateRoot, rootNodes, childNodes, trieId, index);
        (bytes memory v, uint256 gasUsed) = rh.read(stateRoot, accountNodes, account, rootNodes, childNodes, index);
        assertEq(v, value);
        console.log(string.concat(_dir(), ": AccountInfoOf proof (main trie), gas"), accountGas);
        console.log(string.concat(_dir(), ": child root (main trie) + slot (child trie), gas"), slotGas);
        console.log(string.concat(_dir(), ": full read from the address, gas"), gasUsed);

        assertTrue(vm.isIsolateMode(), "run with isolate, so the call is measured as a transaction");
        bytes memory data =
            abi.encodeCall(ReviveHarness.read, (stateRoot, accountNodes, account, rootNodes, childNodes, index));
        (bool ok, bytes memory ret) = address(rh).call{gas: TX_GAS_CAP}(data);
        uint256 txGas = vm.lastFrameGas().gasTotalUsed;
        assertTrue(ok, "the read succeeds");
        (v,) = abi.decode(ret, (bytes, uint256));
        assertEq(v, value);
        console.log(string.concat(_dir(), ": full read as a transaction (calldata included), gas"), txGas);
        console.log(
            "  proof items, account + child root + slot:", accountNodes.length + rootNodes.length + childNodes.length
        );
        console.log("  calldata bytes:", data.length);
    }

    // ------------------------------------------------------------------ decoders

    /// The AccountInfo decoder takes only a contract with exactly its fields: an EOA (variant 1)
    /// and variant 2 revert NotAContract, a byte after the value TrailingBytes, and the value
    /// without its last byte Truncated, where the 64 bytes after the code hash are read.
    function test_accountInfoDecoder_rejects() public view {
        (bool ok, bytes memory ret) =
            address(rh).staticcall(abi.encodeCall(ReviveHarness.contractInfo, (hex"0100000000")));
        assertFalse(ok, "an EOA is not a contract");
        assertEq(ret, abi.encodeWithSelector(ReviveHarness.NotAContract.selector, uint8(1)), "NotAContract(1)");

        (ok, ret) = address(rh).staticcall(abi.encodeCall(ReviveHarness.contractInfo, (hex"0200000000")));
        assertFalse(ok, "variant 2 is not a contract");
        assertEq(ret, abi.encodeWithSelector(ReviveHarness.NotAContract.selector, uint8(2)), "NotAContract(2)");

        (ok, ret) =
            address(rh).staticcall(abi.encodeCall(ReviveHarness.contractInfo, (bytes.concat(accountValue, hex"00"))));
        assertFalse(ok, "a byte after the AccountInfo");
        assertEq(
            ret,
            abi.encodeWithSelector(Scale.TrailingBytes.selector, accountValue.length, 1),
            "TrailingBytes(at the end, 1 byte)"
        );

        (ok, ret) = address(rh).staticcall(abi.encodeCall(ReviveHarness.contractInfo, (_cut(accountValue, 1))));
        assertFalse(ok, "the AccountInfo without its last byte");
        uint256 afterCodeHash = 1 + _compact(trieId.length).length + trieId.length + 32;
        assertEq(
            ret,
            abi.encodeWithSelector(Scale.Truncated.selector, afterCodeHash, 64),
            "Truncated(after the code hash, the 64 bytes that follow it)"
        );
    }

    /// The CodeInfo decoder reads code_type from the fifth byte from the end (flipping it turns one
    /// code type into the other), and rejects code_type 2 (UnknownCodeType), a byte after the value
    /// (TrailingBytes) and the value without its last byte (Truncated, in behaviour_version).
    function test_codeInfoDecoder_rejects() public view {
        (uint32 codeLen, uint8 codeType) = rh.codeInfoFields(codeInfoValue);
        uint256 at = codeInfoValue.length - 5; // code_type (u8), then behaviour_version (u32)
        bytes memory changed = _flip(codeInfoValue, at);
        (uint32 len, uint8 other) = rh.codeInfoFields(changed);
        assertEq(len, codeLen, "the same code_len");
        assertEq(other, 1 - codeType, "the other code type");

        changed[at] = 0x02;
        (bool ok, bytes memory ret) = address(rh).staticcall(abi.encodeCall(ReviveHarness.codeInfoFields, (changed)));
        assertFalse(ok, "code_type 2");
        assertEq(ret, abi.encodeWithSelector(ReviveHarness.UnknownCodeType.selector, uint8(2)), "UnknownCodeType(2)");

        (ok, ret) = address(rh)
            .staticcall(abi.encodeCall(ReviveHarness.codeInfoFields, (bytes.concat(codeInfoValue, hex"00"))));
        assertFalse(ok, "a byte after the CodeInfo");
        assertEq(
            ret,
            abi.encodeWithSelector(Scale.TrailingBytes.selector, codeInfoValue.length, 1),
            "TrailingBytes(at the end, 1 byte)"
        );

        (ok, ret) = address(rh).staticcall(abi.encodeCall(ReviveHarness.codeInfoFields, (_cut(codeInfoValue, 1))));
        assertFalse(ok, "the CodeInfo without its last byte");
        assertEq(
            ret,
            abi.encodeWithSelector(Scale.Truncated.selector, codeInfoValue.length - 4, 4),
            "Truncated(at behaviour_version, 4 bytes)"
        );
    }

    // ------------------------------------------------------------------ tampering

    /// Changing any single byte of any item of the AccountInfoOf proof, the value item included,
    /// breaks the read: the changed item no longer hashes to the reference that leads to it.
    function test_accountProof_everyByteFlipFails() public view {
        assertEq(_everyByteFails(accountNodes, _accountCall), _uint(".account.proof.bytes"), "every byte of every item");
    }

    /// The same for every byte of the CodeInfoOf proof.
    function test_codeInfoProof_everyByteFlipFails() public view {
        assertEq(
            _everyByteFails(codeInfoNodes, _codeInfoCall), _uint(".codeInfo.proof.bytes"), "every byte of every item"
        );
    }

    /// The same for every byte of the child-root proof.
    function test_childRootProof_everyByteFlipFails() public view {
        assertEq(_everyByteFails(rootNodes, _rootCall), _uint(".childRoot.proof.bytes"), "every byte of every item");
    }

    /// The same for every byte of the child proof.
    function test_slotProof_everyByteFlipFails() public view {
        assertEq(_everyByteFails(childNodes, _childCall), _uint(".slot.proof.bytes"), "every byte of every item");
    }

    /// The same for every byte of the Revive.BlockHash(B) proof.
    function test_blockHashProof_everyByteFlipFails() public view {
        assertEq(
            _everyByteFails(blockHashNodes, _blockHashCall),
            _uint(".evm.reviveBlockHash.proof.bytes"),
            "every byte of every item"
        );
    }

    /// The same for every byte of the Revive.BlockHash(B - 1) proof.
    function test_parentBlockHashProof_everyByteFlipFails() public view {
        assertEq(
            _everyByteFails(parentBlockHashNodes, _parentBlockHashCall),
            _uint(".evm.reviveParentBlockHash.proof.bytes"),
            "every byte of every item"
        );
    }

    /// Leaving out any one item of any of the six proofs fails.
    function test_droppedItemFails() public view {
        _droppedItemFails(accountNodes, _accountCall);
        _droppedItemFails(codeInfoNodes, _codeInfoCall);
        _droppedItemFails(rootNodes, _rootCall);
        _droppedItemFails(childNodes, _childCall);
        _droppedItemFails(blockHashNodes, _blockHashCall);
        _droppedItemFails(parentBlockHashNodes, _parentBlockHashCall);
    }

    /// Other slots are not proven by this child proof: the walk shows them absent (KeyNotPresent)
    /// or needs child-trie nodes the proof does not hold ("Incomplete Proof!"). Both revert.
    function test_otherSlots_fail() public view {
        bytes32[4] memory others;
        unchecked {
            others = [
                bytes32(uint256(index) + 1),
                bytes32(uint256(index) - 1),
                index ^ bytes32(uint256(1) << 255),
                keccak256(abi.encode(account, index)) // a mapping entry's slot
            ];
        }
        uint256 absent;
        for (uint256 i = 0; i < others.length; i++) {
            (bool ok, bytes memory ret) = address(rh)
                .staticcall(
                    abi.encodeCall(ReviveHarness.readSlot, (stateRoot, rootNodes, childNodes, trieId, others[i]))
                );
            assertFalse(ok, "another slot is not proven");
            if (_notPresent(ret, childRoot, rh.slotKey(others[i]))) absent++;
        }
        console.log("other slots shown absent (the rest: not in the proof):", absent, "of", others.length);
    }

    /// Each step is bound to its key and its root: another address, another trie id, the main and
    /// child proofs swapped, and another state root all fail.
    function test_otherAddressTrieIdOrRoot_fail() public view {
        address other = address(uint160(account) ^ 1);
        (bool ok, bytes memory ret) =
            address(rh).staticcall(abi.encodeCall(ReviveHarness.accountInfo, (stateRoot, accountNodes, other)));
        assertFalse(ok, "another address is not proven");
        _notPresent(ret, stateRoot, rh.accountInfoKey(other));

        bytes memory otherId = _flip(trieId, trieId.length - 1);
        (ok, ret) = address(rh)
            .staticcall(abi.encodeCall(ReviveHarness.readSlot, (stateRoot, rootNodes, childNodes, otherId, index)));
        assertFalse(ok, "another trie id is not proven");
        _notPresent(ret, stateRoot, SubstrateProofs.childRootKey(otherId));

        (ok, ret) = address(rh)
            .staticcall(abi.encodeCall(ReviveHarness.readSlot, (stateRoot, childNodes, rootNodes, trieId, index)));
        assertFalse(ok, "main and child proofs swapped");
        assertEq(ret, INCOMPLETE);

        bytes32 otherRoot = stateRoot ^ bytes32(uint256(1));
        (ok, ret) =
            address(rh).staticcall(abi.encodeCall(ReviveHarness.accountInfo, (otherRoot, accountNodes, account)));
        assertFalse(ok, "AccountInfoOf under another state root");
        assertEq(ret, INCOMPLETE);
        (ok, ret) = address(rh)
            .staticcall(abi.encodeCall(ReviveHarness.readSlot, (otherRoot, rootNodes, childNodes, trieId, index)));
        assertFalse(ok, "the slot under another state root");
        assertEq(ret, INCOMPLETE);
    }

    /// CodeInfoOf and both Revive.BlockHash proofs are bound to their keys and the state root too:
    /// another code hash, the neighbouring block numbers and another state root all fail.
    function test_otherCodeHashOrBlockNumber_fail() public view {
        bytes32 otherHash = codeHash ^ bytes32(uint256(1));
        (bool ok, bytes memory ret) =
            address(rh).staticcall(abi.encodeCall(ReviveHarness.codeInfo, (stateRoot, codeInfoNodes, otherHash)));
        assertFalse(ok, "another code hash is not proven");
        _notPresent(ret, stateRoot, rh.codeInfoKey(otherHash));

        // The proof of B proves neither B + 1 nor B - 1; the proof of B - 1 neither B nor B - 2.
        uint32[2] memory numbers = [blockNumber + 1, blockNumber - 1];
        uint32[2] memory parentNumbers = [blockNumber, blockNumber - 2];
        for (uint256 i = 0; i < numbers.length; i++) {
            (ok, ret) = address(rh)
                .staticcall(abi.encodeCall(ReviveHarness.ethBlockHash, (stateRoot, blockHashNodes, numbers[i])));
            assertFalse(ok, "another block number is not proven");
            _notPresent(ret, stateRoot, rh.blockHashKey(numbers[i]));
            (ok, ret) = address(rh)
                .staticcall(
                    abi.encodeCall(ReviveHarness.ethBlockHash, (stateRoot, parentBlockHashNodes, parentNumbers[i]))
                );
            assertFalse(ok, "another block number is not proven by the proof of B - 1");
            _notPresent(ret, stateRoot, rh.blockHashKey(parentNumbers[i]));
        }

        bytes32 otherRoot = stateRoot ^ bytes32(uint256(1));
        (ok, ret) = address(rh).staticcall(abi.encodeCall(ReviveHarness.codeInfo, (otherRoot, codeInfoNodes, codeHash)));
        assertFalse(ok, "CodeInfoOf under another state root");
        assertEq(ret, INCOMPLETE);
        (ok, ret) = address(rh)
            .staticcall(abi.encodeCall(ReviveHarness.ethBlockHash, (otherRoot, blockHashNodes, blockNumber)));
        assertFalse(ok, "Revive.BlockHash(B) under another state root");
        assertEq(ret, INCOMPLETE);
        (ok, ret) = address(rh)
            .staticcall(abi.encodeCall(ReviveHarness.ethBlockHash, (otherRoot, parentBlockHashNodes, blockNumber - 1)));
        assertFalse(ok, "Revive.BlockHash(B - 1) under another state root");
        assertEq(ret, INCOMPLETE);
    }

    // ------------------------------------------------------------------ helpers

    function _accountCall(bytes[] memory nodes) internal view returns (bytes memory) {
        return abi.encodeCall(ReviveHarness.accountInfo, (stateRoot, nodes, account));
    }

    function _codeInfoCall(bytes[] memory nodes) internal view returns (bytes memory) {
        return abi.encodeCall(ReviveHarness.codeInfo, (stateRoot, nodes, codeHash));
    }

    function _rootCall(bytes[] memory nodes) internal view returns (bytes memory) {
        return abi.encodeCall(ReviveHarness.readSlot, (stateRoot, nodes, childNodes, trieId, index));
    }

    function _childCall(bytes[] memory nodes) internal view returns (bytes memory) {
        return abi.encodeCall(ReviveHarness.readSlot, (stateRoot, rootNodes, nodes, trieId, index));
    }

    function _blockHashCall(bytes[] memory nodes) internal view returns (bytes memory) {
        return abi.encodeCall(ReviveHarness.ethBlockHash, (stateRoot, nodes, blockNumber));
    }

    function _parentBlockHashCall(bytes[] memory nodes) internal view returns (bytes memory) {
        return abi.encodeCall(ReviveHarness.ethBlockHash, (stateRoot, nodes, blockNumber - 1));
    }

    /// The block parameter of an EVM call at `path` names the EVM block: {blockHash} alone, with
    /// its hash, or B's number.
    function _atEvmBlock(string memory path, bytes32 evmHash) internal view {
        if (vm.keyExistsJson(json, string.concat(path, ".blockHash"))) {
            assertEq(vm.parseJsonKeys(json, path).length, 1, "{blockHash} alone (EIP-1898)");
            assertEq(vm.parseJsonBytes32(json, string.concat(path, ".blockHash")), evmHash, "at the EVM block's hash");
        } else {
            assertEq(vm.parseJsonUint(json, path), blockNumber, "at the EVM block's number, B's");
        }
    }

    /// Flips each byte of each item in turn: every call must revert with "Incomplete Proof!".
    /// Returns the number of bytes flipped.
    function _everyByteFails(
        bytes[] storage items,
        function(bytes[] memory) internal view returns (bytes memory) callWith
    ) internal view returns (uint256 checked) {
        bytes[] memory copy = items;
        for (uint256 i = 0; i < copy.length; i++) {
            bytes memory node = copy[i];
            for (uint256 j = 0; j < node.length; j++) {
                node[j] ^= 0x01;
                (bool ok, bytes memory ret) = address(rh).staticcall(callWith(copy));
                node[j] ^= 0x01;
                assertFalse(ok, "a flipped byte must fail");
                assertEq(ret, INCOMPLETE, "the flipped item is not under its root");
                checked++;
            }
        }
    }

    /// Drops each item in turn: the walk looks the item up and fails ("Incomplete Proof!"), or,
    /// for a proof of one item (a child trie that holds one value), the library refuses the empty
    /// proof before any walk.
    function _droppedItemFails(
        bytes[] storage items,
        function(bytes[] memory) internal view returns (bytes memory) callWith
    ) internal view {
        bytes memory expected = items.length == 1
            ? abi.encodeWithSelector(SubstrateProofs.EmptyProof.selector)
            : INCOMPLETE;
        for (uint256 i = 0; i < items.length; i++) {
            (bool ok, bytes memory ret) = address(rh).staticcall(callWith(_without(items, i)));
            assertFalse(ok, "a proof without one of its items must fail");
            assertEq(ret, expected, "the dropped item is looked up, or the proof is left empty");
        }
    }

    /// `ret` is the library's KeyNotPresent(root, key), or the walk's "Incomplete Proof!".
    /// Returns true for KeyNotPresent.
    function _notPresent(bytes memory ret, bytes32 root, bytes memory key) internal view returns (bool) {
        bytes memory absent = abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, root, key);
        bool isAbsent = keccak256(ret) == keccak256(absent);
        assertTrue(isAbsent || keccak256(ret) == keccak256(INCOMPLETE), "absent, or not in the proof");
        return isAbsent;
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

    function _flip(bytes memory data, uint256 at) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        out[at] = out[at] ^ 0x01;
    }

    function _u128(Scale.Cursor memory c) internal pure returns (uint256 lo) {
        lo = c.readU64();
        lo |= uint256(c.readU64()) << 64;
    }

    function _uint(string memory path) internal view returns (uint256) {
        return vm.parseJsonUint(json, path);
    }

    /// A number the fixture writes as a decimal string (u128 values do not fit a JSON number).
    function _uintString(string memory path) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, path));
    }
}

/// Westend Asset Hub (westmint, trie V1), a parachain without GRANDPA of its own, so its header is
/// trusted input here. The capture is slot 5 of an ERC-20 in EVM bytecode, which pallet-revive
/// runs with REVM: its decimals, 6 (the fixture's slot.label).
contract ReviveStorageWestendAssetHubTest is ReviveStorageSnapshotTest {
    function _dir() internal pure override returns (string memory) {
        return "../fixtures/westend-asset-hub-revive";
    }

    /// What this capture is: Westend Asset Hub (EVM chain id 420,420,421), trie V1, and EVM bytecode
    /// rather than a PolkaVM program (which starts with "PVM\0"), as its CodeInfoOf code_type says.
    /// REVM stores the whole 32-byte word, so eth_getStorageAt's word is the stored value itself.
    function test_snapshot() public view {
        assertEq(vm.parseJsonString(json, ".provenance.chain"), "Westend Asset Hub");
        assertEq(vm.parseJsonUint(json, ".evm.chainId"), 420_420_421, "Westend Asset Hub's EVM chain id");
        assertEq(_uint(".trieVersion"), 1, "trie V1");
        bytes memory code = vm.parseJsonBytes(json, ".code.hex");
        assertEq(vm.parseJsonString(json, ".code.kind"), "evm");
        assertTrue(bytes4(code) != bytes4("PVM\x00"), "not a PolkaVM program");
        assertEq(bytes2(code), bytes2(0x6080), "Solidity's EVM prologue, PUSH1 0x80");
        (, uint8 codeType) = rh.codeInfo(stateRoot, codeInfoNodes, codeHash);
        assertEq(codeType, 1, "CodeInfoOf code_type 1: EVM bytecode");
        assertEq(vm.parseJsonString(json, ".evm.storageAt.matches"), "equal", "the word is the stored value");
        assertEq(value.length, 32, "the whole 32-byte word is stored, leading zero bytes included");
    }
}
