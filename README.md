# Aztec sequencer role bot

A Discord bot that gives a sequencer role to an operator who proves control
of an attester address, and that sends the operator a direct message when the
on-chain state of that attester changes.

The bot is an optional convenience. Server admins can assign the same roles
by hand, and the bot does not need to be the only way to get a role.

## How registration works

1. An admin runs `/register` in a channel. The bot posts a panel with a
   registration button.
2. An operator clicks the button, selects a network, and enters an attester
   address.
3. The bot shows a message to sign. The message names the operator's Discord
   account id and the attester address:

   ```
   Verifying for Aztec Sequencer role. Discord ID: <id>. Wallet: <address>. Timestamp: <ms>
   ```

4. The operator signs the message with the attester key as an Ethereum
   personal message (EIP-191) and submits the signature within five minutes.
5. The bot checks that the signature comes from the attester address, and
   that the message names the account that submits it. It then reads the
   attester from the rollup contract.
6. If the attester is active, the bot grants the role for that network.

A scheduled job reads each registered attester again and sends a direct
message when the state changes. The states are:

| State | Rule |
|---|---|
| `HEALTHY` | The attester is active and its balance is at or above the full stake. |
| `SLASHED` | The attester is active and its balance is below the full stake. |
| `INACTIVE` | The attester has no status or no balance on the current rollup. |

The job runs every six hours and is the only status check. When an attester
becomes `INACTIVE`, the operator gets one alert and keeps the role. The bot
removes the role after seven days of inactivity, counted from the first
inactive reading. If the attester is active again before that, the countdown
stops. After a removal, the operator can register again.

### Colleagues

An operator or provider with an own completed mainnet registration can add
colleagues by Discord user id in the management panel (**Manage Colleagues**),
and remove them again (**Remove Colleagues**). A colleague cannot add or remove
colleagues. One operator can have at most ten colleagues. A colleague gets the network roles of the operator, keeps them
during the at-risk period of the operator, and loses them when the operator
loses the role. A colleague keeps a role that they have through an own
registration or through a different operator.

### Providers

A staking provider registers with **Register as a Provider**. The provider
enters its provider ID (the number in the staking dashboard URL
`/providers/<id>`) and the signing address, and signs one message. The signer
must be the provider admin or rewards recipient from the StakingRegistry, or
an owner of a Safe in one of those two roles. The provider gets the same
network role as an operator, as long as at least one of its attesters is
active. The bot reads the attesters from the `StakedWithProvider` events.

The status job checks each provider registration every six hours. If the
provider has no active attester, or the signer is no longer admin or
recipient, the same seven-day period as for an operator starts. Colleagues of
a provider work the same as colleagues of an operator.

After a signer change, the role is removed after seven days. The account that
registered cannot register again during this period. The current admin or
rewards recipient can register with their own Discord account.

The StakingRegistry address is configured, because the registry does not point
to it. **Check it at each network upgrade.** With an old address, existing
providers keep their roles, but new providers are not found. After a change of
the address, each provider registration for the old address gets a "Registry
Changed" alert and the seven-day period starts. The provider must register
again to keep the role.

Attesters that a provider stakes outside the StakingRegistry do not count.
Those providers get the role by hand.

## Network upgrades

The bot does not store a rollup address. It reads the current rollup from
`Registry.getCanonicalRollup()` and reads it again every ten minutes, so the
rollup needs no configuration change at a network upgrade. It logs a warning
when the canonical rollup changes, and the status job posts the change to the
admin channel. Attesters that stay on the old rollup read as inactive and
follow the normal seven-day path; the bot makes no exception for them.

At each network upgrade, check the StakingRegistry address and its start block
(the block in which the contract was created):
`AZTEC_MAINNET_STAKING_REGISTRY_CONTRACT` and
`AZTEC_MAINNET_STAKING_REGISTRY_START_BLOCK` for mainnet,
`AZTEC_STAKING_REGISTRY_CONTRACT` and `AZTEC_STAKING_REGISTRY_START_BLOCK` for
testnet. If the start block is missing or is not a block number, provider
registration is off for that network and the bot logs an error.

`AZTEC_MAINNET_ROLLUP_CONTRACT` and `AZTEC_ROLLUP_CONTRACT` set a fixed
rollup address for tests. Do not set them in production: an old rollup still
answers, but reports every attester as inactive.

## Discord setup

1. Create an application and a bot in the Discord developer portal.
2. Leave all privileged intents switched off. The bot asks only for the
   **Guilds** intent: it changes roles through REST and receives no member or
   message events.
3. Invite the bot with the `bot` and `applications.commands` scopes and the
   **Manage Roles** permission.
4. In the server role list, put the bot's role above the roles it grants.
5. Create one role for mainnet and one for testnet, and a channel for the
   bot's log messages.

## Configuration

Copy `.env.example` to `.env` and fill it in. The file explains each value.

## Run

Use Node 24.22.1 for local tools (`nvm install && nvm use`). The shared image
contains this runtime and a checked Debian CA bundle for migrate, bot and
status-job. Rebuild all three before starting them:

```bash
docker compose build --pull --no-cache
docker compose up -d --no-build
```

This starts Postgres, creates the tables, then starts the bot and the status
job. The database is not published on a host port.

Check one attester from the command line:

```bash
docker compose run --rm bot node statusChecker.js --network mainnet 0x<attester>
```

## Backups

The `backup` service writes one compressed dump a day to `./backups` on the
host and keeps the newest 14 files (`BACKUP_KEEP`). The files contain Discord
account ids and attester addresses, and only the owner can read them. No
backup leaves the host.

Make a backup now:

```bash
docker compose exec backup sh /backup.sh
```

Restore a backup into an empty database:

```bash
gunzip -c backups/<file>.sql.gz | docker compose exec -T postgres-db psql -U postgres -d postgres
```

## Tests

```bash
npm install
npm test
```

Three groups of tests need a service and are skipped without it:

```bash
# Schema, backup, registration and status job tests: a disposable Postgres.
# The backup tests also need pg_dump, psql and gzip.
docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bot_test \
  -p 127.0.0.1:55440:5432 postgres:14
export TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55440/bot_test

# On-chain tests: an Ethereum mainnet RPC. Read-only.
export TEST_ETH_RPC_URL=<rpc url>

# Faucet live test: one real transfer of 1 STK on Sepolia, from the test
# wallet to itself. The wallet needs at least 1 STK and some Sepolia ETH for gas.
export TEST_SEPOLIA_RPC_URL=<sepolia rpc url>
export TEST_FAUCET_PRIVATE_KEY=<key of the funded test wallet>

npm test
```

## Known limits

- The address an operator registers is the attester address, and the
  signature must come from the attester key.
- A registration that is complete or at risk keeps its attester address. To
  use a different attester, the operator registers again after the removal.
- One attester address can be registered by more than one Discord account,
  if the key holder signs a message for each account.

## Testnet faucet

The bot can run a faucet for testnet STK (Sepolia). Members click a button in a
faucet channel and get STK for a testnet sequencer. It is off unless
`FAUCET_ENABLED=true`.

**Who can claim:** members with the role in `FAUCET_VERIFIED_ROLE_ID`, an account
at least `FAUCET_MIN_ACCOUNT_DAYS` old, at least `FAUCET_MIN_SERVER_DAYS` in the
server, not in a timeout, not quarantined by AutoMod. A sequencer role is not
required to claim.

**Rules:** every claim has the same fixed amount, `FAUCET_AMOUNT` (default
200,000 STK). The values below are the defaults. All values are in
`.env.example`.

| Who | Rule |
| --- | --- |
| Member | One claim in 90 days (`FAUCET_MEMBER_WAIT_HOURS`). Whatever the wait value, a member gets at most one claim in any 30 days. |
| Operator (role in `TESTNET_SEQUENCER_ROLE_ID`) | One claim a week (`FAUCET_OPERATOR_WAIT_HOURS`), at most 400,000 STK in 30 days (`FAUCET_OPERATOR_MAX_30D`). |
| Mainnet sequencer role | Nothing extra. The member rule applies. |
| One wallet, any member | At most 400,000 STK in 30 days (`FAUCET_WALLET_MAX_30D`). |
| The whole faucet | At most 5,000,000 STK in 24 hours (`FAUCET_GLOBAL_MAX_24H`). |

Every limit counts the claims that did not fail. The exception: claims waived by
`/faucet-reset` no longer count for the member's own wait time and 30-day
maximum, but they still count for the wallet limit and the daily cap (see
"Reset a member"). Operators also need Sepolia ETH: for the stake transaction
and for the sequencer's publisher account. The faucet sends STK only.
All values can change without a new release: edit `.env` and restart.

**Reset a member:** `/faucet-reset member:@user reason:...` needs the Manage
Roles permission and works in any channel of the server that holds the faucet
channel. In another server it refuses. Use a normal text channel for the
faucet, not a thread: an archived thread is not in the bot's cache, and the
reset then refuses. The answer is only visible to the
staff member. The command waives all confirmed claims of the member, so the
member can claim again at once. A waived claim no longer counts for the wait
time and the 30-day maximum of that member. It still counts for the wallet limit
(`FAUCET_WALLET_MAX_30D`) and the daily cap (`FAUCET_GLOBAL_MAX_24H`), because
that STK left the faucet. The command refuses while a claim of the member is
`reserved` or `sent`: settle that claim first (see Operation), then run the
reset again. A reset that waives at least one claim posts one line to
`ADMIN_LOG_CHANNEL_ID` with the staff member and the reason.

**Setup:**

1. Create a faucet wallet. Put its key in `FAUCET_PRIVATE_KEY`, never in git or chat.
2. Send STK and some Sepolia ETH (about 0.5) to the wallet.
3. Create the faucet channel: members can read but not write; only the verified
   role can see it. The bot role needs View Channel, Send Messages, Embed Links
   and Read Message History there.
4. Set `FAUCET_ENABLED=true`, `FAUCET_CHANNEL_ID`, `FAUCET_VERIFIED_ROLE_ID` and
   restart. A wrong value turns the faucet off and posts an alert in the admin
   channel; the rest of the bot keeps running. The alert names the variable.
5. In the faucet channel, run `/faucet-panel`. It needs the Manage Roles
   permission.

**Operation:**

- Each claim posts one line to `ADMIN_LOG_CHANNEL_ID`. Each failed transfer
  posts one line. A low wallet balance, the daily cap and an unknown
  transaction post at most once a day per kind (unknown: once a day per claim).
- Recovery and the balance check also run in the 6-hour status job. The status
  job reads `AZTEC_RPC_URL` and the `FAUCET_*` values from the same `.env`. To
  change a value or to stop the faucet, restart both the bot and the status
  job (`docker compose up -d` after you edit `.env`).
- Above the gas price in `FAUCET_MAX_FEE_GWEI` (default 100 gwei) the faucet
  does not sign: the member gets the failed answer and staff get a line.
- To stop the faucet: `FAUCET_ENABLED=false` and restart. The panel stays; the
  button then answers that the faucet is off.
- A claim row with status `sent` that the RPC does not know keeps counting.
  The unknown-transaction alert names the claim id, the hash and the nonce of
  the signed transaction; the `nonce` column of `faucet_claims` holds the same
  value. Check the hash on Etherscan, then set the row by hand:
  `UPDATE faucet_claims SET status = 'failed', updated_at = NOW() WHERE id = <id>;`
  Set the row to `failed` only after the faucet wallet page on Etherscan shows
  a latest sent nonce equal to or above the `nonce` of that row, from a
  different transaction. Before that, the signed transaction can still land,
  and the member would be paid twice.
- A transaction stuck with too-low gas blocks later claims: they reuse its
  nonce, stay pending, and raise unknown-transaction alerts. Staff replace or
  cancel the stuck transaction from the faucet wallet.
- To give a member quota back for confirmed claims, use `/faucet-reset`. The
  manual steps above stay for a claim that is `sent` with an unknown
  transaction: `/faucet-reset` refuses until that claim is settled.
