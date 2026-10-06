# Instant Wallet revised plan review

Date: 2026-10-05. Author: Codex. Plan reviewed: [PLAN.md](PLAN.md) at commit `fe57c3f`.

The revisions fix several earlier problems. The group approval now targets the group Safe, domain loss requires replacing the passkey, and the paper backup format is defined. Serious gaps remain in recovery, key changes, batching, and deployment on other chains. Resolve them before relying on the affected features with real money.

This is a follow-up to [the original report](PLAN-REVIEW-2026-10-05.md). It records design problems and contract constraints, not proven exploits against a deployed wallet. No fork tests, hardware tests, deployment checks, or code changes were performed. Source references below support the relevant contract behavior; the proposed custom composition remains untested.

## Major findings

### 1 Guards do not automatically see every change inside a batch

**Location:** PLAN.md lines 110–114.

The plan says the guard sees every change to owners, threshold, key roles, and rules. Safe guards run before and after a transaction. They do not automatically receive a callback for each call inside MultiSend.

A batch can change owners from A to B and back to A. A guard comparing the initial and final owner lists would miss that change. Arbitrary delegatecalls can also write Safe storage directly. An epoch counter only helps if every relevant change actually updates it.

**Fix:** Define the allowed batching and delegatecall paths. Inspect relevant inner operations or enforce configuration changes through a controlled path. Explain how every supported change updates the epoch.

**Test:** Queue a move, change owners away and back within one batch, then attempt the old move. It must fail. Repeat for threshold and rule changes, nested batches, and recovery.

Sources: [Safe guard interface](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/base/GuardManager.sol), [MultiSend](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/libraries/MultiSend.sol).

### 2 Old keys can keep spending after recovery before phase 4

**Location:** PLAN.md lines 156–161.

Before the custom guard exists, recovery changes owners but leaves the old burner's Roles access active until a later cleanup transaction. Calling the exposure “one day's burner budget” is incorrect. If cleanup fails, the old burner can spend again after each refill.

**Fix:** Provide atomic revocation before introducing Roles, or explicitly describe the exposure as continuing until cleanup succeeds. A fast app transaction cannot establish a fixed loss bound.

**Test:** Recover a phase-2 wallet, keep the app offline, and try the old burner immediately and after multiple refill periods. Verify the intended revocation mechanism.

Sources: [Candide recovery](https://github.com/candidelabs/candide-contracts/blob/main/contracts/modules/social_recovery/SocialRecoveryModule.sol), [Roles allowance accounting](https://github.com/gnosisguild/zodiac-modifier-roles/blob/main/packages/evm/contracts/AllowanceTracker.sol). These main-branch references must be matched to the selected deployed releases.

### 3 Key removal and role mapping need a complete transition rule

**Location:** PLAN.md lines 104–109 and 195–199.

A Safe with four owners and threshold four cannot remove an owner while keeping threshold four. Lowering the threshold changes which keys can execute directly through Safe. The wedgie's two owner slots make this especially important.

The custom module also refuses to operate when its role map does not match the owners. A removal can therefore disable the module unless the map is updated in the same transaction. After recovery, the plan needs a defined way for the new owners to set the map while the module is disabled.

These are missing transition rules, not proof that removal always creates a takeover or permanently freezes the wallet.

**Fix:** Specify the owner list, threshold, role map, and available actions after every removal and replacement. Update owners and map atomically where needed. Define recovery bootstrap through the ordinary Safe threshold or another explicit route. Reject any unintended state in which the wedgie alone has full authority.

**Test:** Remove or replace each logical key, including both wedgie slots. Repeat during a lock and after recovery. Check direct Safe execution as well as custom-module execution.

Source: [Safe OwnerManager](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/base/OwnerManager.sol).

### 4 DAO recovery returns on unused chains

**Location:** PLAN.md lines 274–285 and 541–548.

The original setup now includes DAO recovery. Anyone can deploy that setup on an unused chain. Removing the DAO on Base does not remove it from a Safe later deployed elsewhere with the original setup.

An unattended balance on an undeployed chain can therefore become subject to the original seven-day DAO recovery. This matters even if the user reached level 5 on Base. The relay's refusal to deploy stale setups does not stop other people from deploying them.

**Fix:** Show security level and recovery authority per chain. Define how funded undeployed addresses are monitored and migrated. Do not claim full self-custody across chains merely because the DAO was removed on one.

**Test:** Remove the DAO on Base, deploy the original setup on another supported chain, and check who can recover it. Verify that the app and watcher report the actual authority.

### 5 The custom fallback handler needs a defined 4337 composition

**Location:** PLAN.md lines 27–28, 202–203, and 232–236.

The travel lock needs a custom fallback handler to reject EIP-1271 signatures. The standard Safe4337Module also acts as the Safe's fallback handler. A Safe has one fallback-handler slot, so these cannot simply be installed independently.

**Fix:** Specify how the handler supports both functions. Preserve 4337 caller checks, validation, execution, and lock enforcement. Do not treat this composition as already proven by the individual contracts' audits.

**Test:** Execute a real user operation with the chosen handler. Repeat while locked, including signature validation and any paymaster authorization. Confirm the lock cannot be bypassed.

Source: [Safe 4337 architecture](https://docs.safe.global/advanced/erc-4337/4337-safe).

### 6 Paper rejection can obstruct legitimate key replacement

**Location:** PLAN.md lines 99–103 and 419–421.

The paper key can reject a pending burner or hot removal outright. A thief holding paper can use that power against a legitimate replacement. With paper plus burner stolen, the thief can reject attempts by hot plus wedgie to replace the burner.

This does not prove permanent lockout: the honest pair may be able to replace the recovery authority first. The plan must define that route and what happens to old paper signatures and pending objections. The current threat table only discusses cancelling recovery, so it misses this power.

**Fix:** Bound paper rejection or explicitly allow the honest pair to rotate compromised recovery authority and invalidate its old rejection signatures before replacing the stolen key. Update the threat table.

**Test:** Give the attacker paper plus burner. Have hot plus wedgie replace recovery authority, then replace burner. Old paper signatures must no longer obstruct the process.

### 7 The travel lock blocks the batching mechanism the plan uses

**Location:** PLAN.md lines 201, 210–211, and 216–219.

The lock bans delegatecalls. Standard Safe MultiSend requires delegatecall. Yet sending with relay fees, recovery cleanup, and owner/map updates are described as batches.

Without an exception or another execution mechanism, legitimate operations can fail while locked. An unrestricted exception would weaken the lock.

**Fix:** Define a restricted batching route that checks every inner action, forbids unsafe delegatecalls, and counts all permitted fees. State which recovery and configuration batches remain allowed.

**Test:** Run the permitted sending and recovery batches while locked. Add a forbidden inner action to each batch and verify that the whole batch fails.

Source: [Safe MultiSend](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/libraries/MultiSend.sol).

## Further corrections

| Problem | Location | Required correction |
| --- | --- | --- |
| Reprinting cards does not undo a leak | Line 79 | Generate a new seed, make new cards, and rotate recovery on chain. Reusing the seed preserves the leaked information. |
| First send requires USDC | Lines 487–497 | Provide a usable route for ETH-only or NFT-only deposits, or clearly require a USDC top-up. Self-send is currently deferred to phase 8. |
| Undeployed recovery needs setup data | Lines 541–552 | Preserve or reconstruct the original initializer, salt, signer configuration, and address after phone and browser loss. An undeployed Safe has no owner-index entry. |
| Simulation cannot guarantee zero relay losses | Lines 494–495 | Allow for state changes before inclusion and failed transactions that still consume gas. Define fee recovery and retry behavior. |
| Daily allowances are not automatically rolling limits | Lines 178–185 | Define refill timing and aggregate burner-plus-pair exposure. Spending immediately before and after a refill can consume two allowances close together. |
| Level-2 domain-loss instructions are wrong | Lines 484–486 | With burner unavailable, hot alone cannot satisfy the two-owner threshold. This case requires recovery. |
| Travel-lock opening overstates the guarantee | Lines 189–190 and 204–208 | Keep the external-allowance exception next to the claim. “Kidnappers get $2,000 at most” is not established by a cap limited to wallet-mediated outflows. |

## What must be proven next

Write one precise set of rules covering owner counts, thresholds, logical key roles, configuration epochs, recovery reset, fallback handling, and lock-safe execution. Then test the transitions and attack cases above on a fork using the exact selected contract versions.

The existing deployment, passkey, Roles, Candide, 4337, multichain, and hardware spikes remain unproven. Tests of the shelved InstantWallet contract do not validate this Safe composition.

The revised plan resolves several original findings at the specification level. The remaining work is to make the mechanisms consistent and demonstrate that the allowed execution paths enforce those rules.
