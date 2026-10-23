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
   **Guilds** intent: it reads single members through REST and receives no
   member or message events.
3. Invite the bot with the `bot` and `applications.commands` scopes and the
   **Manage Roles** permission.
4. In the server role list, put the bot's role above the roles it grants.
5. Create one role for mainnet and one for testnet, and a channel for the
   bot's log messages.

## Configuration

Copy `.env.example` to `.env` and fill it in. The file explains each value.

## Run

```bash
docker compose up -d --build
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

Two groups of tests need a service and are skipped without it:

```bash
# Schema, backup, registration and status job tests: a disposable Postgres.
# The backup tests also need pg_dump, psql and gzip.
docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bot_test \
  -p 127.0.0.1:55440:5432 postgres:14
export TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55440/bot_test

# On-chain tests: an Ethereum mainnet RPC. Read-only.
export TEST_ETH_RPC_URL=<rpc url>

npm test
```

## Known limits

- The address an operator registers is the attester address, and the
  signature must come from the attester key.
- A registration that is complete or at risk keeps its attester address. To
  use a different attester, the operator registers again after the removal.
- One attester address can be registered by more than one Discord account,
  if the key holder signs a message for each account.
