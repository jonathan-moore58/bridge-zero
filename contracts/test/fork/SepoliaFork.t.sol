// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {ProvenBalance, IGrandpaImporter} from "../../src/kit/ProvenBalance.sol";

/// The mainnet import and the System.Account proof on a fork of Ethereum Sepolia at its latest
/// block: the light client and ProvenBalance are deployed on the fork, initialized at the
/// set-change checkpoint of fixtures/mainnet, import the set change, then importAndProve the head.
/// Every call is sent with the EIP-7825 cap (16,777,216) as its gas limit. Nothing is sent to
/// Sepolia: the fork reads its state over RPC and executes locally, under the rules forge runs
/// (evm_version in foundry.toml). Sepolia has since moved to newer rules that price new state
/// higher; test/fork/simulate-sepolia.mjs has a Sepolia node execute the same sequence and
/// reports the gas under those rules (docs/GAS.md, "Measured light client").
///
/// Needs network access, so it runs only when SEPOLIA_FORK=1 is set; the default `forge test`
/// skips it without touching the network. Run (from contracts/):
///   SEPOLIA_FORK=1 forge test --match-path "test/fork/*" -vv
/// The RPC is SEPOLIA_RPC_URL when set, else the public endpoint below. When it cannot be
/// reached, the tests are skipped.
contract SepoliaForkTest is Test {
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;
    string internal constant PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
    string internal constant DIR = "../fixtures/mainnet";
    address internal constant BLAKE2F = address(0x09);

    string internal rpc;
    bool internal online;
    string internal offlineReason;

    struct Head {
        bytes header;
        bytes32 hash;
        uint32 number;
        bytes finalityProof;
        uint256 justificationLength;
        bytes signers;
        uint256 firstPos; // position of the first counted precommit
        uint256 firstIdx; // its authority index
    }

    GrandpaLightClient internal lc;
    ProvenBalance internal pb;
    Head internal head;
    bytes32 internal accountId;
    bytes[] internal nodes;
    ProvenBalance.AccountInfo internal expected;

    function setUp() public {
        if (!vm.envOr("SEPOLIA_FORK", false)) {
            offlineReason = "SEPOLIA_FORK is not set, skipping";
            return;
        }
        rpc = vm.envOr("SEPOLIA_RPC_URL", PUBLIC_RPC);
        try vm.createSelectFork(rpc) {
            online = true;
        } catch {
            offlineReason = "Sepolia RPC unreachable, skipping";
        }
    }

    modifier onSepolia() {
        if (!online) {
            console.log(offlineReason);
            vm.skip(true);
        }
        assertEq(block.chainid, SEPOLIA_CHAIN_ID, "forked chain is Sepolia");
        assertEq(vm.getEvmVersion(), "osaka", "runs under the osaka rules");
        console.log("Sepolia fork block:", block.number);
        _;
    }

    // ------------------------------------------------------------------ BLAKE2F

    /// EIP-152 test vector 5: the BLAKE2b compression of "abc" with 12 rounds, whose output state
    /// is the RFC 7693 Appendix A digest of "abc". Checked on the fork and by eth_call on a
    /// Sepolia node.
    function test_blake2f_rfc7693() public onSepolia {
        bytes memory input = abi.encodePacked(
            hex"0000000c",
            hex"48c9bdf267e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5",
            hex"d182e6ad7f520e511f6c3e2b8c68059b6bbd41fbabd9831f79217e1319cde05b",
            hex"6162630000000000000000000000000000000000000000000000000000000000",
            new bytes(96),
            hex"03000000000000000000000000000000",
            hex"01"
        );
        assertEq(input.length, 213, "EIP-152 input length");
        bytes memory digest = hex"ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1"
            hex"7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923";

        (bool ok, bytes memory out) = BLAKE2F.staticcall(input);
        assertTrue(ok, "BLAKE2F call on the fork");
        assertEq(out, digest, "BLAKE2F on the fork: RFC 7693 blake2b-512('abc')");

        string memory params = string.concat(
            '[{"to":"0x0000000000000000000000000000000000000009","data":"', vm.toString(input), '"},"latest"]'
        );
        bytes memory remote = vm.rpc(rpc, "eth_call", params);
        assertEq(remote, digest, "BLAKE2F by eth_call on a Sepolia node");
    }

    // ------------------------------------------------------------------ mainnet import + proof

    function test_mainnetImportAndProve() public onSepolia {
        _deployAndSync();
        _loadHead();
        _importAndProve();
        _tamperReverts();
    }

    /// Deploys both contracts (the test contract is the admin), initializes at the set-change
    /// header's parent with the set that signs the change, and imports the set change.
    function _deployAndSync() internal {
        string memory sc = vm.readFile(string.concat(DIR, "/set-change.json"));

        lc = new GrandpaLightClient();
        _log("deploy GrandpaLightClient", vm.lastFrameGas().gasTotalUsed);
        pb = new ProvenBalance(IGrandpaImporter(address(lc)));
        _log("deploy ProvenBalance", vm.lastFrameGas().gasTotalUsed);

        bytes32[] memory keys = _keys(sc, ".signingSet.authorities");
        assertEq(keys.length, 10, "10 authorities");
        _send(
            "initialize, 10 keys",
            address(lc),
            abi.encodeCall(
                GrandpaLightClient.initialize,
                (
                    vm.parseJsonBytes32(sc, ".provenance.genesisHash"),
                    uint64(vm.parseJsonUint(sc, ".signingSet.setId")),
                    keys,
                    vm.parseJsonBytes(sc, ".parentHeader.scale")
                )
            )
        );

        (bytes memory changeSigners,,) = _signers(sc);
        _send(
            "set-change import, 7 of 10",
            address(lc),
            abi.encodeCall(
                GrandpaLightClient.importHeader,
                (vm.parseJsonBytes(sc, ".header.scale"), vm.parseJsonBytes(sc, ".justification.scale"), changeSigners)
            )
        );
        assertEq(lc.currentSetId(), uint64(vm.parseJsonUint(sc, ".newSetId")), "set change enacted");
    }

    /// The head's finality proof and the System.Account proof at it.
    function _loadHead() internal {
        string memory fp = vm.readFile(string.concat(DIR, "/finality-proof-head.json"));
        string memory ap = vm.readFile(string.concat(DIR, "/account-proof.json"));
        head.header = vm.parseJsonBytes(fp, ".header.scale");
        head.hash = vm.parseJsonBytes32(fp, ".header.hash");
        head.number = uint32(vm.parseJsonUint(fp, ".header.number"));
        head.finalityProof = vm.parseJsonBytes(fp, ".finalityProof.scale");
        head.justificationLength = vm.parseJsonBytes(fp, ".justification.scale").length;
        (head.signers, head.firstPos, head.firstIdx) = _signers(fp);
        assertEq(head.signers.length, 14, "7 signers");

        assertEq(vm.parseJsonBytes32(ap, ".header.hash"), head.hash, "the account proof is at the head");
        accountId = vm.parseJsonBytes32(ap, ".account.id");
        bytes[] memory list = vm.parseJsonBytesArray(ap, ".proof.nodes");
        for (uint256 i = 0; i < list.length; i++) {
            nodes.push(list[i]);
        }
        expected = ProvenBalance.AccountInfo({
            nonce: uint32(vm.parseJsonUint(ap, ".value.decoded.nonce")),
            consumers: uint32(vm.parseJsonUint(ap, ".value.decoded.consumers")),
            providers: uint32(vm.parseJsonUint(ap, ".value.decoded.providers")),
            sufficients: uint32(vm.parseJsonUint(ap, ".value.decoded.sufficients")),
            free: uint128(vm.parseUint(vm.parseJsonString(ap, ".value.decoded.free"))),
            reserved: uint128(vm.parseUint(vm.parseJsonString(ap, ".value.decoded.reserved"))),
            miscFrozen: uint128(vm.parseUint(vm.parseJsonString(ap, ".value.decoded.miscFrozen"))),
            feeFrozen: uint128(vm.parseUint(vm.parseJsonString(ap, ".value.decoded.feeFrozen")))
        });
        assertGt(expected.free, 0);
    }

    function _importAndProve() internal {
        vm.expectEmit(true, true, true, true, address(pb));
        emit ProvenBalance.BalanceProven(head.hash, head.number, accountId, expected.free);
        bytes memory ret =
            _send("importAndProve, 7 of 10 + System.Account", address(pb), _proveCall(head.finalityProof));
        (bytes32 h, uint32 n, ProvenBalance.AccountInfo memory info) =
            abi.decode(ret, (bytes32, uint32, ProvenBalance.AccountInfo));
        assertEq(h, head.hash, "block hash");
        assertEq(n, head.number, "block number");
        assertEq(info.nonce, expected.nonce, "nonce");
        assertEq(info.consumers, expected.consumers, "consumers");
        assertEq(info.providers, expected.providers, "providers");
        assertEq(info.sufficients, expected.sufficients, "sufficients");
        assertEq(info.free, expected.free, "free");
        assertEq(info.reserved, expected.reserved, "reserved");
        assertEq(info.miscFrozen, expected.miscFrozen, "miscFrozen");
        assertEq(info.feeFrozen, expected.feeFrozen, "feeFrozen");
        assertTrue(lc.isImported(head.hash), "head imported");
        (bytes32 latest,) = lc.latestFinalized();
        assertEq(latest, head.hash, "head is the latest finalized");
    }

    /// One byte of the first counted precommit's signature (R) flipped. FinalityProof = block
    /// hash, compact length, justification; precommits start 45 bytes into the justification and
    /// are 132 bytes each (target hash, number, signature, authority id).
    function _tamperReverts() internal {
        uint256 at = 32 + _compactLen(head.justificationLength) + 45 + head.firstPos * 132 + 36;
        bytes memory bad = bytes.concat(head.finalityProof);
        bad[at] ^= 0x01;
        vm.expectRevert(abi.encodeWithSelector(GrandpaLightClient.InvalidSignature.selector, 0, head.firstIdx));
        (bool ok,) = address(pb).call{gas: TX_GAS_CAP}(_proveCall(bad));
        ok;
        console.log("Sepolia fork: one flipped signature byte reverts with InvalidSignature");
    }

    function _proveCall(bytes memory finalityProof) internal view returns (bytes memory) {
        return
            abi.encodeCall(ProvenBalance.importAndProve, (head.header, finalityProof, head.signers, accountId, nodes));
    }

    // ------------------------------------------------------------------ helpers

    /// Sends `data` with the per-transaction cap as gas limit (isolate: its own transaction);
    /// requires success and that the transaction's gas fits the cap.
    function _send(string memory label, address to, bytes memory data) internal returns (bytes memory ret) {
        assertTrue(vm.isIsolateMode(), "run with isolate, so each call is measured as a transaction");
        bool ok;
        (ok, ret) = to.call{gas: TX_GAS_CAP}(data);
        uint256 txGas = vm.lastFrameGas().gasTotalUsed;
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        assertLe(txGas, TX_GAS_CAP, "within the EIP-7825 cap");
        _log(label, txGas);
    }

    function _log(string memory label, uint256 txGas) internal pure {
        console.log(string.concat("Sepolia fork: ", label, ", transaction gas:"), txGas);
        console.log("  share of the 16,777,216 cap, in basis points:", txGas * 10_000 / TX_GAS_CAP);
    }

    function _keys(string memory json, string memory path) internal view returns (bytes32[] memory keys) {
        keys = new bytes32[](_count(json, path));
        for (uint256 i = 0; i < keys.length; i++) {
            keys[i] = vm.parseJsonBytes32(json, string.concat(path, "[", vm.toString(i), "].id"));
        }
    }

    /// The signers hint (2 bytes per precommit: position, authority index; sorted by index), and
    /// the position and authority index of the first counted precommit.
    function _signers(string memory json) internal view returns (bytes memory out, uint256 firstPos, uint256 firstIdx) {
        string memory path = ".justification.precommits";
        uint256 count = _count(json, path);
        uint256[] memory p = new uint256[](count);
        uint256[] memory a = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            p[i] = i;
            a[i] = vm.parseJsonUint(json, string.concat(path, "[", vm.toString(i), "].authorityIndex"));
        }
        for (uint256 i = 1; i < count; i++) {
            for (uint256 k = i; k > 0 && a[k - 1] > a[k]; k--) {
                (a[k - 1], a[k]) = (a[k], a[k - 1]);
                (p[k - 1], p[k]) = (p[k], p[k - 1]);
            }
        }
        out = new bytes(2 * count);
        for (uint256 i = 0; i < count; i++) {
            out[2 * i] = bytes1(uint8(p[i]));
            out[2 * i + 1] = bytes1(uint8(a[i]));
        }
        firstPos = p[0];
        firstIdx = a[0];
    }

    function _count(string memory json, string memory path) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(path, "[", vm.toString(n), "]"))) n++;
    }

    /// Byte length of the SCALE compact encoding of `v`.
    function _compactLen(uint256 v) internal pure returns (uint256) {
        if (v < 1 << 6) return 1;
        if (v < 1 << 14) return 2;
        if (v < 1 << 30) return 4;
        uint256 n;
        while (v > 0) {
            n++;
            v >>= 8;
        }
        return 1 + n;
    }
}
