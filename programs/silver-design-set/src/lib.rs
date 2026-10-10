use sha2::{Digest, Sha256};

pub const DOMAIN: &[u8; 30] = b"ETHERINGS_SILVER_DESIGN_SET_V1";
pub const MAX_DESIGNS: usize = 42;
pub const MAX_URI_BYTES: usize = 200;
pub const ACCOUNT_HEADER_BYTES: usize = 104;
pub const MAX_ENTRY_BYTES: usize = 38 + MAX_URI_BYTES;

pub fn account_size(capacity: usize) -> Result<usize, DesignSetError> {
    if capacity == 0 || capacity > MAX_DESIGNS {
        return Err(DesignSetError::InvalidCount);
    }
    Ok(ACCOUNT_HEADER_BYTES + capacity * MAX_ENTRY_BYTES)
}

#[derive(Debug, PartialEq, Eq)]
pub enum DesignSetError {
    InvalidVersion,
    InvalidCount,
    InvalidDesignId,
    InvalidUri,
    InvalidContentHash,
}

pub struct DesignEntry<'a> {
    pub design_id: u32,
    pub uri: &'a [u8],
    pub content_hash: [u8; 32],
}

pub fn commitment_v1(
    silver_program_id: &[u8; 32],
    design_set_pda: &[u8; 32],
    version: u64,
    entries: &[DesignEntry<'_>],
) -> Result<([u8; 32], usize), DesignSetError> {
    if version == 0 {
        return Err(DesignSetError::InvalidVersion);
    }
    if entries.is_empty() || entries.len() > MAX_DESIGNS {
        return Err(DesignSetError::InvalidCount);
    }
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(silver_program_id);
    hasher.update(design_set_pda);
    hasher.update(version.to_le_bytes());
    hasher.update((entries.len() as u16).to_le_bytes());
    let mut previous = 0u32;
    let mut used = 0usize;
    for entry in entries {
        if entry.design_id == 0 || entry.design_id <= previous {
            return Err(DesignSetError::InvalidDesignId);
        }
        if entry.uri.is_empty()
            || entry.uri.len() > MAX_URI_BYTES
            || !entry.uri.iter().all(|byte| (0x21..=0x7e).contains(byte))
        {
            return Err(DesignSetError::InvalidUri);
        }
        if entry.content_hash == [0; 32] {
            return Err(DesignSetError::InvalidContentHash);
        }
        hasher.update(entry.design_id.to_le_bytes());
        hasher.update((entry.uri.len() as u16).to_le_bytes());
        hasher.update(entry.uri);
        hasher.update(entry.content_hash);
        used += 38 + entry.uri.len();
        previous = entry.design_id;
    }
    Ok((hasher.finalize().into(), used))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn raw<const N: usize>(value: &Value, field: &str) -> [u8; N] {
        let hex = value[field]
            .as_str()
            .expect("vector field must be a string");
        assert_eq!(hex.len(), N * 2, "{field} has wrong encoded length");
        let mut bytes = [0u8; N];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                .expect("vector field must contain lowercase hex");
        }
        assert_eq!(hex, hex.to_ascii_lowercase());
        bytes
    }

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../vectors.json")).expect("valid shared vector corpus")
    }

    fn entries(vector: &Value) -> Vec<DesignEntry<'_>> {
        vector["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| DesignEntry {
                design_id: entry["designId"].as_u64().unwrap() as u32,
                uri: entry["uri"].as_str().unwrap().as_bytes(),
                content_hash: raw::<32>(entry, "contentHashHex"),
            })
            .collect()
    }

    #[test]
    fn canonical_vectors_match_the_shared_corpus() {
        let corpus = vectors();
        assert_eq!(corpus["mapping"], std::str::from_utf8(DOMAIN).unwrap());
        for vector in corpus["vectors"].as_array().unwrap() {
            let list = entries(vector);
            let (commitment, used) = commitment_v1(
                &raw::<32>(vector, "silverProgramIdHex"),
                &raw::<32>(vector, "designSetPdaHex"),
                vector["version"].as_str().unwrap().parse().unwrap(),
                &list,
            )
            .unwrap();
            assert_eq!(commitment, raw::<32>(vector, "commitmentHex"));
            assert_eq!(used as u64, vector["usedEntryBytes"].as_u64().unwrap());
        }
    }

    #[test]
    fn malformed_sets_fail_closed() {
        let hash = [1u8; 32];
        let one = DesignEntry {
            design_id: 1,
            uri: b"ipfs://one",
            content_hash: hash,
        };
        assert_eq!(
            commitment_v1(&[1; 32], &[2; 32], 0, &[one]).unwrap_err(),
            DesignSetError::InvalidVersion
        );
        assert_eq!(
            commitment_v1(&[1; 32], &[2; 32], 1, &[]).unwrap_err(),
            DesignSetError::InvalidCount
        );
        let duplicate = [
            DesignEntry {
                design_id: 1,
                uri: b"ipfs://one",
                content_hash: hash,
            },
            DesignEntry {
                design_id: 1,
                uri: b"ipfs://two",
                content_hash: hash,
            },
        ];
        assert_eq!(
            commitment_v1(&[1; 32], &[2; 32], 1, &duplicate).unwrap_err(),
            DesignSetError::InvalidDesignId
        );
        let bad_uri = DesignEntry {
            design_id: 1,
            uri: b"bad uri",
            content_hash: hash,
        };
        assert_eq!(
            commitment_v1(&[1; 32], &[2; 32], 1, &[bad_uri]).unwrap_err(),
            DesignSetError::InvalidUri
        );
        let zero_hash = DesignEntry {
            design_id: 1,
            uri: b"ipfs://one",
            content_hash: [0; 32],
        };
        assert_eq!(
            commitment_v1(&[1; 32], &[2; 32], 1, &[zero_hash]).unwrap_err(),
            DesignSetError::InvalidContentHash
        );

        let descending = [
            DesignEntry {
                design_id: 2,
                uri: b"ipfs://two",
                content_hash: hash,
            },
            DesignEntry {
                design_id: 1,
                uri: b"ipfs://one",
                content_hash: hash,
            },
        ];
        assert_eq!(
            commitment_v1(&[1; 32], &[2; 32], 1, &descending).unwrap_err(),
            DesignSetError::InvalidDesignId
        );
        let oversized: Vec<_> = (1..=43)
            .map(|design_id| DesignEntry {
                design_id,
                uri: b"ipfs://entry",
                content_hash: hash,
            })
            .collect();
        assert_eq!(
            commitment_v1(&[1; 32], &[2; 32], 1, &oversized).unwrap_err(),
            DesignSetError::InvalidCount
        );
        assert_eq!(account_size(0).unwrap_err(), DesignSetError::InvalidCount);
        assert_eq!(account_size(43).unwrap_err(), DesignSetError::InvalidCount);
        assert_eq!(account_size(1).unwrap(), 342);
        assert_eq!(account_size(42).unwrap(), 10_100);
    }
}
