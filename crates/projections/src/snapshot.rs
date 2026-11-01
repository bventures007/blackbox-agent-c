//! Snapshot codec: bincode(TenantState) + sha256 checksum + format/reducer version.
//! Corrupt or incompatible snapshots are rejected and the tenant is rebuilt from the journal.

use blackbox_domain::{TenantState, REDUCER_VERSION};
use sha2::{Digest, Sha256};

pub const SNAPSHOT_FORMAT_VERSION: i32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("snapshot format version {0} is not supported (expected {SNAPSHOT_FORMAT_VERSION})")]
    Format(i32),
    #[error("snapshot reducer version {0} does not match {REDUCER_VERSION}")]
    Reducer(i32),
    #[error("snapshot checksum mismatch")]
    Checksum,
    #[error("snapshot decode failed: {0}")]
    Decode(String),
    #[error("snapshot tenant mismatch")]
    Tenant,
    #[error("snapshot applied sequence mismatch (row {0}, blob {1})")]
    Sequence(i64, i64),
}

pub struct Encoded {
    pub blob: Vec<u8>,
    pub checksum: String,
    pub applied_sequence: i64,
}

pub fn encode(state: &TenantState) -> Result<Encoded, SnapshotError> {
    let blob = bincode::serialize(state).map_err(|e| SnapshotError::Decode(e.to_string()))?;
    let checksum = hex::encode(Sha256::digest(&blob));
    Ok(Encoded {
        blob,
        checksum,
        applied_sequence: state.applied_sequence,
    })
}

pub fn decode(
    tenant: uuid::Uuid,
    format_version: i32,
    reducer_version: i32,
    applied_sequence: i64,
    checksum: &str,
    blob: &[u8],
) -> Result<TenantState, SnapshotError> {
    if format_version != SNAPSHOT_FORMAT_VERSION {
        return Err(SnapshotError::Format(format_version));
    }
    if reducer_version != REDUCER_VERSION as i32 {
        return Err(SnapshotError::Reducer(reducer_version));
    }
    let actual = hex::encode(Sha256::digest(blob));
    if actual != checksum {
        return Err(SnapshotError::Checksum);
    }
    let mut state: TenantState =
        bincode::deserialize(blob).map_err(|e| SnapshotError::Decode(e.to_string()))?;
    if state.tenant_id != tenant {
        return Err(SnapshotError::Tenant);
    }
    if state.reducer_version != REDUCER_VERSION {
        return Err(SnapshotError::Reducer(state.reducer_version as i32));
    }
    if state.applied_sequence != applied_sequence {
        return Err(SnapshotError::Sequence(applied_sequence, state.applied_sequence));
    }
    state.after_deserialize();
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use blackbox_domain::fixture::{connection_uuid, derived_entries, source_entry, GoldenScenario};
    use blackbox_domain::apply;

    #[test]
    fn snapshot_roundtrip_is_lossless_and_rejects_corruption() {
        let g = GoldenScenario::load_from_repo().unwrap();
        let tenant = uuid::Uuid::new_v4();
        let mut st = TenantState::new(tenant);
        let mut seq = 0;
        for ev in &g.events {
            seq += 1;
            let src = source_entry(tenant, seq, ev, connection_uuid(tenant, &ev.connection), chrono::Utc::now());
            apply(&mut st, &src);
            for d in derived_entries(&src, seq + 1) {
                seq += 1;
                apply(&mut st, &d);
            }
        }
        let enc = encode(&st).unwrap();
        let back = decode(tenant, SNAPSHOT_FORMAT_VERSION, REDUCER_VERSION as i32, enc.applied_sequence, &enc.checksum, &enc.blob).unwrap();
        assert_eq!(back.recs, st.recs);
        assert_eq!(back.entries, st.entries);
        assert_eq!(back.history, st.history);
        assert_eq!(back.state_hash, st.state_hash);
        assert_eq!(back.interner.get("#1001"), st.interner.get("#1001"));
        let mut corrupt = enc.blob.clone();
        corrupt[10] ^= 0xff;
        assert!(matches!(decode(tenant, SNAPSHOT_FORMAT_VERSION, REDUCER_VERSION as i32, enc.applied_sequence, &enc.checksum, &corrupt), Err(SnapshotError::Checksum)));
        assert!(matches!(decode(tenant, 99, REDUCER_VERSION as i32, enc.applied_sequence, &enc.checksum, &enc.blob), Err(SnapshotError::Format(99))));
        assert!(matches!(decode(uuid::Uuid::new_v4(), SNAPSHOT_FORMAT_VERSION, REDUCER_VERSION as i32, enc.applied_sequence, &enc.checksum, &enc.blob), Err(SnapshotError::Tenant)));
    }
}
