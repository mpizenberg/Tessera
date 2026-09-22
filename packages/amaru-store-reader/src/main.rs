use std::{collections::BTreeMap, env, path::PathBuf};

use amaru_kernel::{Credential, DRep, Epoch, NetworkName};
use amaru_ledger::{
    store::{ReadStore, Snapshot},
    summary::{governance::GovernanceSummary, stake_distribution::StakeSummary},
};
use amaru_stores::rocksdb::{RocksDBHistoricalStores, RocksDbConfig};
use anyhow::{anyhow, bail};
use serde_json::{Value, json};

const USAGE: &str = "usage: amaru-store-reader snapshot <network> <ledger-dir> <epoch>";

fn credential(c: &Credential) -> String {
    match c {
        Credential::KeyHash(h) => format!("key:{}", hex::encode(h)),
        Credential::ScriptHash(h) => format!("script:{}", hex::encode(h)),
    }
}

fn drep(d: &DRep) -> String {
    match d {
        DRep::Key(h) => format!("key:{}", hex::encode(h)),
        DRep::Script(h) => format!("script:{}", hex::encode(h)),
        DRep::Abstain => "abstain".to_string(),
        DRep::NoConfidence => "no_confidence".to_string(),
    }
}

/// One epoch snapshot as JSON: the registered accounts and DReps as the ledger stores them
/// (the certificates), plus what the node derives from them at the epoch boundary: under
/// `active`, an account's stake and the delegations still standing once retired pools and
/// lapsed DReps are dropped; for a DRep, its expiry extended by dormant epochs and its voting
/// stake. Lovelace are decimal strings.
fn snapshot(network: NetworkName, ledger_dir: PathBuf, epoch: Epoch) -> anyhow::Result<Value> {
    let era_history = network
        .as_era_history()
        .ok_or_else(|| anyhow!("no era history for {network}"))?;
    let snapshot = RocksDBHistoricalStores::for_epoch_with(&RocksDbConfig::new(ledger_dir), epoch)?;
    let summary = StakeSummary::new(
        &snapshot,
        GovernanceSummary::new(&snapshot, era_history)?,
        network,
        |_| {},
    )?;

    let accounts: BTreeMap<String, Value> = snapshot
        .iter_accounts()?
        .map(|(key, row)| {
            let active = summary.accounts.get(&key).map(|state| {
                json!({
                    "stake": state.balance.to_string(),
                    "pool": state.pool.map(hex::encode),
                    "drep": state.drep.as_ref().map(drep),
                })
            });
            (
                credential(&key),
                json!({
                    "pool": row.pool.map(|(pool, _)| hex::encode(pool)),
                    "pool_slot": row.pool.map(|(_, at)| u64::from(at.slot())),
                    "drep": row.drep.as_ref().map(|(d, _)| drep(d)),
                    "drep_slot": row.drep.as_ref().map(|(_, at)| u64::from(at.slot())),
                    "deposit": row.deposit.to_string(),
                    "rewards": row.rewards.to_string(),
                    "active": active,
                }),
            )
        })
        .collect();

    let dreps: BTreeMap<String, Value> = snapshot
        .iter_dreps()?
        .map(|(key, row)| {
            let as_drep = match key {
                Credential::KeyHash(h) => DRep::Key(h),
                Credential::ScriptHash(h) => DRep::Script(h),
            };
            let state = summary.dreps.get(&as_drep);
            (
                credential(&key),
                json!({
                    "registered_slot": u64::from(row.registered_at.slot()),
                    "valid_until": u64::from(row.valid_until),
                    "deposit": row.deposit.to_string(),
                    "expiry": state.and_then(|s| s.valid_until).map(u64::from),
                    "voting_stake": state.map(|s| s.voting_stake.to_string()),
                }),
            )
        })
        .collect();

    let tip = snapshot.tip()?;
    Ok(json!({
        "epoch": u64::from(snapshot.epoch()),
        "tip": { "slot": u64::from(tip.slot_or_default()), "hash": hex::encode(tip.hash()) },
        "accounts": accounts,
        "dreps": dreps,
    }))
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();
    let output = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [_, "snapshot", network, ledger_dir, epoch] => snapshot(
            network.parse().map_err(|e| anyhow!("{e}"))?,
            PathBuf::from(ledger_dir),
            Epoch::from(epoch.parse::<u64>()?),
        )?,
        _ => bail!("{USAGE}"),
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
