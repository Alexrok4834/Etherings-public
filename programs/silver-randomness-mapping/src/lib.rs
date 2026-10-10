use sha2::{Digest, Sha256};

pub const DOMAIN: &[u8; 36] = b"ETHERINGS_ORAO_CLASSIC_RANDOMNESS_V1";

pub fn normalize_v1(
    orao_program_id: &[u8; 32],
    request_pda: &[u8; 32],
    seed: &[u8; 32],
    fulfilled_randomness: &[u8; 64],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(orao_program_id);
    hasher.update(request_pda);
    hasher.update(seed);
    hasher.update(fulfilled_randomness);
    hasher.finalize().into()
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
        assert_eq!(
            hex,
            hex.to_ascii_lowercase(),
            "{field} must use canonical lowercase hex"
        );
        bytes
    }

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../vectors.json")).expect("valid shared vector corpus")
    }

    #[test]
    fn canonical_alpha_v1_vectors_hash_raw_fixed_length_bytes() {
        let corpus = vectors();
        assert_eq!(corpus["mapping"], std::str::from_utf8(DOMAIN).unwrap());
        for vector in corpus["vectors"].as_array().unwrap() {
            let actual = normalize_v1(
                &raw::<32>(vector, "oraoProgramIdHex"),
                &raw::<32>(vector, "requestPdaHex"),
                &raw::<32>(vector, "seedHex"),
                &raw::<64>(vector, "fulfilledRandomnessHex"),
            );
            assert_eq!(
                actual,
                raw::<32>(vector, "randomness32Hex"),
                "{}",
                vector["name"]
            );
        }
    }

    #[test]
    fn every_raw_component_and_its_position_are_binding() {
        let corpus = vectors();
        let vector = &corpus["vectors"][1];
        let program = raw::<32>(vector, "oraoProgramIdHex");
        let request = raw::<32>(vector, "requestPdaHex");
        let seed = raw::<32>(vector, "seedHex");
        let fulfilled = raw::<64>(vector, "fulfilledRandomnessHex");
        let expected = normalize_v1(&program, &request, &seed, &fulfilled);

        let mut changed_program = program;
        changed_program[31] ^= 1;
        assert_ne!(
            normalize_v1(&changed_program, &request, &seed, &fulfilled),
            expected
        );
        let mut changed_request = request;
        changed_request[31] ^= 1;
        assert_ne!(
            normalize_v1(&program, &changed_request, &seed, &fulfilled),
            expected
        );
        let mut changed_seed = seed;
        changed_seed[31] ^= 1;
        assert_ne!(
            normalize_v1(&program, &request, &changed_seed, &fulfilled),
            expected
        );
        let mut changed_fulfilled = fulfilled;
        changed_fulfilled[63] ^= 1;
        assert_ne!(
            normalize_v1(&program, &request, &seed, &changed_fulfilled),
            expected
        );
        assert_ne!(
            normalize_v1(&request, &program, &seed, &fulfilled),
            expected
        );
    }
}
