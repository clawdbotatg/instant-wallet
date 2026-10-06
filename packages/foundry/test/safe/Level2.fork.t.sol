// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SafeBase.sol";

interface IModuleProxyFactory {
    function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

enum ParameterType {
    None,
    Static,
    Dynamic,
    Tuple,
    Array,
    Calldata,
    AbiEncoded
}

enum ExecutionOptions {
    None,
    Send,
    DelegateCall,
    Both
}

struct ConditionFlat {
    uint8 parent;
    ParameterType paramType;
    uint8 operator;
    bytes compValue;
}

interface IRoles {
    function enableModule(address module) external;
    function assignRoles(address module, bytes32[] calldata roleKeys, bool[] calldata memberOf) external;
    function scopeTarget(bytes32 roleKey, address targetAddress) external;
    function scopeFunction(
        bytes32 roleKey,
        address targetAddress,
        bytes4 selector,
        ConditionFlat[] memory conditions,
        ExecutionOptions options
    ) external;
    function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)
        external;
    function setTransactionUnwrapper(address to, bytes4 selector, address adapter) external;
    function execTransactionWithRole(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        bytes32 roleKey,
        bool shouldRevert
    ) external returns (bool);
    function moduleTxHash(bytes calldata data, bytes32 salt) external view returns (bytes32);
    function allowances(bytes32 key)
        external
        view
        returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp);
    function revokeTarget(bytes32 roleKey, address targetAddress) external;
    function disableModule(address prevModule, address module) external;
}

interface IMulticall3Value {
    struct Call3Value {
        address target;
        bool allowFailure;
        uint256 value;
        bytes callData;
    }

    function aggregate3Value(Call3Value[] calldata calls) external payable returns (bytes[] memory);
}

/// Level 2: MetaMask (an EOA) is added as an owner, threshold 2. The burner keeps a daily budget through
/// Zodiac Roles 2.1.1: it signs a Roles call, a relay submits it (no Safe owner signature needed).
contract Level2Test is SafeBase {
    address constant MODULE_FACTORY = 0x000000000000aDdB49795b0f9bA5BC298cDda236; // zodiac 1.2.0
    address constant ROLES_MASTERCOPY = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5; // Roles 2.1.1
    address constant MULTISEND_UNWRAPPER = 0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD;
    bytes32 constant ROLE = keccak256("instant-wallet.burner");
    bytes32 constant KEY_USDC = keccak256("instant-wallet.burner.usdc");
    bytes32 constant KEY_ETH = keccak256("instant-wallet.burner.eth");
    uint8 constant OP_PASS = 0;
    uint8 constant OP_MATCHES = 5;
    uint8 constant OP_WITHIN_ALLOWANCE = 28;
    uint8 constant OP_ETHER_WITHIN_ALLOWANCE = 29;

    Passkey burner;
    address burnerSigner;
    uint256 hotPk = uint256(keccak256("metamask"));
    address hot;
    ISafe safe;
    IRoles roles;
    address bob = makeAddr("instant-wallet test recipient");

    function setUp() public {
        _forkBase();
        burner = _passkey("burner");
        burnerSigner = _deploySigner(burner);
        safe = _deploySafe(burnerSigner);
        hot = vm.addr(hotPk);
        _dealUSDC(address(safe), 1000e6);
        vm.deal(address(safe), 1 ether);
        _levelUp();
    }

    function _rolesAddress(address safe_) internal pure returns (address) {
        bytes memory init = abi.encodeWithSignature("setUp(bytes)", abi.encode(safe_, safe_, safe_));
        bytes32 salt = keccak256(abi.encodePacked(keccak256(init), uint256(0)));
        bytes memory code = abi.encodePacked(
            hex"602d8060093d393df3363d3d373d3d3d363d73", ROLES_MASTERCOPY, hex"5af43d82803e903d91602b57fd5bf3"
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), MODULE_FACTORY, salt, keccak256(code)))))
        );
    }

    function _usdcConditions() internal pure returns (ConditionFlat[] memory c) {
        // transfer(address to, uint256 amount): any recipient, amount within the daily allowance
        c = new ConditionFlat[](3);
        c[0] = ConditionFlat(0, ParameterType.Calldata, OP_MATCHES, "");
        c[1] = ConditionFlat(0, ParameterType.Static, OP_PASS, "");
        c[2] = ConditionFlat(0, ParameterType.Static, OP_WITHIN_ALLOWANCE, abi.encode(KEY_USDC));
    }

    function _ethConditions() internal pure returns (ConditionFlat[] memory c) {
        // Multicall3.aggregate3Value((address,bool,uint256,bytes)[]): the ETH sent within the daily allowance.
        // Multicall3 holds nothing, so its inner calls can only spend the ETH this call gives it.
        c = new ConditionFlat[](8);
        c[0] = ConditionFlat(0, ParameterType.Calldata, OP_MATCHES, "");
        c[1] = ConditionFlat(0, ParameterType.Array, OP_PASS, "");
        c[2] = ConditionFlat(0, ParameterType.None, OP_ETHER_WITHIN_ALLOWANCE, abi.encode(KEY_ETH));
        c[3] = ConditionFlat(1, ParameterType.Tuple, OP_PASS, "");
        c[4] = ConditionFlat(3, ParameterType.Static, OP_PASS, "");
        c[5] = ConditionFlat(3, ParameterType.Static, OP_PASS, "");
        c[6] = ConditionFlat(3, ParameterType.Static, OP_PASS, "");
        c[7] = ConditionFlat(3, ParameterType.Dynamic, OP_PASS, "");
    }

    /// One batch signed by the burner alone (it is still the only owner): deploy Roles, wire the burner's
    /// budget, add MetaMask, threshold 2.
    function _levelUp() internal {
        roles = IRoles(_rolesAddress(address(safe)));
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = ROLE;
        bool[] memory yes = new bool[](1);
        yes[0] = true;
        bytes memory init = abi.encodeWithSignature("setUp(bytes)", abi.encode(safe, safe, safe));
        uint64 today = uint64(block.timestamp);
        SafeTx memory t = _batch(
            abi.encodePacked(
                _call(MODULE_FACTORY, 0, abi.encodeCall(IModuleProxyFactory.deployModule, (ROLES_MASTERCOPY, init, 0))),
                _call(address(safe), 0, abi.encodeCall(ISafe.enableModule, (address(roles)))),
                _call(address(roles), 0, abi.encodeCall(IRoles.enableModule, (burnerSigner))),
                _call(address(roles), 0, abi.encodeCall(IRoles.assignRoles, (burnerSigner, keys, yes))),
                _call(
                    address(roles),
                    0,
                    abi.encodeCall(
                        IRoles.setTransactionUnwrapper,
                        (MULTISEND_CALL_ONLY, bytes4(keccak256("multiSend(bytes)")), MULTISEND_UNWRAPPER)
                    )
                ),
                _rolesSetup(today),
                _call(address(safe), 0, abi.encodeCall(ISafe.addOwnerWithThreshold, (hot, 2)))
            )
        );
        assertTrue(_exec(safe, t, _encodeSigs(_one(_passkeySig(burner, _hash(safe, t))))));
        assertEq(address(roles).code.length > 0, true);
    }

    function _rolesSetup(uint64 today) internal view returns (bytes memory) {
        return abi.encodePacked(
            _call(address(roles), 0, abi.encodeCall(IRoles.scopeTarget, (ROLE, USDC))),
            _call(
                address(roles),
                0,
                abi.encodeCall(
                    IRoles.scopeFunction, (ROLE, USDC, IERC20.transfer.selector, _usdcConditions(), ExecutionOptions.None)
                )
            ),
            _call(address(roles), 0, abi.encodeCall(IRoles.setAllowance, (KEY_USDC, 100e6, 100e6, 100e6, 1 days, today))),
            _call(address(roles), 0, abi.encodeCall(IRoles.scopeTarget, (ROLE, MULTICALL3))),
            _call(
                address(roles),
                0,
                abi.encodeCall(
                    IRoles.scopeFunction,
                    (ROLE, MULTICALL3, IMulticall3Value.aggregate3Value.selector, _ethConditions(), ExecutionOptions.Send)
                )
            ),
            _call(
                address(roles), 0, abi.encodeCall(IRoles.setAllowance, (KEY_ETH, 0.04 ether, 0.04 ether, 0.04 ether, 1 days, today))
            )
        );
    }

    // ------------------------------------------------------------ burner calls through Roles

    /// The calldata a relay sends: execTransactionWithRole(...) ‖ burner's WebAuthn signature ‖ salt ‖ (r = signer,
    /// s = where the signature starts, v = 0).
    function _signedRolesCall(Passkey memory k, address signer, bytes memory call, bytes32 salt)
        internal
        view
        returns (bytes memory)
    {
        bytes32 h = roles.moduleTxHash(call, salt);
        bytes memory sig = _webauthn(k, h);
        return abi.encodePacked(call, sig, salt, bytes32(uint256(uint160(signer))), bytes32(call.length), uint8(0));
    }

    function _burnerSends(bytes memory packed, bytes32 salt) internal returns (bool ok) {
        bytes memory call = abi.encodeCall(
            IRoles.execTransactionWithRole,
            (MULTISEND_CALL_ONLY, 0, _multiSend(packed), Operation.DelegateCall, ROLE, true)
        );
        vm.prank(relayer, relayer);
        (ok,) = address(roles).call(_signedRolesCall(burner, burnerSigner, call, salt));
    }

    function _burnerSendsETH(address to, uint256 amount, bytes32 salt) internal returns (bool ok) {
        IMulticall3Value.Call3Value[] memory calls = new IMulticall3Value.Call3Value[](1);
        calls[0] = IMulticall3Value.Call3Value(to, false, amount, "");
        bytes memory call = abi.encodeCall(
            IRoles.execTransactionWithRole,
            (MULTICALL3, amount, abi.encodeCall(IMulticall3Value.aggregate3Value, (calls)), Operation.Call, ROLE, true)
        );
        vm.prank(relayer, relayer);
        (ok,) = address(roles).call(_signedRolesCall(burner, burnerSigner, call, salt));
    }

    function test_levelUpWiring() public view {
        assertEq(safe.getThreshold(), 2);
        assertTrue(safe.isOwner(hot));
        assertTrue(safe.isOwner(burnerSigner));
        assertTrue(safe.isModuleEnabled(address(roles)));
        assertTrue(safe.isModuleEnabled(RECOVERY_7D));
    }

    function test_burnerSpendsWithinItsBudgetAndPaysTheRelay() public {
        assertTrue(_burnerSends(abi.encodePacked(_usdcTransfer(bob, 60e6), _usdcTransfer(relayer, 0.05e6)), "a"));
        assertEq(IERC20(USDC).balanceOf(bob), 60e6);
        assertEq(IERC20(USDC).balanceOf(relayer), 0.05e6);
        (,,, uint128 left,) = roles.allowances(KEY_USDC);
        assertEq(left, 100e6 - 60.05e6);
    }

    function test_burnerCantGoOverItsBudget() public {
        assertTrue(_burnerSends(_usdcTransfer(bob, 60e6), "a"));
        assertFalse(_burnerSends(_usdcTransfer(bob, 41e6), "b"));
        assertTrue(_burnerSends(_usdcTransfer(bob, 40e6), "c"));
        assertEq(IERC20(USDC).balanceOf(bob), 100e6);
        assertFalse(_burnerSends(_usdcTransfer(bob, 1), "d"));
    }

    function test_budgetRefillsNextDay() public {
        assertTrue(_burnerSends(_usdcTransfer(bob, 100e6), "a"));
        assertFalse(_burnerSends(_usdcTransfer(bob, 1e6), "b"));
        vm.warp(block.timestamp + 1 days);
        assertTrue(_burnerSends(_usdcTransfer(bob, 100e6), "c"));
        // it doesn't stack: two days later it's still one day's worth
        vm.warp(block.timestamp + 3 days);
        assertFalse(_burnerSends(_usdcTransfer(bob, 101e6), "d"));
    }

    function test_replayedBurnerCallFails() public {
        assertTrue(_burnerSends(_usdcTransfer(bob, 10e6), "same salt"));
        assertFalse(_burnerSends(_usdcTransfer(bob, 10e6), "same salt"));
        assertEq(IERC20(USDC).balanceOf(bob), 10e6);
    }

    function test_burnerCantSpendOtherTokensOrCallOtherThings() public {
        address weth = 0x4200000000000000000000000000000000000006;
        deal(weth, address(safe), 1 ether);
        assertFalse(_burnerSends(_call(weth, 0, abi.encodeCall(IERC20.transfer, (bob, 1))), "a"));
        // approvals are not allowed either
        assertFalse(_burnerSends(_call(USDC, 0, abi.encodeCall(IERC20.approve, (bob, 1e6))), "b"));
        // nor any Safe change
        assertFalse(_burnerSends(_call(address(safe), 0, abi.encodeCall(ISafe.changeThreshold, (1))), "c"));
        assertFalse(
            _burnerSends(_call(address(roles), 0, abi.encodeCall(IRoles.setAllowance, (KEY_USDC, 1e12, 1e12, 1e12, 1, 0))), "d")
        );
    }

    function test_someoneElsesPasskeyCantUseTheBudget() public {
        Passkey memory other = _passkey("other");
        address otherSigner = _deploySigner(other);
        bytes memory call = abi.encodeCall(
            IRoles.execTransactionWithRole,
            (MULTISEND_CALL_ONLY, 0, _multiSend(_usdcTransfer(bob, 1e6)), Operation.DelegateCall, ROLE, true)
        );
        // signed by another key, claiming to be the burner
        bytes32 h = roles.moduleTxHash(call, "x");
        bytes memory forged =
            abi.encodePacked(call, _webauthn(other, h), bytes32("x"), bytes32(uint256(uint160(burnerSigner))), bytes32(call.length), uint8(0));
        (bool ok,) = address(roles).call(forged);
        assertFalse(ok);
        // signed by another key as itself: not a member
        (ok,) = address(roles).call(_signedRolesCall(other, otherSigner, call, "y"));
        assertFalse(ok);
    }

    function test_burnerSendsETHWithinItsBudget() public {
        assertTrue(_burnerSendsETH(bob, 0.03 ether, "a"));
        assertEq(bob.balance, 0.03 ether);
        assertFalse(_burnerSendsETH(bob, 0.011 ether, "b"));
        assertTrue(_burnerSendsETH(bob, 0.01 ether, "c"));
    }

    function test_burnerAloneCantUseTheSafe() public {
        SafeTx memory t = _batch(_usdcTransfer(bob, 500e6));
        bytes memory sigs = _encodeSigs(_one(_passkeySig(burner, _hash(safe, t))));
        vm.expectRevert(); // one signature for threshold 2 (GS020/GS021 depending on its type)
        _exec(safe, t, sigs);
    }

    function test_hotAloneCantUseTheSafe() public {
        SafeTx memory t = _batch(_usdcTransfer(bob, 500e6));
        bytes memory sigs = _encodeSigs(_one(_eoaSig(hotPk, _hash(safe, t))));
        vm.expectRevert(bytes("GS020"));
        _exec(safe, t, sigs);
    }

    function test_burnerPlusHotCanDoAnything() public {
        SafeTx memory t = _batch(_usdcTransfer(bob, 900e6));
        bytes32 h = _hash(safe, t);
        Sig[] memory s = new Sig[](2);
        s[0] = _passkeySig(burner, h);
        s[1] = _eoaSig(hotPk, h);
        assertTrue(_exec(safe, t, _encodeSigs(s)));
        assertEq(IERC20(USDC).balanceOf(bob), 900e6);
    }

    function test_ownersCanRaiseTheBudget() public {
        SafeTx memory t = SafeTx(
            address(roles),
            0,
            abi.encodeCall(IRoles.setAllowance, (KEY_USDC, 1000e6, 1000e6, 1000e6, 1 days, uint64(block.timestamp))),
            Operation.Call
        );
        bytes32 h = _hash(safe, t);
        Sig[] memory s = new Sig[](2);
        s[0] = _passkeySig(burner, h);
        s[1] = _eoaSig(hotPk, h);
        assertTrue(_exec(safe, t, _encodeSigs(s)));
        assertTrue(_burnerSends(_usdcTransfer(bob, 500e6), "a"));
    }

    function test_hotStopsAStolenBurner() public {
        // here with both signatures; the one-key "protect" role comes with phase 4
        SafeTx memory t = SafeTx(address(roles), 0, abi.encodeCall(IRoles.revokeTarget, (ROLE, USDC)), Operation.Call);
        bytes32 h = _hash(safe, t);
        Sig[] memory s = new Sig[](2);
        s[0] = _passkeySig(burner, h);
        s[1] = _eoaSig(hotPk, h);
        assertTrue(_exec(safe, t, _encodeSigs(s)));
        assertFalse(_burnerSends(_usdcTransfer(bob, 1e6), "a"));
    }
}
