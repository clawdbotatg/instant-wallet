# Roles — who can do what

> **Superseded / summarized by `PLAN.md` (2026-10-05)** — read that first.

Austin, 2026-10-05. This replaces the key list and the "what a thief gets" table in `COLD-STORAGE.md`. Its delay, cancel
and freeze mechanics still hold, with the changes below.
Not built yet: contract 3.2 has burner + cold + guardians; hot, signature tiers and the death switch are new.
Safe vs our own contract is still open — the roles are the same either way.

## The rule

**Protecting is instant. Weakening is slow. More signatures = fewer limits.**

## The five roles

| # | role | what it is | who controls the key | used for |
|---|---|---|---|---|
| 1 | **Burner** | passkey made instantly on your device (Face ID) | us (our app) | daily spending money |
| 2 | **Hot** | MetaMask / Rainbow / any outside wallet, usually added by ENS | the user's own wallet app, not us | rarely: second signer on big sends |
| 3 | **Cold** | the wedgie (Trust M or ATECC chip). Could be any hardware wallet later; we start wedgie-only | the chip, physical button press | big sends, changing settings |
| 4 | **Recovery** | an address that can reset a key to a new one, after a delay | starts as dao.buidlguidl.eth; the user swaps in their own | lost keys |
| 5 | **Death switch** (optional) | an address (default the DAO) that, after a very long delay, moves everything to a new address | the DAO | you died or lost everything |

## Signatures and limits (the knobs)

| who signs | can move | wait |
|---|---|---|
| burner alone | up to the daily limit (default $100/day per token) | none |
| hot alone, or cold alone | anything | 48 h, cancelable |
| burner + hot | up to a bigger daily limit (default $5,000/day) | none |
| any two including cold | anything | none |
| all three | anything | none |

Burner + hot is capped because both live on everyday devices and both can be phished; anything with the
cold wallet is not. Every number is a per-wallet setting. Raising one is "weakening", so it follows the same table.

Changing settings (add/remove a key, raise a limit, shorten a delay, change recovery) works like a big send:
it needs cold. Cold alone waits 48 h; cold + any other key is instant. Burner + hot can't change settings
without waiting 48 h (cancelable), or they could raise their own cap or add a cold key they own.

Protecting (cancel a pending action, freeze, lower a limit) is instant for any one key, and for the
recovery address (it can cancel and freeze, never spend).
Exception: the burner can't cancel a recovery — otherwise a thief with your phone blocks it.

## Recovery and the death switch

| | recovery | death switch |
|---|---|---|
| does | resets a key (burner, hot or cold) to a new address | moves everything / sets a new owner |
| delay | 7 days | 1 year |
| canceled by | hot or cold (any one) | any key (burner, hot, cold) |
| default holder | dao.buidlguidl.eth, until you set your own | dao.buidlguidl.eth, kept even after you set your own recovery |
| example | lost wedgie → new wedgie | you died → DAO sends it to your spouse |

**Trust:** while the DAO is your recovery, the DAO could in theory reset your key to its own address,
and it lands if you don't cancel in 7 days. Fine for a new wallet with spending money; the app pushes you
to set your own recovery once the balance grows. The death switch has the same power with a 1-year wait,
so it only lands if no key cancels it during that year. Using the wallet does not reset it; the alert
when it starts is what tells you to cancel. Open: should the user name the death-switch destination in
advance (safer — the DAO only pulls the trigger) instead of the DAO choosing it?

Every pending recovery / death switch / big send sends a loud alert (push, email, Telegram). A delay
you don't hear about is useless.

## Growing up

1. **Land:** Face ID → burner. While it's the only key it can move everything (it's spending money).
   Recovery = DAO.
2. **Add hot** (type your ENS, sign once). Burner drops to its daily limit.
3. **Add cold** (plug in the wedgie, press A).
4. **Own your recovery:** swap the DAO for your own address (a second wedgie, a friend, a Safe).
5. **Optional:** keep the DAO as death switch.

## Stolen

| stolen | what happens |
|---|---|
| burner (only key) | thief gets it all — spending money only |
| burner | thief gets one day's limit; hot or cold removes the burner |
| hot | thief's send waits 48 h; cold cancels and freezes, then removes hot |
| cold | thief's send waits 48 h; hot cancels and freezes; recovery replaces cold in 7 d |
| burner + hot | thief gets the $5,000/day tier; cold freezes and removes both |
| burner + cold, or hot + cold | thief moves everything at once (two keys = no wait). Keep them apart |
| recovery | thief's reset waits 7 d; hot or cold cancels; set a new recovery |
| death switch | thief's move waits 1 year; any key cancels |

## Lost

| lost | what happens |
|---|---|
| burner (synced passkey) | open the app on the new phone, nothing else |
| burner (not synced, only key) | recovery gives you a new one in 7 d |
| burner | hot or cold adds a new one |
| hot | cold removes it and adds a new one |
| cold | burner keeps spending; hot can still do big sends (48 h); recovery replaces cold in 7 d |
| everything but recovery | recovery replaces your keys in 7 d |
| everything, no recovery | death switch moves it after 1 year |
| recovery | hot or cold sets a new one |

## Known gaps

- A thief holding your cold (or hot) wallet can keep canceling the recovery. Money stays put but stuck.
  Possible fix: a recovery can only be canceled by a key it is *not* replacing.
- Two stolen keys that include cold = no wait, so recovery can't catch it (COLD-STORAGE.md said guardians
  could; that only holds in vault mode). If that's too weak, a "vault" setting makes everything wait
  except all three together.
