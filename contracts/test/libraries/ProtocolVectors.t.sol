// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../utils/MiniTest.sol";
import {Poseidon2Hasher} from "../../src/hasher/Poseidon2Hasher.sol";
import {IHasher} from "../../src/libraries/IHasher.sol";
import {NoteLib} from "../../src/libraries/NoteLib.sol";
import {NullifierLib} from "../../src/libraries/NullifierLib.sol";

/// The Solidity libraries against circuits/vectors/primitives.json (the seventh review round, 2026-11-03): the owner commitment, the note
/// body, the commitment, the nullifier and the phantom of the sample note — the values the TypeScript reference, the Rust core, the Python
/// reference and the circuit are pinned to. Before, the Solidity layer was pinned only through the end-to-end real-proof test.
contract ProtocolVectorsTest is Test {
    IHasher internal h;

    // circuits/vectors/primitives.json: keys.spendKey and sampleNote
    uint256 internal constant SPEND_KEY = 19069277275575830376041861371178238667629648361860576430786740294780284255794;
    uint256 internal constant OWNER_COMMITMENT = 6296251118823642552905479752093160106216242361714863370242727181463510312526;
    uint256 internal constant VAULT_ID = 171;
    uint256 internal constant AMOUNT = 1000000000000000000;
    uint256 internal constant NOTE_SECRET = 11501897306810649921226615145916377511217047860362527109580516595403634051394;
    uint256 internal constant LEAF_INDEX = 0;
    uint256 internal constant BODY = 7036011642237197311999862065151222355796997821170127520998926338364275402714;
    uint256 internal constant COMMITMENT = 12595268047360202351094213505007419247851492103840245511985528164260469941520;
    uint256 internal constant NULLIFIER = 12644030007897431547901765497318272837449284482345902727017064648987225373916;
    uint256 internal constant PHANTOM = 8214221301253560742094663349026827647901783686994563075300515413426606118119;

    function setUp() public {
        h = IHasher(address(new Poseidon2Hasher()));
    }

    function test_SampleNoteMatchesThePrimitiveVectors() public view {
        assertEq(NoteLib.ownerCommitment(h, SPEND_KEY), OWNER_COMMITMENT, "ownerCommitment(spendKey)");
        assertEq(NoteLib.noteBody(h, VAULT_ID, AMOUNT, OWNER_COMMITMENT, NOTE_SECRET), BODY, "noteBody");
        assertEq(NoteLib.noteCommitment(h, BODY, LEAF_INDEX), COMMITMENT, "noteCommitment(body, 0)");
        assertEq(NullifierLib.nullifier(h, COMMITMENT, SPEND_KEY), NULLIFIER, "nullifier(commitment, spendKey)");
        assertEq(NullifierLib.phantom(h, NULLIFIER, 1, SPEND_KEY), PHANTOM, "phantom(nullifier, 1, spendKey)");
    }
}
