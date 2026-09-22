use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    path::PathBuf,
};

use amaru_kernel::{
    Credential, DRep, Epoch, Hasher, IsHeader, NetworkName, Slot,
    cardano::network_block::NetworkBlock, cbor,
};
use amaru_ledger::{
    store::{ReadStore, Snapshot},
    summary::{governance::GovernanceSummary, stake_distribution::StakeSummary},
};
use amaru_ouroboros_traits::BaseReadChainStore;
use amaru_stores::rocksdb::{RocksDBHistoricalStores, RocksDbConfig, consensus::RocksDBStore};
use anyhow::{anyhow, bail};
use serde_json::{Value, json};

const USAGE: &str = "usage: amaru-store-reader snapshot <network> <ledger-dir> <epoch>
       amaru-store-reader blocks <network> <chain-dir> <from-slot> <to-slot>";

/// The metadata label CIP-179 records are written under.
const METADATA_LABEL: u64 = 17;

fn credential(c: &Credential) -> String {
    match c {
        Credential::KeyHash(h) => format!("key:{}", hex::encode(h)),
        Credential::ScriptHash(h) => format!("script:{}", hex::encode(h)),
    }
}

/// One epoch snapshot as JSON: every registered stake credential with the stake and pool the
/// node's own end-of-epoch view gives it (the pool `null` once retired), every registered
/// DRep with its voting stake, and every governance action still in the state with its last
/// votable epoch and anchor. Lovelace are decimal strings.
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
        .map(|(key, _)| {
            let state = summary.accounts.get(&key).ok_or_else(|| {
                anyhow!(
                    "registered account {} has no end-of-epoch view",
                    credential(&key)
                )
            })?;
            Ok((
                credential(&key),
                json!({
                    "stake": state.balance.to_string(),
                    "pool": state.pool.map(hex::encode),
                }),
            ))
        })
        .collect::<anyhow::Result<_>>()?;

    let dreps: BTreeMap<String, Value> = snapshot
        .iter_dreps()?
        .map(|(key, _)| {
            let as_drep = match key {
                Credential::KeyHash(h) => DRep::Key(h),
                Credential::ScriptHash(h) => DRep::Script(h),
            };
            let state = summary.dreps.get(&as_drep).ok_or_else(|| {
                anyhow!(
                    "registered DRep {} has no end-of-epoch view",
                    credential(&key)
                )
            })?;
            Ok((
                credential(&key),
                json!({ "voting_stake": state.voting_stake.to_string() }),
            ))
        })
        .collect::<anyhow::Result<_>>()?;

    let proposals: BTreeMap<String, Value> = snapshot
        .iter_proposals()?
        .map(|(id, row)| {
            (
                format!("{}#{}", id.transaction_id, id.proposal_index),
                json!({
                    "valid_until": u64::from(row.valid_until),
                    "anchor": {
                        "url": row.proposal.anchor.url.as_ref(),
                        "hash": hex::encode(row.proposal.anchor.content_hash),
                    },
                }),
            )
        })
        .collect();

    let tip = snapshot.tip()?;
    Ok(json!({
        "epoch": u64::from(snapshot.epoch()),
        "tip": { "slot": u64::from(tip.slot_or_default()), "hash": hex::encode(tip.hash()) },
        "gov_action_lifetime": snapshot.protocol_parameters()?.gov_action_lifetime,
        "accounts": accounts,
        "dreps": dreps,
        "proposals": proposals,
    }))
}

/// Where one label's datum sits in a metadata map, as a byte range of the decoder's input.
fn metadatum_range(
    d: &mut cbor::Decoder<'_>,
    label: u64,
) -> Result<Option<(usize, usize)>, cbor::decode::Error> {
    cbor::heterogeneous_map(
        d,
        None,
        |d| d.u64(),
        |d, found, key| {
            let start = d.position();
            d.skip()?;
            if key == label {
                *found = Some((start, d.position()));
            }
            Ok(())
        },
    )
}

/// The bytes of one label's datum in a transaction's auxiliary data, whichever of the three
/// encodings carries it: a bare metadata map, the Allegra `[metadata, scripts]` pair, or the
/// Alonzo `#6.259({0: metadata, …})` map.
fn metadatum_bytes(aux: &[u8], label: u64) -> Result<Option<&[u8]>, cbor::decode::Error> {
    let mut d = cbor::Decoder::new(aux);
    let range = match d.datatype()? {
        cbor::data::Type::Tag => {
            d.tag()?;
            cbor::heterogeneous_map(
                &mut d,
                None,
                |d| d.u64(),
                |d, found, key| {
                    if key == 0 {
                        *found = metadatum_range(d, label)?;
                    } else {
                        d.skip()?;
                    }
                    Ok(())
                },
            )?
        }
        cbor::data::Type::Array | cbor::data::Type::ArrayIndef => {
            d.array()?;
            metadatum_range(&mut d, label)?
        }
        _ => metadatum_range(&mut d, label)?,
    };
    Ok(range.map(|(start, end)| &aux[start..end]))
}

/// Every transaction carrying label-17 metadata in the best chain's blocks from slot `from` to
/// slot `to`, inclusive, as JSON: its hash, where it sits (block slot, height, hash and epoch,
/// index in the block), its standalone CBOR reassembled from the block's own bytes, and the
/// bytes of its label-17 datum. The chain is walked from the best tip back through parent
/// links, so every block listed is on the chain the node validated.
fn blocks(network: NetworkName, chain_dir: PathBuf, from: Slot, to: Slot) -> anyhow::Result<Value> {
    let era_history = network
        .as_era_history()
        .ok_or_else(|| anyhow!("no era history for {network}"))?;
    let db = RocksDBStore::open_for_readonly(&RocksDbConfig::new(chain_dir))?;
    let tip = db.get_best_chain_tip();

    let mut window = Vec::new();
    let mut hash = db.get_best_chain_hash();
    loop {
        let header = db
            .load_header(&hash)
            .ok_or_else(|| anyhow!("no header {hash} on the best chain"))?;
        if header.slot() < from {
            break;
        }
        if header.slot() <= to {
            window.push((hash, header.slot(), u64::from(header.block_height())));
        }
        match header.parent() {
            Some(parent) => hash = parent,
            None => break,
        }
    }
    window.reverse();

    let mut transactions = Vec::new();
    for (hash, slot, height) in &window {
        let raw = db
            .load_block(hash)?
            .ok_or_else(|| anyhow!("no block for header {hash}"))?;
        let epoch = u64::from(era_history.slot_to_epoch_unchecked_horizon(*slot)?);
        let network_block = NetworkBlock::try_from(raw)?;
        let mut d = cbor::Decoder::new(network_block.encoded_block());
        d.array()?;
        d.skip()?;
        let bodies = cbor::collect_array_item_bytes(&mut d)?;
        let witnesses = cbor::collect_array_item_bytes(&mut d)?;
        let auxiliary_data = cbor::collect_map_value_bytes(&mut d, |d| d.u16())?;
        let invalid: Option<BTreeSet<u16>> = d.decode()?;
        for (index, (body, witness)) in bodies.iter().zip(&witnesses).enumerate() {
            let index = u16::try_from(index)?;
            let Some(aux) = auxiliary_data.get(&index) else {
                continue;
            };
            let Some(datum) = metadatum_bytes(aux, METADATA_LABEL)? else {
                continue;
            };
            let valid = !invalid.as_ref().is_some_and(|set| set.contains(&index));
            let mut tx = vec![0x84];
            tx.extend_from_slice(body);
            tx.extend_from_slice(witness);
            tx.push(if valid { 0xf5 } else { 0xf4 });
            tx.extend_from_slice(aux);
            transactions.push(json!({
                "hash": hex::encode(Hasher::<256>::hash(body)),
                "slot": u64::from(*slot),
                "epoch": epoch,
                "height": height,
                "block": hex::encode(hash),
                "index": index,
                "valid": valid,
                "cbor": hex::encode(tx),
                "metadata": hex::encode(datum),
            }));
        }
    }

    let tip_slot = tip.slot_or_default();
    let tip_epoch = era_history.slot_to_epoch_unchecked_horizon(tip_slot)?;
    let epoch_start = era_history.epoch_bounds(tip_epoch)?.start;
    let system_start = network
        .as_global_parameters()
        .ok_or_else(|| anyhow!("no global parameters for {network}"))?
        .system_start;
    let tip_time = system_start / 1000
        + era_history
            .slot_to_relative_time_unchecked_horizon(tip_slot)?
            .as_secs();
    Ok(json!({
        "from": u64::from(from),
        "to": u64::from(to),
        "tip": {
            "slot": u64::from(tip_slot),
            "hash": hex::encode(tip.hash()),
            "epoch": u64::from(tip_epoch),
            "epoch_slot": tip_slot.elapsed_from(epoch_start)?,
            "time": tip_time,
        },
        "blocks": window.len(),
        "transactions": transactions,
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
        [_, "blocks", network, chain_dir, from, to] => blocks(
            network.parse().map_err(|e| anyhow!("{e}"))?,
            PathBuf::from(chain_dir),
            Slot::from(from.parse::<u64>()?),
            Slot::from(to.parse::<u64>()?),
        )?,
        _ => bail!("{USAGE}"),
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
