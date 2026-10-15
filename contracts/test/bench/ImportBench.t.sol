// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {BLAKE2b} from "blake2b-solidity/BLAKE2b.sol";
import {SCL_EIP6565} from "crypto-lib/lib/libSCL_EIP6565.sol";
import {PolkadotTrie} from "../../src/trie/vendor/PolkadotTrie.sol";
import {BenchFixtures, GrandpaPayload} from "./BenchFixtures.sol";
import {SclEd25519Bench} from "./Ed25519Bench.t.sol";

/// ABI form of a justification for the stand-in below: every precommit is on the commit target.
struct BenchJustification {
    bytes32 targetHash;
    uint32 targetNumber;
    uint64 round;
    uint64 setId;
    uint16[] authorityIndex; // strictly increasing
    bytes32[] r; // signature bytes 0..32
    bytes32[] s; // signature bytes 32..64
}

/// Benchmark stand-in for one mainnet import followed by a storage read, all in one call: keys
/// are loaded from storage by authority index, every precommit signature is checked over the
/// 53-byte payload, the header must hash to the commit target, the state root is read from the
/// header, the System.Account proof is walked against it, and one storage slot is written.
/// It is not the light client: SCALE decoding of the justification, the authority-set
/// bookkeeping and events are left out (docs/GAS.md lists what they add).
abstract contract ImportBenchBase {
    bytes32 public lastStateRoot;

    function _authorityCount() internal view virtual returns (uint256);

    function _verify(uint256 index, bytes32 r, bytes32 s, bytes memory payload) internal view virtual returns (bool);

    function importAndRead(
        bytes calldata header,
        BenchJustification calldata j,
        bytes[] calldata proof,
        bytes calldata key
    ) external returns (bytes memory value) {
        _checkSignatures(j);
        require(bytes32(BLAKE2b.hash(header, "", "", "", 32)) == j.targetHash, "header hash mismatch");
        bytes32 stateRoot = _stateRoot(header);
        value = _read(stateRoot, proof, key);
        lastStateRoot = stateRoot;
    }

    function _checkSignatures(BenchJustification calldata j) internal view {
        bytes memory payload = GrandpaPayload.precommit(j.targetHash, j.targetNumber, j.round, j.setId);
        uint256 n = _authorityCount();
        uint256 valid;
        for (uint256 i = 0; i < j.authorityIndex.length; i++) {
            uint256 index = j.authorityIndex[i];
            require(i == 0 || index > j.authorityIndex[i - 1], "signers not increasing");
            require(index < n, "unknown signer");
            require(_verify(index, j.r[i], j.s[i], payload), "invalid signature");
            valid++;
        }
        require(valid >= n - (n - 1) / 3, "below threshold");
    }

    function _read(bytes32 stateRoot, bytes[] calldata proof, bytes calldata key) internal view returns (bytes memory) {
        bytes[] memory keys = new bytes[](1);
        keys[0] = key;
        PolkadotTrie.StorageValue[] memory values = PolkadotTrie.VerifyProof(stateRoot, proof, keys);
        require(values[0].keyPresent, "key not in state");
        return values[0].value;
    }

    /// state_root follows the parent hash and the SCALE compact block number (1, 2 or 4 bytes).
    function _stateRoot(bytes calldata header) internal pure returns (bytes32 root) {
        uint256 mode = uint8(header[32]) & 3;
        require(mode != 3, "block number too large");
        uint256 offset = 32 + (1 << mode);
        root = bytes32(header[offset:offset + 32]);
    }
}

/// SCL: each authority is stored as its extended key (Wx, Wy, key: 3 slots), expanded once.
contract SclImportBench is ImportBenchBase {
    uint256[3][] internal authorities;

    function setAuthorities(uint256[5][] calldata ext) external {
        delete authorities;
        for (uint256 i = 0; i < ext.length; i++) {
            authorities.push([ext[i][0], ext[i][1], ext[i][4]]);
        }
    }

    function _authorityCount() internal view override returns (uint256) {
        return authorities.length;
    }

    function _verify(uint256 index, bytes32 r, bytes32 s, bytes memory payload) internal view override returns (bool) {
        uint256[3] storage a = authorities[index];
        uint256[5] memory ext = [a[0], a[1], 0, 0, a[2]];
        return SCL_EIP6565.Verify_LE(string(payload), uint256(r), uint256(s), ext);
    }
}

contract ImportBenchTest is BenchFixtures {
    SclEd25519Bench internal expander;
    SclImportBench internal scl;

    bytes32[] internal setKeys; // the 10 keys of set 3895, in :grandpa_authorities order
    bytes internal header;
    bytes[] internal proof;
    bytes internal storageKey;
    bytes internal accountValue;

    function setUp() public {
        expander = new SclEd25519Bench();
        scl = new SclImportBench();
        string memory json = vm.readFile(HEAD);
        setKeys = _signingSetKeys(json);
        assertEq(setKeys.length, 10, "set 3895 has 10 authorities");
        header = vm.parseJsonBytes(json, ".header.scale");
        string memory proofJson = vm.readFile(ACCOUNT_PROOF);
        bytes[] memory nodes = vm.parseJsonBytesArray(proofJson, ".proof.nodes");
        for (uint256 i = 0; i < nodes.length; i++) {
            proof.push(nodes[i]);
        }
        storageKey = vm.parseJsonBytes(proofJson, ".key.hex");
        accountValue = vm.parseJsonBytes(proofJson, ".value.scale");
    }

    /// Mainnet, 7 of 10, SCL: one call, sent with exactly the EIP-7825 cap as its gas limit.
    function test_import_scl_7of10() public {
        _requireOsaka();
        _setScl(setKeys);
        _report("SCL, mainnet 7 of 10", address(scl), _justification(type(uint256).max));
    }

    /// One authority, one signature (the shape of a V3 dev-chain import), with mainnet data:
    /// the set is reduced to the key of precommit 0, so the threshold is 1.
    function test_import_scl_1of1() public {
        _requireOsaka();
        Justified memory head = _loadHead();
        bytes32[] memory one = new bytes32[](1);
        one[0] = head.precommits[0].key;
        _setScl(one);
        BenchJustification memory j = _justification(0);
        j.authorityIndex[0] = 0;
        _report("SCL, 1 of 1", address(scl), j);
    }

    /// A flipped signature bit, header bit or proof bit makes the call revert, within the cap.
    function test_import_scl_tampersRevert() public {
        _setScl(setKeys);
        BenchJustification memory j = _justification(type(uint256).max);

        bytes32 s3 = j.s[3];
        j.s[3] = _flipBit(s3, 0, 0);
        vm.expectRevert(bytes("invalid signature"));
        scl.importAndRead{gas: TX_GAS_CAP}(header, j, proof, storageKey);
        j.s[3] = s3;

        vm.expectRevert(bytes("header hash mismatch"));
        scl.importAndRead{gas: TX_GAS_CAP}(_flipBit(header, 120, 0), j, proof, storageKey);

        bytes[] memory badProof = proof;
        badProof[4] = _flipBit(proof[4], 40, 0);
        vm.expectRevert(bytes("Incomplete Proof!"));
        scl.importAndRead{gas: TX_GAS_CAP}(header, j, badProof, storageKey);

        // and the untouched input still goes through
        assertEq(scl.importAndRead{gas: TX_GAS_CAP}(header, j, proof, storageKey), accountValue);
    }

    // ---------------------------------------------------------------- helpers

    /// Expands the keys with SCL (once per key) and stores them; logs the cost of both steps.
    function _setScl(bytes32[] memory keys) internal {
        uint256[5][] memory ext = new uint256[5][](keys.length);
        uint256 expandGas;
        for (uint256 i = 0; i < keys.length; i++) {
            uint256 g;
            (ext[i], g) = expander.expandKey(keys[i]);
            expandGas += g;
        }
        scl.setAuthorities(ext);
        console.log("SCL key expansion for the set:", expandGas);
        console.log("SCL extended keys stored, transaction gas (3 slots per key):", vm.lastFrameGas().gasTotalUsed);
    }

    /// The head justification in ABI form, precommits sorted by authority index. `only` keeps a
    /// single precommit (by position in the fixture); type(uint256).max keeps all of them.
    function _justification(uint256 only) internal view returns (BenchJustification memory j) {
        Justified memory head = _loadHead();
        string memory json = vm.readFile(HEAD);
        j.targetHash = head.blockHash;
        j.targetNumber = head.number;
        j.round = head.round;
        j.setId = head.setId;

        uint256 count = head.precommits.length;
        uint256[] memory index = new uint256[](count);
        uint256[] memory order = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            index[i] =
                vm.parseJsonUint(json, string.concat(".justification.precommits[", vm.toString(i), "].authorityIndex"));
            order[i] = i;
        }
        for (uint256 i = 1; i < count; i++) {
            for (uint256 k = i; k > 0 && index[order[k - 1]] > index[order[k]]; k--) {
                (order[k - 1], order[k]) = (order[k], order[k - 1]);
            }
        }

        uint256 n = only == type(uint256).max ? count : 1;
        j.authorityIndex = new uint16[](n);
        j.r = new bytes32[](n);
        j.s = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 at = only == type(uint256).max ? order[i] : only;
            j.authorityIndex[i] = uint16(index[at]);
            j.r[i] = head.precommits[at].r;
            j.s[i] = head.precommits[at].s;
        }
    }

    /// Sends the import with the EIP-7825 cap as its gas limit and logs the transaction's gas.
    /// forge runs with `isolate` here, so this top-level call executes as its own transaction:
    /// cold storage and accounts, and lastFrameGas() includes the intrinsic gas (21,000 plus
    /// calldata, or the EIP-7623 floor if higher).
    function _report(string memory label, address target, BenchJustification memory j) internal {
        assertTrue(vm.isIsolateMode(), "run with isolate, so the import is measured as a transaction");
        bytes memory data = abi.encodeCall(ImportBenchBase.importAndRead, (header, j, proof, storageKey));
        (bool ok, bytes memory ret) = target.call{gas: TX_GAS_CAP}(data);
        uint256 txGas = vm.lastFrameGas().gasTotalUsed;
        assertTrue(ok, "import fits in one transaction under the cap");
        assertEq(abi.decode(ret, (bytes)), accountValue, "the proven value is the captured AccountInfo");
        assertLe(txGas, TX_GAS_CAP, "within the EIP-7825 cap");
        console.log(string.concat(label, ", calldata bytes:"), data.length);
        console.log(string.concat(label, ", intrinsic gas (21,000 + calldata):"), _intrinsicGas(data));
        console.log(string.concat(label, ", transaction gas:"), txGas);
        console.log(string.concat(label, ", headroom to 16,777,216:"), TX_GAS_CAP - txGas);
    }
}
