use std::{
    collections::{BTreeMap, BTreeSet},
    env, io,
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

const USAGE: &str =
    "usage: amaru-store-reader snapshot <network> <ledger-dir> <epoch> < credentials.json
       amaru-store-reader blocks <network> <chain-dir> <from-slot> <to-slot> <survey-tx-hash>";

/// The metadata label CIP-179 records are written under.
const METADATA_LABEL: u64 = 17;

fn parse_credential(key: &str) -> anyhow::Result<Credential> {
    match key.split_once(':') {
        Some(("key", h)) => Ok(Credential::KeyHash(h.parse()?)),
        Some(("script", h)) => Ok(Credential::ScriptHash(h.parse()?)),
        _ => bail!("not a credential key: {key}"),
    }
}

/// The credentials a snapshot is asked about, as `credentials` in `packages/amaru` prints them:
/// `{"accounts": [key, …], "dreps": [key, …]}`, keys `key:<hex>` or `script:<hex>`.
struct Asked {
    accounts: Vec<String>,
    dreps: Vec<String>,
}

impl Asked {
    fn read(input: impl io::Read) -> anyhow::Result<Self> {
        let value: Value = serde_json::from_reader(input)?;
        let keys = |field: &str| -> anyhow::Result<Vec<String>> {
            value[field]
                .as_array()
                .ok_or_else(|| anyhow!("the credentials on stdin have no `{field}` array"))?
                .iter()
                .map(|k| {
                    k.as_str()
                        .map(String::from)
                        .ok_or_else(|| anyhow!("`{field}` holds a non-string: {k}"))
                })
                .collect()
        };
        Ok(Asked {
            accounts: keys("accounts")?,
            dreps: keys("dreps")?,
        })
    }
}

/// One epoch snapshot as JSON, for the asked credentials only: each stake credential with the
/// stake and pool the node's own end-of-epoch view gives it (the pool `null` once retired), each
/// DRep with its voting stake, either `null` when not registered; and every governance action
/// still in the state with its last votable epoch and anchor. Lovelace are decimal strings.
fn snapshot(
    network: NetworkName,
    ledger_dir: PathBuf,
    epoch: Epoch,
    asked: Asked,
) -> anyhow::Result<Value> {
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

    let accounts: BTreeMap<String, Value> = asked
        .accounts
        .iter()
        .map(|key| {
            let credential = parse_credential(key)?;
            if snapshot.account(&credential)?.is_none() {
                return Ok((key.clone(), Value::Null));
            }
            let state = summary
                .accounts
                .get(&credential)
                .ok_or_else(|| anyhow!("registered account {key} has no end-of-epoch view"))?;
            Ok((
                key.clone(),
                json!({
                    "stake": state.balance.to_string(),
                    "pool": state.pool.map(hex::encode),
                }),
            ))
        })
        .collect::<anyhow::Result<_>>()?;

    let dreps: BTreeMap<String, Value> = asked
        .dreps
        .iter()
        .map(|key| {
            let credential = parse_credential(key)?;
            if snapshot.drep(&credential)?.is_none() {
                return Ok((key.clone(), Value::Null));
            }
            let as_drep = match credential {
                Credential::KeyHash(h) => DRep::Key(h),
                Credential::ScriptHash(h) => DRep::Script(h),
            };
            let state = summary
                .dreps
                .get(&as_drep)
                .ok_or_else(|| anyhow!("registered DRep {key} has no end-of-epoch view"))?;
            Ok((
                key.clone(),
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

/// Whether a CBOR item holds, at any depth, a byte string equal to `needle`, an indefinite one
/// judged by its joined chunks.
fn holds_bytes(d: &mut cbor::Decoder<'_>, needle: &[u8]) -> Result<bool, cbor::decode::Error> {
    use cbor::data::Type;
    let items = match d.datatype()? {
        Type::Bytes => return Ok(d.bytes()? == needle),
        Type::BytesIndef => {
            let mut joined = Vec::new();
            for chunk in d.bytes_iter()? {
                joined.extend_from_slice(chunk?);
            }
            return Ok(joined == needle);
        }
        Type::Tag => {
            d.tag()?;
            return holds_bytes(d, needle);
        }
        Type::Array | Type::ArrayIndef => d.array()?,
        Type::Map | Type::MapIndef => d.map()?.map(|n| 2 * n),
        _ => {
            d.skip()?;
            return Ok(false);
        }
    };
    let mut seen = 0;
    while match items {
        Some(n) => seen < n,
        None => !cbor::decode_break(d, None)?,
    } {
        if holds_bytes(d, needle)? {
            return Ok(true);
        }
        seen += 1;
    }
    Ok(false)
}

/// The transactions that can concern one survey in the best chain's blocks from slot `from` to
/// slot `to`, inclusive: the survey's own and every one whose label-17 datum holds its hash as a
/// byte string, which a record naming the survey must. A datum holding it for another reason
/// lets a transaction through; none naming the survey is left out. As JSON: its hash, where it
/// sits (block slot, height, hash and epoch, index in the block), its standalone CBOR
/// reassembled from the block's own bytes, and the bytes of its label-17 datum. The chain is walked from the best tip back through parent
/// links, so every block listed is on the chain the node validated.
fn blocks(
    network: NetworkName,
    chain_dir: PathBuf,
    from: Slot,
    to: Slot,
    survey: &[u8],
) -> anyhow::Result<Value> {
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
            let tx_hash = Hasher::<256>::hash(body);
            if tx_hash.as_ref() != survey && !holds_bytes(&mut cbor::Decoder::new(datum), survey)? {
                continue;
            }
            let valid = !invalid.as_ref().is_some_and(|set| set.contains(&index));
            let mut tx = vec![0x84];
            tx.extend_from_slice(body);
            tx.extend_from_slice(witness);
            tx.push(if valid { 0xf5 } else { 0xf4 });
            tx.extend_from_slice(aux);
            transactions.push(json!({
                "hash": hex::encode(tx_hash),
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
    Ok(json!({
        "from": u64::from(from),
        "to": u64::from(to),
        "survey": hex::encode(survey),
        "tip": {
            "slot": u64::from(tip_slot),
            "hash": hex::encode(tip.hash()),
            "epoch": u64::from(tip_epoch),
            "epoch_slot": tip_slot.elapsed_from(epoch_start)?,
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
            Asked::read(io::stdin().lock())?,
        )?,
        [_, "blocks", network, chain_dir, from, to, survey] => blocks(
            network.parse().map_err(|e| anyhow!("{e}"))?,
            PathBuf::from(chain_dir),
            Slot::from(from.parse::<u64>()?),
            Slot::from(to.parse::<u64>()?),
            &hex::decode(survey)?,
        )?,
        _ => bail!("{USAGE}"),
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holds(item: &[u8], needle: &[u8]) -> bool {
        holds_bytes(&mut cbor::Decoder::new(item), needle).unwrap()
    }

    #[test]
    fn finds_a_byte_string_at_any_depth_and_across_chunks() {
        let needle = [b'a'; 32];
        let mut definite = vec![0xa1, 0x00, 0x82, 0x9f, 0x01, 0xff, 0x82, 0x58, 0x20];
        definite.extend_from_slice(&needle);
        definite.push(0x00);
        assert!(holds(&definite, &needle));

        let mut chunked = vec![0xd8, 0x79, 0x9f, 0x5f, 0x50];
        chunked.extend_from_slice(&needle[..16]);
        chunked.push(0x50);
        chunked.extend_from_slice(&needle[16..]);
        chunked.extend_from_slice(&[0xff, 0xff]);
        assert!(holds(&chunked, &needle));

        let mut longer = vec![0x58, 0x21];
        longer.extend_from_slice(&needle);
        longer.push(0x00);
        assert!(!holds(&longer, &needle));
        let mut text = vec![0x78, 0x20];
        text.extend_from_slice(&needle);
        assert!(!holds(&text, &needle));
    }
}
