# Provider registration — design

Date: 2026-10-17. Status: draft for review.

## Goal

Let a staking provider get the sequencer role with one signature, without an
attester key. The provider keeps the role while it has at least one active
attester.

Today a registration links one Discord account to one attester. That does not
fit a provider with hundreds of attesters whose keys are in a remote signer.

## Decisions

| Topic | Decision |
|---|---|
| Role | The existing network roles (`MAINNET_SEQUENCER_ROLE_ID`, `TESTNET_SEQUENCER_ROLE_ID`). No separate provider role. |
| Who can sign | The provider admin or the provider rewards recipient, as read from the StakingRegistry. |
| Networks | Mainnet and testnet. |
| Teams | The existing colleague feature. A provider registration counts as an operator registration. |
| Manual path | Server admins can still assign the role by hand. The bot is not the only way to get it. |

## Facts this design relies on (checked on chain 2026-10-17)

- `StakingRegistry.providerConfigurations(id)` returns
  `(providerAdmin, providerTakeRate, providerRewardsRecipient)`. Ids start at 1.
  An id with a zero admin is not in use.
- Mainnet: 105 providers. Admins: 94 EOA, 3 EOA with EIP-7702 code, 8 Safe.
  Rewards recipients: 86 EOA, 5 EOA with EIP-7702 code, 14 Safe. No other
  contract types.
- `StakedWithProvider(providerIdentifier, rollupAddress, attester, …)` is
  emitted for each staked attester. Mainnet: 6,326 events, 67 providers with
  stake, 52 with at least one attester that is `VALIDATING` on the canonical
  rollup. The largest provider has about 1,000 attesters.
- Stake follows the canonical rollup. Attesters from events with an old
  `rollupAddress` read as active on the current rollup. Status is therefore
  read on `Registry.getCanonicalRollup()`, never on the event rollup.
- The StakingRegistry is not in `node_getL1ContractAddresses` and the Registry
  does not point to it, so it must be configured.
  - Mainnet `0x042df8f42790d6943f41c25c2132400fd727f452` served v0, v4 and v5.
  - Testnet changed once: `0xa65f52BD…EEa` was replaced by
    `0xC6EcC183…1C2`, which then served at least five rollups.
- The test RPC accepts `eth_getLogs` ranges of about 3,900 blocks. A first
  full mainnet scan takes about 650 queries (about 1 minute).

## Registration flow

1. The welcome panel gets a button **Register as a Provider**.
2. The user selects the network, then enters the provider id (the number in
   the staking dashboard URL `/providers/<id>`) and the address that signs.
3. The bot reads `providerConfigurations(id)` and refuses the request unless
   the address is one of the **eligible signers**:
   - the admin or the rewards recipient, if that address is an EOA (with or
     without EIP-7702 code);
   - an owner of the admin or the rewards recipient, if that address is a
     Safe (`getOwners()`).
4. The bot shows the message to sign:
   `Verifying for Aztec Sequencer role as a provider. Discord ID: <id>. Provider: <providerId>. Signer: <address>. Timestamp: <ms>`
5. The user signs it with the signer key (EIP-191 personal message) and submits
   the signature within five minutes.
6. The bot checks that the signature recovers to the signer, that the record
   belongs to the submitting account, and that the message names that account,
   provider and signer.
7. The bot checks that the provider has at least one active attester (see
   *Activity check*). If yes, it grants the network role. If no, it refuses
   with a message that says so.

The rate limits and the five-minute expiry of the operator flow apply.

## Data model

New table `provider_registrations`:

| Column | Notes |
|---|---|
| `id` | serial primary key |
| `discord_user_id`, `discord_username` | |
| `network` | `Mainnet` or `Testnet`, as in `pending_registrations` |
| `provider_id` | integer |
| `signer_address` | the address that signed |
| `signer_kind` | `admin`, `recipient`, `admin_safe_owner`, `recipient_safe_owner` |
| `message_to_sign`, `signature`, `expires_at` | as in `pending_registrations` |
| `status` | `pending`, `completed`, `at_risk`, `removed`, `cancelled`, `expired` |
| `at_risk_since`, `last_notification_status` | as in `pending_registrations` |
| `created_at`, `updated_at` | |

Unique on `(discord_user_id, network, provider_id)`.

New table `provider_attesters` (an index of the `StakedWithProvider` events):
`(network, provider_id, attester)` primary key. New table `event_cursors`:
`(network, contract, last_block)`.

`db/roleAccess.keepsRole()` also counts a `provider_registrations` row in use,
for the user and for the managers of a colleague.

## Activity check

- The status job first brings `provider_attesters` up to date: it reads
  `StakedWithProvider` from `last_block + 1` to the latest block, in ranges
  that the RPC accepts, and stores the new rows and the new cursor in one
  transaction.
- A provider is **active** if at least one of its attesters has
  `getStatus == 1` on the canonical rollup. The check stops at the first
  active attester.
- The registration step uses the same check. If the index is empty for a new
  network, the registration step runs the first sync before it answers.

## Monitoring

In the existing six-hour job, for each provider registration that is
`completed` or `at_risk`:

| Condition | Action |
|---|---|
| Signer still eligible and provider active | Nothing. An `at_risk` registration goes back to `completed` and clears `at_risk_since`. |
| Provider not active | Same as an inactive operator: one alert, `at_risk`, role removed after seven days. |
| Signer no longer eligible (admin or recipient changed, or no longer a Safe owner) | Same seven-day path, with a different alert text. The new signer can register. |

Colleague handling is the same as for an operator registration.

## Configuration

| Variable | Default in `.env.example` |
|---|---|
| `AZTEC_MAINNET_STAKING_REGISTRY_CONTRACT` | `0x042df8f42790d6943f41c25c2132400fd727f452` |
| `AZTEC_STAKING_REGISTRY_CONTRACT` | `0xC6EcC1832c8BF6a41c927BEb4E9ec610FBeDd1C2` |
| `AZTEC_MAINNET_STAKING_REGISTRY_START_BLOCK` | `23786843` |
| `AZTEC_STAKING_REGISTRY_START_BLOCK` | `10049301` |

Without the registry variable for a network, provider registration is off for
that network and the button says so.

## Failure modes

- **A new StakingRegistry and a stale configuration.** Existing provider
  attesters still read active on the canonical rollup, so no role is removed.
  New providers are not found and get the role by hand until the address is
  updated. The README states this as an upgrade check item.
- **RPC refuses a log range.** The sync halves the range and retries. The
  cursor moves only after a stored range, so a failed run resumes.
- **RPC down during the job.** No state change for that registration. The
  same rule as for an operator registration.
- **A Safe changes its owners.** The next job run sees that the signer is not
  an owner and starts the seven-day path.

## Testing

- Unit: eligible-signer rules for EOA, EOA with EIP-7702 code, Safe owner,
  not eligible. Message binding and replay to a second account.
- Event sync: ranges, the halving retry, the cursor, no duplicate rows.
- Flow (harness): registration success, refusal for a non-eligible address,
  refusal for a provider with no active attester.
- Status job (harness): provider inactive for less and more than seven days,
  recovery, signer no longer eligible, colleagues of a provider.
- Live, read-only: the first sync against mainnet and testnet, and the activity
  result compared with a direct count.
- Live on the test server: one provider registration with a testnet provider
  key, if one is available.

## Out of scope

- Attesters that a provider stakes outside the StakingRegistry (self-stake).
  Those providers get the role by hand.
- Signatures from a Safe as a contract (EIP-1271). An owner signature is
  sufficient for a Discord role.
- A separate provider role.
