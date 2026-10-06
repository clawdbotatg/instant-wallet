# Instant Wallet plan security and feasibility review

Date: 2026-10-05. Author: Codex. Audience: Austin and the Instant Wallet implementation team.

The Safe-based direction is viable, but the current plan is not ready to govern an implementation that holds real funds. Eight major findings affect recovery, authorization, delayed execution, travel locks, group wallets, passkey availability, and multichain deployment. Two further corrections affect the stated security guarantees and paper recovery format.

This report preserves the accepted product decisions: the delay catches deceptive signing; two stolen keys including the wedgie are an accepted loss scenario; all three keys can act instantly; no additional panic wallet is proposed. The findings concern whether the planned mechanisms actually deliver those decisions.

## Scope and evidence

The target is [PLAN.md](PLAN.md), the master plan dated 2026-10-05, with supporting context from [SAFE.md](SAFE.md), [WEDGIE-SAFE.md](WEDGIE-SAFE.md), and the earlier local review briefs. Line references below refer to the plan as reviewed and may move with future edits.

This is a design review supported by upstream source inspection. It is not a deployed-contract audit or proof that a live wallet is exploitable. No Base-fork spike, deployment verification, hardware test, or end-to-end integration test was performed. The shelved InstantWallet contract does not prove the proposed Safe architecture.

Safe references use the v1.5.0 source. The Candide reference inspected includes current main-branch code; main is not a pinned deployed or audited release. Implementation must identify the exact deployed versions and bytecode before transferring source conclusions to production.

“Major” means a failure could break an advertised security or availability guarantee and should be resolved before relying on the affected feature. The review does not establish a critical deployed exploit.

## Findings at a glance

| ID | Severity | Finding | Required outcome |
| --- | --- | --- | --- |
| F1 | Major | Recovery leaves old Roles permissions active | Revoke or invalidate old authority atomically |
| F2 | Major | Safe owners do not identify logical keys | Authenticate the burner, hot, and wedgie identities |
| F3 | Major | Owner-set comparisons can revive queued moves | Permanently invalidate stale authorizations |
| F4 | Major | Travel-lock outflow cap is not established | Cover all allowed outflows and qualify external allowances |
| F5 | Major | One key may repeatedly lock the wallet | Bound reactivation and preserve replacement paths |
| F6 | Major | Group approveHash route is ambiguous and partly invalid | Choose and test the exact approval mechanism |
| F7 | Major | IPFS hosting does not preserve passkey access | Establish a usable escape path if the domain fails |
| F8 | Major | Multichain setup conflicts with build order | Resolve deployment timing and current-key authorization |
| C1 | Correction | A delay does not guarantee deception is caught | State the limits and require independent alerts |
| C2 | Correction | Paper backup format is underspecified | Define and independently restore the same recovery address |

## F1 Recovery must invalidate old permissions atomically

**Plan location:** PLAN.md lines 144–148, “After a recovery, reset everything.”

The plan acknowledges that Candide changes Safe owners without clearing the old burner's Roles budget or protect permissions. It then relies on the new owners sending another transaction immediately.

The old burner can submit a Roles spend after recovery finalizes and before the cleanup transaction lands. If the app fails, the new owners cannot complete their signatures, or the cleanup is blocked, access can persist indefinitely. Old protect permissions may also interfere with newly configured spending access. Replacing owners therefore does not by itself complete recovery.

**Required change:** Owner replacement must invalidate old permissions within the same atomic operation, or the enforcement layer must reject permissions associated with an obsolete owner or authorization epoch. Specify how this works with the chosen Candide version, Roles, both recovery modules, and an active travel lock. A promise that the app quickly sends another transaction is not an on-chain security boundary.

**Acceptance checks:** Finalize recovery, then immediately attempt a spend and a protect action with each old key before any follow-up transaction. They must fail. Repeat with the app offline and with the travel lock active. Verify that the intended new permissions can be established without restoring old authority.

**Evidence:** [Candide SocialRecoveryModule](https://github.com/candidelabs/candide-contracts/blob/main/contracts/modules/social_recovery/SocialRecoveryModule.sol) replaces owners and threshold through Safe module calls; its finalization does not reset Roles.

## F2 Logical keys need authenticated identities

**Plan location:** PLAN.md lines 82–86 and 94–102.

The wedgie occupies two owner slots. Burner and hot occupy one each. The custom module is supposed to require the wedgie plus another logical key for spending, while accepting any two logical keys for cancellation. The plan also says it maintains no key list and only reads the Safe's current owners.

A Safe owner list supplies addresses, not their product roles or their shared physical custody. Two owner signatures might both come from the wedgie. Requiring three signatures would exclude legitimate burner-plus-hot cancellation. Signature counts alone cannot implement the policy.

This is a specification gap, not proof that an implementation already counts incorrectly. The implementation must have enough authenticated information to distinguish the cases.

**Required change:** Define an authoritative association of owner addresses with burner, hot, and the two wedgie slots. State who may change it, how those changes are authorized, and how recovery updates it. If identities are derived rather than stored, specify and prove the derivation. Define behavior after recovery introduces a different number or type of owners.

**Acceptance checks:** Wedgie alone must not cancel, remove another key, or execute a delayed spend. Burner plus hot must cancel but must not spend beyond the burner budget. Wedgie plus either other key must receive the intended pair permissions. Repeat after replacement and recovery.

## F3 Queued authorizations need permanent invalidation

**Plan location:** PLAN.md line 101.

Recording the owner set and comparing it at execution time does not establish that a queued move dies permanently when owners change. A move signed under owner set A becomes temporarily invalid under set B, then may become valid again if the Safe later returns to A. Changes to threshold or policy may leave the address set unchanged altogether.

An old authorization could therefore execute after the user believes it was invalidated.

**Required change:** Use an authorization epoch that increases when relevant configuration changes, together with unique nonces and terminal executed, cancelled, or rejected states. Bind signatures to the Safe, chain, action, and applicable epoch. Define what threshold, logical-role, recovery, and policy changes invalidate. Explain how the epoch observes every supported configuration path; direct Safe owner changes cannot silently bypass it.

**Acceptance checks:** Queue under A, change to B, return to A, and attempt execution. It must remain invalid. Test threshold-only changes, cancellation replay, repeated execution, and owner changes through both ordinary Safe transactions and recovery.

## F4 Travel lock does not yet establish an absolute outflow cap

**Plan location:** PLAN.md lines 176–204.

The lock claims that no matter who signs, no more than the configured cap can leave. Checking allowances to known spenders does not prove this: an unknown approved spender can withdraw tokens directly without invoking a Safe transaction guard. The plan acknowledges that residual risk, so the absolute guarantee is stronger than the stated mechanism.

Safe also has a separate gas-refund payment path. A transaction with an innocuous target and value can pay ETH or tokens through its refund configuration. Inspecting only the intended transfer does not cover that outflow.

**Required change:** State precisely which assets and authorizations the cap covers. Block or account for Safe refunds, relay fees, and every permitted execution path. For the proposed USDC-only mode, define a strict allowlist of transfers and protective operations, including the exact authorized token address. Block guard removal, module-guard removal, fallback replacement, unsafe delegatecalls, and signature-based authority while locked. Unknown standing allowances must either be excluded transparently from the guarantee or eliminated by a demonstrable invariant; a finite known-spender checklist cannot establish that none exist.

**Acceptance checks:** Try a known and an unknown standing allowance; Permit2 authorization; an EIP-1271 signature; ETH and token refunds; relay fees; module execution; delegatecall; guard replacement; and a batch with an allowed action plus a forbidden action. Verify cap accounting and failure behavior across all allowed paths.

**Evidence:** [Safe v1.5.0 Safe.sol](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/Safe.sol) pays gas refunds separately from the target call. [ModuleManager](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/base/ModuleManager.sol) provides the module guard path; it must be configured alongside the ordinary transaction guard.

## F5 One key may repeatedly lock the wallet

**Plan location:** PLAN.md lines 179–182 and 195–198.

The plan limits a one-key lock to seven days and prohibits extension, but does not define whether the same key can activate a fresh lock immediately after expiration. If it can, a thief can repeatedly interfere with access.

The proposed response is to remove the stolen key. That path also needs clarification: replacement may introduce owners, additions are blocked during a lock, and only Candide finalization is explicitly exempted. This matters especially when the stolen item is the wedgie and the intended instant replacement uses burner, hot, and paper.

**Required change:** Define reactivation rules, including cooldown or authorization requirements if repeated one-key activation is prohibited. Specify which removal and replacement operations remain available while locked, how they preserve the cap, and how configuration invalidates the stolen key's lock authority. Do not imply every stolen-key removal takes 24 hours: the objection rule can extend some removals to seven days.

**Acceptance checks:** Let a stolen key activate at expiry repeatedly. Confirm the intended bound. During a lock, exercise each key-removal and replacement path, including the wedgie path and Candide recovery, without allowing cap removal or new spending powers.

## F6 Group approval must use the correct Safe mechanism

**Plan location:** PLAN.md lines 223–227.

The delayed group-signing path says the member Safe approves the group transaction on chain using approveHash, without stating which Safe receives the call. These mechanisms differ:

- Calling approveHash on the member Safe from itself fails: the caller must be an owner of that Safe, and the Safe is not its own owner.
- Calling approveHash on the group Safe from the member Safe can work because the member Safe is an owner of the group. The group then consumes the corresponding approved-hash signature.
- Authorizing a message within the member Safe uses the on-chain signed-message mechanism and the correctly wrapped Safe message hash, which the group's contract-signature verification can consume.

**Required change:** Choose one path and document the receiving contract, exact hash, signature encoding, nonce, and execution route. Calling the group Safe's approveHash through the member's delayed module is a plausible implementation; it still needs proof. Specify what member recovery does to already granted group approvals rather than assuming recovery revokes them.

**Acceptance checks:** Execute a two-of-three group transaction with threshold-four member Safes. Test all-three immediate signing and the chosen delayed approval path. Verify signature sorting, offsets, wrong hashes, wrong chains, recovery, and travel-lock behavior at both member and group level.

**Evidence:** [Safe approveHash](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/Safe.sol) requires an owner caller. [CompatibilityFallbackHandler](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/handler/CompatibilityFallbackHandler.sol) validates Safe messages. [SignMessageLib](https://github.com/safe-global/safe-contracts/blob/v1.5.0/contracts/libraries/SignMessageLib.sol) records messages signed on chain.

## F7 IPFS hosting does not preserve passkey access

**Plan location:** PLAN.md lines 336 and 361–363; domain choice at line 479.

An IPFS copy preserves the application code, but an existing instantwallet.io passkey generally cannot be requested from an unrelated gateway or localhost origin. Browser access to the credential depends on the relying-party identity and origin rules. Code availability and signing availability are separate requirements.

At level 1, domain failure can disable the sole owner signing path. At later levels, the plan must explain which surviving keys and recovery mechanisms can restore access.

**Required change:** Define an operational domain-continuity strategy, a supported alternative credential-access mechanism, or recovery as the explicit escape route. If an alternative domain is proposed, prove the applicable browser and authenticator support. Correct the unconditional statement that pinning the app alone makes the wallet usable after domain loss.

**Acceptance checks:** Use a real credential created at the production relying-party identity. Exercise the proposed backup app and origin on supported phones and browsers. Demonstrate recovery with the original site unavailable.

**Evidence:** [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/#sctn-rp-id) defines relying-party scoping and browser origin checks.

## F8 Multichain deployment needs a consistent initial strategy

**Plan location:** PLAN.md lines 240–267, 486–497.

The multichain security strategy requires deploying on every cheap supported chain at signup while the original burner is fresh. Phase 1 instead creates the Safe on first deposit on Base, with other chains deferred to phase 5. These choices need a single consistent definition of supported chains and deployment timing.

Later deployment also requires more than having the same initializer. The plan proposes deploying the original burner-owned Safe and replaying changes in a batch. If that burner is unavailable, authenticated migration may be impossible through the proposed route. Historical signatures are not automatically portable across chains, so “replay” needs an explicit authorization design.

The plan already recognizes that a compromised original burner can take a previously undeployed chain. This report does not propose undoing that accepted limitation; it asks that the build sequence actually implement it.

**Required change:** Define the initial supported chain set, when each Safe and signer is deployed, who funds it, and how current configuration is authorized on later chains. After original-burner loss or compromise, follow the stated new-address policy. Replace the broad statement that funds sent before deployment are safe with its actual conditions.

**Acceptance checks:** Deploy the same initial setup on two supported chains, then migrate configuration through the intended authenticated route. Repeat after burner replacement, loss, and compromise. Confirm the app does not present an undeployed or stale wallet as ready to receive funds.

## C1 Qualify the protection against deceptive signing

**Plan location:** PLAN.md lines 87–91, 165–172, and 369–371.

“Tricked into signing means caught by the 24-hour wait” is too strong. All-three signatures execute instantly, pair spending within its daily allowance is instant, and transactions above the allowance execute after the wait if nobody notices or successfully cancels. These are accepted routes, but they limit the guarantee.

Alerts must independently decode the actual signed and queued action. A compromised signing interface can also misrepresent the pending transaction or cancellation screen. Delivery must work without relying solely on the same compromised application.

**Required change:** State that the delay creates an opportunity to detect and cancel qualifying deceptive transactions. Define the watcher trust boundary, action hash shown to the user, notification channels, and a independently usable cancellation route. State aggregate exposure accurately: pair and burner budgets are separate, and “per day” needs a defined refill model before it is presented as a rolling loss bound.

**Acceptance checks:** Queue a malicious action through a compromised interface while the watcher independently reads chain state. Verify the notification describes the actual action and cancellation works through another supported client. Test all-three immediate execution and pair-budget execution so the interface accurately explains their lack of a wait.

## C2 Specify the paper recovery format completely

**Plan location:** PLAN.md lines 69–78 and 441–442.

“24-word seed sharded with SLIP-39” does not identify the exact secret being backed up. BIP-39 entropy, its mnemonic, and the derived wallet seed are different objects. Choosing the wrong reconstruction interpretation can produce a different recovery address even when shares rebuild successfully.

**Required change:** Specify whether this is native SLIP-39 wallet backup or a documented backup of a BIP-39-derived secret. Define passphrase handling, derivation path, share parameters, restoration software, and the expected recovery address. If entropy is shared using a custom interpretation, do not assume native SLIP-39 wallets restore the same address. A practice restore should use an independent path, because the same incorrect implementation can reproduce its own mistake.

**Acceptance checks:** Restore from each valid two-share combination using the specified independent procedure and verify the exact address. Confirm one share cannot reconstruct the secret. Define what the user does if one share is lost and the original device no longer holds the seed.

**Evidence:** [SLIP-39 specification](https://github.com/satoshilabs/slips/blob/master/slip-0039.md) describes the master secret and its relationship to wallet seed material.

## Implementation prerequisites

Before treating the plan as implementable, resolve F1–F5 in a concrete authorization specification. It should identify logical key roles, signature domains, consumed nonces, configuration epochs, recovery cleanup, lock accounting, and exact allowed calls. Those rules determine the custom contract's security boundary.

Before relying on group, multichain, and backup-app features, resolve F6–F8 through end-to-end spikes. The existing threshold-one wedgie test does not establish weighted ownership, threshold-four signing, or nested Safe execution.

The plan's existing unproven integration list remains necessary: Roles with relayed passkey signatures and replay protection; the protect role; both wedgie key slots; DAO Safe guardian signatures; six-month Candide deployment; batched level changes; Safe 1.5 compatibility; 4337 and Circle; Safe-app fallback; EAS heir attestations; nested Safe signing; deterministic multichain deployment; and exact deployment availability on Base and Ethereum. Audit labels must be matched to selected releases and deployed bytecode, rather than inferred from a project's general audit history.

After the specification and spikes pass, audit the complete composition: module, ordinary guard, module guard, fallback handler, recovery interactions, Roles configuration, app, relay, alerts, and firmware. Counting the custom logic as one contract does not reduce the authority it holds.

## Review outcome

Eight major findings and two additional corrections remain open. Some are direct contract-behavior mismatches; others are security mechanisms that the plan has not specified sufficiently to prove its promises. No code, plan text, or deployments were changed as part of the original review. This report records the findings and acceptance criteria for the next revision.
